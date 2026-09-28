#!/usr/bin/env node
/**
 * Scrape the skills.sh leaderboard into a local dataset.
 *
 * Zero dependencies (Node >= 24). Auth: a Vercel OIDC token in VERCEL_OIDC_TOKEN
 * (env var, or .env.local produced by `vercel env pull`) — see DEVELOPING.md.
 *
 * Everything comes from skills.sh's API and nothing else: no skill content, no
 * GitHub API. Only github-sourced skills (sourceType "github") are mirrored —
 * the index is keyed by the {owner}/{repo}/{slug} id that well-known (domain)
 * sources don't fit — and entries upstream flags as duplicates of another
 * skill are skipped, keeping the index one row per distinct skill.
 *
 * Output (rebuilt from scratch on every run, each file written atomically):
 *   skills.jsonl     { id, installs } per skill, sorted by installs desc
 *   trending.json    the trending view's first 100 github-sourced ids
 *   curated.jsonl    the curated partners, one row per owner, skills as ids
 *   README.md        the dist landing page: file guide + this run's stats
 *
 * Usage: node scraper.mjs [--out data]
 */

import { setTimeout as sleep } from "node:timers/promises";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { argValue, canonicalId } from "./lib.mjs";

const API_BASE = (process.env.SKILLS_API_BASE ?? "https://skills.sh").replace(/\/+$/, "");
const OUT_DIR = argValue(process.argv.slice(2), "--out") ?? "data";
const startedAt = new Date();

// Every artifact is written to `<path>.tmp` first and swapped in via
// rename(2), so a crash can never leave a half-updated file behind
// (verify.mjs flags leftovers).
const atomicWrite = async (p, contents) => {
  await writeFile(`${p}.tmp`, contents);
  await rename(`${p}.tmp`, p);
};

// The token comes from the environment or .env.local. A missing token is fatal.
async function loadEnvToken(name, hint) {
  if (process.env[name]) return process.env[name];
  try {
    const env = await readFile(".env.local", "utf8");
    const line = env.split("\n").find((l) => l.startsWith(`${name}=`));
    if (line) return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
  } catch {}
  console.error(`Missing ${name}.\n${hint}`);
  process.exit(1);
}

const token = await loadEnvToken(
  "VERCEL_OIDC_TOKEN",
  "Get one with:  npm i -g vercel && vercel link && vercel env pull\n" +
    "(the token lasts ~12h), or export VERCEL_OIDC_TOKEN yourself. See DEVELOPING.md.",
);

