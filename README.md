# skills.sh data mirror

A daily snapshot of every GitHub-sourced skill on [skills.sh](https://www.skills.sh) — the leaderboard as a queryable index. Everything comes from skills.sh's API: no skill content, no GitHub API. A row's id addresses the skill upstream, so nothing else needs mirroring.

中文:[README.zh-CN.md](README.zh-CN.md) · Dev guide: [DEVELOPING.md](DEVELOPING.md)

## The data

```
skills.jsonl    { id, installs } per skill, sorted by installs desc — query/filter/rank here
trending.json   the trending view's first 100 github-sourced ids, in rank order
curated.jsonl   the officially featured skills, one row per owner
README.md       the dist landing page — file guide plus the latest run's stats
```

```json
{"id": "vercel-labs/skills/find-skills", "installs": 3263512}
```

- `id` — the canonical `{owner}/{repo}/{slug}`: it doubles as the install argument (`npx skills add <id>`), its first two segments name the hosting GitHub repository, and the skill's page lives at `https://skills.sh/<id>`.
- The slug (`id`'s last segment) is the skill's own `name:` field from its `SKILL.md` frontmatter, made addressable: lowercased, every space replaced by `-`, `/` dropped, everything else kept verbatim (`&`, `.`, `_`, `:` survive; e.g. `agent-development`). No separate name is mirrored — it can be recovered from the slug by reversing the space→`-` step.
- `installs` — the skill's install count on skills.sh.

All artifacts are keyed by the same canonical id, so `trending.json` and `curated.jsonl` join straight back into `skills.jsonl` (curated is not source-filtered and may repeat a skill under several owners). Upstream duplicate-flagged entries are skipped — one row per distinct skill; delisted skills leave the index on the next run. `verify.mjs` gates every publish.

## Getting the data

Published daily to the [`dist` branch](../../tree/dist) — its tip is always the newest complete snapshot; older days are pinned as `dist-<date>` tags.

```bash
BASE=https://raw.githubusercontent.com/skill-one/skills-sh-mirror
curl -sO $BASE/dist/skills.jsonl               # newest snapshot
curl -sO $BASE/dist-2026-09-11/skills.jsonl    # pin a day
```

How the snapshots are produced: [DEVELOPING.md](DEVELOPING.md).
