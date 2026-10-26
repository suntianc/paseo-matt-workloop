// End-to-end tests for tidy-docs.mjs against throwaway git repos.
// Run: node --test skills/paseo-workloop/scripts/test/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "tidy-docs.mjs");
const SKILL = resolve(HERE, "..", "..");
const PROCEDURE = join(SKILL, "reference", "tidy-docs.md");
const WORKLOOP = join(SKILL, "scripts", "workloop.mjs");
const AGENTS = ".agents/skills/tidy-docs/SKILL.md";
const CLAUDE = ".claude/skills/tidy-docs/SKILL.md";
const slash = (p) => p.replace(/\\/g, "/");

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tidy-docs-test-")));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(root, "gitconfig"), "");
  const env = {
    ...process.env, GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  };
  const g = (cwd, ...args) => {
    const r = spawnSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  g(repo, "init", "-q", "-b", "main");
  const write = (path, content) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  const commit = (msg = "base") => { g(repo, "add", "-A"); g(repo, "commit", "-q", "--allow-empty", "-m", msg); };
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8", env });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}${r.stderr}` };
  };
  const ok = (...args) => { const r = run(...args); assert.equal(r.code, 0, r.out); return r.out; };
  const no = (pattern, ...args) => { const r = run(...args); assert.notEqual(r.code, 0, r.out); assert.match(r.out, pattern); return r.out; };
  const json = (...args) => {
    const r = run(...args);
    assert.equal(r.code, 0, r.out);
    return JSON.parse(r.stdout);
  };
  return { root, repo, env, g, write, commit, run, ok, no, json, read: (p) => readFileSync(join(repo, p), "utf8"), has: (p) => existsSync(join(repo, p)) };
}

// A registry in the shape the spec prints, with the extra rows a report must cover.
const REGISTRY = `# AGENTS.md

Instructions for agents.

## Documents

| Path | Type | Domain |
|------|------|--------|
| AGENTS.md | instructions | global |
| docs/adr | adr | global |
| archive/adr | adr | global |
| docs/adr-history.md | history | global |
| docs/api/billing.md | product | billing |
| \`docs/api/*.md\` | product | billing |
| docs/old.md | product | legacy |
`;

