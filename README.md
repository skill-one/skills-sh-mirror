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
- `installs` — the skill's install count on skills.sh.

All artifacts are keyed by the same canonical id, so `trending.json` and `curated.jsonl` join straight back into `skills.jsonl` (curated is not source-filtered and may repeat a skill under several owners). Upstream duplicate-flagged entries are skipped — one row per distinct skill; delisted skills leave the index on the next run. `verify.mjs` gates every publish.

## Getting the data

Published daily to the [`dist` branch](../../tree/dist) — its tip is always a complete snapshot (a single parentless commit, replaced each run); older days live in the `dist-<date>` tags (newest 30, slash-free names so they resolve in raw URLs).

```bash
BASE=https://raw.githubusercontent.com/skill-one/skills-sh-mirror
curl -sO $BASE/dist/skills.jsonl                                             # newest snapshot
curl -s $BASE/dist/skills.jsonl | jq -r 'select(.installs > 100000) | .id'   # or query in flight
curl -sO $BASE/dist-2026-09-11/skills.jsonl                                  # pin a day
```

raw's ~5-minute branch cache is the worst-case lag on `dist` (12h via jsDelivr); a `dist-<date>` tag never changes, so cache by it freely.

```bash
git clone --depth 1 -b dist https://github.com/skill-one/skills-sh-mirror.git   # whole snapshot
git ls-remote --tags --refs https://github.com/skill-one/skills-sh-mirror.git 'dist-*'   # list days
```

Snapshots are published by GitHub Actions — `gh workflow run fetch-skills.yml` publishes now. To produce the data yourself: `node scraper.mjs` — see [DEVELOPING.md](DEVELOPING.md).