// Transient failures (429/5xx, network errors) are retried with backoff,
// honoring Retry-After; 4xx are deterministic and never retried.
const apiGet = async (pathname) => {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(`${API_BASE}${pathname}`, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      if (attempt >= 5) throw new Error(`network error after ${attempt} tries: ${err.cause?.code ?? err.message} (${pathname})`);
      await sleep(1000 * attempt);
      continue;
    }
    if (res.status === 401) throw new Error("HTTP 401 — VERCEL_OIDC_TOKEN missing/expired; re-run `vercel env pull`");
    if ((res.status === 429 || res.status >= 500) && attempt < 8) {
      await res.text().catch(() => {});
      await sleep((Number(res.headers.get("retry-after")) || 1) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}`);
    return res.json();
  }
};

async function fetchLeaderboard(api) {
  const skills = [];
  const seen = new Set();
  let nonGithub = 0;
  let duplicates = 0;
  for (let page = 0; ; page++) {
    const { data, pagination } = await api(`/api/v1/skills?per_page=500&page=${page}`);
    // The leaderboard can drift while we paginate, serving the same id twice;
    // keep the first occurrence. Normalizing to the canonical id first also
    // collapses a raw and a canonical occurrence of the same skill into one.
    for (const skill of data ?? []) {
      if (skill.sourceType !== "github") {
        nonGithub++;
        continue;
      }
      if (skill.isDuplicate) {
        duplicates++;
        continue;
      }
      const id = canonicalId(skill);
      if (!seen.has(id)) {
        seen.add(id);
        skills.push({ id, installs: skill.installs });
      }
    }
    if (!pagination.hasMore || !data?.length) return { skills, nonGithub, duplicates };
  }
}

// The trending view's first 100 github-sourced skills, one request (deep
// enough to cover the top-100 cutoff after well-known entries are skipped).
// Ids are canonicalized and kept in upstream rank order.
const TRENDING_COUNT = 100;
async function fetchTrending(api) {
  const { data } = await api(`/api/v1/skills?view=trending&per_page=${TRENDING_COUNT * 2}`);
  const ids = [];
  const seen = new Set();
  for (const skill of data ?? []) {
    if (skill.sourceType !== "github") continue;
    const id = canonicalId(skill);
    if (!seen.has(id)) {
      seen.add(id);
      if (ids.length < TRENDING_COUNT) ids.push(id);
    }
  }
  return ids;
}

// The curated partners: one row per owner, kept verbatim except the
// per-skill entries, which are reduced to canonical ids (the wrapper's
// generatedAt / totalOwners / totalSkills are derivable from the rows). No
// source filtering: the list is curated upstream.
async function fetchCurated(api) {
  const raw = await api("/api/v1/skills/curated");
  return (raw.data ?? []).map((owner) => ({
    owner: owner.owner,
    totalInstalls: owner.totalInstalls,
    featuredRepo: owner.featuredRepo ?? null,
    featuredSkill: owner.featuredSkill ?? null,
    skills: (owner.skills ?? []).map(canonicalId),
  }));
}

await mkdir(OUT_DIR, { recursive: true });

console.error("[1/3] Fetching the leaderboard ...");
const { skills, nonGithub, duplicates } = await fetchLeaderboard(apiGet);

// The leaderboard's own order shifts as installs move, so sort the index:
// installs desc, ties by id — daily diffs stay one line per changed skill.
const byRank = (a, b) => b.installs - a.installs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const rows = [...skills].sort(byRank);
await atomicWrite(
  path.join(OUT_DIR, "skills.jsonl"),
  rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""),
);

console.error(`[2/3] Fetching the trending top ${TRENDING_COUNT} ...`);
const trending = await fetchTrending(apiGet);
await atomicWrite(path.join(OUT_DIR, "trending.json"), JSON.stringify(trending, null, 2) + "\n");

console.error("[3/3] Fetching the curated partners ...");
const curated = await fetchCurated(apiGet);
await atomicWrite(
  path.join(OUT_DIR, "curated.jsonl"),
  curated.map((row) => JSON.stringify(row)).join("\n") + (curated.length ? "\n" : ""),
);

// dist/README.md: the published snapshot's landing page for humans — what the
// files are, plus this run's stats. The machine contract is the three data
// files, gated by verify.mjs.
const finishedAt = new Date();
await atomicWrite(
  path.join(OUT_DIR, "README.md"),
  `# skills.sh data mirror

A daily snapshot of every GitHub-sourced skill on [skills.sh](https://www.skills.sh), rebuilt from the leaderboard on every run. Fetch any file straight from this branch, or pin a day via the \`dist-<date>\` tags. Docs: [skill-one/skills-sh-mirror](https://github.com/skill-one/skills-sh-mirror).

| File | Content |
|---|---|
| \`skills.jsonl\` | one \`{ id, installs }\` row per skill, sorted by installs desc |
| \`trending.json\` | the trending view's first 100 github-sourced ids, in rank order |
| \`curated.jsonl\` | the officially featured skills, one row per owner |

## Latest run

Generated ${finishedAt.toISOString()} in ${((finishedAt - startedAt) / 1000).toFixed(1)}s.

| Skills indexed | ${rows.length} |
|---|---|
| Duplicates skipped | ${duplicates} |
| Non-github skipped | ${nonGithub} |
| Trending ids | ${trending.length} |
| Curated owners / skills | ${curated.length} / ${curated.reduce((n, o) => n + o.skills.length, 0)} |
`,
);

console.error(`Done: ${rows.length} skills indexed (${duplicates} duplicates, ${nonGithub} non-github skipped) -> ${OUT_DIR}/`);
