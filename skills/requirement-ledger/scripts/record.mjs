// One requirement is one Markdown file: YAML frontmatter holding the machine
// fields, then prose. This module knows that shape — how to mint a record, how to
// write it out, how to read one back, and what counts as a valid record. It never
// touches the filesystem.
import { createHash } from "node:crypto";

import { parseYaml, stringifyYaml } from "./yaml.mjs";

export const STATUSES = ["active", "retired"];

export class RecordError extends Error {
  constructor(message, code = "invalid-record") {
    super(message);
    this.name = "RecordError";
    this.code = code;
  }
}

export const idFor = (n) => `REQ-${String(n).padStart(3, "0")}`;

// Letters and digits of any script survive, so a Chinese title still yields a
// usable file name; everything else collapses to a dash.
export function slugify(title) {
  const slug = String(title ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "requirement";
}

export const fileNameFor = (id, title) => `${id}-${slugify(title)}.md`;

export const emptyBody = () => "## Summary\n\n## History\n\n## Notes\n";

export function newRecord({ id, title, aliases = [], repoPath, repoRemote = null, now }) {
  const record = {
    id,
    title,
    status: "active",
    rev: 1,
    created_at: now,
    updated_at: now,
    repo_path: repoPath,
  };
  if (repoRemote) record.repo_remote = repoRemote;
  if (aliases.length) record.aliases = [...aliases];
  record.runs = [];
  record.outcomes = [];
  record.refs = {};
  return record;
}

// The digest an audit line carries, so `doctor` can tell prose that no CLI write
// recorded from prose that matches its last recorded write. Short is enough: this
// detects drift, it is not a security boundary.
export const bodyDigest = (body) => createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);

export const emitRecord = (frontmatter, body = "") => `---\n${stringifyYaml(frontmatter)}---\n${body}`;

export function parseRecord(text) {
  const normalised = String(text).replace(/\r\n/g, "\n");
  const rows = normalised.split("\n");
  if (rows[0].trim() !== "---") throw new RecordError("the file does not start with a --- frontmatter block", "no-frontmatter");
  const close = rows.findIndex((row, index) => index > 0 && row.trim() === "---");
  if (close < 0) throw new RecordError("the frontmatter block is not closed with ---", "no-frontmatter");
  let frontmatter;
  try {
    frontmatter = parseYaml(rows.slice(1, close).join("\n"));
  } catch (error) {
    throw new RecordError(`the frontmatter is not valid: ${error.message}`, "bad-frontmatter");
  }
  if (!isMapping(frontmatter)) throw new RecordError("the frontmatter is not a mapping", "bad-frontmatter");
  return { frontmatter, body: rows.slice(close + 1).join("\n") };
}

// What `doctor` means by an invalid record: the machine fields are missing or of
// the wrong shape. Human-edited fields are checked only for being lists/mappings
// where the schema says so.
export function recordProblems(frontmatter) {
  if (!isMapping(frontmatter)) return ["the frontmatter is not a mapping"];
  const problems = [];
  if (typeof frontmatter.id !== "string" || !/^REQ-\d{3,}$/.test(frontmatter.id)) {
    problems.push(`id must look like REQ-<n>, found ${JSON.stringify(frontmatter.id)}`);
  }
  if (typeof frontmatter.title !== "string" || !frontmatter.title.trim()) problems.push("title is missing");
  if (!STATUSES.includes(frontmatter.status)) problems.push(`status must be active or retired, found ${JSON.stringify(frontmatter.status)}`);
  if (!Number.isInteger(frontmatter.rev) || frontmatter.rev < 1) problems.push(`rev must be a positive integer, found ${JSON.stringify(frontmatter.rev)}`);
  for (const key of ["created_at", "updated_at"]) {
    if (typeof frontmatter[key] !== "string" || !frontmatter[key]) problems.push(`${key} is missing`);
  }
  if (typeof frontmatter.repo_path !== "string" || !frontmatter.repo_path) problems.push("repo_path is missing");
  for (const key of ["aliases", "runs", "outcomes"]) {
    if (frontmatter[key] !== undefined && !Array.isArray(frontmatter[key])) problems.push(`${key} must be a list`);
  }
  if (frontmatter.refs !== undefined && !isMapping(frontmatter.refs)) problems.push("refs must be a mapping");
  return problems;
}

export const numberIn = (id) => Number(/^REQ-(\d+)$/.exec(id)?.[1] ?? NaN);

// A free-form note is one dated line at the end of `## Notes`. Everything else in
// the prose — the summary, the history, notes already there — is left as it is.
export function appendNote(body, line) {
  const lines = String(body ?? "").replace(/\r\n/g, "\n").trimEnd().split("\n");
  const heading = lines.findIndex((text) => text.trim() === "## Notes");
  if (heading < 0) return `${lines.join("\n")}\n\n## Notes\n${line}\n`;
  let end = lines.length;
  for (let i = heading + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) { end = i; break; }
  }
  while (end > heading + 1 && lines[end - 1].trim() === "") end -= 1;
  lines.splice(end, 0, line);
  return `${lines.join("\n")}\n`;
}

const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
