// Helpers shared by scraper.mjs and verify.mjs.

import { access } from "node:fs/promises";

export const argValue = (args, flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

// Ids are "owner/repo/slug" (github) or "domain/slug" (well-known); file paths
// are relative. A skill's directory mirrors its id segment by segment; each
// segment is mapped to a filesystem-safe name ("." and ".." become "_"), so a
// skill directory can never escape the output directory.
export const safeSegment = (s) => (s === "." || s === ".." ? "_" : s.replace(/[^\w.-]/g, "_"));
export const dirName = (id) => id.split("/").map(safeSegment).join("/");

// The "owner/repo" an id's first two segments encode. Github-sourced ids are
// normalized so that these two segments are exactly the skill's `source`
// (see canonicalId), so this is the repository every consumer joins index
// rows into repos.jsonl by.
export const repoOfId = (id) => {
  const segs = typeof id === "string" ? id.split("/") : [];
  return segs.length >= 3 ? segs.slice(0, 2).join("/") : null;
};

// skills.sh keys a skill by `${source}/${slug}` with any "/" stripped out of
// the slug, and that canonical form is the only way its detail API can
// address multi-segment slugs. The leaderboard carries the raw id (the slug
// may still contain "/"), so normalize with the entry's own source and slug
// fields — no segment counting: a well-known source can span several
// segments ("affaan-m/ecc") and a github source is exactly two.
export const canonicalId = (skill) => {
  if (typeof skill.source !== "string" || typeof skill.slug !== "string") return skill.id;
  return `${skill.source}/${skill.slug.split("/").join("")}`;
};

// The local avatar copy's path for an owner, relative to the output
// directory. The extension is fixed on purpose: owners.jsonl rows carry only
// the upstream URL, so consumers must be able to derive the path from the
// owner alone. Image decoders sniff the payload, so jpeg bytes under a .png
// name render fine everywhere (scraper and verifier share this function).
export const avatarPath = (owner) => `avatars/${safeSegment(owner)}.png`;

export const exists = (p) => access(p).then(() => true, () => false);
