#!/usr/bin/env node
/**
 * Verify the integrity of a scraped dataset — no network, no token.
 *
 *   - skills.jsonl: every line an object carrying exactly id and installs
 *     (id a canonical github "owner/repo/slug", installs a non-negative
 *     number), ids unique, sorted by installs desc (ties by id)
 *   - trending.json: an array of unique ids
 *   - curated.jsonl: one owner/totalInstalls/featuredRepo/featuredSkill/
 *     skills row per owner
 *   - README.md exists (the dist landing page, written for humans)
 *   - no *.tmp leftovers from interrupted runs
 *
 * Usage: node verify.mjs [--out data]
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { argValue, exists } from "./lib.mjs";

const OUT_DIR = argValue(process.argv.slice(2), "--out") ?? "data";

const problems = [];
const problem = (msg) => problems.push(msg);

// Reads `<OUT_DIR>/<file>` (newline-delimited JSON objects); a missing file
// or an unparseable line is reported and skipped.
const readJsonl = async (file) => {
  const text = await readFile(path.join(OUT_DIR, file), "utf8").catch(() => null);
  if (text === null) {
    problem(`${file} not found`);
    return null;
  }
  const rows = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row === null || typeof row !== "object" || Array.isArray(row)) problem(`${file} line ${i + 1}: not a JSON object`);
      else rows.push(row);
    } catch {
      problem(`${file} line ${i + 1}: invalid JSON`);
    }
  }
  return rows;
};

const readJson = async (file) => {
  const text = await readFile(path.join(OUT_DIR, file), "utf8").catch(() => null);
  if (text === null) problem(`${file} not found`);
  return text;
};

let rowCount = 0;
let trendingCount = null;
let curatedOwners = null;

const rows = await readJsonl("skills.jsonl");
if (rows !== null) {
  rowCount = rows.length;
  if (!rows.length) problem("skills.jsonl has no rows");

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
  for (const row of rows) {
    const id = typeof row.id === "string" && row.id ? row.id : "(missing id)";
    // The index row is exactly the leaderboard's essentials — nothing else.
    if (Object.keys(row).sort().join(",") !== "id,installs") problem(`${id}: rows must carry exactly id and installs`);
    // Github-sourced ids only: "owner/repo/slug" (canonical — no "/" in the slug).
    if (typeof row.id !== "string" || row.id.split("/").filter(Boolean).length !== 3) problem(`${id}: malformed id`);
    if (!Number.isFinite(row.installs) || row.installs < 0) problem(`${id}: bad installs`);
  }

  // README.md is the dist landing page, written for humans — just require it.
  if (!(await exists(path.join(OUT_DIR, "README.md")))) problem("README.md not found");

  const trending = await readJson("trending.json");
  if (trending !== null) {
    try {
      const ids = JSON.parse(trending);
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id)) problem("trending.json: not an array of ids");
      else {
        const dup = ids.find((id, i) => ids.indexOf(id) !== i);
        if (dup !== undefined) problem(`trending.json: duplicate id: ${dup}`);
        else trendingCount = ids.length;
      }
    } catch {
      problem("trending.json: invalid JSON");
    }
  }

  // Upstream legitimately repeats a skill under several owners, so ids are
  // not required to be unique across curated rows.
  const curated = await readJsonl("curated.jsonl");
  if (curated !== null) {
    const shaped = curated.every((r) =>
      typeof r.owner === "string" && r.owner &&
      Number.isFinite(r.totalInstalls) &&
      (r.featuredRepo === null || typeof r.featuredRepo === "string") &&
      (r.featuredSkill === null || typeof r.featuredSkill === "string") &&
      Array.isArray(r.skills) && r.skills.every((s) => typeof s === "string" && s),
    );
    if (!shaped) problem("curated.jsonl: rows must carry owner/totalInstalls/featuredRepo/featuredSkill/skills");
    else curatedOwners = curated.length;
  }
}

for (const file of ["README.md", "skills.jsonl", "trending.json", "curated.jsonl"]) {
  if (await exists(path.join(OUT_DIR, `${file}.tmp`))) problem(`${file}.tmp leftover from an interrupted run`);
}

if (problems.length) {
  for (const msg of problems.slice(0, 20)) console.error(`FAIL ${msg}`);
  if (problems.length > 20) console.error(`... and ${problems.length - 20} more`);
  console.error(`verify: ${problems.length} problem(s) in ${OUT_DIR}`);
  process.exit(1);
}
console.log(`OK: ${rowCount} rows, ${trendingCount ?? "no"} trending, ${curatedOwners ?? "no"} curated owners, 0 problems (${OUT_DIR})`);
