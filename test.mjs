// End-to-end test: scraper.mjs against a local mock of the skills.sh API —
// no real token, no network, and no host but the mock (any other endpoint
// 500s and is counted; in particular per-skill content fetches must not
// exist). Covers: transient-500 retry, pagination with leaderboard drift,
// filtering (well-known — including multi-segment sources — and
// duplicate-flagged entries), exact { id, name, installs } rows in
// installs-desc /
// id-asc order, canonical id normalization for slash slugs, delisting and
// re-listing, the trending and curated id reductions, the dist README.md
// carrying the run's stats, .env.local token loading, verifier acceptance and rejection of tampered datasets, and
// the dist publisher (one parentless commit exactly the publish set — stale
// trees on dist cannot survive — same-day reruns re-pointing the day's tag,
// the --window-bounded tag set, and a bad --window aborting up front).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { canonicalId } from "./lib.mjs";

const SCRAPER = fileURLToPath(new URL("./scraper.mjs", import.meta.url));
const VERIFY = fileURLToPath(new URL("./verify.mjs", import.meta.url));
const PUBLISH = fileURLToPath(new URL("./publish.mjs", import.meta.url));

// The mock leaderboard serves only the fields the scraper reads: sourceType,
// isDuplicate, source, slug (canonicalId), name and installs. Ids in `hidden`
// are delisted until later runs (upstream delisting / re-listing).
const SKILLS = [
  { id: "vercel-labs/skills/find-skills", slug: "find-skills", name: "find-skills", source: "vercel-labs/skills", installs: 12345, sourceType: "github" },
  { id: "owner/repo/braavo", slug: "braavo", name: "Braavo", source: "owner/repo", installs: 99, sourceType: "github" },
  { id: "owner/repo/alpha", slug: "alpha", name: "Alpha", source: "owner/repo", installs: 99, sourceType: "github" }, // ties braavo: id-asc must win
  { id: "owner/repo/zebra", slug: "zebra", name: "Zebra", source: "owner/repo", installs: 6, sourceType: "github" },
  { id: "owner/repo/dup", slug: "dup", name: "Dup", source: "owner/repo", installs: 2, sourceType: "github", isDuplicate: true },
  { id: "mintlify.com/mintlify", slug: "mintlify", name: "Mintlify", source: "mintlify.com", installs: 99, sourceType: "well-known" },
  // raw id carries a slash inside the slug (4 segments); skills.sh keys it by
  // the slug with the "/" stripped, so the canonical id is owner/repo/hiddenslash
  { id: "owner/repo/hidden-slash", slug: "hidden/slash", name: "Hidden Slash", source: "owner/repo", installs: 7, sourceType: "github" },
  // well-known with a MULTI-SEGMENT source: filtered like every well-known
  // entry, even though its id would survive canonical normalization
  { id: "affaan-m/ecc/hidden-known", slug: "hidden-known", name: "Hidden Known", source: "affaan-m/ecc", installs: 5, sourceType: "well-known" },
];
const hidden = new Set(["owner/repo/hidden-slash", "affaan-m/ecc/hidden-known"]);

// The index: every github-sourced, non-duplicate, listed entry as an exact
// { id, name, installs } row, sorted by installs desc, ties by id asc.
const RUN1_ROWS = [
  { id: "vercel-labs/skills/find-skills", name: "find-skills", installs: 12345 },
  { id: "owner/repo/alpha", name: "Alpha", installs: 99 },
  { id: "owner/repo/braavo", name: "Braavo", installs: 99 },
  { id: "owner/repo/zebra", name: "Zebra", installs: 6 },
];

// Trending ranks independently of the leaderboard: the still-hidden slash
// slug ranks here (canonicalized) and the well-known entry is skipped.
const TRENDING = [SKILLS[0], SKILLS[6], SKILLS[5]];

