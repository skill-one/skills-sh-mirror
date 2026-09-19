# skills.sh data mirror

A daily snapshot of every GitHub-sourced skill on [skills.sh](https://www.skills.sh): the leaderboard as a queryable index (`skills.jsonl`) plus each skill's full files (`skills/`). Skills from well-known (domain) sources are not mirrored — they have no repository to attribute.

中文:[README.zh-CN.md](README.zh-CN.md) · Dev guide (run / verify / extend): [DEVELOPING.md](DEVELOPING.md)

## What the data is

```
├── skills.jsonl   one row per skill, sorted by installs desc — query / filter / rank here
├── repos.jsonl    one row per GitHub repository behind the index (stars, about, last push)
├── owners.jsonl   one row per repository owner and its avatar URL
├── avatars/       the owners' GitHub avatars, saved as {owner}.png
├── trending.json  the trending view's first 100 GitHub-sourced ids, in rank order
├── curated.jsonl  the officially featured skills, one row per owner
├── stats.json     the producing run's stats (counts, changes, failed ids)
├── latest         the newest tag, one line — read it to pin
└── skills/        one directory per skill, named after its id
    └── vercel-labs/skills/find-skills/   ({owner}/{repo}/{slug})
        └── SKILL.md
```

Each `skills.jsonl` row:

```json
{
  "id": "vercel-labs/skills/find-skills",
  "installs": 3263512,
  "url": "https://www.skills.sh/vercel-labs/skills/find-skills",
  "hash": "b146008599c31057cef1c145774cea5d5afb30e8f43fa802e47a4b461419aaaf",
  "fetchedAt": "2026-09-05T08:26:00.682Z"
}
```

| Field | Meaning |
|---|---|
| `id`, `installs`, `url` | from the skills.sh leaderboard (the id encodes source and slug: `{owner}/{repo}/{slug}`) |
| `hash` | Content version of the skill's files: SHA-256 over each file's `path + 0x00 + bytes + 0x00`, files in case-insensitive path order ([the upstream `hash`](DEVELOPING.md#the-upstream-hash)); `null` if unknown |
| `fetchedAt` | when the current content version was first fetched |
| `audits` | with `--audits`: partner audit results (`provider`, `status`, `riskLevel`, …); `[]` = none yet |

`repos.jsonl` holds the GitHub repository metadata — one row per repository, sorted by repo:

```json
{"repo": "vercel-labs/skills", "stars": 1523, "description": "Agents, skills, and plugins for Vercel", "pushedAt": "2026-09-11T14:02:11.000Z"}
```

| Field | Meaning |
|---|---|
| `repo` | `owner/repo`, an id's first two segments — the join key from every index row |
| `stars` | the repository's stargazer count; `null` if the repo is gone or the count is unknown |
| `description` | the repository's GitHub About text; `null` if unset or unknown |
| `pushedAt` | the repository's last code-push time (`pushed_at`); `null` if the repo is gone. Note this tracks the repository, not the skill: use `hash`/`fetchedAt` in the index for skill-level changes |

`owners.jsonl` holds the repository owners' GitHub avatars, pulled into `avatars/` so consumers need no GitHub API for them — one row per owner, sorted by owner:

```json
{"owner": "vercel-labs", "avatarUrl": "https://avatars.githubusercontent.com/u/12565288?v=4"}
```

| Field | Meaning |
|---|---|
| `owner` | the GitHub user/org name — the id's first segment, the join key from every index row |
| `avatarUrl` | the upstream avatar URL (its `?v=` parameter bumps when the user changes the avatar — this is what keeps re-downloads away); `null` if that run's download failed |

The local copy's path is derivable from the owner alone: `avatars/{owner}.png`. The extension is fixed regardless of the actual image format (GitHub serves png or jpeg): a derivable path needs a fixed name, and image decoders sniff the payload, so jpeg bytes under a `.png` name render fine everywhere. When `avatarUrl` is `null`, the copy is absent until the next run succeeds.

Two guarantees, integrity-checked after every run:

- A skill directory contains exactly the files the upstream skill ships — copy it straight into an agent's skills folder.
- The index and `skills/` match exactly: a row exists if and only if its directory exists, and a directory is always complete.

Edge cases (failed fetches, `--limit` runs, delisted skills) are covered in [DEVELOPING.md](DEVELOPING.md).

`trending.json` is an array of the trending leaderboard's first 100 GitHub-sourced ids, in upstream rank order — the array index is the rank. `curated.jsonl` is the officially featured list, one row per owner:

```json
{"owner": "vercel-labs", "totalInstalls": 12345, "featuredRepo": "vercel-labs/skills", "featuredSkill": "find-skills", "skills": ["vercel-labs/skills/find-skills", "mintlify.com/mintlify"]}
```

Both use the same id form as the index, so they join straight back into `skills.jsonl`. `curated.jsonl` is not source-filtered: it can hold ids the index does not, and the same skill may appear under several owners.

## How to get the data

Published daily by the [`fetch-skills.yml`](.github/workflows/fetch-skills.yml) workflow to the [`dist` branch](../../tree/dist) — each commit is a complete snapshot at the branch root.

### Fetch individual files

No clone, no auth. `dist` always serves the newest snapshot; swap it for a `dist-<date>` tag to pin a day (the newest 30 are tagged, and the name is slash-free — `dist/<date>` 404s as a URL ref):

```bash
BASE=https://raw.githubusercontent.com/skill-one/skills-sh-mirror
latest=$(curl -s $BASE/dist/latest)
curl -sO $BASE/$latest/skills.jsonl                    # the index: one row per skill
curl -sO $BASE/$latest/skills/vercel-labs/skills/find-skills/SKILL.md   # any skill file, by id
```

`latest` is one line of plain text holding the tag (`dist-2026-09-11`) — cache by tag, since it is what changes when a new day lands. Resolve it from `dist`: raw's ~5-minute cache is the worst-case lag, and nothing busts it; via jsDelivr instead, it is a 12-hour branch cache (7 days in the browser).

### Clone the whole snapshot

Get everything in one shot, ready for offline use:

```bash
git clone --depth 1 -b dist https://github.com/skill-one/skills-sh-mirror.git
```

To pin to a day, clone the `dist-<date>` tag instead (resolve the newest one as shown above):

```bash
git clone --depth 1 -b "$latest" https://github.com/skill-one/skills-sh-mirror.git
```

Snapshots are published by GitHub Actions — publish now with `gh workflow run fetch-skills.yml`. To produce the data yourself: `node scraper.mjs` — see [DEVELOPING.md](DEVELOPING.md).
