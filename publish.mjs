// Publishes the scraped snapshot in data/ to the dist branch. The workflow
// runs this after scrape + verify; it is also runnable by hand:
//
//   node publish.mjs [--date YYYY-MM-DD] [--window N]   (date defaults to today, UTC)
//
// The dist branch is only ever the newest snapshot: each run force-pushes a
// single parentless (orphan) commit whose tree is exactly the publish set.
// Per-day pinning lives in the dist-<date> tags, not in branch history — a
// consumer resolves the newest snapshot from the branch root and an older day
// from its tag. Keeping history off the branch is what makes this simple: there
// is nothing to prune or re-root, no stale entry can ride along (an orphan
// commit starts from an empty index), and the commit is never empty (no parent
// to diff against), so a day whose dataset is unchanged still publishes.
//
// The tags are what bound the repo: the newest N (N = --window, default 30 — one
// per day, so about a month) are kept and the rest deleted on origin, which
// makes their commits unreachable so they can be garbage collected. The tag name
// is deliberately slash-free: dist/<date> in a raw.githubusercontent.com URL
// resolves as the dist branch plus a path (the shorter ref wins) and 404s, while
// dist-<date> is unambiguous and works in single-file raw URLs.

import { renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { argValue } from "./lib.mjs";

const DEFAULT_WINDOW = 30;
const SNAPSHOT = ["skills", "skills.jsonl", "repos.jsonl", "owners.jsonl", "avatars", "trending.json", "curated.jsonl", "stats.json"];

const git = (args, opts = {}) => {
  const r = spawnSync("git", args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
};
const hasRef = (...args) => spawnSync("git", args, { encoding: "utf8" }).status === 0;
const gitSoft = (args) => spawnSync("git", args, { encoding: "utf8" }); // a non-zero exit is fine

const argv = process.argv.slice(2);
const date = argValue(argv, "--date") ?? new Date().toISOString().slice(0, 10);
// Validated up front: a non-numeric window would turn the tag-prune slice into
// nonsense and silently keep every tag, so reject it before the snapshot is
// moved into place.
const keep = Number(argValue(argv, "--window") ?? DEFAULT_WINDOW);
if (!Number.isInteger(keep) || keep < 1) {
  throw new Error(`--window must be a positive integer, got "${argValue(argv, "--window")}"`);
}
const subject = `skills.sh data — ${date}`;
const expectedTag = `dist-${date}`;

// Park the fresh snapshot, then start dist over as an unborn orphan branch with
// an empty index. Whatever the branch held before — locally or on origin — is
// irrelevant, since this commit has no parent. Detach first so the local branch
// ref can be deleted even when a prior same-clone run left it checked out.
renameSync("data", "data-fresh");
if (hasRef("rev-parse", "-q", "--verify", "HEAD")) gitSoft(["checkout", "-q", "--detach"]);
gitSoft(["update-ref", "-d", "refs/heads/dist"]);
git(["checkout", "-q", "--orphan", "dist"]);
git(["rm", "-rq", "--cached", "--ignore-unmatch", "."]);
for (const f of SNAPSHOT) rmSync(f, { recursive: true, force: true });
for (const f of SNAPSHOT) renameSync(`data-fresh/${f}`, f);
rmSync("data-fresh", { recursive: true, force: true });
git(["add", "-f", ...SNAPSHOT]);
git(["commit", "-q", "-m", subject]);
git(["push", "-q", "--force", "origin", "dist"]);

// Bound the tag set to the newest `keep`. Pull origin's tags first, then force
// today's at this commit — so a same-day rerun re-points it and a stale fetched
// copy of today's tag cannot win. dist-<date> sorts lexically == chronologically,
// so the newest are the last `keep`; today's is always kept even if a manual
// backfill carries an older date. Deleting a pruned tag on origin makes its
// (parentless) commit unreachable, which is what keeps the repo bounded.
try {
  git(["fetch", "-q", "origin", "+refs/tags/dist-*:refs/tags/dist-*"]);
} catch {}
git(["tag", "-f", expectedTag, "HEAD"]);
const all = [...new Set([...git(["tag", "-l", "dist-*"]).split("\n").filter(Boolean), expectedTag])].sort();
const keepSet = new Set([...all.slice(-keep), expectedTag]);
for (const tag of all) {
  if (keepSet.has(tag)) continue;
  git(["tag", "-d", tag]);
  gitSoft(["push", "-q", "origin", `:refs/tags/${tag}`]);
}
// "+" force: a same-day rerun re-points today's tag, a non-fast-forward update.
git(["push", "-q", "--force", "origin", `+refs/tags/${expectedTag}:refs/tags/${expectedTag}`]);

// Self-check on the published state: the committed tree is exactly the publish
// set (an orphan commit cannot carry a stale entry, but prove it anyway), and
// the day's tag points at the snapshot a consumer resolves it to.
const tree = git(["ls-tree", "--name-only", "HEAD"]).split("\n").filter(Boolean).sort();
const want = [...SNAPSHOT].sort();
if (tree.join("\n") !== want.join("\n")) {
  throw new Error(`published tree is [${tree.join(", ")}], expected [${want.join(", ")}]`);
}
if (git(["rev-parse", `${expectedTag}^{commit}`]) !== git(["rev-parse", "HEAD"])) {
  throw new Error(`tag ${expectedTag} does not point at the published snapshot HEAD`);
}
