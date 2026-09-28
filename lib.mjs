// Helpers shared by scraper.mjs, verify.mjs and the tests.

import { access } from "node:fs/promises";

// The value of `--flag <value>` in an argv array, or undefined.
export const argValue = (args, flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

// skills.sh keys a skill by `${source}/${slug}` with any "/" stripped from the
// slug, while the leaderboard may carry the raw id (the slug can still contain
// "/"). Normalizing with the entry's own source and slug gives every skill one
// stable id — no segment counting: a well-known source can span several
// segments, a github source is exactly two.
export const canonicalId = (skill) => {
  if (typeof skill.source !== "string" || typeof skill.slug !== "string") return skill.id;
  return `${skill.source}/${skill.slug.split("/").join("")}`;
};

export const exists = (p) => access(p).then(() => true, () => false);