// Curated: kept verbatim except per-skill entries reduced to canonical ids
// (no source filtering; the wrapper's counts are derivable and dropped).
const CURATED = {
  data: [
    { owner: "vercel-labs", totalInstalls: 12345, featuredRepo: "vercel-labs/skills", featuredSkill: "find-skills", skills: [SKILLS[0], SKILLS[5]] },
    { owner: "owner", totalInstalls: 205, featuredRepo: "owner/repo", featuredSkill: "alpha", skills: [SKILLS[2], SKILLS[6]] },
  ],
};
const CURATED_REDUCED = CURATED.data.map((o) => ({ ...o, skills: o.skills.map(canonicalId) }));

test("scraper end-to-end against mock API", async () => {
  const hits = { list: 0, trending: 0, curated: 0, other: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://mock");
    if (url.pathname === "/api/v1/skills" && url.searchParams.get("view") === "trending") {
      hits.trending++;
      if (url.searchParams.get("per_page") !== "200") {
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
      if (hits.list === 1) {
        res.statusCode = 500; // transient upstream failure: the retry succeeds
        res.end(JSON.stringify({ error: "internal" }));
        return;
      }
      const page = Number(url.searchParams.get("page") ?? 0);
      const listed = SKILLS.filter((s) => !hidden.has(s.id));
      const data = listed.slice(page * 3, page * 3 + 3);
      if (page === 1) data.push(SKILLS[0]); // leaderboard drift: same id served on two pages
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data, pagination: { page, perPage: 500, total: listed.length, hasMore: (page + 1) * 3 < listed.length } }));
      return;
    }
    hits.other++;
    res.statusCode = 500; // no other endpoint may ever be called
    res.end(JSON.stringify({ error: "unexpected request" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const workDir = await mkdtemp(path.join(tmpdir(), "skills-scraper-test-"));
  const out = path.join(workDir, "data");
  // Token with quotes exercises the .env.local parsing (quote stripping).
  await writeFile(path.join(workDir, ".env.local"), `VERCEL_OIDC_TOKEN="mock-token"\n`);

  // Async spawn: the scraper fetches from the mock server hosted in THIS
  // process, so a synchronous spawnSync would deadlock its event loop.
  const run = async () => {
    const env = { ...process.env, SKILLS_API_BASE: base };
    delete env.VERCEL_OIDC_TOKEN; // force the .env.local fallback
    const child = spawn(process.execPath, [SCRAPER, "--out", out], { cwd: workDir, env });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise((resolve, reject) => {
      child.on("close", resolve);
      child.on("error", reject);
    });
    return { status: code, stderr };
  };
  const readRows = async () => (await readFile(path.join(out, "skills.jsonl"), "utf8")).split("\n").filter(Boolean).map(JSON.parse);
  const readCurated = async () => (await readFile(path.join(out, "curated.jsonl"), "utf8")).split("\n").filter(Boolean).map(JSON.parse);
  const readReadme = async () => readFile(path.join(out, "README.md"), "utf8");
  const pathExists = (p) => access(p).then(() => true, () => false);
  const verify = async () => {
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

  try {
    // --- run 1: the index is the leaderboard itself; the transient 500 on the
    // first list request is retried into success
    const r1 = await run();
    assert.equal(r1.status, 0, `run 1 failed:\n${r1.stderr}`);
    assert.deepEqual(hits, { list: 3, trending: 1, curated: 1, other: 0 }); // 2 pages + 1 retried 500
    assert.deepEqual(await readRows(), RUN1_ROWS); // exact shape (id + installs only) and order
    assert.equal(await pathExists(path.join(out, "skills")), false); // no content is written at all
    assert.equal(await pathExists(path.join(out, "skills.jsonl.tmp")), false); // no temp leftovers
    assert.deepEqual(JSON.parse(await readFile(path.join(out, "trending.json"), "utf8")), [
      "vercel-labs/skills/find-skills",
      "owner/repo/hiddenslash",
    ]);
    assert.deepEqual(await readCurated(), CURATED_REDUCED);
    // README.md is the dist landing page: a file guide plus this run's stats
    assert.match(await readReadme(), /# skills\.sh data mirror/);
    assert.match(await readReadme(), /\| Skills indexed \| 4 \|/);
    assert.match(await readReadme(), /\| Duplicates skipped \| 1 \|/);
    assert.match(await readReadme(), /\| Non-github skipped \| 1 \|/);
    assert.match(await readReadme(), /\| Trending ids \| 2 \|/);
    assert.match(await readReadme(), /\| Curated owners \/ skills \| 2 \/ 4 \|/);
    assert.match(await readReadme(), /Generated \d{4}-\d{2}-\d{2}T/);

    // --- run 2: everything is rebuilt; the unchanged leaderboard reproduces
    // the index verbatim
    const r2 = await run();
    assert.equal(r2.status, 0, `run 2 failed:\n${r2.stderr}`);
    assert.deepEqual(await readRows(), RUN1_ROWS);

    // --- run 3: upstream delists a skill -> its row simply leaves the index
    hidden.add("owner/repo/zebra");
    const r3 = await run();
    assert.equal(r3.status, 0, `run 3 failed:\n${r3.stderr}`);
    assert.deepEqual(await readRows(), RUN1_ROWS.filter((r) => r.id !== "owner/repo/zebra"));
    const v3 = await verify();
    assert.equal(v3.status, 0, `verify failed after delisting:\n${v3.stdout}${v3.stderr}`);
    assert.match(v3.stdout, /OK: 3 rows/);

    // --- run 4: upstream re-lists the skill and lists the slash-slug skill,
    // which joins the index under its canonical (slash-stripped) id
    hidden.delete("owner/repo/zebra");
    hidden.delete("owner/repo/hidden-slash");
    const r4 = await run();
    assert.equal(r4.status, 0, `run 4 failed:\n${r4.stderr}`);
    assert.deepEqual(await readRows(), [
      RUN1_ROWS[0],
      RUN1_ROWS[1],
      RUN1_ROWS[2],
      { id: "owner/repo/hiddenslash", name: "Hidden Slash", installs: 7 },
      RUN1_ROWS[3],
    ]);
    const v4 = await verify();
    assert.equal(v4.status, 0, `verify failed after re-listing:\n${v4.stdout}${v4.stderr}`);
    assert.match(v4.stdout, /OK: 5 rows/);

    // --- run 5: a well-known skill whose source spans several segments
    // ("affaan-m/ecc") is filtered out like every well-known entry — even
    // though its id would survive canonical normalization.
    hidden.delete("affaan-m/ecc/hidden-known");
    const r5 = await run();
    assert.equal(r5.status, 0, `run 5 failed:\n${r5.stderr}`);
    // the well-known entry joins nothing, but shows up in the run's stats
    assert.match(await readReadme(), /\| Skills indexed \| 5 \|/);
    assert.match(await readReadme(), /\| Non-github skipped \| 2 \|/); // mintlify + affaan-m/ecc/hidden-known

    // --- verifier accepts the dataset
    const v5 = await verify();
    assert.equal(v5.status, 0, `verify failed:\n${v5.stdout}${v5.stderr}`);
    assert.match(v5.stdout, /OK: 5 rows, 2 trending, 2 curated owners/);

    // --- verifier rejects tampered datasets. Every case is self-contained: it
    // mutates the known-good dataset left by run 5 (5 index rows), expects
    // verify to fail with a specific problem — or, for the pattern-less
    // entries, to pass — and then restores the base state.
    const GOOD_TRENDING = ["vercel-labs/skills/find-skills", "owner/repo/hiddenslash"];
    const GOOD_CURATED = await readCurated();
    const baseRows = await readRows();
    const writeIndex = async (rows) =>
      writeFile(path.join(out, "skills.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const writeJson = (file, value) =>
      writeFile(path.join(out, file), typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
    const writeCurated = (rows) =>
      writeFile(path.join(out, "curated.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const indexCase = (name, pattern, mutate) => ({
      name,
      pattern,
      setup: async () => writeIndex(mutate(baseRows.map((r) => ({ ...r })))),
      cleanup: () => writeIndex(baseRows),
    });
    const jsonCase = (file, name, pattern, bad) => ({
      name,
      pattern,
      setup: () => writeJson(file, bad),
      cleanup: () => writeJson(file, GOOD_TRENDING),
    });
    const curCase = (name, pattern, rows) => ({
      name,
      pattern,
      setup: () => writeCurated(rows),
      cleanup: () => writeCurated(GOOD_CURATED),
    });

    const tamperCases = [
      {
        name: "a non-object index line",
        pattern: /line 1: not a JSON object/,
        setup: () => writeFile(path.join(out, "skills.jsonl"), "5\n" + baseRows.map((r) => JSON.stringify(r)).join("\n") + "\n"),
        cleanup: () => writeIndex(baseRows),
      },
      {
        name: "a row carrying a field beyond id, name and installs",
        pattern: /rows must carry exactly id, name and installs/,
        setup: () => writeIndex(baseRows.map((r, i) => (i === 1 ? { ...r, url: "https://skills.sh/x" } : r))),
        cleanup: () => writeIndex(baseRows),
      },
      {
        name: "a row without installs",
        pattern: /rows must carry exactly id, name and installs/,
        setup: () => writeIndex(baseRows.map((r, i) => (i === 1 ? { id: r.id, name: r.name } : r))),
        cleanup: () => writeIndex(baseRows),
      },
      {
        name: "a row without name",
        pattern: /bad name/,
        setup: () => writeIndex(baseRows.map((r, i) => (i === 1 ? { id: r.id, installs: r.installs } : r))),
        cleanup: () => writeIndex(baseRows),
      },
      indexCase("index order broken", /not sorted/, (rows) => rows.reverse()),
      // find-skills (12345 installs) is dropped to tie alpha's 99 while staying
      // ahead of it in id order: the id tiebreak must catch it.
      indexCase("equal-installs rows out of id order", /not sorted by id/, (rows) => {
        rows[0].installs = 99;
        return rows;
      }),
      indexCase("negative installs", /bad installs/, (rows) => {
        rows[1].installs = -1;
        return rows;
      }),
      indexCase("duplicate ids", /duplicate id: owner\/repo\/zebra/, (rows) => {
        rows[3] = rows[4]; // two adjacent rows with the same id
        return rows;
      }),
      indexCase("well-known (two-segment) ids are rejected", /malformed id/, (rows) => {
        rows[1].id = "mintlify.com/mintlify";
        return rows;
      }),
      jsonCase("trending.json", "trending.json is unparseable", /trending\.json: invalid JSON/, "{"),
      jsonCase("trending.json", "trending.json holds something else than an array of ids", /trending\.json: not an array of ids/, { top: 1 }),
      jsonCase("trending.json", "trending.json repeats an id", /trending\.json: duplicate id: a\/b\/c/, ["a/b/c", "a/b/c"]),
      {
        name: "curated.jsonl is unparseable",
        pattern: /curated\.jsonl line 1: invalid JSON/,
        setup: () => writeFile(path.join(out, "curated.jsonl"), "{\n" + GOOD_CURATED.map((r) => JSON.stringify(r)).join("\n") + "\n"),
        cleanup: () => writeCurated(GOOD_CURATED),
      },
      curCase("curated.jsonl's rows are not owner/totalInstalls/featuredRepo/featuredSkill/skills shaped", /curated\.jsonl: rows must carry/, [{ owner: "x" }, ...GOOD_CURATED]),
      // Upstream genuinely features the same skill under several owners, so
      // repeated ids across curated rows are accepted.
      curCase("curated.jsonl may repeat an id across owners", null, [
        { owner: "x", totalInstalls: 1, featuredRepo: null, featuredSkill: null, skills: ["a/b/c"] },
        { owner: "y", totalInstalls: 1, featuredRepo: null, featuredSkill: null, skills: ["a/b/c"] },
      ]),
      {
        name: "leftover temp file from an interrupted run",
        pattern: /skills\.jsonl\.tmp/,
        setup: () => writeFile(path.join(out, "skills.jsonl.tmp"), "{"),
        cleanup: () => rm(path.join(out, "skills.jsonl.tmp")),
      },
    ];
    for (const { name, pattern, setup, cleanup } of tamperCases) {
      await setup();
      const t = await verify();
      if (pattern === null) {
        assert.equal(t.status, 0, `${name}: expected verify to pass\n${t.stdout}${t.stderr}`);
      } else {
        assert.equal(t.status, 1, `${name}: expected verify to fail\n${t.stdout}${t.stderr}`);
        assert.match(t.stderr, pattern, name);
      }
      await cleanup();
    }
    // All cleanups ran: the dataset is whole again and verifies clean.
    const tRestored = await verify();
    assert.equal(tRestored.status, 0, `verify failed after restores:\n${tRestored.stdout}${tRestored.stderr}`);
  } finally {
    server.close();
    await rm(workDir, { recursive: true, force: true });
  }
});

test("missing VERCEL_OIDC_TOKEN aborts before any request", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "skills-scraper-noauth-"));
  try {
    const env = { ...process.env, SKILLS_API_BASE: "http://127.0.0.1:1" };
    delete env.VERCEL_OIDC_TOKEN; // no env token, no .env.local in the empty workDir
    const child = spawn(process.execPath, [SCRAPER, "--out", path.join(workDir, "data")], { cwd: workDir, env });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise((resolve, reject) => {
      child.on("close", resolve);
      child.on("error", reject);
    });
    assert.equal(code, 1);
    assert.match(stderr, /Missing VERCEL_OIDC_TOKEN/);
    assert.match(stderr, /vercel env pull/);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("publish: parentless snapshot per run, tag-bounded window", async () => {
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
      await mkdir(data, { recursive: true });
      await writeFile(path.join(data, "skills.jsonl"), `{"day":"${day}","body":"${body}"}\n`);
      for (const f of ["trending.json", "curated.jsonl", "README.md"]) {
        await writeFile(path.join(data, f), `{"day":"${day}"}\n`);
      }
    };
    // The retained-tag count is a parameter, so the window is exercised with a
    // 3-day span rather than the production default (30).
    const WINDOW = 3;
    const publish = (day, win = WINDOW) =>
      spawnSync(process.execPath, [PUBLISH, "--date", day, "--window", String(win)], { cwd: work, encoding: "utf8" });
    const distLog = (fmt) => sh(`git fetch -q origin dist && git log --format=${fmt} origin/dist`, work);
    const distHas = (file) =>
      sh(`git fetch -q origin dist && git show origin/dist:${file} >/dev/null 2>&1 && echo yes || echo no`, work) === "yes";
    const remoteTag = (tag) => sh(`git ls-remote origin refs/tags/${tag}`, work);
    const remoteTags = () =>
      sh("git ls-remote --tags origin 'dist-*'", work).split("\n").filter(Boolean).map((l) => l.split("refs/tags/")[1]).sort();

    await scrape("d1", "first");
    // A bad --window aborts up front, before the snapshot is moved out of data/.
    let r = publish("d1", "abc");
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /--window must be a positive integer/);
    await access(path.join(work, "data", "skills.jsonl"));
    assert.equal(sh("git rev-parse --verify --quiet origin/dist || true", work), "");

    r = publish("d1");
    assert.equal(r.status, 0, r.stderr);
    // First publish: dist is a single parentless commit holding exactly the
    // snapshot, tagged dist-d1. The branch is not a history — it is the newest.
    assert.equal(distLog("%s"), "skills.sh data — d1");
    assert.equal(distLog("%P"), ""); // no parent
    assert.equal(distLog("%H").split("\n").length, 1);
    const d1Sha = distLog("%H");
    assert.match(remoteTag("dist-d1"), new RegExp(`^${d1Sha}`));

    // Same-day rerun replaces the snapshot with a fresh parentless commit and
    // re-points the day's tag at it — nothing stacks, nothing amends.
    await scrape("d1", "second");
    r = publish("d1");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(distLog("%H").split("\n").length, 1);
    assert.equal(distLog("%P"), "");
    assert.notEqual(distLog("%H"), d1Sha);
    assert.equal(sh("git show origin/dist:skills.jsonl", work), `{"day":"d1","body":"second"}`);
    assert.match(remoteTag("dist-d1"), new RegExp(`^${distLog("%H")}`));

    // Junk tracked on dist but outside the publish set cannot survive: the
    // next publish is a parentless commit built only from data/, so stale
    // files — or skills//avatars trees from an older snapshot layout — are
    // simply gone, while every published entry is present.
    sh(
      "git fetch -q origin dist && git checkout -q -B dist origin/dist" +
        " && echo old > repos.json && echo old > curated.json && echo dist-d1 > latest" +
        " && mkdir -p skills/o/r/s avatars && echo old > skills/o/r/s/SKILL.md && echo old > avatars/o.png" +
        " && git add repos.json curated.json latest skills avatars && git commit -q --amend -m 'skills.sh data — d1'" +
        " && git push -q --force origin dist",
      work,
    );
    await scrape("d1", "third");
    r = publish("d1");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(distHas("repos.json"), false);
    assert.equal(distHas("curated.json"), false);
    assert.equal(distHas("latest"), false);
    assert.equal(distHas("skills/o/r/s/SKILL.md"), false);
    assert.equal(distHas("avatars/o.png"), false);
    assert.equal(distHas("skills.jsonl"), true);
    assert.equal(distHas("trending.json"), true);
    assert.equal(sh("git show origin/dist:skills.jsonl", work), `{"day":"d1","body":"third"}`);

    // Each further day is its own parentless commit on dist; the day's tag pins
    // it even after dist moves on. Capture each tag's sha right after publish.
    const tagSha = { d1: distLog("%H") };
    for (const day of ["d2", "d3", "d4"]) {
      await scrape(day, day);
      r = publish(day);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(distLog("%H").split("\n").length, 1); // the branch is only ever the newest
      assert.equal(distLog("%P"), "");
      tagSha[day] = distLog("%H");
      assert.match(remoteTag(`dist-${day}`), new RegExp(`^${tagSha[day]}`));
    }
    assert.equal(new Set(Object.values(tagSha)).size, 4); // four distinct days -> four commits

    // The window bounds the tag set, not branch history: with WINDOW=3 the
    // oldest day's tag is deleted (its parentless commit goes unreachable), and
    // exactly the newest three survive.
    assert.match(remoteTag("dist-d1"), /^$/);
    assert.deepEqual(remoteTags(), ["dist-d2", "dist-d3", "dist-d4"]);
    // The survivors still resolve to their own snapshots, and dist serves the
    // newest.
    sh("git fetch -q origin '+refs/tags/dist-*:refs/tags/dist-*'", work);
    for (const day of ["d2", "d3", "d4"]) {
      assert.equal(sh(`git rev-parse dist-${day}`, work), tagSha[day], day);
      assert.equal(sh(`git show dist-${day}:skills.jsonl`, work), `{"day":"${day}","body":"${day}"}`, day);
    }
    assert.equal(sh("git show origin/dist:skills.jsonl", work), `{"day":"d4","body":"d4"}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