test("install writes the same project skill to .agents and .claude, filled with absolute paths", () => {
  const sb = sandbox();
  sb.commit();
  sb.ok("install");
  assert.equal(sb.read(AGENTS), sb.read(CLAUDE));
  const skill = sb.read(AGENTS);
  assert.doesNotMatch(skill, /\{\{/, "no placeholder is left unfilled");
  assert.match(skill, /^---\nname: tidy-docs\ndescription: .+\ndisable-model-invocation: true\n---\n/);
  assert.match(skill, /Have agents tidy this repository's documents/);
  // Both paths come from the script's own location, so they point at this machine's skill.
  assert.ok(existsSync(WORKLOOP), `${WORKLOOP} exists`);
  assert.ok(skill.includes(slash(WORKLOOP)), `skill names ${WORKLOOP}`);
  assert.ok(skill.includes(slash(PROCEDURE)), `skill names ${PROCEDURE}`);
  assert.ok(isAbsolute(PROCEDURE) && isAbsolute(WORKLOOP));
});

test("install excludes both skill files from git once, and a second install reports it", () => {
  const sb = sandbox();
  sb.commit();
  sb.ok("install");
  // git writes comments into its default exclude file; only the patterns matter here.
  const excluded = () => sb.read(".git/info/exclude").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(excluded(), [AGENTS, CLAUDE], "each path exactly once, in order");
  assert.equal(sb.g(sb.repo, "status", "--porcelain"), "");

  const out = sb.ok("install");
  assert.match(out, /already installed/);
  assert.deepEqual(excluded(), [AGENTS, CLAUDE], "a second install adds no line");
  assert.equal(sb.g(sb.repo, "status", "--porcelain"), "");
});

test("install refuses a hand-edited copy and touches neither", () => {
  const sb = sandbox();
  sb.write(CLAUDE, "hand edited\n");
  sb.commit();
  sb.no(/differs from the template/, "install");
  assert.equal(sb.read(CLAUDE), "hand edited\n");
  assert.equal(sb.has(AGENTS), false, "the other copy is not written");
  assert.doesNotMatch(sb.read(".git/info/exclude"), /tidy-docs/, "nothing is excluded when it refuses");
});

// A repo holding one of each kind the inventory must place.
function docsRepo() {
  const sb = sandbox();
  sb.write("AGENTS.md", REGISTRY);
  sb.write("docs/adr/0001-use-postgres.md", "# 1: Use Postgres\n");
  sb.write("docs/adr/0002-billing-retries.md", "# 2: Billing retries\n");
  sb.write("docs/adr-history.md", "# ADR history\n");
  sb.write("archive/adr/0009-old-decision.md", "# 9: Old decision\n");
  sb.write("docs/api/billing.md", "# Billing API\n");
  sb.write("docs/api/invoices.md", "# Invoices API\n");   // matched by the `docs/api/*.md` glob row, same type and domain as billing.md
  sb.write("docs/guide/getting-started.md", "# Getting started\n"); // no row covers it
  sb.write("PROGRESS.md", "# Progress\n");                // process document, unregistered
  sb.write("docs/generated/api.md", "generated\n");       // ignored, so never listed
  sb.write(".gitignore", "docs/generated/\n");
  sb.commit();
  sb.write("docs/guide/untracked.md", "# Untracked but not ignored\n");
  return sb;
}

test("inventory reports registered, unregistered, stale and duplicate rows, and skips ignored files", () => {
  const sb = docsRepo();
  const r = sb.json("inventory", "--json");
  assert.deepEqual(r.registry.file, "AGENTS.md");
  assert.equal(r.registry.rows.length, 7);

  const byPath = Object.fromEntries(r.registered.map((f) => [f.path, f]));
  assert.deepEqual(byPath["AGENTS.md"], { path: "AGENTS.md", type: "instructions", domain: "global" });
  assert.deepEqual(byPath["docs/adr/0002-billing-retries.md"], { path: "docs/adr/0002-billing-retries.md", type: "adr", domain: "global" });
  assert.deepEqual(byPath["docs/adr-history.md"], { path: "docs/adr-history.md", type: "history", domain: "global" });
  assert.deepEqual(byPath["archive/adr/0009-old-decision.md"], { path: "archive/adr/0009-old-decision.md", type: "adr", domain: "global" });
  assert.deepEqual(byPath["docs/api/billing.md"], { path: "docs/api/billing.md", type: "product", domain: "billing" });
  assert.deepEqual(byPath["docs/api/invoices.md"], { path: "docs/api/invoices.md", type: "product", domain: "billing" });

  // Tracked and untracked-but-not-ignored; ignored files never appear anywhere.
  assert.deepEqual(r.unregistered.sort(), ["PROGRESS.md", "docs/guide/getting-started.md", "docs/guide/untracked.md"]);
  assert.deepEqual(r.stale, [{ path: "docs/old.md", type: "product", domain: "legacy" }]);
  assert.deepEqual(r.duplicates, [{ type: "product", domain: "billing", paths: ["docs/api/billing.md", "docs/api/*.md"] }]);
  assert.ok(!JSON.stringify(r).includes("docs/generated"));
});

test("plain inventory reads the same report without --json", () => {
  const sb = docsRepo();
  const out = sb.ok("inventory");
  assert.match(out, /^registry: AGENTS\.md \(7 rows\)$/m);
  assert.match(out, /^unregistered: 3$/m);
  assert.match(out, /^  PROGRESS\.md$/m);
  assert.match(out, /^stale: 1$/m);
  assert.match(out, /^duplicates: 1$/m);
  assert.ok(!out.includes("docs/generated"));
});

test("registry comes from AGENTS.md, else CLAUDE.md, else there is none", () => {
  const claude = sandbox();
  claude.write("CLAUDE.md", "## Documents\n\n| Path | Type | Domain |\n|---|---|---|\n| CLAUDE.md | instructions | global |\n");
  claude.write("notes.md", "# Notes\n");
  claude.commit();
  const only = claude.json("inventory", "--json");
  assert.equal(only.registry.file, "CLAUDE.md");
  assert.deepEqual(only.registered.map((f) => f.path).sort(), ["CLAUDE.md"]);

  const both = sandbox();
  both.write("AGENTS.md", "## Documents\n\n| Path | Type | Domain |\n|---|---|---|\n| AGENTS.md | instructions | global |\n");
  both.write("CLAUDE.md", "## Documents\n\n| Path | Type | Domain |\n|---|---|---|\n| CLAUDE.md | instructions | global |\n");
  both.commit();
  const winner = both.json("inventory", "--json");
  assert.equal(winner.registry.file, "AGENTS.md", "AGENTS.md wins when both exist");
  // Both root files are instructions/global by rule, whichever file holds the table.
  assert.deepEqual(winner.registered.map((f) => f.path).sort(), ["AGENTS.md", "CLAUDE.md"]);
  assert.deepEqual(winner.registered.find((f) => f.path === "CLAUDE.md"), CLAUDE_INSTRUCTIONS);
  assert.deepEqual(winner.duplicates, [], "the two implicit root files are one document");

  const none = sandbox();
  none.write("README.md", "# Readme\n");
  none.write("docs/adr/0001-a.md", "# 1: A\n");
  none.commit();
  const bare = none.json("inventory", "--json");
  assert.equal(bare.registry, null);
  assert.deepEqual(bare.unregistered, ["README.md", "docs/adr/0001-a.md"]);
  assert.deepEqual(bare.registered, []);
  assert.deepEqual(bare.stale, []);
  assert.equal(none.run("inventory").code, 0, "a repo without a registry is not an error");
});

test("a row with an unknown type, or a Documents heading without a table, fails and names the problem", () => {
  const bad = sandbox();
  bad.write("AGENTS.md", "## Documents\n\n| Path | Type | Domain |\n|---|---|---|\n| docs/guide | guide | global |\n");
  bad.commit();
  bad.no(/AGENTS\.md:5.*\| docs\/guide \| guide \| global \|.*unknown type "guide"/s, "inventory");

  const empty = sandbox();
  empty.write("AGENTS.md", "# AGENTS.md\n\n## Documents\n\nNothing tabulated yet.\n\n## Other\n\n| a | b |\n|---|---|\n");
  empty.commit();
  empty.no(/AGENTS\.md:3.*"## Documents" heading has no table/, "inventory");

  const missing = sandbox();
  missing.write("AGENTS.md", "# AGENTS.md\n\n## Documents\n");
  missing.commit();
  missing.no(/"## Documents" heading has no table/, "inventory");
});

test("--since lists only Markdown files added or renamed after the ref as unregistered", () => {
  const sb = sandbox();
  sb.write("AGENTS.md", "## Documents\n\n| Path | Type | Domain |\n|---|---|---|\n| AGENTS.md | instructions | global |\n");
  sb.write("docs/guide/old.md", "# Old\n");             // renamed after the ref
  sb.write("docs/guide/keep.md", "# Keep\n");           // unregistered, and untouched: only --since hides it
  sb.commit("base");
  const base = sb.g(sb.repo, "rev-parse", "HEAD");

  sb.write("docs/guide/new.md", "# New\n");
  sb.write("NOTES.md", "# Notes\n");
  sb.write("code.mjs", "// not Markdown\n");
  sb.g(sb.repo, "mv", "docs/guide/old.md", "docs/guide/renamed.md");
  sb.commit("add and rename");

  const r = sb.json("inventory", "--json", "--since", base);
  assert.equal(r.since, base);
  assert.deepEqual(r.unregistered.sort(), ["NOTES.md", "docs/guide/new.md", "docs/guide/renamed.md"]);
  // Without --since the same report also lists the file that predates the ref.
  assert.deepEqual(sb.json("inventory", "--json").unregistered.sort(),
    ["NOTES.md", "docs/guide/keep.md", "docs/guide/new.md", "docs/guide/renamed.md"]);
});

test("a directory row covers the files below it, and the first matching row wins", () => {
  const sb = sandbox();
  sb.write("AGENTS.md", [
    "# AGENTS.md", "", "## Documents", "",
    "| Path | Type | Domain |",
    "|---|---|---|",
    "| AGENTS.md | instructions | global |",
    "| docs/guide | product | guide |",
    "| docs/guide/api.md | product | api |",
    "| docs/adr | adr | global |",
    "",
  ].join("\n"));
  sb.write("docs/guide/intro.md", "# Intro\n");
  sb.write("docs/guide/deep/nested.md", "# Nested\n");
  sb.write("docs/guide/api.md", "# API\n");
  sb.write("docs/adr/0001-a.md", "# 1: A\n");
  sb.commit();

  const r = sb.json("inventory", "--json");
  const byPath = Object.fromEntries(r.registered.map((f) => [f.path, f]));
  assert.equal(byPath["docs/guide/intro.md"].domain, "guide");
  assert.equal(byPath["docs/guide/deep/nested.md"].domain, "guide");
  assert.equal(byPath["docs/guide/api.md"].domain, "guide", "the directory row comes first, so it wins");
  assert.equal(byPath["docs/adr/0001-a.md"].type, "adr");
  assert.deepEqual(r.unregistered, []);
  // The shadowed row still matches a file, so it is not stale: it just loses
  // type/domain ownership to the row above it.
  assert.deepEqual(r.stale, []);
});

test("usage errors exit 1 without a report", () => {
  const sb = sandbox();
  sb.commit();
  sb.no(/usage:/, "wat");
  sb.no(/usage:/, "inventory", "--nope");
  sb.no(/usage:/, "install", "--json");
  sb.no(/usage:/, "inventory", "extra");
  sb.no(/not a git repository/, "inventory", "--repo", join(sb.root, "nope"));
});

test("only Markdown that exists on disk is listed, in any case of extension", () => {
  const sb = sandbox();
  sb.write("AGENTS.md", "## Documents\n\n| Path | Type | Domain |\n|---|---|---|\n| AGENTS.md | instructions | global |\n");
  sb.write("README.MD", "# Readme\n");
  sb.write("docs/gone.md", "# Gone\n");
  sb.commit();
  rmSync(join(sb.repo, "docs/gone.md"));

  const r = sb.json("inventory", "--json");
  assert.equal(r.registry.file, "AGENTS.md");
  assert.deepEqual(r.unregistered, ["README.MD"], "the tracked file deleted from disk is not listed");
});

test("both commands find the repo top level from a subdirectory and from --repo", () => {
  const sb = sandbox();
  sb.write("AGENTS.md", "## Documents\n\n| Path | Type | Domain |\n|---|---|---|\n| AGENTS.md | instructions | global |\n");
  mkdirSync(join(sb.repo, "docs"), { recursive: true });
  sb.commit();
  const sub = spawnSync(process.execPath, [CLI, "install"], { cwd: join(sb.repo, "docs"), encoding: "utf8", env: sb.env });
  assert.equal(sub.status, 0, `${sub.stdout}${sub.stderr}`);
  assert.ok(sb.has(AGENTS), "installed at the top level, not in docs/");
  assert.equal(sb.has("docs/.agents"), false);

  const other = sandbox();
  other.write("AGENTS.md", "## Documents\n\n| Path | Type | Domain |\n|---|---|---|\n| AGENTS.md | instructions | global |\n");
  other.commit();
  const r = spawnSync(process.execPath, [CLI, "inventory", "--repo", other.repo, "--json"], { cwd: sb.repo, encoding: "utf8", env: sb.env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).registry.file, "AGENTS.md");
});

test("reinstalling after one copy is deleted restores it without repeating the exclude lines", () => {
  const sb = sandbox();
  sb.commit();
  sb.ok("install");
  rmSync(join(sb.repo, CLAUDE));
  assert.equal(sb.has(CLAUDE), false);
  sb.ok("install");
  assert.equal(sb.read(AGENTS), sb.read(CLAUDE));
  const patterns = sb.read(".git/info/exclude").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(patterns, [AGENTS, CLAUDE], "still one line each");
});

test("the registry table is parsed leniently: any case, backticks, no edge pipes", () => {
  const sb = sandbox();
  sb.write("AGENTS.md", [
    "# AGENTS.md", "",
    "## documents", "",
    "path | TYPE | Domain",
    ":--- | --- | ---:",
    "`AGENTS.md` | Instructions | Global",
    "docs/api | PRODUCT | Billing",
    "",
    "## Next section", "",
    "| not | a | row of the registry |",
  ].join("\n"));
  sb.write("docs/api/billing.md", "# Billing\n");
  sb.write("docs/other.md", "# Other\n");
  sb.commit();

  const r = sb.json("inventory", "--json");
  assert.equal(r.registry.file, "AGENTS.md");
  assert.deepEqual(r.registry.rows, [
    { path: "AGENTS.md", type: "instructions", domain: "Global" },
    { path: "docs/api", type: "product", domain: "Billing" },
  ]);
  assert.deepEqual(r.registered.map((f) => f.path).sort(), ["AGENTS.md", "docs/api/billing.md"]);
  assert.deepEqual(r.unregistered, ["docs/other.md"], "the rows after the table are not parsed");
});

// --- repo-root instruction files -------------------------------------------

const INSTRUCTIONS = { path: "AGENTS.md", type: "instructions", domain: "global" };
const CLAUDE_INSTRUCTIONS = { path: "CLAUDE.md", type: "instructions", domain: "global" };

test("the repo-root AGENTS.md and CLAUDE.md are registered as instructions/global without a registry", () => {
  const sb = sandbox();
  sb.write("AGENTS.md", "# Instructions\n");
  sb.write("CLAUDE.md", "@AGENTS.md\n");
  sb.write("docs/CLAUDE.md", "# A nested document, not the root one\n");
  sb.commit();

  const r = sb.json("inventory", "--json");
  assert.equal(r.registry, null, "neither file is a registry when it has no table");
  const byPath = Object.fromEntries(r.registered.map((f) => [f.path, f]));
  assert.deepEqual(byPath["AGENTS.md"], INSTRUCTIONS);
  assert.deepEqual(byPath["CLAUDE.md"], CLAUDE_INSTRUCTIONS);
  // Nested files of these names stay ordinary documents.
  assert.deepEqual(r.unregistered, ["docs/CLAUDE.md"]);
  assert.deepEqual(r.stale, []);
  assert.deepEqual(r.duplicates, [], "the implicit pair is not a duplicate");
});

test("rows for the root instruction files never make a duplicate or go stale", () => {
  const sb = sandbox();
  sb.write("AGENTS.md", [
    "# AGENTS.md", "", "## Documents", "",
    "| Path | Type | Domain |",
    "|---|---|---|",
    "| AGENTS.md | instructions | global |",
    "| CLAUDE.md | instructions | global |",
    "| docs/guide | product | guide |",
    "",
  ].join("\n"));
  sb.write("docs/guide/intro.md", "# Intro\n");
  sb.commit(); // CLAUDE.md is absent, but its row must not go stale

  const r = sb.json("inventory", "--json");
  const byPath = Object.fromEntries(r.registered.map((f) => [f.path, f]));
  assert.deepEqual(byPath["AGENTS.md"], INSTRUCTIONS);
  assert.equal(byPath["CLAUDE.md"], undefined, "a missing file is never reported as registered");
  assert.deepEqual(r.stale, [], "a row for AGENTS.md or CLAUDE.md is never stale");
  assert.deepEqual(r.duplicates, [], "two instructions/global rows for the pair are not a duplicate");
});

test("the implicit instructions/global registration wins over a conflicting row", () => {
  const sb = sandbox();
  sb.write("AGENTS.md", [
    "# AGENTS.md", "", "## Documents", "",
    "| Path | Type | Domain |",
    "|---|---|---|",
    "| AGENTS.md | product | billing |",
    "| README.md | product | billing |",
    "",
  ].join("\n"));
  sb.write("CLAUDE.md", "@AGENTS.md\n");
  sb.write("README.md", "# Readme\n");
  sb.commit();

  const r = sb.json("inventory", "--json");
  const byPath = Object.fromEntries(r.registered.map((f) => [f.path, f]));
  assert.deepEqual(byPath["AGENTS.md"], INSTRUCTIONS, "the rule wins over the row");
  assert.deepEqual(byPath["CLAUDE.md"], CLAUDE_INSTRUCTIONS);
  assert.deepEqual(byPath["README.md"], { path: "README.md", type: "product", domain: "billing" });
  assert.deepEqual(r.unregistered, []);
  assert.deepEqual(r.stale, [], "the conflicting row still covers a real file");
});

test("a glob row that the root instruction files match is not stale for that reason", () => {
  const sb = sandbox();
  sb.write("AGENTS.md", [
    "# AGENTS.md", "", "## Documents", "",
    "| Path | Type | Domain |",
    "|---|---|---|",
    "| *.md | product | docs |",
    "",
  ].join("\n"));
  sb.write("CLAUDE.md", "@AGENTS.md\n");
  sb.commit();

  const r = sb.json("inventory", "--json");
  const byPath = Object.fromEntries(r.registered.map((f) => [f.path, f]));
  assert.deepEqual(byPath["AGENTS.md"], INSTRUCTIONS);
  assert.deepEqual(byPath["CLAUDE.md"], CLAUDE_INSTRUCTIONS);
  assert.deepEqual(r.stale, [], "the row covers the files, which are just registered as instructions");
});

// --- install keeps the exclude file in sync --------------------------------

const excludePatterns = (sb) => sb.read(".git/info/exclude").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const writeExclude = (sb, patterns) => writeFileSync(join(sb.repo, ".git", "info", "exclude"), `${patterns.map((p) => `${p}\n`).join("")}`);

test("a reinstall restores both missing exclusion lines without touching the skill files", () => {
  const sb = sandbox();
  sb.commit();
  sb.ok("install");
  const installed = sb.read(AGENTS);
  writeExclude(sb, []); // the user emptied it, so git now shows the machine-specific files
  assert.match(sb.g(sb.repo, "status", "--porcelain"), /\?\? \.agents\//);

  const out = sb.ok("install");
  assert.match(out, /already installed/);
  assert.deepEqual(excludePatterns(sb), [AGENTS, CLAUDE], "both lines are back, once each");
  assert.equal(sb.read(AGENTS), installed, "the file is not rewritten");
  assert.equal(sb.read(CLAUDE), installed);
  assert.equal(sb.g(sb.repo, "status", "--porcelain"), "", "git no longer sees them");
  // Repeat idempotency: a third install changes nothing.
  sb.ok("install");
  assert.deepEqual(excludePatterns(sb), [AGENTS, CLAUDE]);
});

test("a reinstall restores a single missing exclusion line", () => {
  const sb = sandbox();
  sb.commit();
  sb.ok("install");
  writeExclude(sb, [AGENTS]);
  const out = sb.ok("install");
  assert.match(out, /already installed/);
  assert.deepEqual(excludePatterns(sb), [AGENTS, CLAUDE]);
  sb.ok("install");
  assert.deepEqual(excludePatterns(sb), [AGENTS, CLAUDE]);
});

test("reinstall repairs the exclusions after an install whose exclude file was never written", () => {
  const sb = sandbox();
  sb.commit();
  sb.ok("install");
  rmSync(join(sb.repo, ".git", "info", "exclude"));
  sb.ok("install");
  assert.deepEqual(excludePatterns(sb), [AGENTS, CLAUDE], "the missing exclude file is created");
});

test("the reviewer's plain-pair repo: both root files registered, nothing stale or duplicated", () => {
  const sb = sandbox();
  sb.write("AGENTS.md", "# Instructions\n");
  sb.write("CLAUDE.md", "@AGENTS.md\n");
  sb.commit();
  const r = sb.json("inventory", "--json");
  assert.deepEqual(r.registered, [INSTRUCTIONS, CLAUDE_INSTRUCTIONS]);
  assert.deepEqual(r.unregistered, []);
  assert.deepEqual(r.stale, []);
  assert.deepEqual(r.duplicates, []);
  assert.equal(r.registry, null);
});

test("an AGENTS.md row alone is not a duplicate, and a CLAUDE.md row alone is never stale", () => {
  const sb = sandbox();
  sb.write("AGENTS.md", "## Documents\n\n| Path | Type | Domain |\n|---|---|---|\n| AGENTS.md | instructions | global |\n");
  sb.write("CLAUDE.md", "@AGENTS.md\n");
  sb.commit();
  const withRow = sb.json("inventory", "--json");
  assert.deepEqual(withRow.duplicates, [], "the row and the implicit file are one document");
  assert.deepEqual(withRow.stale, []);
  assert.deepEqual(withRow.registered, [INSTRUCTIONS, CLAUDE_INSTRUCTIONS]);

  // The other way round: a CLAUDE.md row with no CLAUDE.md on disk is not stale,
  // and doesn't duplicate the implicit instructions/global document either.
  const other = sandbox();
  other.write(
    "AGENTS.md",
    "## Documents\n\n| Path | Type | Domain |\n|---|---|---|\n| CLAUDE.md | instructions | global |\n",
  );
  other.commit();
  const r = other.json("inventory", "--json");
  assert.deepEqual(r.stale, [], "a root instruction file's row is never stale");
  assert.deepEqual(r.duplicates, []);
  assert.deepEqual(r.registered, [INSTRUCTIONS], "a missing file is never registered");
});

// A root-file row never counts towards duplicates, whatever type and domain it
// declares. Rows are what count for every other document: two rows naming two
// documents of one single-document type and domain are a duplicate.
const dupRows = (rows) => [
  "# AGENTS.md", "", "## Documents", "",
  "| Path | Type | Domain |",
  "|---|---|---|",
  ...rows.map((r) => `| ${r} |`),
  "",
].join("\n");

test("a root-file row never counts towards duplicates, whatever type it declares", () => {
  const sb = sandbox();
  // The reviewer's case 1: the root row shares a single-document type and domain
  // with an ordinary document, and is registered as instructions/global anyway.
  sb.write("AGENTS.md", dupRows(["AGENTS.md | product | billing", "README.md | product | billing"]));
  sb.write("README.md", "# Readme\n");
  sb.commit();

  const r = sb.json("inventory", "--json");
  assert.deepEqual(r.registered.find((f) => f.path === "AGENTS.md"), INSTRUCTIONS, "the rule still overrides the row");
  assert.deepEqual(r.registered.find((f) => f.path === "README.md"), { path: "README.md", type: "product", domain: "billing" });
  assert.deepEqual(r.duplicates, [], "the root row never counts, so README.md is alone");
});

test("root rows don't form duplicates among themselves, and one non-root row is not a duplicate", () => {
  const sb = sandbox();
  // The reviewer's case 2: three instructions/global rows, two of them root files.
  sb.write("AGENTS.md", dupRows(["AGENTS.md | instructions | global", "CLAUDE.md | instructions | global", "EXTRA.md | instructions | global"]));
  sb.write("EXTRA.md", "# Extra\n");
  sb.commit();

  const r = sb.json("inventory", "--json");
  assert.deepEqual(r.registered.map((f) => f.path).sort(), ["AGENTS.md", "EXTRA.md"]);
  assert.deepEqual(r.duplicates, [], "only EXTRA.md counts, and one row is not a duplicate");
});

test("duplicates stay row-based for the documents that do count", () => {
  const sb = sandbox();
  sb.write("AGENTS.md", dupRows([
    "AGENTS.md | product | billing",   // a root row: never counts
    "CLAUDE.md | product | billing",   // the other root file's row: never counts either
    "docs/a.md | product | billing",
    "docs/b.md | product | billing",
    "docs/c.md | product | billing",
  ]));
  sb.write("CLAUDE.md", "@AGENTS.md\n");
  sb.write("docs/a.md", "# A\n");
  sb.write("docs/b.md", "# B\n");
  sb.write("docs/c.md", "# C\n");
  sb.commit();

  const r = sb.json("inventory", "--json");
  assert.deepEqual(r.duplicates, [{
    type: "product", domain: "billing", paths: ["docs/a.md", "docs/b.md", "docs/c.md"],
  }], "one group listing each non-root row once, in registry order");
});

test("two non-root rows of one single-document type and domain are still a duplicate", () => {
  const sb = sandbox();
  sb.write("AGENTS.md", dupRows(["docs/one.md | glossary | billing", "docs/two.md | glossary | billing"]));
  sb.write("docs/one.md", "# Terms\n");
  sb.write("docs/two.md", "# More terms\n");
  sb.commit();

  const r = sb.json("inventory", "--json");
  assert.deepEqual(r.duplicates, [{
    type: "glossary", domain: "billing", paths: ["docs/one.md", "docs/two.md"],
  }]);
  // Types that allow more than one document per domain are never duplicates.
  const adr = sandbox();
  adr.write("AGENTS.md", dupRows(["docs/adr | adr | global", "archive/adr | adr | global"]));
  adr.write("docs/adr/0001-a.md", "# 1: A\n");
  adr.write("archive/adr/0009-b.md", "# 9: B\n");
  adr.commit();
  assert.deepEqual(adr.json("inventory", "--json").duplicates, []);
});

test("duplicates count rows, not distinct paths, for non-root rows", () => {
  const sb = sandbox();
  // Two rows naming the same document: still two rows for one single-document
  // type and domain, so the registry is wrong and the report says so.
  sb.write("AGENTS.md", dupRows(["docs/terms.md | glossary | billing", "docs/terms.md | glossary | billing"]));
  sb.write("docs/terms.md", "# Terms\n");
  sb.commit();

  const r = sb.json("inventory", "--json");
  assert.deepEqual(r.duplicates, [{
    type: "glossary", domain: "billing", paths: ["docs/terms.md", "docs/terms.md"],
  }], "rows are counted as they appear, not collapsed into a set");
});

// Staleness is "no candidate file matches this row", which is independent of
// which matching row wins type/domain ownership.
test("a shadowed row that still matches a file is not stale", () => {
  const sb = sandbox();
  sb.write("AGENTS.md", dupRows(["docs | product | broad", "docs/guide.md | product | narrow"]));
  sb.write("docs/guide.md", "# Guide\n");
  sb.commit();

  const r = sb.json("inventory", "--json");
  assert.deepEqual(r.registered.find((f) => f.path === "docs/guide.md"), {
    path: "docs/guide.md", type: "product", domain: "broad",
  }, "the first row owns the file");
  assert.deepEqual(r.stale, [], "the narrower row matches the file too");
});

test("overlapping directory, glob and exact rows: ownership from the first, staleness from any match", () => {
  const sb = sandbox();
  sb.write("AGENTS.md", dupRows([
    "docs/** | product | wide",
    "docs/api | product | api",
    "docs/api/billing.md | product | billing",
    "docs/api/*.md | product | api-files",
    "docs/missing | product | gone",        // matches nothing: genuinely stale
  ]));
  sb.write("docs/api/billing.md", "# Billing\n");
  sb.write("docs/api/invoices.md", "# Invoices\n");
  sb.write("docs/guide.md", "# Guide\n");
  sb.commit();

  const r = sb.json("inventory", "--json");
  const byPath = Object.fromEntries(r.registered.map((f) => [f.path, f]));
  assert.equal(byPath["docs/api/billing.md"].domain, "wide", "the first matching row owns every file");
  assert.equal(byPath["docs/api/invoices.md"].domain, "wide");
  assert.equal(byPath["docs/guide.md"].domain, "wide");
  assert.deepEqual(r.stale, [{ path: "docs/missing", type: "product", domain: "gone" }],
    "only the row no file matches is stale");
  // Every row here declares its own domain, so no two rows share a type and
  // domain: staleness and duplication stay separate questions.
  assert.deepEqual(r.duplicates, []);
});

test("repeated identical ordinary rows are not stale while the file exists, and are a duplicate", () => {
  const sb = sandbox();
  sb.write("AGENTS.md", dupRows([
    "docs/terms.md | glossary | billing",
    "docs/terms.md | glossary | billing",
    "docs/gone.md | glossary | billing",
  ]));
  sb.write("docs/terms.md", "# Terms\n");
  sb.commit();

  const r = sb.json("inventory", "--json");
  assert.deepEqual(r.stale, [{ path: "docs/gone.md", type: "glossary", domain: "billing" }],
    "the repeated rows match the file; only the row for the missing file is stale");
  // Duplicates are groups of rows, so a stale row in the same type and domain is
  // part of the group: the two dimensions are independent.
  assert.deepEqual(r.duplicates, [{
    type: "glossary",
    domain: "billing",
    paths: ["docs/terms.md", "docs/terms.md", "docs/gone.md"],
  }]);
});

test("a live row and a missing row of one type and domain are both stale-or-not and a duplicate", () => {
  const sb = sandbox();
  sb.write("AGENTS.md", dupRows([
    "docs/live.md | product | billing",
    "docs/missing.md | product | billing",
  ]));
  sb.write("docs/live.md", "# Live\n");
  sb.commit();

  const r = sb.json("inventory", "--json");
  assert.deepEqual(r.stale, [{ path: "docs/missing.md", type: "product", domain: "billing" }]);
  assert.deepEqual(r.duplicates, [{
    type: "product", domain: "billing", paths: ["docs/live.md", "docs/missing.md"],
  }], "the missing row still counts towards the duplicate group");
});

test("two rows whose files are both missing are stale and still a duplicate group", () => {
  const sb = sandbox();
  sb.write("AGENTS.md", dupRows([
    "docs/a.md | product | billing",
    "docs/b.md | product | billing",
  ]));
  sb.commit();

  const r = sb.json("inventory", "--json");
  assert.deepEqual(r.stale, [
    { path: "docs/a.md", type: "product", domain: "billing" },
    { path: "docs/b.md", type: "product", domain: "billing" },
  ], "both rows are stale");
  assert.deepEqual(r.duplicates, [{
    type: "product", domain: "billing", paths: ["docs/a.md", "docs/b.md"],
  }], "both rows are still one duplicate group, as the reviewer reproduced");
});

test("a root-file row is never stale even when nothing else matches it", () => {
  const sb = sandbox();
  sb.write("AGENTS.md", dupRows(["CLAUDE.md | instructions | global", "docs/nowhere | product | gone"]));
  sb.commit();
  const r = sb.json("inventory", "--json");
  assert.deepEqual(r.stale, [{ path: "docs/nowhere", type: "product", domain: "gone" }]);
});

// Git reads `.git/info/exclude` as patterns, so only the exact line ignores the
// file: a leading space or any other difference leaves it untracked and visible.
const ignored = (sb, path) => spawnSync("git", ["-C", sb.repo, "check-ignore", "-q", path], { env: sb.env }).status === 0;
const rawExclude = (sb) => readFileSync(join(sb.repo, ".git", "info", "exclude"), "utf8");

test("a first install replaces ineffective leading-space patterns with the real ones", () => {
  const sb = sandbox();
  sb.commit();
  writeExclude(sb, [` ${AGENTS}`, ` ${CLAUDE}`, "unrelated.log"]);
  sb.ok("install");

  assert.ok(ignored(sb, AGENTS), "git ignores the .agents copy");
  assert.ok(ignored(sb, CLAUDE), "git ignores the .claude copy");
  assert.equal(sb.g(sb.repo, "status", "--porcelain"), "");
  const lines = rawExclude(sb).split("\n");
  assert.ok(lines.includes(AGENTS) && lines.includes(CLAUDE), "the exact paths are there");
  assert.ok(lines.includes(` ${AGENTS}`) && lines.includes(` ${CLAUDE}`), "the original lines are preserved");
  assert.ok(lines.includes("unrelated.log"), "an unrelated line is preserved");
  assert.equal(lines.filter((l) => l === AGENTS).length, 1, "each correct path once");
});

test("a reinstall repairs ineffective leading-space patterns and then adds nothing", () => {
  const sb = sandbox();
  sb.commit();
  sb.ok("install");
  // Someone re-indents both lines: git no longer ignores the files.
  writeExclude(sb, [` ${AGENTS}`, ` ${CLAUDE}`]);
  assert.equal(ignored(sb, AGENTS), false);

  assert.match(sb.ok("install"), /already installed/);
  assert.ok(ignored(sb, AGENTS) && ignored(sb, CLAUDE));
  assert.equal(sb.g(sb.repo, "status", "--porcelain"), "");
  const once = rawExclude(sb);
  sb.ok("install");
  assert.equal(rawExclude(sb), once, "a third install changes nothing");
  assert.equal(once.split("\n").filter((l) => l === AGENTS).length, 1);
});

test("a conflicting skill copy still refuses with no write to either file or the exclusions", () => {
  const sb = sandbox();
  sb.write(CLAUDE, "hand edited\n");
  sb.write(".git/info/exclude", ` ${AGENTS}\nunrelated.log\n`);
  sb.commit();
  const before = rawExclude(sb);

  sb.no(/differs from the template/, "install");
  assert.equal(sb.read(CLAUDE), "hand edited\n");
  assert.equal(sb.has(AGENTS), false);
  assert.equal(rawExclude(sb), before, "the exclude file is untouched");
});

test("a root-anchored exclusion line already covers a skill path", () => {
  const sb = sandbox();
  sb.commit();
  writeExclude(sb, [`/${AGENTS}`, `/${CLAUDE}`]);
  assert.ok(ignored(sb, AGENTS) && ignored(sb, CLAUDE), "git reads these as the same pattern");

  const out = sb.ok("install");
  assert.doesNotMatch(out, /restored the git exclusions/, "nothing needs repairing");
  const lines = rawExclude(sb).split("\n");
  assert.deepEqual(lines.filter((l) => l.includes("tidy-docs")), [`/${AGENTS}`, `/${CLAUDE}`],
    "the supported anchored lines are kept and nothing is appended");
});

test("trailing spaces still exclude a path, trailing tabs do not", () => {
  const sb = sandbox();
  sb.commit();
  writeExclude(sb, [`${AGENTS}   `, `${CLAUDE}\t`]);
  // git ignores trailing spaces on a pattern; a trailing tab is part of it.
  assert.equal(ignored(sb, AGENTS), true);
  assert.equal(ignored(sb, CLAUDE), false);

  sb.ok("install");
  assert.ok(ignored(sb, CLAUDE), "the ineffective line is repaired");
  const lines = rawExclude(sb).split("\n");
  assert.equal(lines.filter((l) => l.startsWith(AGENTS)).length, 1, "no redundant line beside the spaced one");
  assert.equal(lines.filter((l) => l === CLAUDE).length, 1, "the exact path is added once");
  assert.ok(lines.includes(`${CLAUDE}\t`), "the original tabbed line is preserved");
});
