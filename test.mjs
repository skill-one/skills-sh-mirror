// End-to-end test: runs scraper.mjs against a local mock of the skills.sh API
// and a local mock of the GitHub API. No real token, no network. Covers:
// pagination (with leaderboard drift), github-only filtering (well-known
// entries are dropped at the leaderboard, and stale well-known rows/dirs from
// an older dataset are removed), repo star counts (per unique repo — skills
// sharing a repo trigger a single request; 404 -> null; 500 retried into a
// value), skills.jsonl index shape (only saved skills — duplicates and
// no-snapshot skills are omitted; skills whose fetch failed keep their
// previous row and content), pure content directories, path sanitization,
// SKILL.md description extraction (plain / quoted / folded block scalars;
// absent -> null), full re-write every run with fetchedAt pinned to the
// content hash via the previous index, .env.local token loading, 429/5xx
// retry (Retry-After honored), --audits (kept while the hash is unchanged,
// re-fetched when it changes), --limit carrying over rows outside the limit
// so a limited run never orphans content, deterministic installs-desc/id-asc
// row order, per-run stats in stats.json (timing, counters for
// changed/added/removed rows, failed ids, nonGithub/githubRepos), upstream
// delisting (row and content directory removed) and re-listing, slug-with-
// slash ids normalized to skills.sh's canonical (slash-stripped) form, the
// trending top 100 and the curated owners written as id-only lists (every
// per-skill field the index drops is dropped here too), a missing
// GITHUB_TOKEN aborting the run, verifier rejection of tampered datasets, and
// the dist publisher (one commit per day via same-day amend, the --window-driven
// prune re-rooting that preserves the original commit dates, the dist-<date>
// tag window, the one-line `latest` pointer every snapshot carries naming its
// own tag, and a bad --window aborting before the snapshot is touched).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { canonicalId } from "./lib.mjs";

const SCRAPER = fileURLToPath(new URL("./scraper.mjs", import.meta.url));
const VERIFY = fileURLToPath(new URL("./verify.mjs", import.meta.url));

// Realistic content hashes (64-hex) so the verifier's format check passes.
const hashOf = (s) => createHash("sha256").update(s).digest("hex");

// find-skills content is revision-controlled so tests can simulate upstream edits.
const findSkillsFiles = (rev) => [
  { path: "SKILL.md", contents: `---
name: find-skills
description: Find skills on skills.sh.
---
# find-skills rev ${rev}
Find skills on skills.sh.
` },
  { path: "scripts/run.sh", contents: "#!/bin/sh\necho find-skills\n" },
  { path: "_meta.json", contents: "{}\n" }, // some skills ship their own _meta.json
];
let findSkillsRev = 0;

const FILES = {
  "owner/repo/wei rd~x": [{ path: "SKILL.md", contents: '---\ndescription: "weird but quoted"\n---\n# weird slug\n' }],
  "owner/repo/dup-skill": [{ path: "SKILL.md", contents: "# duplicate\n" }],
  "owner/repo/flaky-500": [{ path: "SKILL.md", contents: "---\ndescription: >-\n  fetched after a\n  transient 500\n---\n# flaky\n" }], // detail 500s once, then succeeds
  "owner/repo/rate-limited": null, // no upstream snapshot: hash null, files null
  "owner/repo/bad-id": [{ path: "SKILL.md", contents: "---\ndescription: bad-id fixed\n---\n# bad-id\n" }], // detail 400s while badIdBroken
  "owner/flaky-repo/star-skill": [{ path: "SKILL.md", contents: "---\ndescription: star retry\n---\n# star\n" }],
  "gone/repo/ghost": [{ path: "SKILL.md", contents: "# ghost\n" }], // SKILL.md without frontmatter: no description -> dropped
  "owner/repo/no-md": [{ path: "README.md", contents: "# no skill md\n" }], // files but no SKILL.md: no description -> dropped
  // canonical form: the raw leaderboard id is claude-office-skills/skills/facebook/meta-ads
  "claude-office-skills/skills/facebookmeta-ads": [{ path: "SKILL.md", contents: "---\nname: Facebook Meta Ads\ndescription: slash slug normalized\n---\n# fb\n" }],
};

// "bad-id" rejects the detail request outright until repaired — used to test
// that a failed fetch carries over the previous snapshot on the next run.
let badIdBroken = true;

// Ids hidden from the leaderboard — simulates upstream delisting / re-listing.
// The two skills below start hidden so they only join in runs 12 and 13.
const gone = new Set(["claude-office-skills/skills/facebook/meta-ads", "affaan-m/ecc/security-review"]);

const filesFor = (id) => (id === "vercel-labs/skills/find-skills" ? findSkillsFiles(findSkillsRev) : FILES[id]);

const AUDITS = {
  "vercel-labs/skills/find-skills": [
    { provider: "Socket", slug: "socket", status: "pass", summary: "No alerts", auditedAt: "2026-09-01T00:00:00.000Z", riskLevel: "LOW" },
  ],
};

