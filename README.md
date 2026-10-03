# skills.sh data mirror

A daily snapshot of every GitHub-sourced skill on [skills.sh](https://www.skills.sh), rebuilt from the leaderboard on every run. Fetch any file straight from this branch, or pin a day via the `dist-<date>` tags. Docs: [skill-one/skills-sh-mirror](https://github.com/skill-one/skills-sh-mirror).

| File | Content |
|---|---|
| `skills.jsonl` | one `{ id, name, installs }` row per skill, sorted by installs desc — `name` is the skill's SKILL.md frontmatter name (lowercased), the slug (last segment of `id`) is that name made addressable (spaces -> "-", "/" dropped) |
| `trending.json` | the trending view's first 100 github-sourced ids, in rank order |
| `curated.jsonl` | the officially featured skills, one row per owner |

## Latest run

Generated 2026-10-03T20:18:11.547Z in 45.7s.

| Skills indexed | 9142 |
|---|---|
| Duplicates skipped | 0 |
| Non-github skipped | 747 |
| Trending ids | 100 |
| Curated owners / skills | 102 / 6681 |
