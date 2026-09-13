#!/usr/bin/env node
/**
 * Verify the integrity of a scraped dataset — no network, no token.
 *
 * Checks skills.jsonl + content directories against the scraper's invariants:
 *   - every line parses; ids unique; rows sorted by installs desc (ties by id)
 *   - required fields well-formed (id, installs, url, fetchedAt, hash, audits,
 *     description)
 *   - repos.jsonl parses, is well-shaped (repo/stars/description/pushedAt
 *     rows, sorted by repo), and matches the index's repositories exactly
 *   - owners.jsonl + avatars/ are well-shaped and consistent with the index's
 *     owners (every referenced avatar file exists, no orphan files)
 *   - no two rows share a sanitized directory name
 *   - every content directory's SKILL.md carries a description that matches
 *     the index row
 *   - rows and content directories match exactly, in both directions: every
 *     row has a non-empty directory (its files mirror the upstream skill
 *     verbatim, including files like _meta.json that skills may ship) and
 *     every directory belongs to a row
 *   - stats.json parses and its indexedRows count matches the index
 *   - trending.json is a well-shaped id list; curated.jsonl holds well-shaped
 *     per-owner rows
 *   - no .tmp / skills.jsonl.tmp leftovers from interrupted runs
 *
 * Usage: node verify.mjs [--out data]
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { argValue, dirName, exists, repoOfId, skillDescription } from "./lib.mjs";

const args = process.argv.slice(2);
const OUT_DIR = argValue(args, "--out") ?? "data";
const isHash = (v) => typeof v === "string" && /^[0-9a-f]{64}$/i.test(v);
const isIso = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));

const problems = [];
const problem = (msg) => problems.push(msg);

function checkRow(row) {
  const id = row.id;
  const label = typeof id === "string" ? id : "(missing id)";
  // Github-sourced ids only: "owner/repo/slug" (already canonical — the slug
  // carries no "/").
  const segs = typeof id === "string" ? id.split("/").filter((s) => s.length) : [];
  if (segs.length !== 3) problem(`${label}: malformed id`);
  if (!Number.isFinite(row.installs) || row.installs < 0) problem(`${label}: bad installs`);
  if (row.url !== null && typeof row.url !== "string") problem(`${label}: bad url`);
  if (row.fetchedAt !== null && !isIso(row.fetchedAt)) problem(`${label}: bad fetchedAt`);
  if (row.hash !== null && !isHash(row.hash)) problem(`${label}: bad hash`);
  if (row.description !== null && typeof row.description !== "string") problem(`${label}: bad description`);
  if ("audits" in row && !Array.isArray(row.audits)) problem(`${label}: audits must be an array`);
  return label;
}

let dirCount = 0;
let rowCount = 0;
let trendingCount = null;
let curatedOwners = null;
let reposCount = null;
let ownersCount = null;
const text = await readFile(path.join(OUT_DIR, "skills.jsonl"), "utf8").catch(() => null);
if (text === null) {
  problem(`skills.jsonl not found under ${OUT_DIR}`);
} else {
  const rows = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      problem(`line ${i + 1}: invalid JSON`);
    }
  }
  rowCount = rows.length;
  if (!rows.length) problem("index has no rows");

  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.id)) problem(`duplicate id: ${row.id}`);
    seen.add(row.id);
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1].installs < rows[i].installs) problem(`rows not sorted by installs desc at ${rows[i].id}`);
    else if (rows[i - 1].installs === rows[i].installs && rows[i - 1].id > rows[i].id)
      problem(`equal-installs rows not sorted by id at ${rows[i].id}`);
  }

  // Rows and directories must match exactly, in both directions.
  const rowNames = new Map();
  for (const row of rows) {
    const label = checkRow(row);
    if (typeof row.id !== "string") continue;
    const name = dirName(row.id);
    if (rowNames.has(name)) problem(`${label}: directory name collides with another row (${rowNames.get(name)})`);
    rowNames.set(name, row.id);
    const dir = path.join(OUT_DIR, "skills", name);
    if (!(await exists(dir))) {
      problem(`${label}: index row has no content directory`);
      continue;
    }
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    if (!entries.some((e) => e.isFile())) problem(`${label}: content directory is empty`);
    const description = skillDescription(await readFile(path.join(dir, "SKILL.md"), "utf8").catch(() => null));
    if (description === null) problem(`${label}: SKILL.md missing or has no description`);
    if (row.description !== description) problem(`${label}: description does not match SKILL.md`);
    dirCount++;
  }
  // Every directory under skills/ must be a row's content directory (whose
  // whole subtree is skill files) or an ancestor of one (the leading id
  // segments group skills by owner / repo).
  const ancestors = new Set();
  for (const name of rowNames.keys()) {
    const segs = name.split("/");
    for (let i = 1; i < segs.length; i++) ancestors.add(segs.slice(0, i).join("/"));
  }
  const walk = async (rel, insideRow) => {
    for (const entry of await readdir(path.join(OUT_DIR, "skills", rel), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = rel ? `${rel}/${entry.name}` : entry.name;
      const isRow = rowNames.has(sub);
      await walk(sub, insideRow || isRow);
      if (!insideRow && !isRow && !ancestors.has(sub)) problem(`orphan content directory (no index row): ${sub}`);
    }
  };
  if (await exists(path.join(OUT_DIR, "skills"))) await walk("", false);

  if (await exists(path.join(OUT_DIR, ".tmp"))) problem(".tmp leftover from an interrupted run");
  if (await exists(path.join(OUT_DIR, "skills.jsonl.tmp"))) problem("skills.jsonl.tmp leftover from an interrupted run");

  const statsRaw = await readFile(path.join(OUT_DIR, "stats.json"), "utf8").catch(() => null);
  if (statsRaw === null) {
    problem("stats.json not found");
  } else {
    try {
      const stats = JSON.parse(statsRaw);
      if (stats.indexedRows !== rowCount) problem(`stats.json: indexedRows ${stats.indexedRows} != index row count ${rowCount}`);
    } catch {
      problem("stats.json: invalid JSON");
    }
  }
  if (await exists(path.join(OUT_DIR, "stats.json.tmp"))) problem("stats.json.tmp leftover from an interrupted run");

  // trending.json: the trending view's first 100 github-sourced ids in
  // upstream rank order (the join key back into the index).
  const trendingRaw = await readFile(path.join(OUT_DIR, "trending.json"), "utf8").catch(() => null);
  if (trendingRaw === null) {
    problem("trending.json not found");
  } else {
    try {
      const ids = JSON.parse(trendingRaw);
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id)) {
        problem("trending.json: not an array of ids");
      } else {
        const seenIds = new Set();
        for (const id of ids) {
          if (seenIds.has(id)) problem(`trending.json: duplicate id: ${id}`);
          seenIds.add(id);
        }
        trendingCount = ids.length;
      }
    } catch {
      problem("trending.json: invalid JSON");
    }
  }
  if (await exists(path.join(OUT_DIR, "trending.json.tmp"))) problem("trending.json.tmp leftover from an interrupted run");

  // curated.jsonl: officially featured skills grouped by owner, one row per
  // owner, per-skill entries reduced to ids. The rows are kept verbatim —
  // upstream legitimately repeats a skill under several owners, so ids are
  // not required to be unique across rows.
  const curatedRaw = await readFile(path.join(OUT_DIR, "curated.jsonl"), "utf8").catch(() => null);
  if (curatedRaw === null) {
    problem("curated.jsonl not found");
  } else {
    const rows = [];
    for (const [i, line] of curatedRaw.split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        problem(`curated.jsonl line ${i + 1}: invalid JSON`);
      }
    }
    const shaped = rows.every((r) =>
      r !== null && typeof r === "object" && !Array.isArray(r) &&
      typeof r.owner === "string" && r.owner &&
      Number.isFinite(r.totalInstalls) &&
      (r.featuredRepo === null || typeof r.featuredRepo === "string") &&
      (r.featuredSkill === null || typeof r.featuredSkill === "string") &&
      Array.isArray(r.skills) && r.skills.every((s) => typeof s === "string" && s),
    );
    if (!shaped) problem("curated.jsonl: rows must carry owner/totalInstalls/featuredRepo/featuredSkill/skills");
    else curatedOwners = rows.length;
  }
  if (await exists(path.join(OUT_DIR, "curated.jsonl.tmp"))) problem("curated.jsonl.tmp leftover from an interrupted run");

  // repos.jsonl: one row per repository behind the indexed skills, sorted by
  // repo asc. Must match the index's repositories exactly in both directions,
  // so a consumer can join by the repo key without misses.
  const reposRaw = await readFile(path.join(OUT_DIR, "repos.jsonl"), "utf8").catch(() => null);
  if (reposRaw === null) {
    problem("repos.jsonl not found");
  } else {
    const repos = [];
    for (const [i, line] of reposRaw.split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        repos.push(JSON.parse(line));
      } catch {
        problem(`repos.jsonl line ${i + 1}: invalid JSON`);
      }
    }
    const shaped = repos.every((r) =>
      r !== null && typeof r === "object" && !Array.isArray(r) &&
      /^[^/]+\/[^/]+$/.test(r.repo) &&
      (r.stars === null || (Number.isFinite(r.stars) && r.stars >= 0)) &&
      (r.description === null || typeof r.description === "string") &&
      (r.pushedAt === null || isIso(r.pushedAt)),
    );
    if (!shaped) {
      problem("repos.jsonl: rows must carry repo/stars/description/pushedAt");
    } else {
      reposCount = repos.length;
      const seen = new Set();
      for (const r of repos) {
        if (seen.has(r.repo)) problem(`repos.jsonl: duplicate repo: ${r.repo}`);
        seen.add(r.repo);
      }
      for (let i = 1; i < repos.length; i++) {
        if (repos[i - 1].repo >= repos[i].repo) problem(`repos.jsonl: rows not sorted by repo at ${repos[i].repo}`);
      }
      const rowRepos = new Set(rows.map((r) => repoOfId(r.id)).filter(Boolean));
      for (const repo of rowRepos) if (!seen.has(repo)) problem(`repos.jsonl: no row for ${repo}`);
      for (const repo of seen) if (!rowRepos.has(repo)) problem(`repos.jsonl: orphan row (no index row): ${repo}`);
    }
  }
  if (await exists(path.join(OUT_DIR, "repos.jsonl.tmp"))) problem("repos.jsonl.tmp leftover from an interrupted run");

  // owners.jsonl: one row per repository owner behind the indexed skills —
  // the avatar pulled into avatars/ so consumers need no GitHub API for it.
  // Owners must match the index's owners exactly in both directions; every
  // referenced avatar file must exist and every avatar file must be
  // referenced.
  const ownersRaw = await readFile(path.join(OUT_DIR, "owners.jsonl"), "utf8").catch(() => null);
  if (ownersRaw === null) {
    problem("owners.jsonl not found");
  } else {
    const owners = [];
    for (const [i, line] of ownersRaw.split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        owners.push(JSON.parse(line));
      } catch {
        problem(`owners.jsonl line ${i + 1}: invalid JSON`);
      }
    }
    const shaped = owners.every((r) =>
      r !== null && typeof r === "object" && !Array.isArray(r) &&
      /^[^/]+$/.test(r.owner) &&
      (r.avatarUrl === null || typeof r.avatarUrl === "string") &&
      (r.avatar === null || (typeof r.avatar === "string" && r.avatar.startsWith("avatars/"))) &&
      (r.avatar === null || r.avatarUrl !== null),
    );
    if (!shaped) {
      problem("owners.jsonl: rows must carry owner/avatarUrl/avatar");
    } else {
      ownersCount = owners.length;
      const seen = new Set();
      for (const r of owners) {
        if (seen.has(r.owner)) problem(`owners.jsonl: duplicate owner: ${r.owner}`);
        seen.add(r.owner);
      }
      for (let i = 1; i < owners.length; i++) {
        if (owners[i - 1].owner >= owners[i].owner) problem(`owners.jsonl: rows not sorted by owner at ${owners[i].owner}`);
      }
      const rowOwners = new Set(rows.map((r) => repoOfId(r.id)?.split("/")[0]).filter(Boolean));
      for (const owner of rowOwners) if (!seen.has(owner)) problem(`owners.jsonl: no row for ${owner}`);
      for (const owner of seen) if (!rowOwners.has(owner)) problem(`owners.jsonl: orphan row (no index row): ${owner}`);
      for (const r of owners) {
        if (r.avatar && !(await exists(path.join(OUT_DIR, r.avatar)))) problem(`owners.jsonl: avatar file missing: ${r.avatar} (${r.owner})`);
      }
      const referenced = new Set(owners.map((r) => r.avatar).filter(Boolean));
      for (const entry of (await readdir(path.join(OUT_DIR, "avatars")).catch(() => []))) {
        if (!referenced.has(`avatars/${entry}`)) problem(`orphan avatar file (no owners.jsonl row): avatars/${entry}`);
      }
    }
  }
  if (await exists(path.join(OUT_DIR, "owners.jsonl.tmp"))) problem("owners.jsonl.tmp leftover from an interrupted run");
}

if (problems.length) {
  for (const msg of problems.slice(0, 20)) console.error(`FAIL ${msg}`);
  if (problems.length > 20) console.error(`... and ${problems.length - 20} more`);
  console.error(`verify: ${problems.length} problem(s) in ${OUT_DIR}`);
  process.exit(1);
}
console.log(
  `OK: ${rowCount} rows, ${dirCount} content directories, ${reposCount ?? "no"} repos, ${ownersCount ?? "no"} owners, ${trendingCount ?? "no"} trending, ${curatedOwners ?? "no"} curated owners, 0 problems (${OUT_DIR})`,
);
