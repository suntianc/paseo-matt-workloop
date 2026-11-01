// Resolving a citation (`refs.adr`, `refs.pitfalls`) to the document behind it.
// `context` and `doctor` ask the same question — does this name still point at a
// file? — and a reader must never be told "dangling" by one and "ok" by the other,
// so the rules live here once.
//
// The union of the conventions the ledger documents: an explicit or repository-
// relative path; the directory convention (`<dir>/<name>` and `<dir>/<name>.md`);
// a unique `<name>-*.md` or `<name>.md` under the directory; and, for pitfalls,
// the slug of a heading on one of its pages.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { slugify } from "./record.mjs";

export const DOC_DIRS = { adr: "docs/adr", pitfalls: "docs/pitfalls" };

// How far below the directory a page may sit: `doctor` scanned three levels, and
// `context` now reads the same tree, so an entry filed under a topic is found.
const MAX_DEPTH = 3;

export function resolveDocRef(repo, kind, ref) {
  const entry = { ref, path: null, status: "dangling" };
  if (!repo) return { ...entry, reason: "the record has no repo_path, so no document can be resolved" };
  const dir = join(repo, DOC_DIRS[kind]);
  const name = String(ref).trim();

  // An explicit path beats any convention, and the convention ("docs/adr/<ref>.md")
  // beats nothing at all.
  const candidates = [];
  if (isAbsolute(name)) candidates.push(name);
  else if (name.includes("/") || /\.md$/i.test(name)) candidates.push(resolve(repo, name));
  candidates.push(join(dir, name), join(dir, `${name}.md`));
  for (const path of candidates) if (existsSync(path)) return { ...entry, path, status: "ok" };

  // A bare number (`0007`) finds `0007-session-tokens.md`, and a name finds the page
  // that is exactly it, anywhere under the directory. An exact page wins over the
  // prefix rule — `auth` is `auth.md` even when `auth-cookie.md` sits beside it —
  // and only when no page is exactly it does `auth` mean the unique `auth-*.md`.
  // Several matches on either rule are a question, and this never answers one by
  // choosing.
  const files = markdownFiles(dir, MAX_DEPTH).sort();
  const stem = name.replace(/\.md$/i, "");
  for (const matches of [
    files.filter((file) => basename(file, ".md") === stem),
    files.filter((file) => basename(file, ".md").startsWith(`${stem}-`)),
  ]) {
    if (matches.length === 1) return { ...entry, path: matches[0], status: "ok" };
    if (matches.length > 1) return { ...entry, reason: `several files match: ${describe(matches, dir)}` };
  }

  // A pitfall is an entry on a topic page as often as a page of its own, and the
  // record cites the heading's slug. A heading repeated on several pages still
  // names the topic, so the first page (in path order) stands for it.
  if (kind === "pitfalls") {
    const heading = files.find((file) => headingsOf(file).some((text) => slugify(text) === stem));
    if (heading) return { ...entry, path: heading, status: "ok" };
  }

  return {
    ...entry,
    reason: `no ${kind === "adr" ? "ADR" : "pitfall"} under ${dir} matches ${name}`,
  };
}

// The matches as a reader knows them: page names, unless two pages share one, in
// which case their paths under the directory tell them apart.
function describe(matches, dir) {
  const names = matches.map((path) => basename(path));
  if (new Set(names).size === names.length) return names.join(", ");
  return matches.map((path) => relative(dir, path)).join(", ");
}

function markdownFiles(dir, depth) {
  if (depth < 0) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Copied retro evidence is not an entry, so its pages do not count.
      if (entry.name !== "evidence") files.push(...markdownFiles(path, depth - 1));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

function headingsOf(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n")
    .map((line) => /^#{1,6}\s+(.*?)\s*$/.exec(line)?.[1] ?? null)
    .filter(Boolean)
    .map((heading) => heading.replace(/\s+#+$/, ""));
}
