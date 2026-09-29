# skills.sh data mirror

A daily snapshot of every GitHub-sourced skill on [skills.sh](https://www.skills.sh), rebuilt from the leaderboard on every run. Fetch any file straight from this branch, or pin a day via the `dist-<date>` tags. Docs: [skill-one/skills-sh-mirror](https://github.com/skill-one/skills-sh-mirror).

| File | Content |
|---|---|
| `skills.jsonl` | one `{ id, installs }` row per skill, sorted by installs desc |
| `trending.json` | the trending view's first 100 github-sourced ids, in rank order |
| `curated.jsonl` | the officially featured skills, one row per owner |

## Latest run

Generated 2026-09-29T21:36:25.032Z in 48.4s.

| Skills indexed | 9088 |
|---|---|
| Duplicates skipped | 0 |
| Non-github skipped | 746 |
| Trending ids | 100 |
| Curated owners / skills | 102 / 6588 |
