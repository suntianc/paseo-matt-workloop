#!/usr/bin/env node
// tidy-docs — install the per-project /tidy-docs skill and inventory a repo's
// Markdown documents against its registry.
//
//   node tidy-docs.mjs install   [--repo <path>]
//   node tidy-docs.mjs inventory [--repo <path>] [--since <ref>] [--json]
//
// Zero dependencies, Node >= 18. workloop.mjs runs `inventory` as a child
// process at the end of a full run; this script imports only `inScope` from it.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { inScope, isMain } from "./workloop.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(HERE, "..");
const TEMPLATE = join(SKILL_DIR, "templates", "tidy-docs-skill.md");
const PROCEDURE = join(SKILL_DIR, "reference", "tidy-docs.md");
const WORKLOOP = join(HERE, "workloop.mjs");

// The skill is registered for every agent that reads Agent Skills, which is
// why it goes in both places. Both are machine-specific (they hold absolute
// paths), so install excludes them from git instead of committing them.
const SKILL_FILES = [
  join(".agents", "skills", "tidy-docs", "SKILL.md"),
  join(".claude", "skills", "tidy-docs", "SKILL.md"),
];

const ROOT_INSTRUCTIONS = ["AGENTS.md", "CLAUDE.md"];
const TYPES = ["instructions", "standards", "glossary", "adr", "history", "pitfalls", "product", "generated"];
const SINGLE = ["instructions", "standards", "glossary", "product"];
const MD = /\.md$/i;

class UserError extends Error {}
const fail = (msg) => { throw new UserError(msg); };
const say = (...a) => console.log(...a);
const slash = (p) => p.replace(/\\/g, "/");

// ---------------------------------------------------------------- processes

function gitTry(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.error) fail(`git: ${r.error.message}`);
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}
function git(cwd, ...args) {
  const r = gitTry(cwd, ...args);
  if (r.code !== 0) fail(`git ${args.join(" ")} failed (exit ${r.code}):\n${(r.err || r.out).trim()}`);
  return r.out;
}

function repoRoot(dir) {
  const path = resolve(dir || ".");
  const r = gitTry(path, "rev-parse", "--show-toplevel");
  if (r.code !== 0) fail(`not a git repository: ${path}`);
  const top = r.out.trim();
  if (!top) fail(`not a git repository: ${path}`);
  return resolve(top);
}

// ---------------------------------------------------------------- install

function excludedPaths(repo) {
  const r = gitTry(repo, "rev-parse", "--git-path", "info/exclude");
  const p = r.code === 0 ? r.out.trim() : join(".git", "info", "exclude");
  return isAbsolute(p) ? p : resolve(repo, p);
}

// git reads the exclude file as patterns, so a line counts only when it names the
// path exactly (or root-anchored, which git treats the same for a path with a
// slash). Trailing spaces are insignificant to git; leading ones are not, so they
// are kept: " .agents/..." does not ignore anything.
const excludesPath = (line, path) => {
  const pattern = line.replace(/[ \r]+$/, "");   // git ignores trailing spaces, not tabs
  return pattern === path || pattern === `/${path}`;
};

// Keeps the exclude file in step with the two skill files: each line once, and a
// line put back after someone removed or broke it. Returns what it had to add.
function exclude(repo, files) {
  const file = excludedPaths(repo);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = text.split("\n");
  const added = files.map(slash).filter((p) => !lines.some((l) => excludesPath(l, p)));
  if (!added.length) return { file, added };
  mkdirSync(dirname(file), { recursive: true });
  const lead = text && !text.endsWith("\n") ? "\n" : "";
  appendFileSync(file, `${lead}${added.join("\n")}\n`);
  return { file, added };
}

function cmdInstall(opts) {
  const repo = repoRoot(opts.repo);
  const template = readFileSync(TEMPLATE, "utf8");
  const content = template
    .replaceAll("{{procedure}}", slash(PROCEDURE))
    .replaceAll("{{workloop}}", slash(WORKLOOP));
  const targets = SKILL_FILES.map((p) => ({ rel: slash(p), abs: join(repo, p) }));
  const current = targets.map((t) => (existsSync(t.abs) ? readFileSync(t.abs, "utf8") : null));
  const changed = targets.filter((t, i) => current[i] !== null && current[i] !== content);
  const same = targets.filter((t, i) => current[i] === content);
  if (changed.length) {
    fail(`${changed.map((t) => t.rel).join(", ")} differs from the template; refusing to overwrite it. `
      + `Edit or delete it, then run install again. This machine's paths are in the template: ${TEMPLATE}`);
  }
  const allMatch = same.length === targets.length;
  if (!allMatch) {
    for (const t of targets) {
      mkdirSync(dirname(t.abs), { recursive: true });
      writeFileSync(t.abs, content);
    }
  }
  // Even when the files need no change, the exclude file may have lost its lines
  // (a fresh clone, a user's edit), and those files must never be committed.
  const { file, added } = exclude(repo, SKILL_FILES);
  if (allMatch) {
    say(`already installed: ${targets.map((t) => t.rel).join(" and ")}`);
    if (added.length) say(`restored the git exclusions in ${slash(file)}`);
    return;
  }
  say(`installed ${targets.map((t) => t.rel).join(" and ")}`);
  say(`excluded both from git in ${slash(file)}`);
}