const SKILLS = [
  { id: "vercel-labs/skills/find-skills", slug: "find-skills", name: "find-skills", source: "vercel-labs/skills", installs: 12345, sourceType: "github", installUrl: "npx skills add vercel-labs/skills/find-skills", url: "https://skills.sh/vercel-labs/skills/find-skills" },
  // well-known entries are dropped at the leaderboard: no repo, no stars
  { id: "mintlify.com/mintlify", slug: "mintlify", name: "mintlify", source: "mintlify.com", installs: 99, sourceType: "well-known", installUrl: "npx skills add mintlify.com/mintlify", url: "https://skills.sh/mintlify.com/mintlify" },
  // installs ties with mintlify (both 99): exercises the id tiebreak — the
  // expected order below is the id-ascending one.
  { id: "owner/repo/wei rd~x", slug: "wei rd~x", name: "weird", source: "owner/repo", installs: 99, sourceType: "github", installUrl: "npx skills add owner/repo/wei rd~x", url: "https://skills.sh/owner/repo/wei rd~x" },
  { id: "owner/repo/flaky-500", slug: "flaky-500", name: "flaky", source: "owner/repo", installs: 50, sourceType: "github", installUrl: "npx skills add owner/repo/flaky-500", url: "https://skills.sh/owner/repo/flaky-500" },
  { id: "owner/repo/dup-skill", slug: "dup-skill", name: "dup", source: "owner/repo", installs: 2, sourceType: "github", installUrl: "npx skills add owner/repo/dup-skill", url: "https://skills.sh/owner/repo/dup-skill", isDuplicate: true },
  { id: "owner/repo/rate-limited", slug: "rate-limited", name: "rl", source: "owner/repo", installs: 1, sourceType: "github", installUrl: "npx skills add owner/repo/rate-limited", url: "https://skills.sh/owner/repo/rate-limited" },
  { id: "owner/repo/bad-id", slug: "bad-id", name: "bad", source: "owner/repo", installs: 0, sourceType: "github", installUrl: "npx skills add owner/repo/bad-id", url: "https://skills.sh/owner/repo/bad-id" },
  // a second repo for its own star fetch (flaky on the GitHub side)
  { id: "owner/flaky-repo/star-skill", slug: "star-skill", name: "star-skill", source: "owner/flaky-repo", installs: 4, sourceType: "github", installUrl: "npx skills add owner/flaky-repo/star-skill", url: "https://skills.sh/owner/flaky-repo/star-skill" },
  // a github skill whose SKILL.md has no frontmatter: no description -> dropped
  // (its dead repo still gets a star request, pinned to the null that lands nowhere)
  { id: "gone/repo/ghost", slug: "ghost", name: "ghost", source: "gone/repo", installs: 3, sourceType: "github", installUrl: "npx skills add gone/repo/ghost", url: "https://skills.sh/gone/repo/ghost" },
  // raw leaderboard id carries a slash inside the slug (4 segments); skills.sh
  // keys this skill by the slug with the "/" stripped
  { id: "claude-office-skills/skills/facebook/meta-ads", slug: "facebook/meta-ads", name: "facebook", source: "claude-office-skills/skills", installs: 7, sourceType: "github", installUrl: "npx skills add claude-office-skills/skills/facebook/meta-ads", url: "https://skills.sh/claude-office-skills/skills/facebookmeta-ads" },
  // well-known with a MULTI-SEGMENT source: filtered out like every
  // well-known entry, even though its id would survive normalization
  { id: "affaan-m/ecc/security-review", slug: "security-review", name: "security-review", source: "affaan-m/ecc", installs: 5, sourceType: "well-known", installUrl: null, url: "https://skills.sh/site/affaan-m.ecc/security-review" },
  // a github skill with files but no describable SKILL.md: dropped
  { id: "owner/repo/no-md", slug: "no-md", name: "no-md", source: "owner/repo", installs: 6, sourceType: "github", installUrl: "npx skills add owner/repo/no-md", url: "https://skills.sh/owner/repo/no-md" },
];

// Trending view (view=trending): a ranking of its own. trending.json keeps
// the first 100 github-sourced ids in upstream rank order: well-known entries
// are skipped (like the leaderboard), the raw slash-slug id is normalized to
// skills.sh's canonical form, and every per-skill field but the id is dropped
// (the index deliberately drops them too).
const TRENDING = [
  SKILLS[0],
  { id: "claude-office-skills/skills/facebook/meta-ads", slug: "facebook/meta-ads", name: "facebook", source: "claude-office-skills/skills", installs: 7, sourceType: "github", installUrl: null, url: "https://skills.sh/claude-office-skills/skillsfacebook-meta-ads" },
  SKILLS[1], // well-known: skipped by the trending fetch
];

// Curated view: officially featured skills grouped by owner, kept verbatim
// except that per-skill entries are reduced to canonical ids (no source
// filtering). Covers the owner aggregates, the top-level counts/timestamp,
// and a well-known entry inside a group.
const CURATED = {
  generatedAt: "2026-05-28T04:12:23.313Z",
  totalOwners: 2,
  totalSkills: 3,
  data: [
    {
      owner: "vercel-labs",
      totalInstalls: 12345,
      featuredRepo: "vercel-labs/skills",
      featuredSkill: "find-skills",
      skills: [SKILLS[0], SKILLS[1]],
    },
    {
      owner: "claude-office-skills",
      totalInstalls: 7,
      featuredRepo: "claude-office-skills/skills",
      featuredSkill: "facebook/meta-ads",
      skills: [
        { id: "claude-office-skills/skills/facebook/meta-ads", slug: "facebook/meta-ads", name: "facebook", source: "claude-office-skills/skills", installs: 7, sourceType: "github", installUrl: null, url: "https://skills.sh/claude-office-skills/skillsfacebook-meta-ads" },
      ],
    },
  ],
};
// The trending fetch must request the top-200 cutoff in a single request.
const TRENDING_PER_PAGE = "200";

// What the scraper writes: CURATED with each per-skill entry reduced to its
// canonical id.
const CURATED_REDUCED = { ...CURATED, data: CURATED.data.map((o) => ({ ...o, skills: o.skills.map(canonicalId) })) };

// Mock GitHub API: repo -> stargazers_count (null = repo gone, 404).
const STARS = {
  "/repos/vercel-labs/skills": 1000,
  "/repos/owner/repo": 42,
  "/repos/owner/flaky-repo": 5, // 500s once, then succeeds
  "/repos/gone/repo": null,
  "/repos/claude-office-skills/skills": 7,
};
const GH_TOKEN = "gh-mock-token";
const ghHits = {};
const ghServer = createServer((req, res) => {
  const repoPath = req.url.split("?")[0];
  ghHits[repoPath] = (ghHits[repoPath] ?? 0) + 1;
  if (req.headers.authorization !== `Bearer ${GH_TOKEN}`) {
    res.statusCode = 401;
    res.end(JSON.stringify({ message: "Bad credentials" }));
    return;
  }
  if (repoPath === "/repos/owner/flaky-repo" && ghHits[repoPath] === 1) {
    res.statusCode = 500; // transient GitHub failure: the retry succeeds
    res.end(JSON.stringify({ message: "boom" }));
    return;
  }
  if (STARS[repoPath] === undefined || STARS[repoPath] === null) {
    res.statusCode = 404; // unknown or deleted repo -> stars null
    res.end(JSON.stringify({ message: "Not Found" }));
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ full_name: repoPath.slice("/repos/".length), stargazers_count: STARS[repoPath] }));
});

