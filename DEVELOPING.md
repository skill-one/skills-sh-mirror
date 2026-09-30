# Developing

How to run, verify, and extend the scraper. Using the data: [README.md](README.md) · 中文:[DEVELOPING.zh-CN.md](DEVELOPING.zh-CN.md)

## How it works

`node scraper.mjs [--out data]` contacts skills.sh only and rebuilds everything from scratch:

1. `GET /api/v1/skills?per_page=500&page=N` (~17 requests) — the leaderboard. Keeps github-sourced entries only, each normalized to the canonical id `${source}/${slug-without-slashes}` (`canonicalId` in `lib.mjs` — skills.sh keys slash slugs by the stripped form); well-known (non-GitHub) sources and upstream duplicate-flagged entries are skipped and counted.
2. `GET /api/v1/skills?view=trending&per_page=200` — the trending view in one request; its first 100 github-sourced ids (in rank order) go to `trending.json`.
3. `GET /api/v1/skills/curated` — the curated partners; one row per owner in `curated.jsonl`, per-skill entries reduced to canonical ids (no source filtering).
4. Writes `skills.jsonl` ({ id, installs }, sorted by installs desc, ties by id) and `README.md` — the dist landing page: a file guide plus this run's stats (timing and the skip counters) for humans.

Every artifact is written to `<path>.tmp` first and swapped in via rename(2), so a crash can never leave a half-updated file. The index is the leaderboard itself: no skill content is fetched, and a skill upstream stops listing simply leaves the index. Transient failures (429/5xx, network errors) are retried with backoff, honoring `Retry-After`; 4xx are deterministic and never retried.

## Prerequisites

Node >= 24 and a Vercel OIDC token (any Vercel project works):

```bash
npm i -g vercel
vercel link && vercel env pull   # writes VERCEL_OIDC_TOKEN into .env.local, valid ~12h
```

Re-run `vercel env pull` when the token expires (HTTP 401). Never commit `.env.local`.

## Verify

| Layer | Answers | Needs | Command |
|---|---|---|---|
| 1. Offline tests | Is the scraper logic correct? | nothing (mock API) | `npm test` |
| 2. Artifact verifier | Is a dataset intact? | nothing (no network) | `node verify.mjs --out data` |
| 3. Real API run | Does the live API still behave? | token | `node scraper.mjs && node verify.mjs` |

`verify.mjs` is the gate before trusting or publishing a dataset: rows parse and carry exactly `id` + `installs` (id a canonical `owner/repo/slug`, installs non-negative), ids unique and sorted (installs desc, ties by id), `trending.json` an id array, `curated.jsonl` well-shaped owner rows, `README.md` present, no `.tmp` leftovers.

## CI

- **`ci.yml`** (push / PR): layer 1 on Node 24 — secret-free, so fork PRs run it too.
- **`fetch-skills.yml`**: daily 18:00 UTC canary + publisher (`gh workflow run fetch-skills.yml` to trigger). Mints a fresh OIDC token from the long-lived `VERCEL_TOKEN` (secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`) → `node scraper.mjs` → `node verify.mjs` → `node publish.mjs`, which force-pushes the `dist` branch as a single parentless commit exactly the publish set, re-points the `dist-<date>` tag, and prunes tags beyond `--window` (default 30). The run fails if the published tree is not exactly the publish set or the tag does not point at it.