// ---------------------------------------------------------------- registry

const isRow = (line) => line.includes("|") && !/^\s*#{1,6}\s/.test(line) && line.trim() !== "";
const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isSeparator = (line) => isRow(line) && cells(line).every((c) => /^:?-+:?$/.test(c));

function readRegistry(repo) {
  const name = ["AGENTS.md", "CLAUDE.md"].find((f) => existsSync(join(repo, f)));
  if (!name) return { rows: [], file: null };
  const file = join(repo, name);
  const lines = readFileSync(file, "utf8").replace(/\r/g, "").split("\n");
  const heading = lines.findIndex((l) => /^#{1,6}\s+documents\s*$/i.test(l.trim()));
  if (heading < 0) return { rows: [], file: null };
  const where = `${name}:${heading + 1}`;

  let i = heading + 1;
  while (i < lines.length && !isRow(lines[i])) {
    if (/^#{1,6}\s/.test(lines[i].trim())) fail(`${where}: the "## Documents" heading has no table`);
    i++;
  }
  if (i >= lines.length) fail(`${where}: the "## Documents" heading has no table`);
  const header = cells(lines[i]).map((c) => c.toLowerCase());
  if (header.join("|") !== "path|type|domain") {
    fail(`${where}: the table under "## Documents" needs the header "Path | Type | Domain", not "${lines[i].trim()}"`);
  }
  i++;
  if (i >= lines.length || !isSeparator(lines[i])) {
    fail(`${where}: the table under "## Documents" has no separator row after its header`);
  }
  i++;

  const rows = [];
  for (; i < lines.length && isRow(lines[i]) && !isSeparator(lines[i]); i++) {
    const c = cells(lines[i]);
    const at = `${name}:${i + 1}: the registry row "${lines[i].trim()}"`;
    if (c.length < 3) fail(`${at} is missing a column; expected Path | Type | Domain`);
    const path = c[0].replace(/`/g, "").replace(/^\.\//, "").replace(/\/+$/, "").trim();
    const type = c[1].replace(/`/g, "").toLowerCase();
    const domain = c[2].replace(/`/g, "").trim();
    if (!path) fail(`${at} has no path`);
    if (!TYPES.includes(type)) fail(`${at} has an unknown type "${type}"; expected one of ${TYPES.join(", ")}`);
    rows.push({ path, type, domain, line: i + 1 });
  }
  return { rows, file: name };
}

// ---------------------------------------------------------------- inventory

function markdownFiles(repo) {
  const out = git(repo, "ls-files", "--cached", "--others", "--exclude-standard", "-z");
  const paths = new Set(out.split("\0").filter(Boolean));
  return [...paths].filter((p) => MD.test(p) && existsSync(join(repo, p))).sort();
}

// Markdown files added or renamed between `ref` and HEAD.
function addedSince(repo, ref) {
  const out = git(repo, "diff", "--name-status", "-z", "--diff-filter=AR", ref, "HEAD");
  const parts = out.split("\0");
  const paths = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++];
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      i++;                                  // the old path
      const to = parts[i++];                // for a rename, the new path
      if (to) paths.push(to);
    } else {
      const p = parts[i++];
      if (p) paths.push(p);
    }
  }
  return new Set(paths.filter((p) => MD.test(p)));
}

// The repo-root instruction files are instructions/global by rule: every agent
// reads them, with or without a registry, and CLAUDE.md is usually just
// `@AGENTS.md`. They count as one document, so a row for one of them neither
// adds a second document of that type and domain nor can go stale. Nested files
// of the same names are ordinary documents.
const isRootInstruction = (path) => ROOT_INSTRUCTIONS.includes(path);

function inventory(repo, opts) {
  const registry = readRegistry(repo);
  const files = markdownFiles(repo);

  const registered = [];
  const unregistered = [];
  for (const path of files) {
    if (isRootInstruction(path)) { registered.push({ path, type: "instructions", domain: "global" }); continue; }
    // Ownership is the first matching row only.
    const row = registry.rows.find((r) => inScope(path, [r.path]));
    if (!row) { unregistered.push(path); continue; }
    registered.push({ path, type: row.type, domain: row.domain });
  }

  // Staleness is a separate question: a row is stale when no candidate file
  // matches it at all. A row whose match lost ownership to an earlier row still
  // matches a file, so it is not stale. A row for a root instruction file is
  // never stale: the file is the point of the rule, whether or not the other one
  // exists.
  const matches = registry.rows.map((row) => files.some((path) => inScope(path, [row.path])));
  const stale = registry.rows.filter((row, i) => !matches[i] && !isRootInstruction(row.path))
    .map((row) => ({ path: row.path, type: row.type, domain: row.domain }));

  // Duplicates are rows sharing a single-document type and domain. This is a
  // separate dimension from staleness: a row can be stale and still share its
  // type and domain with another row. Only the root instruction files' rows are
  // exempt, whatever type and domain they declare, because every repo has them.
  const groups = new Map();
  for (const row of registry.rows) {
    if (!SINGLE.includes(row.type) || isRootInstruction(row.path)) continue;
    const key = `${row.type}\u0000${row.domain}`;
    if (!groups.has(key)) groups.set(key, { type: row.type, domain: row.domain, paths: [] });
    groups.get(key).paths.push(row.path);
  }
  const duplicates = [...groups.values()].filter((g) => g.paths.length > 1)
    .sort((a, b) => `${a.type}/${a.domain}`.localeCompare(`${b.type}/${b.domain}`));

  const since = opts.since ? addedSince(repo, opts.since) : null;
  const report = {
    repo: slash(repo),
    registry: registry.file ? { file: registry.file, rows: registry.rows.map(({ path, type, domain }) => ({ path, type, domain })) } : null,
    registered,
    unregistered: since ? unregistered.filter((p) => since.has(p)) : unregistered,
    stale,
    duplicates,
  };
  if (opts.since) report.since = opts.since;
  return report;
}

function printReport(r) {
  say(`registry: ${r.registry ? `${r.registry.file} (${r.registry.rows.length} rows)` : "none"}`);
  say(`registered: ${r.registered.length}`);
  for (const f of r.registered) say(`  ${f.path} — ${f.type} — ${f.domain}`);
  say(`unregistered: ${r.unregistered.length}`);
  for (const f of r.unregistered) say(`  ${f}`);
  say(`stale: ${r.stale.length}`);
  for (const f of r.stale) say(`  ${f.path} — ${f.type} — ${f.domain}`);
  say(`duplicates: ${r.duplicates.length}`);
  for (const d of r.duplicates) say(`  ${d.type}/${d.domain}: ${d.paths.join(", ")}`);
}

// ---------------------------------------------------------------- CLI

const USAGE = `usage: node tidy-docs.mjs install   [--repo <path>]
       node tidy-docs.mjs inventory [--repo <path>] [--since <ref>] [--json]

install    register /tidy-docs in a repo: .agents/skills/tidy-docs/SKILL.md (pi
           and other Agent Skills agents) and .claude/skills/tidy-docs/SKILL.md,
           filled with this machine's absolute paths and excluded from git.
inventory  list Markdown files with the type and domain their registry row gives
           them, plus unregistered files, stale rows and duplicate rows.`;

const OPTIONS = { repo: { type: "string" }, since: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" } };

function main(argv) {
  let opts, positionals;
  try {
    ({ values: opts, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }));
  } catch (e) {
    if (e.code !== "ERR_PARSE_ARGS_UNKNOWN_OPTION" && e.code !== "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") throw e;
    fail(`${e.message}\n\n${USAGE}`);
  }
  const [cmd, ...extra] = positionals;
  if (opts.help || !cmd || cmd === "help") return say(USAGE);
  if (extra.length) fail(`unexpected argument "${extra[0]}"\n\n${USAGE}`);
  if (cmd === "install") {
    if (opts.since) fail(`install takes no --since\n\n${USAGE}`);
    if (opts.json) fail(`install takes no --json\n\n${USAGE}`);
    return cmdInstall(opts);
  }
  if (cmd === "inventory") {
    const r = inventory(repoRoot(opts.repo), opts);
    return opts.json ? say(JSON.stringify(r, null, 2)) : printReport(r);
  }
  return fail(`unknown command "${cmd}"\n\n${USAGE}`);
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    console.error(`tidy-docs: ${e.message}`);
    process.exitCode = 1;
  }
}