test("scraper end-to-end against mock API", async () => {
  const hits = { list: 0, detail: 0, audit: 0, trending: 0, curated: 0, rateLimited: 0, flaky500: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://mock");
    if (url.pathname === "/api/v1/skills" && url.searchParams.get("view") === "trending") {
      hits.trending++;
      if (url.searchParams.get("per_page") !== TRENDING_PER_PAGE) {
        res.statusCode = 400; // the fetch must request the top-200 cutoff in one page
        res.end(JSON.stringify({ error: "bad_request" }));
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: TRENDING, pagination: { page: 0, perPage: 200, total: 9959, hasMore: true } }));
      return;
    }
    if (url.pathname === "/api/v1/skills/curated") {
      hits.curated++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(CURATED));
      return;
    }
    if (url.pathname === "/api/v1/skills") {
      hits.list++;
      const page = Number(url.searchParams.get("page") ?? 0);
      const listed = SKILLS.filter((s) => !gone.has(s.id));
      const data = listed.slice(page * 3, page * 3 + 3);
      if (page === 1) data.push(SKILLS[0]); // leaderboard drift: same id served on two pages
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data, pagination: { page, perPage: 500, total: listed.length, hasMore: (page + 1) * 3 < listed.length } }));
      return;
    }
    if (url.pathname.startsWith("/api/v1/skills/audit/")) {
      hits.audit++;
      const id = decodeURIComponent(url.pathname.slice("/api/v1/skills/audit/".length));
      if (!AUDITS[id]) {
        res.statusCode = 404; // nobody audited this skill yet
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      res.end(JSON.stringify({ id, source: "vercel-labs/skills", slug: "find-skills", audits: AUDITS[id] }));
      return;
    }
    const id = decodeURIComponent(url.pathname.slice("/api/v1/skills/".length));
    // The detail API only addresses skills.sh's canonical ids (slug slashes
    // stripped): a request for the raw form is not found.
    const skill = SKILLS.find((s) => canonicalId(s) === id);
    if (!skill) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    hits.detail++;
    if (id === "owner/repo/bad-id" && badIdBroken) {
      res.statusCode = 400; // permanently broken upstream id (while badIdBroken)
      res.end(JSON.stringify({ error: "bad_request" }));
      return;
    }
    if (id === "owner/repo/flaky-500" && hits.flaky500++ === 0) {
      res.statusCode = 500; // transient upstream failure: the retry succeeds
      res.end(JSON.stringify({ error: "internal" }));
      return;
    }
    if (id === "owner/repo/rate-limited" && hits.rateLimited++ === 0) {
      res.statusCode = 429;
      res.setHeader("retry-after", "0");
      res.end("rate limited");
      return;
    }
    const files = filesFor(id);
    res.setHeader("content-type", "application/json");
    // The hash covers the content: bumping findSkillsRev changes exactly one
    // skill's upstream hash, the others' hashes stay stable across runs.
    const hash = files ? (id === "vercel-labs/skills/find-skills" ? hashOf(`${id}:${findSkillsRev}`) : hashOf(id)) : null;
    res.end(JSON.stringify({ id: skill.id, source: skill.source, slug: skill.slug, installs: skill.installs, hash, files }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => ghServer.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ghBase = `http://127.0.0.1:${ghServer.address().port}`;

  const workDir = await mkdtemp(path.join(tmpdir(), "skills-scraper-test-"));
  const out1 = path.join(workDir, "data1");
  const out2 = path.join(workDir, "data2");
  // Token with quotes exercises the .env.local parsing (quote stripping).
  await writeFile(path.join(workDir, ".env.local"), `VERCEL_OIDC_TOKEN="mock-token"\nGITHUB_TOKEN=${GH_TOKEN}\n`);

  // Async spawn: the scraper fetches from the mock servers hosted in THIS
  // process, so a synchronous spawnSync would deadlock its event loop.
  const run = async (out, flags = []) => {
    const env = { ...process.env, SKILLS_API_BASE: base, GITHUB_API_BASE: ghBase };
    delete env.VERCEL_OIDC_TOKEN; // force the .env.local fallback
    delete env.GITHUB_TOKEN; // ditto
    const child = spawn(process.execPath, [SCRAPER, "--out", out, ...flags], { cwd: workDir, env });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise((resolve, reject) => {
      child.on("close", resolve);
      child.on("error", reject);
    });
    return { status: code, stderr };
  };

  const readRows = async (out) => (await readFile(path.join(out, "skills.jsonl"), "utf8")).split("\n").filter(Boolean).map(JSON.parse);
  const readStats = async (out) => JSON.parse(await readFile(path.join(out, "stats.json"), "utf8"));
  const pathExists = (p) => access(p).then(() => true, () => false);
  const dir = (out, ...p) => path.join(out, "skills", ...p);

  try {
    // --- run 1: default scrape saves everything saveable; the index holds
    // only the saved github-sourced skills (well-known entries are filtered
    // at the leaderboard; dup / no-snapshot / failed are left out)
    const r1 = await run(out1);
    assert.equal(r1.status, 0, `run 1 failed:\n${r1.stderr}`);
    assert.equal(hits.list, 4); // 10 listed entries, 3 per mock page
    assert.equal(hits.detail, 10); // 8 skills attempted (the duplicate is never fetched) + one 429 retry + one 500 retry
    assert.equal(hits.audit, 0); // flag off -> no audit requests
    assert.equal(hits.trending, 1); // a single trending request per run (per_page=200 is enforced by the mock)
    assert.equal(hits.curated, 1); // a single curated request per run
    assert.match(r1.stderr, /stars: 4\/4/); // vercel-labs/skills, owner/repo, owner/flaky-repo, gone/repo

    // trending.json: the trending view's first 100 github-sourced ids, in
    // upstream rank order, slash slugs canonicalized, well-known skipped —
    // every per-skill field but the id is dropped (the index drops it too)
    assert.deepEqual(JSON.parse(await readFile(path.join(out1, "trending.json"), "utf8")), [
      "vercel-labs/skills/find-skills",
      "claude-office-skills/skills/facebookmeta-ads",
    ]);
    assert.equal(await pathExists(path.join(out1, "trending.json.tmp")), false);

    // curated.json: the curated payload verbatim except the per-skill
    // entries, which are reduced to canonical ids (well-known entries kept —
    // the list is curated upstream)
    assert.deepEqual(JSON.parse(await readFile(path.join(out1, "curated.json"), "utf8")), {
      generatedAt: "2026-05-28T04:12:23.313Z",
      totalOwners: 2,
      totalSkills: 3,
      data: [
        {
          owner: "vercel-labs",
          totalInstalls: 12345,
          featuredRepo: "vercel-labs/skills",
          featuredSkill: "find-skills",
          skills: ["vercel-labs/skills/find-skills", "mintlify.com/mintlify"],
        },
        {
          owner: "claude-office-skills",
          totalInstalls: 7,
          featuredRepo: "claude-office-skills/skills",
          featuredSkill: "facebook/meta-ads",
          skills: ["claude-office-skills/skills/facebookmeta-ads"],
        },
      ],
    });
    assert.equal(await pathExists(path.join(out1, "curated.json.tmp")), false);

    const rows1 = await readRows(out1);
    assert.deepEqual(
      rows1.map((r) => r.id),
      ["vercel-labs/skills/find-skills", "owner/repo/wei rd~x", "owner/repo/flaky-500", "owner/flaky-repo/star-skill"], // installs desc; well-known, dup, no-snapshot, no-description and failed skills omitted
    );
    assert.equal(rows1[0].installs, 12345);
    assert.equal(rows1[0].hash, hashOf("vercel-labs/skills/find-skills:0"));
    assert.ok(rows1[0].fetchedAt);
    assert.equal("audits" in rows1[0], false);
    // redundant leaderboard fields are not carried into the index
    for (const field of ["contentSaved", "noSnapshot", "error", "slug", "name", "source", "sourceType", "installUrl"])
      assert.equal(field in rows1[0], false);

    // stars come from the unique-repo fetches
    assert.equal(rows1[0].stars, 1000);
    assert.equal(rows1[1].stars, 42);
    assert.equal(rows1[2].stars, 42); // same repo as rows1[1]
    assert.equal(rows1[3].stars, 5); // fetched after a transient 500
    // one request per unique repo, even though five skills map to owner/repo
    assert.equal(ghHits["/repos/owner/repo"], 1);
    assert.equal(ghHits["/repos/vercel-labs/skills"], 1);
    assert.equal(ghHits["/repos/owner/flaky-repo"], 2); // 500 + successful retry
    assert.equal(ghHits["/repos/gone/repo"], 1);

    // description comes from the SKILL.md frontmatter (plain / quoted / folded)
    assert.equal(rows1[0].description, "Find skills on skills.sh."); // plain scalar
    assert.equal(rows1[1].description, "weird but quoted"); // quoted scalar
    assert.equal(rows1[2].description, "fetched after a transient 500"); // folded block scalar
    assert.equal(rows1[3].description, "star retry"); // plain scalar

    assert.equal(
      await readFile(dir(out1, "vercel-labs/skills/find-skills", "SKILL.md"), "utf8"),
      findSkillsFiles(0)[0].contents,
    );
    assert.equal(
      await readFile(dir(out1, "vercel-labs/skills/find-skills", "scripts", "run.sh"), "utf8"),
      findSkillsFiles(0)[1].contents,
    );
    // content dirs contain ONLY skill files (upstream-shipped _meta.json is legit)
    assert.deepEqual((await readdir(dir(out1, "vercel-labs/skills/find-skills"))).sort(), ["SKILL.md", "_meta.json", "scripts"]);
    // unsafe slug characters are sanitized in directory names
    assert.equal(await readFile(dir(out1, "owner/repo/wei_rd_x", "SKILL.md"), "utf8"), FILES["owner/repo/wei rd~x"][0].contents);
    // the transient 500 was retried into a save
    assert.equal(await readFile(dir(out1, "owner/repo/flaky-500", "SKILL.md"), "utf8"), FILES["owner/repo/flaky-500"][0].contents);
    assert.equal(await readFile(dir(out1, "owner/flaky-repo/star-skill", "SKILL.md"), "utf8"), FILES["owner/flaky-repo/star-skill"][0].contents);
    // well-known skills never materialize on disk
    assert.equal(await pathExists(dir(out1, "mintlify.com/mintlify")), false);
    // duplicate / no-snapshot / no-description / failed skills leave nothing on disk
    assert.equal(await pathExists(dir(out1, "owner/repo/dup-skill")), false);
    assert.equal(await pathExists(dir(out1, "owner/repo/rate-limited")), false);
    assert.equal(await pathExists(dir(out1, "gone/repo/ghost")), false); // SKILL.md without frontmatter
    assert.equal(await pathExists(dir(out1, "owner/repo/no-md")), false); // no SKILL.md at all
    assert.equal(await pathExists(dir(out1, "owner/repo/bad-id")), false);
    assert.match(r1.stderr, /changed=4, added=4, removed=0, dropped=4, failed=1/); // run still exits 0
    // no temp leftovers
    assert.equal(await pathExists(path.join(out1, ".tmp")), false);

    // stats.json describes this run: timing, entry counts, failed ids
    const stats1 = await readStats(out1);
    assert.equal(stats1.limit, null); // no --limit: full scrape
    assert.equal(stats1.audits, false);
    assert.ok(!Number.isNaN(Date.parse(stats1.startedAt)));
    assert.ok(!Number.isNaN(Date.parse(stats1.finishedAt)));
    assert.ok(stats1.finishedAt >= stats1.startedAt);
    assert.ok(Number.isInteger(stats1.durationMs) && stats1.durationMs >= 0);
    assert.equal(stats1.leaderboardTotal, 9); // github-sourced leaderboard entries (drift dupe excluded)
    assert.equal(stats1.nonGithub, 1); // mintlify.com/mintlify
    assert.equal(stats1.githubRepos, 4); // unique repos among the targets
    assert.equal(stats1.indexedRows, 4);
    assert.equal(stats1.changed, 4); // every first save re-stamps fetchedAt
    assert.equal(stats1.added, 4); // all four rows are new to the index
    assert.equal(stats1.removed, 0);
    assert.deepEqual(
      { dropped: stats1.dropped, failed: stats1.failed, carriedOver: stats1.carriedOver },
      { dropped: 4, failed: 1, carriedOver: 0 },
    );
    assert.deepEqual(stats1.failedIds, ["owner/repo/bad-id"]);

    // --- run 2: everything is re-fetched and re-written, but while the
    // upstream hash is unchanged each row keeps the fetchedAt of the run
    // that first fetched that content version
    const r2 = await run(out1);
    assert.equal(r2.status, 0, `run 2 failed:\n${r2.stderr}`);
    assert.equal(hits.detail, 18); // +8: the four saves + the two no-description skills + no-snapshot + failed (no retries left)
    assert.equal(hits.audit, 0);
    assert.match(r2.stderr, /changed=0, added=0, removed=0, dropped=4, failed=1/);
    const rows2 = await readRows(out1);
    assert.equal(rows2.length, 4);
    assert.equal((await readStats(out1)).changed, 0); // nothing changed: all hashes stable
    assert.deepEqual(rows2.map((r) => r.fetchedAt), rows1.map((r) => r.fetchedAt)); // carried over
    assert.deepEqual(rows2.map((r) => r.hash), rows1.map((r) => r.hash));
    assert.deepEqual(rows2.map((r) => r.stars), rows1.map((r) => r.stars));
    assert.equal(
      await readFile(dir(out1, "vercel-labs/skills/find-skills", "SKILL.md"), "utf8"),
      findSkillsFiles(0)[0].contents,
    );

    // --- run 3: upstream edits find-skills -> hash changes, its fetchedAt is
    // re-stamped while the untouched skills keep theirs
    findSkillsRev = 1;
    const r3 = await run(out1);
    assert.equal(r3.status, 0, `run 3 failed:\n${r3.stderr}`);
    assert.equal(hits.detail, 26); // +8
    assert.match(r3.stderr, /changed=1, added=0, removed=0, dropped=4, failed=1/);
    const rows3 = await readRows(out1);
    assert.equal((await readStats(out1)).changed, 1); // exactly the edited skill
    assert.equal(rows3[0].hash, hashOf("vercel-labs/skills/find-skills:1"));
    assert.notEqual(rows3[0].fetchedAt, rows1[0].fetchedAt); // re-stamped for the new content
    assert.deepEqual(rows3.slice(1).map((r) => r.fetchedAt), rows1.slice(1).map((r) => r.fetchedAt)); // unchanged hash -> unchanged fetchedAt
    assert.equal(
      await readFile(dir(out1, "vercel-labs/skills/find-skills", "SKILL.md"), "utf8"),
      findSkillsFiles(1)[0].contents, // new content on disk
    );

    // --- run 4: fresh dir with --audits; stale duplicate content is cleaned up
    await mkdir(dir(out2, "owner/repo/dup-skill"), { recursive: true }); // leftover from an older scrape
    const r4 = await run(out2, ["--audits"]);
    assert.equal(r4.status, 0, `run 4 failed:\n${r4.stderr}`);
    assert.equal(hits.detail, 34); // +8 new fetches (the duplicate is skipped, no 429/500 retry left)
    assert.equal(hits.audit, 4); // only the four saved skills reach the audit call
    assert.match(r4.stderr, /changed=4, added=4, removed=0, dropped=4, failed=1/);

    const rows4 = await readRows(out2);
    assert.equal(stats1.audits, false); // run 1's stats (out1) unaffected by run 4
    assert.equal((await readStats(out2)).audits, true); // --audits recorded
    assert.deepEqual(
      rows4.map((r) => r.id),
      ["vercel-labs/skills/find-skills", "owner/repo/wei rd~x", "owner/repo/flaky-500", "owner/flaky-repo/star-skill"],
    );
    assert.equal(await pathExists(dir(out2, "owner/repo/dup-skill")), false); // stale duplicate content removed
    assert.deepEqual(rows4[0].audits, AUDITS["vercel-labs/skills/find-skills"]);
    assert.deepEqual(rows4[1].audits, []); // audited by nobody -> empty array
    assert.equal(rows4[0].stars, 1000); // stars fetched again for the fresh dir

    // --- run 5: repairing bad-id lets it save (into out1, where it has
    // never had content)
    badIdBroken = false;
    const r5 = await run(out1);
    assert.equal(r5.status, 0, `run 5 failed:\n${r5.stderr}`);
    assert.match(r5.stderr, /changed=1, added=1, removed=0, dropped=4, failed=0/);
    const rows5 = await readRows(out1);
    assert.deepEqual(rows5.map((r) => r.id), [...rows1.map((r) => r.id), "owner/repo/bad-id"]);
    assert.equal(rows5[4].stars, 42); // owner/repo's stars
    const stats5 = await readStats(out1);
    assert.equal(stats5.changed, 1); // only the newly saved bad-id
    assert.equal(stats5.added, 1);
    assert.equal(await readFile(dir(out1, "owner/repo/bad-id", "SKILL.md"), "utf8"), FILES["owner/repo/bad-id"][0].contents);

    // --- run 6: bad-id breaks again. Its previous snapshot stays on disk, so
    // the previous index row must be carried over: index and directories keep
    // matching (an orphan directory would fail verify) and the mirror keeps
    // serving the last good content.
    badIdBroken = true;
    const r6 = await run(out1);
    assert.equal(r6.status, 0, `run 6 failed:\n${r6.stderr}`);
    assert.match(r6.stderr, /changed=0, added=0, removed=0, dropped=4, failed=1 \(carried over: 1\)/);
    const stats6 = await readStats(out1);
    assert.equal(stats6.carriedOver, 1); // machine-readable stats replaced the old stderr metrics line
    assert.equal(stats6.changed, 0); // the carried-over row keeps its old fetchedAt
    assert.equal(stats6.indexedRows, 5);
    assert.deepEqual(stats6.failedIds, ["owner/repo/bad-id"]);
    const rows6 = await readRows(out1);
    assert.deepEqual(rows6[4], rows5[4]); // carried over verbatim: same hash, fetchedAt, stars, fields
    assert.equal(await readFile(dir(out1, "owner/repo/bad-id", "SKILL.md"), "utf8"), FILES["owner/repo/bad-id"][0].contents);

    // --- run 7: --limit 1 on an existing dataset. The limit constrains only
    // what is fetched, never the index: skills outside the limit keep their
    // previous rows (their content is still on disk), so the index does not
    // shrink to one row and orphan the rest.
    const r7l = await run(out1, ["--limit", "1"]);
    assert.equal(r7l.status, 0, `run 7 failed:\n${r7l.stderr}`);
    assert.match(r7l.stderr, /changed=0, added=0, removed=0, dropped=0, failed=0 \(carried over: 4\)/);
    assert.deepEqual((await readRows(out1)).map((r) => r.id), rows6.map((r) => r.id));
    const stats7l = await readStats(out1);
    assert.equal(stats7l.limit, 1);
    assert.equal(stats7l.carriedOver, 4);
    assert.equal(stats7l.changed, 0); // the one fetched skill's hash is unchanged
    assert.equal(stats7l.indexedRows, 5);

    // --- run 8 (--audits, out2): unchanged content reuses the previous audit
    // results without any audit request
    const auditHitsAfterRun4 = hits.audit;
    const r8 = await run(out2, ["--audits"]);
    assert.equal(r8.status, 0, `run 8 failed:\n${r8.stderr}`);
    assert.equal(hits.audit, auditHitsAfterRun4); // no re-fetch while hashes are unchanged
    const rows8 = await readRows(out2);
    assert.deepEqual(rows8[0].audits, AUDITS["vercel-labs/skills/find-skills"]); // kept
    assert.deepEqual(rows8[1].audits, []);

    // --- run 9 (--audits, out2): an upstream edit changes the hash, so that
    // skill's audits are re-fetched; the untouched skills keep theirs
    findSkillsRev = 2;
    const r9 = await run(out2, ["--audits"]);
    assert.equal(r9.status, 0, `run 9 failed:\n${r9.stderr}`);
    assert.equal(hits.audit, auditHitsAfterRun4 + 1); // exactly the edited skill re-audited
    const rows9 = await readRows(out2);
    assert.equal(rows9[0].hash, hashOf("vercel-labs/skills/find-skills:2"));
    assert.deepEqual(rows9[0].audits, AUDITS["vercel-labs/skills/find-skills"]);

    // --- artifact verifier accepts both datasets (default + audits modes)
    const verify = async (out) => {
      const child = spawn(process.execPath, [VERIFY, "--out", out], { cwd: workDir, env: process.env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      const code = await new Promise((resolve, reject) => {
        child.on("close", resolve);
        child.on("error", reject);
      });
      return { status: code, stdout, stderr };
    };
    const v1 = await verify(out1);
    assert.equal(v1.status, 0, `verify out1 failed:\n${v1.stdout}${v1.stderr}`);
    assert.match(v1.stdout, /OK: 5 rows, 5 content directories/); // bad-id carried over from run 6
    const v2 = await verify(out2);
    assert.equal(v2.status, 0, `verify out2 failed:\n${v2.stdout}${v2.stderr}`);
    assert.match(v2.stdout, /OK: 4 rows, 4 content directories/);

    // --- verifier rejects tampered datasets (problems are reported on stderr).
    // Every case is self-contained: it mutates the known-good dataset left by
    // run 7 (5 index rows, including the carried-over bad-id), expects verify
    // to fail with a specific problem — or, for the pattern-less entries, to
    // pass — and then restores the base state. No case may rely on another's
    // leftovers.
    const GOOD_TRENDING = ["vercel-labs/skills/find-skills", "claude-office-skills/skills/facebookmeta-ads"];
    const GOOD_STATS = JSON.parse(await readFile(path.join(out1, "stats.json"), "utf8"));
    const baseRows = await readRows(out1); // == rows6: 5 rows including bad-id
    const writeIndex = async (rows) =>
      writeFile(path.join(out1, "skills.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const writeJson = (file, value) =>
      writeFile(path.join(out1, file), typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");

    // Index-row cases: mutate a shallow copy of the base rows, then restore.
    const indexCase = (name, pattern, mutate, notPattern) => ({
      name,
      pattern,
      notPattern,
      setup: async () => writeIndex(mutate(baseRows.map((r) => ({ ...r })))),
      cleanup: () => writeIndex(baseRows),
    });
    // JSON-artifact cases: overwrite one artifact wholesale, then restore.
    const jsonCase = (file, name, pattern, bad, good) => ({
      name,
      pattern,
      setup: () => writeJson(file, bad),
      cleanup: () => writeJson(file, good),
    });

    const tamperCases = [
      {
        name: "content directory without an index row",
        pattern: /orphan content directory/,
        setup: async () => mkdir(dir(out1, "owner/repo/orphan"), { recursive: true }),
        cleanup: async () => rm(dir(out1, "owner/repo/orphan"), { recursive: true, force: true }),
      },
      {
        name: "index claims content that is gone from disk",
        pattern: /no content directory/,
        setup: async () => rm(dir(out1, "vercel-labs/skills/find-skills"), { recursive: true, force: true }),
        cleanup: async () => {
          await mkdir(dir(out1, "vercel-labs/skills/find-skills"), { recursive: true });
          await writeFile(dir(out1, "vercel-labs/skills/find-skills", "SKILL.md"), findSkillsFiles(findSkillsRev)[0].contents);
        },
      },
      {
        name: "leftover temp file from an interrupted run",
        pattern: /skills\.jsonl\.tmp/,
        setup: () => writeFile(path.join(out1, "skills.jsonl.tmp"), "{"),
        cleanup: () => rm(path.join(out1, "skills.jsonl.tmp")),
      },
      indexCase("index order broken", /not sorted/, (rows) => rows.reverse()),
      // find-skills (12345 installs) is dropped to tie wei rd~x's 99 while
      // staying ahead of it in id order: the id tiebreak must catch it.
      indexCase("equal-installs rows out of id order", /not sorted by id/, (rows) => {
        rows[0].installs = 99;
        return rows;
      }),
      indexCase("two ids sanitizing to the same directory name", /collides/, (rows) => {
        rows[1].id = "owner/repo/a b"; // both sanitize to owner/repo/a_b
        rows.splice(2, 0, { ...rows[1], id: "owner/repo/a_b" });
        return rows;
      }),
      indexCase("description disagrees with the on-disk SKILL.md", /description does not match/, (rows) => {
        rows[0].description = "bogus";
        return rows;
      }),
      indexCase("stars is not a non-negative number", /bad stars/, (rows) => {
        rows[0].stars = "many";
        return rows;
      }),
      // JSON.stringify drops undefined fields, so the row reaches the verifier
      // without the stars key at all — reported as exactly "missing stars",
      // not additionally as "bad stars".
      indexCase(
        "the stars field is missing entirely",
        /missing stars/,
        (rows) => {
          rows[0].stars = undefined;
          return rows;
        },
        /bad stars/,
      ),
      indexCase("well-known (two-segment) ids are rejected", /malformed id/, (rows) => {
        rows[1].id = "mintlify.com/mintlify";
        return rows;
      }),
      jsonCase("stats.json", "stats.json is unparseable", /stats\.json: invalid JSON/, "{", GOOD_STATS),
      jsonCase("stats.json", "stats.json's indexedRows disagrees with the index", /indexedRows 99 != index row count 5/, { ...GOOD_STATS, indexedRows: 99 }, GOOD_STATS),
      jsonCase("trending.json", "trending.json is unparseable", /trending\.json: invalid JSON/, "{", GOOD_TRENDING),
      jsonCase("trending.json", "trending.json holds something else than an array of ids", /trending\.json: not an array of ids/, { top: 1 }, GOOD_TRENDING),
      jsonCase("trending.json", "trending.json repeats an id", /trending\.json: duplicate id: a\/b\/c/, ["a/b/c", "a/b/c"], GOOD_TRENDING),
      jsonCase("curated.json", "curated.json is unparseable", /curated\.json: invalid JSON/, "{", CURATED_REDUCED),
      jsonCase("curated.json", "curated.json's data is not an array of owners with skill ids", /curated\.json: data is not an array of owners with skill ids/, { data: [{ owner: "x" }] }, CURATED_REDUCED),
      // Upstream genuinely features the same skill under several owners, so
      // repeated ids across curated groups are accepted.
      jsonCase("curated.json", "curated.json may repeat an id across owners", null, { data: [{ owner: "x", skills: ["a/b/c"] }, { owner: "y", skills: ["a/b/c"] }] }, CURATED_REDUCED),
    ];
    for (const { name, pattern, notPattern, setup, cleanup } of tamperCases) {
      await setup();
      const t = await verify(out1);
      if (pattern === null) {
        assert.equal(t.status, 0, `${name}: expected verify to pass\n${t.stdout}${t.stderr}`);
      } else {
        assert.equal(t.status, 1, `${name}: expected verify to fail\n${t.stdout}${t.stderr}`);
        assert.match(t.stderr, pattern, name);
        if (notPattern) assert.doesNotMatch(t.stderr, notPattern, name);
      }
      await cleanup();
    }
    // All cleanups ran: the dataset is whole again and verifies clean.
    const tRestored = await verify(out1);
    assert.equal(tRestored.status, 0, `verify failed after restores:\n${tRestored.stdout}${tRestored.stderr}`);

    // --- run 10: upstream delists a skill. A full run drops its row AND its
    // content directory (the row-iff-directory invariant must keep holding,
    // otherwise verify would report an orphan directory); the removal shows
    // up in stats.
    gone.add("owner/repo/flaky-500");
    const r10 = await run(out1);
    assert.equal(r10.status, 0, `run 10 failed:\n${r10.stderr}`);
    assert.match(r10.stderr, /changed=1, added=0, removed=1, dropped=4, failed=1 \(carried over: 1\)/);
    const stats10 = await readStats(out1);
    assert.equal(stats10.removed, 1);
    assert.equal(stats10.added, 0);
    assert.deepEqual(
      (await readRows(out1)).map((r) => r.id),
      ["vercel-labs/skills/find-skills", "owner/repo/wei rd~x", "owner/flaky-repo/star-skill", "owner/repo/bad-id"],
    );
    assert.equal(await pathExists(dir(out1, "owner/repo/flaky-500")), false); // delisted content removed
    const v10 = await verify(out1);
    assert.equal(v10.status, 0, `verify out1 failed after removal:\n${v10.stdout}${v10.stderr}`);
    assert.match(v10.stdout, /OK: 4 rows, 4 content directories/);

    // --- run 11: upstream re-lists the skill -> it comes back as added, and
    // changed (a fresh first fetch re-stamps its fetchedAt even though the
    // content hash is the same as before the delisting)
    gone.delete("owner/repo/flaky-500");
    const r11 = await run(out1);
    assert.equal(r11.status, 0, `run 11 failed:\n${r11.stderr}`);
    assert.match(r11.stderr, /changed=1, added=1, removed=0, dropped=4, failed=1 \(carried over: 1\)/);
    const stats11 = await readStats(out1);
    assert.equal(stats11.added, 1);
    assert.equal(stats11.removed, 0);
    assert.deepEqual((await readRows(out1)).map((r) => r.id), [...rows1.map((r) => r.id), "owner/repo/bad-id"]);
    assert.equal(await readFile(dir(out1, "owner/repo/flaky-500", "SKILL.md"), "utf8"), FILES["owner/repo/flaky-500"][0].contents);

    // --- run 12: upstream lists a skill whose slug contains "/" (raw id has
    // 4 segments). skills.sh keys such skills by the slug with the "/" stripped;
    // the scraper normalizes the id to that canonical form, so the detail API
    // can address it and the directory layout mirrors the canonical id.
    gone.delete("claude-office-skills/skills/facebook/meta-ads");
    const r12 = await run(out1);
    assert.equal(r12.status, 0, `run 12 failed:\n${r12.stderr}`);
    assert.match(r12.stderr, /changed=1, added=1, removed=0, dropped=4, failed=1 \(carried over: 1\)/);
    const stats12 = await readStats(out1);
    assert.equal(stats12.added, 1);
    assert.deepEqual(stats12.failedIds, ["owner/repo/bad-id"]); // slash slugs no longer fail
    assert.deepEqual(
      (await readRows(out1)).map((r) => r.id),
      [
        "vercel-labs/skills/find-skills",
        "owner/repo/wei rd~x",
        "owner/repo/flaky-500",
        "claude-office-skills/skills/facebookmeta-ads",
        "owner/flaky-repo/star-skill",
        "owner/repo/bad-id",
      ],
    );
    assert.equal(
      await readFile(dir(out1, "claude-office-skills/skills/facebookmeta-ads", "SKILL.md"), "utf8"),
      FILES["claude-office-skills/skills/facebookmeta-ads"][0].contents,
    );
    assert.equal(await pathExists(dir(out1, "claude-office-skills/skills/facebook")), false); // the raw id never materializes
    const rows12 = await readRows(out1);
    assert.equal(rows12[3].stars, 7); // claude-office-skills/skills' stars
    const v12 = await verify(out1);
    assert.equal(v12.status, 0, `verify out1 failed after run 12:\n${v12.stdout}${v12.stderr}`);
    assert.match(v12.stdout, /OK: 6 rows, 6 content directories/);

    // --- run 13: a well-known skill whose source spans several segments
    // ("affaan-m/ecc") is filtered out like every well-known entry — even
    // though its id would survive canonical normalization.
    gone.delete("affaan-m/ecc/security-review");
    const r13 = await run(out1);
    assert.equal(r13.status, 0, `run 13 failed:\n${r13.stderr}`);
    assert.match(r13.stderr, /changed=0, added=0, removed=0, dropped=4, failed=1 \(carried over: 1\)/);
    const stats13 = await readStats(out1);
    assert.equal(stats13.nonGithub, 2); // mintlify.com/mintlify + affaan-m/ecc/security-review
    assert.equal(stats13.added, 0);
    assert.equal(stats13.removed, 0);
    const rows13 = await readRows(out1);
    assert.deepEqual(rows13.map((r) => r.id), rows12.map((r) => r.id)); // the well-known entry joins nothing
    assert.equal(await pathExists(dir(out1, "affaan-m/ecc/security-review")), false);
    const v13 = await verify(out1);
    assert.equal(v13.status, 0, `verify out1 failed after run 13:\n${v13.stdout}${v13.stderr}`);
    assert.match(v13.stdout, /OK: 6 rows, 6 content directories/);
  } finally {
    server.close();
    ghServer.close();
    await rm(workDir, { recursive: true, force: true });
  }
});

test("missing GITHUB_TOKEN aborts before any request", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "skills-scraper-noauth-"));
  try {
    const env = { ...process.env, VERCEL_OIDC_TOKEN: "mock-token", SKILLS_API_BASE: "http://127.0.0.1:1" };
    delete env.GITHUB_TOKEN; // no env token, no .env.local in the empty workDir
    const child = spawn(process.execPath, [SCRAPER, "--out", path.join(workDir, "data")], { cwd: workDir, env });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise((resolve, reject) => {
      child.on("close", resolve);
      child.on("error", reject);
    });
    assert.equal(code, 1);
    assert.match(stderr, /Missing GITHUB_TOKEN/);
    assert.match(stderr, /github\.com\/settings\/tokens/);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("publish: one commit per day, date-preserving prune, tag window", async () => {
  const PUBLISH = fileURLToPath(new URL("./publish.mjs", import.meta.url));
  const root = await mkdtemp(path.join(tmpdir(), "skills-publish-"));
  const sh = (cmd, cwd) => {
    const r = spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${cmd}\n${r.stderr}`);
    return r.stdout.trim();
  };
  // A bare "origin" plus a work repo whose data/ plays the scraped snapshot.
  try {
    sh("git init -q --bare origin.git", root);
    const work = path.join(root, "work");
    sh("git init -q -b main work", root);
    sh("git config user.name tester && git config user.email t@t.io && git remote add origin ../origin.git", work);
    sh("git commit -q --allow-empty -m seed", work);
    const scrape = async (day, body) => {
      const data = path.join(work, "data");
      await mkdir(path.join(data, "skills", "o/r/s"), { recursive: true });
      await writeFile(path.join(data, "skills", "o/r/s", "SKILL.md"), `# s rev ${day}\n`);
      await writeFile(path.join(data, "skills.jsonl"), `{"day":"${day}","body":"${body}"}\n`);
      for (const f of ["trending.json", "curated.json", "stats.json"]) {
        await writeFile(path.join(data, f), `{"day":"${day}"}\n`);
      }
    };
    // The retained-history length is a parameter, so the mechanism is exercised
    // with a 3-commit window rather than the production default (30 days).
    const WINDOW = 3;
    const publish = (day, win = WINDOW) =>
      spawnSync(process.execPath, [PUBLISH, "--date", day, "--window", String(win)], {
        cwd: work,
        encoding: "utf8",
      });
    const distLog = (fmt) => sh(`git fetch -q origin dist && git log --format=${fmt} origin/dist`, work);
    const distTip = (fmt) => sh(`git fetch -q origin dist && git log -1 --format=${fmt} origin/dist`, work);
    const distShow = (file) => sh(`git fetch -q origin dist && git show origin/dist:${file}`, work);
    const remoteTag = (tag) => sh(`git ls-remote origin refs/tags/${tag}`, work);

    await scrape("d1", "first");
    // A bad --window aborts up front: `count > NaN` is false, so an unguarded
    // value would silently publish without ever pruning. It must fail before
    // the snapshot is moved out of data/.
    let r = publish("d1", "abc");
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /--window must be a positive integer/);
    await access(path.join(work, "data", "skills.jsonl"));
    assert.equal(sh("git rev-parse --verify --quiet origin/dist || true", work), "");

    r = publish("d1");
    assert.equal(r.status, 0, r.stderr);
    // First publish: an orphan dist branch with a single day-one commit, tagged.
    assert.equal(distLog("%s"), "skills.sh data — d1");
    const d1Sha = distLog("%H");
    assert.match(remoteTag("dist-d1"), new RegExp(`^${d1Sha}`));

    // The snapshot carries the pointer a consumer resolves the newest tag from:
    // one line holding this snapshot's own tag.
    const pointerOf = () => distShow("latest");
    assert.equal(pointerOf(), "dist-d1");

    // Same-day rerun amends the day's commit instead of stacking a second one,
    // re-points the tag at the amended sha, and keeps the original author date.
    const authorDate = distTip("%aD");
    await scrape("d1", "second");
    r = publish("d1");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(distLog("%H").split("\n").length, 1);
    assert.equal(distLog("%s"), "skills.sh data — d1");
    assert.notEqual(distLog("%H"), d1Sha);
    assert.equal(distLog("%aD"), authorDate);
    assert.equal(sh("git show origin/dist:skills.jsonl", work), `{"day":"d1","body":"second"}`);
    assert.match(remoteTag("dist-d1"), new RegExp(`^${distLog("%H")}`));
    assert.equal(pointerOf(), "dist-d1"); // the amended commit's pointer still names the day's tag

    // The remaining days fill the window; publishing one more overflows it and
    // re-roots, pushing d1 out. The author date of each day's commit is
    // captured right after its publish (git dates have 1s resolution, so runs
    // inside the same second can tie).
    const days = ["d2", "d3", "d4"];
    const authorDates = {};
    for (const day of days) {
      await scrape(day, day);
      r = publish(day);
      assert.equal(r.status, 0, r.stderr);
      authorDates[day] = distTip("%aD");
    }
    assert.equal(distLog("%H").split("\n").length, WINDOW);
    // The pruned (re-rooted) commits keep their real per-run timeline — the
    // rewrite does not stamp them all with the rewrite moment — and their
    // subjects name their days (newest first in the log).
    const shas = distLog("%H%x7C%s%x7C%aD").split("\n");
    assert.deepEqual(
      shas.map((l) => l.split("|")[1]),
      [...days].reverse().map((d) => `skills.sh data — ${d}`),
    );
    for (const line of shas) {
      const [, subject, authorDate] = line.split("|");
      assert.equal(authorDate, authorDates[subject.slice(-2)]);
    }

    // Tags mirror the window: d1 fell out and its tag was deleted, every day
    // still in the window keeps a tag pointing at its own commit — and every
    // retained snapshot's pointer still names exactly that tag, so the
    // prune/re-tag round trip never leaves a snapshot describing another one.
    assert.match(remoteTag("dist-d1"), /^$/);
    for (const line of shas) {
      const [sha, subject] = line.split("|");
      const day = subject.slice(-2);
      assert.match(remoteTag(`dist-${day}`), new RegExp(`^${sha}`), subject);
      assert.equal(sh(`git show ${sha}:latest`, work), `dist-${day}`, subject);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
