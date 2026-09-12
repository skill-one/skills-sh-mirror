// Publishes the scraped snapshot in data/ to the dist branch. The workflow
// runs this after scrape + verify; it is also runnable by hand:
//
//   node publish.mjs [--date YYYY-MM-DD] [--window N]   (date defaults to today, UTC)
//
// Publishing means: the scraped snapshot plus a generated pointer file at the
// branch root, one commit per day — a same-day rerun amends the day's commit
// instead of stacking a second one, so the commit window can never be filled by
// a single day — history pruned to the newest N commits (N = --window, default
// 30; one commit per day, so the window is about a month of snapshots), and each
// retained snapshot tagged dist-<date> (from the commit subject, not the commit
// dates: pruning re-roots commits, which resets them). Tags mirror the window
// and tags for days that fell out of it are deleted, so the pruned objects stay
// unreachable and the repo stays bounded. The tag name is deliberately
// slash-free: dist/<date> in a raw.githubusercontent.com URL resolves as the
// dist branch plus a path (the shorter ref wins) and 404s, while dist-<date> is
// unambiguous and works in single-file raw URLs.
//
// latest is generated here, not scraped: a snapshot's own name only exists at
// publish time. It holds that tag on one line — the whole pointer file — so a
// consumer resolves the newest snapshot with a single plain-text fetch, no git
// and no GitHub API; it also keeps every day's commit non-empty even when the
// dataset itself is unchanged.

import { renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { argValue } from "./lib.mjs";

const DEFAULT_WINDOW = 30;
const SNAPSHOT = ["skills", "skills.jsonl", "trending.json", "curated.json", "stats.json"];
const POINTER = "latest";

const git = (args, opts = {}) => {
  const r = spawnSync("git", args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
};
const hasRef = (...args) => spawnSync("git", args, { encoding: "utf8" }).status === 0;

const argv = process.argv.slice(2);
const date = argValue(argv, "--date") ?? new Date().toISOString().slice(0, 10);
// Validated up front: a non-numeric window would make the prune test
// `count > keep` always false and silently stop pruning, so reject it before
// the snapshot is moved into place.
const keep = Number(argValue(argv, "--window") ?? DEFAULT_WINDOW);
if (!Number.isInteger(keep) || keep < 1) {
  throw new Error(`--window must be a positive integer, got "${argValue(argv, "--window")}"`);
}
const subject = `skills.sh data — ${date}`;
const dayOf = (sha) => git(["log", "-1", "--format=%s", sha]).replace(/^.*—\s*/, "");

// Park the fresh snapshot; load the current dist branch if it exists.
renameSync("data", "data-fresh");
if (hasRef("fetch", "-q", "origin", "dist")) {
  git(["checkout", "-q", "-B", "dist", "FETCH_HEAD"]);
} else {
  git(["checkout", "-q", "--orphan", "dist"]);
  git(["rm", "-rq", "--cached", "--ignore-unmatch", "."]);
}
for (const f of SNAPSHOT) rmSync(f, { recursive: true, force: true });
for (const f of SNAPSHOT) renameSync(`data-fresh/${f}`, f);
rmSync("data-fresh", { recursive: true, force: true });

// Names the tag this commit will get — both derive from `date`, so they cannot
// drift (checked against the committed tree at the end).
writeFileSync(POINTER, `dist-${date}\n`);
git(["add", "-f", ...SNAPSHOT, POINTER]);

if (hasRef("rev-parse", "-q", "--verify", "HEAD") && dayOf("HEAD") === date) {
  git(["commit", "-q", "--amend", "-m", subject]);
} else {
  git(["commit", "-q", "-m", subject]);
}

if (Number(git(["rev-list", "--count", "HEAD"])) > keep) {
  // Re-root the newest `keep` commits (no diff replay). commit-tree would stamp
  // every rebuilt commit with the rewrite moment — one same-second publish —
  // so carry the original author and committer dates over instead.
  let parent = "";
  for (let i = keep - 1; i >= 0; i--) {
    const args = [
      "commit-tree",
      git(["rev-parse", `HEAD~${i}^{tree}`]),
      "-m",
      git(["log", "-1", "--format=%B", `HEAD~${i}`]),
    ];
    if (parent) args.push("-p", parent);
    parent = git(args, {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: git(["log", "-1", "--format=%aD", `HEAD~${i}`]),
        GIT_COMMITTER_DATE: git(["log", "-1", "--format=%cD", `HEAD~${i}`]),
      },
    });
  }
  git(["reset", "-q", "--hard", parent]);
}
git(["push", "-q", "--force", "origin", "dist"]);

// Tag each retained snapshot as dist-<date>; oldest first, so if history from
// before the same-day amend still carries two commits of one day, the newest
// snapshot of that day wins the tag.
try {
  git(["fetch", "-q", "origin", "+refs/tags/dist-*:refs/tags/dist-*"]);
} catch {}
const kept = [];
const n = Math.min(Number(git(["rev-list", "--count", "HEAD"])), keep);
for (let i = n - 1; i >= 0; i--) {
  const sha = git(["rev-parse", `HEAD~${i}`]);
  const tag = `dist-${dayOf(sha)}`;
  git(["tag", "-f", tag, sha]);
  if (!kept.includes(tag)) kept.push(tag);
}
for (const tag of git(["tag", "-l", "dist-*"]).split("\n").filter(Boolean)) {
  if (kept.includes(tag)) continue;
  git(["tag", "-d", tag]);
  try {
    git(["push", "-q", "origin", `:refs/tags/${tag}`]);
  } catch {}
}
for (const tag of kept) {
  // "+" force: a day re-published onto an amended commit re-points its tag,
  // and a non-fast-forward tag update needs it.
  git(["push", "-q", "--force", "origin", `+refs/tags/${tag}:refs/tags/${tag}`]);
}

// Self-check on the published state: the pointer is written before the commit
// and the tag created after it, so re-read it from the committed tree and prove
// what a consumer would resolve is what was actually tagged.
const expectedTag = `dist-${date}`;
const pointer = git(["show", `HEAD:${POINTER}`]);
if (pointer !== expectedTag) {
  throw new Error(`${POINTER} holds "${pointer}", expected "${expectedTag}"`);
}
if (!hasRef("rev-parse", "-q", "--verify", `refs/tags/${expectedTag}`)) {
  throw new Error(`${POINTER} names tag ${expectedTag}, which this run did not create`);
}
if (git(["rev-parse", `${expectedTag}^{commit}`]) !== git(["rev-parse", "HEAD"])) {
  throw new Error(`tag ${expectedTag} does not point at the published snapshot HEAD`);
}
