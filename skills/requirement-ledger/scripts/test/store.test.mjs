// Tests for the requirement ledger's storage foundation: record files, identity
// allocation, atomic replacement, the project lock, the audit log and `doctor`.
// Run: node --test skills/requirement-ledger/scripts/test/store.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseYaml, stringifyYaml } from "../yaml.mjs";
import { bodyDigest, emitRecord, fileNameFor, idFor, newRecord, parseRecord, recordProblems } from "../record.mjs";
import { allocateId, readLog, writeFileAtomic } from "../store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "req.mjs");
const NOW = "2026-11-01T10:00:00+08:00";

// Every test works in a throwaway repo plus a throwaway WORKLOOP_ROOT, so the
// real ~/.workloop is never touched.
function sandbox(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "req-test-")));
  const repo = join(root, "myapp");
  mkdirSync(repo, { recursive: true });
  const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q");
  const env = { ...process.env, WORKLOOP_ROOT: join(root, "wl"), GIT_CONFIG_NOSYSTEM: "1" };
  delete env.WORKLOOP_RUN;
  delete env.REQ_LOCK_WAIT_MS;
  const dir = join(root, "wl", "myapp", ".requirements");
  const run = (args, options = {}) => spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd ?? repo, env: { ...env, ...options.env }, encoding: "utf8",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, repo, dir, env, run, git };
}

const lines = (text) => text.split("\n").filter(Boolean);
const requirementFiles = (dir) => readdirSync(dir).filter((n) => n.startsWith("REQ-")).sort();
const readMetaJson = (dir) => JSON.parse(readFileSync(join(dir, "_meta.json"), "utf8"));
const readLogLines = (dir) => readLog(dir);

// ---------------------------------------------------------------- the record

test("a record survives a round trip through frontmatter and back", () => {
  const frontmatter = {
    id: "REQ-007",
    title: "用户登录: sign-in",
    status: "active",
    rev: 3,
    created_at: NOW,
    updated_at: NOW,
    repo_path: "/Users/x/project/myapp",
    repo_remote: "github.com/owner/myapp",
    aliases: ["登录", "sign-in", "a, b"],
    runs: [{
      project: "myapp",
      feature: "req-007-login",
      relation: "primary",
      base_sha: "3f2a",
      delivery: { state: "pending" },
      delivery_history: [],
    }],
    outcomes: [],
    refs: { adr: ["0007-session-tokens"], codegraph: { symbols: ["AuthService.login"], paths: ["src/auth/"] } },
  };
  const text = emitRecord(frontmatter, "## Summary\nThe capability.\n");
  const parsed = parseRecord(text);
  assert.deepEqual(parsed.frontmatter, frontmatter);
  assert.equal(parsed.body, "## Summary\nThe capability.\n");
});

test("a title with YAML punctuation keeps its exact text", () => {
  const titles = ["a: b", "line #2", "- leading dash", "  spaced  ", 'quote "inside"', "tab\tinside", "1.5", "true", ""];
  for (const title of titles) {
    const parsed = parseYaml(stringifyYaml({ title }));
    assert.equal(parsed.title, title, `title ${JSON.stringify(title)} round-tripped`);
  }
});

test("a file without a frontmatter block is rejected as a record, not silently accepted", () => {
  assert.throws(() => parseRecord("# just prose\n"), /frontmatter/);
  assert.throws(() => parseRecord("---\nid: REQ-001\n"), /not closed/);
});

test("frontmatter that is not a mapping, or is structurally broken, is rejected", () => {
  assert.throws(() => parseRecord("---\n- a\n- b\n---\nbody\n"), /frontmatter/);
  assert.throws(() => parseRecord("---\nid: REQ-001\n  stray: x\n---\nbody\n"), /indent/);
});

test("a record missing its machine fields is reported by recordProblems", () => {
  const problems = recordProblems({ id: "REQ-1", title: "", status: "paused", rev: 0 });
  assert.ok(problems.some((p) => p.includes("id")), problems.join("; "));
  assert.ok(problems.some((p) => p.includes("title")), problems.join("; "));
  assert.ok(problems.some((p) => p.includes("status")), problems.join("; "));
  assert.ok(problems.some((p) => p.includes("rev")), problems.join("; "));
  assert.deepEqual(recordProblems({ ...newRecord({ id: "REQ-001", title: "t", repoPath: "/x", now: NOW }) }), []);
});

test("identity formatting pads to three digits and does not cap at 999", () => {
  assert.equal(idFor(1), "REQ-001");
  assert.equal(idFor(99), "REQ-099");
  assert.equal(idFor(1000), "REQ-1000");
  assert.equal(fileNameFor("REQ-001", "User login"), "REQ-001-user-login.md");
  assert.equal(fileNameFor("REQ-002", "用户登录"), "REQ-002-用户登录.md");
  assert.match(fileNameFor("REQ-003", "!!!"), /^REQ-003-[a-z0-9-]+\.md$/);
});

// ---------------------------------------------------------------- atomic replace

// Records every call writeFileAtomic makes, in order, and still does the real work.
function recordingIO() {
  const events = [];
  const openPaths = new Map();
  const io = {
    openSync(path, flags, mode) {
      const fd = openSync(path, flags, mode);
      openPaths.set(fd, path);
      events.push({ call: "openSync", path });
      return fd;
    },
    writeFileSync(fd, text) {
      events.push({ call: "writeFileSync", path: openPaths.get(fd) });
      return writeFileSync(fd, text);
    },
    fsyncSync(fd) {
      events.push({ call: "fsyncSync", path: openPaths.get(fd) });
      return fsyncSync(fd);
    },
    closeSync(fd) {
      events.push({ call: "closeSync", path: openPaths.get(fd) });
      return closeSync(fd);
    },
    renameSync(from, to) {
      events.push({ call: "renameSync", from, to });
      return renameSync(from, to);
    },
    unlinkSync(path) {
      events.push({ call: "unlinkSync", path });
      return unlinkSync(path);
    },
  };
  return { io, events };
}

test("replacing a file fsyncs the temp copy before the rename and the directory after it", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "req-atomic-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "_meta.json");
  writeFileSync(target, "{}\n");
  const { io, events } = recordingIO();
  writeFileAtomic(target, '{"lastIssued":1}\n', io);

  const renameAt = events.findIndex((e) => e.call === "renameSync");
  const tempFsyncAt = events.findIndex((e) => e.call === "fsyncSync" && e.path.endsWith(".tmp"));
  const dirFsyncAt = events.findIndex((e) => e.call === "fsyncSync" && e.path === root);

  assert.ok(tempFsyncAt >= 0, "the temp file is fsynced");
  assert.ok(renameAt >= 0, "the temp file is renamed into place");
  assert.ok(dirFsyncAt >= 0, "the directory is fsynced");
  assert.ok(tempFsyncAt < renameAt, "temp fsync precedes the rename");
  assert.ok(renameAt < dirFsyncAt, "the directory fsync follows the rename");
  assert.equal(readFileSync(target, "utf8"), '{"lastIssued":1}\n');
  assert.deepEqual(readdirSync(root), ["_meta.json"], "no temp file is left behind");
});

test("a failed rename leaves the original file whole and no temp file behind", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "req-atomic-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "_meta.json");
  writeFileSync(target, '{"lastIssued":7}\n');
  const { io } = recordingIO();
  const broken = { ...io, renameSync() { const error = new Error("busy"); error.code = "EBUSY"; throw error; } };
  assert.throws(() => writeFileAtomic(target, '{"lastIssued":8}\n', broken), /busy/);
  assert.equal(readFileSync(target, "utf8"), '{"lastIssued":7}\n');
  assert.deepEqual(readdirSync(root), ["_meta.json"]);
});

test("a reader never sees a partly written file while it is being replaced", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "req-torn-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "record.md");
  const stop = join(root, "stop");
  const size = 200_000;
  writeFileSync(target, "a".repeat(size));

  const reader = `
    const { readFileSync, existsSync } = require("node:fs");
    const [target, stop] = process.argv.slice(-2);
    let reads = 0, bad = 0, missing = 0, sample = null;
    while (!existsSync(stop)) {
      let text;
      try { text = readFileSync(target, "utf8"); } catch { missing += 1; continue; }
      reads += 1;
      if (!/^(a+|b+)$/.test(text)) { bad += 1; if (!sample) sample = text.slice(0, 40); }
    }
    console.log(JSON.stringify({ reads, bad, missing, sample }));
  `;
  const child = spawn(process.execPath, ["-e", reader, target, stop], { stdio: ["ignore", "pipe", "inherit"] });
  const done = new Promise((resolve) => {
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", () => resolve(JSON.parse(out || "{}")));
  });
  for (let i = 0; i < 300; i += 1) writeFileAtomic(target, (i % 2 ? "b" : "a").repeat(size));
  writeFileSync(stop, "");
  const result = await done;
  assert.ok(result.reads > 0, "the reader observed the file");
  assert.equal(result.bad, 0, `every read saw a whole file (first bad: ${result.sample})`);
  assert.equal(result.missing, 0, "the file was never absent");
});

// ---------------------------------------------------------------- lock

test("a live lock holder is never displaced, and the command says who holds it", (t) => {
  const s = sandbox(t);
  mkdirSync(s.dir, { recursive: true });
  writeFileSync(join(s.dir, ".lock"), JSON.stringify({ pid: process.pid, at: NOW }));
  const result = s.run(["new", "User login"], { env: { REQ_LOCK_WAIT_MS: "50" } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, new RegExp(`locked by process ${process.pid}`));
  assert.deepEqual(requirementFiles(s.dir), []);
  assert.ok(existsSync(join(s.dir, ".lock")), "the holder's lock stays");
});

test("a lock whose holder cannot be identified is refused, not taken over", (t) => {
  const s = sandbox(t);
  mkdirSync(s.dir, { recursive: true });
  writeFileSync(join(s.dir, ".lock"), "half a line, no pid\n");
  const result = s.run(["new", "User login"], { env: { REQ_LOCK_WAIT_MS: "50" } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /does not name a usable pid/);
  assert.match(result.stderr, /cannot be established/);
  assert.equal(readFileSync(join(s.dir, ".lock"), "utf8"), "half a line, no pid\n");
});

test("a lock left by a dead process is taken over", (t) => {
  const s = sandbox(t);
  const dead = spawnSync(process.execPath, ["-e", ""]);
  mkdirSync(s.dir, { recursive: true });
  writeFileSync(join(s.dir, ".lock"), JSON.stringify({ pid: dead.pid, at: NOW }));
  const result = s.run(["new", "User login"], { env: { REQ_LOCK_WAIT_MS: "50" } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(requirementFiles(s.dir).length, 1);
  assert.equal(existsSync(join(s.dir, ".lock")), false, "the lock is released");
});

// ---------------------------------------------------------------- allocation

test("REQ-001 is the first number, padded to three digits, and the meta records it", (t) => {
  const s = sandbox(t);
  // Assembled at runtime so no credential-shaped string sits in the source; the
  // point is that whatever sits before the "@" never reaches the record.
  s.git("remote", "add", "origin", ["https://", "user", ":", "not-a-real-token", "@github.com/owner/myapp.git"].join(""));
  const result = s.run(["new", "User login", "--alias", "sign-in", "--alias", "登录"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^REQ-001\b/);

  const files = requirementFiles(s.dir);
  assert.deepEqual(files, ["REQ-001-user-login.md"]);
  assert.deepEqual(readMetaJson(s.dir).project, "myapp");
  assert.equal(readMetaJson(s.dir).lastIssued, 1);

  const { frontmatter, body } = parseRecord(readFileSync(join(s.dir, files[0]), "utf8"));
  assert.equal(frontmatter.id, "REQ-001");
  assert.equal(frontmatter.title, "User login");
  assert.equal(frontmatter.status, "active");
  assert.equal(frontmatter.rev, 1);
  assert.deepEqual(frontmatter.aliases, ["sign-in", "登录"]);
  assert.equal(frontmatter.repo_path, s.repo);
  assert.equal(frontmatter.repo_remote, "github.com/owner/myapp", "credentials are stripped from the remote");
  assert.match(frontmatter.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  assert.match(body, /## Summary/);
});

test("a number is persisted before its file, so an interrupted create costs a gap and never a reused number", (t) => {
  const s = sandbox(t);
  // Only the allocation lands: the file write is what the interruption would cut.
  assert.equal(allocateId(s.dir, { project: "myapp" }), 1);
  assert.equal(readMetaJson(s.dir).lastIssued, 1);
  assert.deepEqual(requirementFiles(s.dir), []);

  assert.equal(s.run(["new", "Retry after the crash"]).status, 0);
  assert.deepEqual(requirementFiles(s.dir), ["REQ-002-retry-after-the-crash.md"]);
  assert.equal(readMetaJson(s.dir).lastIssued, 2);

  // A hand-issued number above lastIssued, and a gap, both only push it upward.
  writeFileSync(join(s.dir, "REQ-005-hand-written.md"), emitRecord(
    { ...newRecord({ id: "REQ-005", title: "Hand written", repoPath: s.repo, now: NOW }) }, "## Summary\nx\n"));
  assert.equal(s.run(["new", "After the hand write"]).status, 0);
  assert.deepEqual(requirementFiles(s.dir).sort(), [
    "REQ-002-retry-after-the-crash.md", "REQ-005-hand-written.md", "REQ-006-after-the-hand-write.md",
  ]);
  assert.equal(readMetaJson(s.dir).lastIssued, 6);
});

test("lastIssued is never lowered, even when every file is gone", (t) => {
  const s = sandbox(t);
  mkdirSync(s.dir, { recursive: true });
  writeFileSync(join(s.dir, "_meta.json"), JSON.stringify({ project: "myapp", lastIssued: 9, updated_at: NOW }));
  assert.equal(s.run(["new", "After pruning"]).status, 0);
  assert.deepEqual(requirementFiles(s.dir), ["REQ-010-after-pruning.md"]);
  assert.equal(readMetaJson(s.dir).lastIssued, 10);

  // The same number stored as a JSON string — a hand edit, or another tool — is
  // still the high-water mark: "12" reads as 12, and never licenses reissuing 3.
  // The files are what is missing here, so `_meta.json` is the only memory left.
  const s2 = sandbox(t);
  writeRecord(s2, 1, "First");
  writeRecord(s2, 2, "Second");
  writeFileSync(join(s2.dir, "_meta.json"), `${JSON.stringify({ project: "myapp", lastIssued: "12", updated_at: NOW })}\n`);

  const report = s2.run(["doctor", "--repair-log"]);
  assert.equal(report.status, 0, report.stdout + report.stderr);
  assert.match(report.stdout, /lastIssued "12"/);
  assert.equal(readMetaJson(s2.dir).lastIssued, 12, "the readable value survives, and is stored as a number");
  assert.equal(s2.run(["new", "After twelve"]).stdout.split(/\s+/)[0], "REQ-013");

  // `new` alone must not reissue it either: the allocator reads the same value.
  const s3 = sandbox(t);
  writeRecord(s3, 1, "First");
  writeRecord(s3, 2, "Second");
  writeFileSync(join(s3.dir, "_meta.json"), `${JSON.stringify({ project: "myapp", lastIssued: "12", updated_at: NOW })}\n`);
  assert.equal(s3.run(["new", "After twelve"]).stdout.split(/\s+/)[0], "REQ-013");
  assert.equal(readMetaJson(s3.dir).lastIssued, 13);
});

test("concurrent creates all land on distinct numbers", async (t) => {
  const s = sandbox(t);
  const runs = Array.from({ length: 8 }, (_, i) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "new", `Parallel ${i}`], { cwd: s.repo, env: s.env });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stderr }));
  }));
  const results = await Promise.all(runs);
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  const ids = requirementFiles(s.dir).map((file) => file.split("-").slice(0, 2).join("-"));
  assert.deepEqual([...new Set(ids)].length, 8, `distinct ids: ${ids.join(", ")}`);
  assert.equal(readMetaJson(s.dir).lastIssued, 8);
});

// ---------------------------------------------------------------- commands

// A record written by hand, for the states only damage or an older tool produces.
function writeRecord(s, n, title, overrides = {}) {
  mkdirSync(s.dir, { recursive: true });
  const record = { ...newRecord({ id: idFor(n), title, repoPath: s.repo, now: NOW }), ...overrides };
  writeFileSync(join(s.dir, fileNameFor(record.id, title)), emitRecord(record, "## Summary\nHand written.\n"));
  return record;
}

test("new records its write in the audit log", (t) => {
  const s = sandbox(t);
  assert.equal(s.run(["new", "User login"]).status, 0);
  const [entry] = readLogLines(s.dir);
  const file = requirementFiles(s.dir)[0];
  const { body } = parseRecord(readFileSync(join(s.dir, file), "utf8"));
  assert.equal(entry.op, "new");
  assert.equal(entry.id, "REQ-001");
  assert.equal(entry.rev, 1);
  assert.equal(entry.file, file);
  assert.equal(entry.body_sha, bodyDigest(body));
  assert.equal(entry.seq, 1);
});

test("list shows each requirement with its status and title", (t) => {
  const s = sandbox(t);
  assert.equal(s.run(["new", "User login"]).status, 0);
  assert.equal(s.run(["new", "Checkout"]).status, 0);
  const result = s.run(["list"]);
  assert.equal(result.status, 0, result.stderr);
  const [first, second] = lines(result.stdout);
  assert.match(first, /^REQ-001\s+active\b.*User login$/);
  assert.match(second, /^REQ-002\s+active\b.*Checkout$/);
});

test("list on a project with no ledger says so instead of failing", (t) => {
  const s = sandbox(t);
  const result = s.run(["list"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no requirements/);
});

test("show prints the requirement file itself, and an unknown number is an error", (t) => {
  const s = sandbox(t);
  assert.equal(s.run(["new", "User login"]).status, 0);
  const shown = s.run(["show", "REQ-001"]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stdout, readFileSync(join(s.dir, "REQ-001-user-login.md"), "utf8"));
  assert.equal(s.run(["show", "1"]).stdout, shown.stdout, "a bare number resolves too");

  const missing = s.run(["show", "REQ-042"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /no requirement REQ-042/);
});

test("retire flips the status and keeps the file, the number and the prose", (t) => {
  const s = sandbox(t);
  assert.equal(s.run(["new", "User login"]).status, 0);
  const before = parseRecord(readFileSync(join(s.dir, "REQ-001-user-login.md"), "utf8"));

  const retired = s.run(["retire", "REQ-001"]);
  assert.equal(retired.status, 0, retired.stderr);
  assert.match(retired.stdout, /REQ-001 retired/);

  const after = parseRecord(readFileSync(join(s.dir, "REQ-001-user-login.md"), "utf8"));
  assert.equal(after.frontmatter.status, "retired");
  assert.equal(after.frontmatter.rev, before.frontmatter.rev + 1);
  assert.equal(after.frontmatter.id, "REQ-001");
  assert.equal(after.body, before.body, "retire leaves the prose alone");
  assert.deepEqual(requirementFiles(s.dir), ["REQ-001-user-login.md"]);

  assert.match(s.run(["list"]).stdout, /^REQ-001\s+retired\b/m);
  const log = readLogLines(s.dir);
  assert.equal(log.at(-1).op, "retire");
  assert.equal(log.at(-1).rev, after.frontmatter.rev);

  // Retiring twice changes nothing, and the number is not handed out again.
  const again = s.run(["retire", "REQ-001"]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already retired/);
  assert.equal(parseRecord(readFileSync(join(s.dir, "REQ-001-user-login.md"), "utf8")).frontmatter.rev, after.frontmatter.rev);

  assert.equal(s.run(["new", "Something else"]).status, 0);
  assert.deepEqual(requirementFiles(s.dir), ["REQ-001-user-login.md", "REQ-002-something-else.md"]);
});

// ---------------------------------------------------------------- audit gaps

test("a write survives a failed audit append, and doctor reports the gap", (t) => {
  const s = sandbox(t);
  assert.equal(s.run(["new", "User login"]).status, 0);
  const file = join(s.dir, "REQ-001-user-login.md");
  const before = readFileSync(file, "utf8");

  chmodSync(join(s.dir, "_log.jsonl"), 0o444);
  const retired = s.run(["retire", "REQ-001"]);
  assert.equal(retired.status, 0, "a failed audit append does not fail the command");
  assert.match(retired.stderr, /audit log could not be written/);
  assert.equal(parseRecord(readFileSync(file, "utf8")).frontmatter.status, "retired", "the file is authoritative");

  const gap = s.run(["doctor"]);
  assert.equal(gap.status, 1);
  assert.match(gap.stdout, /audit-stale|audit gap|stops at rev 1/);

  chmodSync(join(s.dir, "_log.jsonl"), 0o644);
  const repaired = s.run(["doctor", "--repair-log"]);
  assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
  assert.match(repaired.stdout, /\[repaired\]/);
  assert.equal(parseRecord(readFileSync(file, "utf8")).body, parseRecord(before).body, "the repair writes no prose");
  assert.equal(parseRecord(readFileSync(file, "utf8")).frontmatter.status, "retired");

  const recovery = readLogLines(s.dir).at(-1);
  assert.equal(recovery.op, "log-repair");
  assert.equal(recovery.rev, 2);
  assert.equal(recovery.reason, "stale");
  assert.equal(s.run(["doctor"]).status, 0, "the ledger is consistent again");
});

// ---------------------------------------------------------------- doctor

test("doctor reports a duplicate id, a damaged file and a missing audit line, and repairs only the log", (t) => {
  const s = sandbox(t);
  assert.equal(s.run(["new", "User login"]).status, 0);
  writeFileSync(join(s.dir, "REQ-001-copy.md"), readFileSync(join(s.dir, "REQ-001-user-login.md"), "utf8"));
  writeFileSync(join(s.dir, "REQ-002-broken.md"), "---\nid: [\n---\n## Summary\n");
  writeRecord(s, 3, "Unlogged");

  const report = s.run(["doctor"]);
  assert.equal(report.status, 1, report.stdout + report.stderr);
  assert.match(report.stdout, /duplicate id REQ-001/);
  assert.match(report.stdout, /REQ-002-broken\.md: the frontmatter/);
  assert.match(report.stdout, /REQ-003: the audit log has no line/);

  const repaired = s.run(["doctor", "--repair-log"]);
  assert.equal(repaired.status, 1, "the duplicate and the damaged file are not repairable");
  assert.match(repaired.stdout, /REQ-003: the audit log has no line[^\n]*\[repaired\]/);
  assert.doesNotMatch(repaired.stdout, /duplicate id REQ-001[^\n]*\[repaired\]/);
  assert.doesNotMatch(repaired.stdout, /REQ-002-broken\.md[^\n]*\[repaired\]/, "an unreadable file is never repaired blind");
});

test("doctor repairs lastIssued upward from the files present, and never downward", (t) => {
  const s = sandbox(t);
  assert.equal(s.run(["new", "First"]).status, 0);
  writeRecord(s, 5, "Fifth");
  writeFileSync(join(s.dir, "_meta.json"), `${JSON.stringify({ project: "myapp", lastIssued: 2, updated_at: NOW })}\n`);

  const repaired = s.run(["doctor", "--repair-log"]);
  assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
  assert.match(repaired.stdout, /lastIssued 2 is below the highest requirement number 5 \(repaired to 5\)/);
  assert.equal(readMetaJson(s.dir).lastIssued, 5);

  // A lastIssued ahead of the files is a gap, not a fault: it stays where it is.
  writeFileSync(join(s.dir, "_meta.json"), `${JSON.stringify({ project: "myapp", lastIssued: 9, updated_at: NOW })}\n`);
  const clean = s.run(["doctor"]);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.equal(readMetaJson(s.dir).lastIssued, 9);
  assert.equal(s.run(["new", "After nine"]).stdout.split(/\s+/)[0], "REQ-010");
});

test("a damaged _meta.json is rebuilt from the files present, not trusted", (t) => {
  const s = sandbox(t);
  assert.equal(s.run(["new", "First"]).status, 0);
  writeRecord(s, 4, "Fourth");
  writeFileSync(join(s.dir, "_meta.json"), "{ half a file");

  const report = s.run(["doctor", "--repair-log"]);
  assert.equal(report.status, 0, report.stdout + report.stderr);
  assert.match(report.stdout, /_meta\.json cannot be trusted/);
  assert.equal(readMetaJson(s.dir).lastIssued, 4);
  assert.equal(s.run(["new", "After the repair"]).stdout.split(/\s+/)[0], "REQ-005");

  // A value that does not read as a number at all still repairs upward from the
  // files, and the number it repairs to is the files' maximum, never a file's smaller one.
  writeFileSync(join(s.dir, "_meta.json"), `${JSON.stringify({ project: "myapp", lastIssued: "banana", updated_at: NOW })}\n`);
  const second = s.run(["doctor", "--repair-log"]);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /cannot be trusted/);
  assert.equal(readMetaJson(s.dir).lastIssued, 5);
  assert.equal(s.run(["new", "After the second repair"]).stdout.split(/\s+/)[0], "REQ-006");
});

test("a gap in the numbering is healthy, not a finding", (t) => {
  const s = sandbox(t);
  assert.equal(s.run(["new", "First"]).status, 0);
  writeRecord(s, 5, "Fifth");
  writeFileSync(join(s.dir, "_meta.json"), `${JSON.stringify({ project: "myapp", lastIssued: 5, updated_at: NOW })}\n`);
  assert.equal(s.run(["doctor", "--repair-log"]).status, 0);

  const clean = s.run(["doctor"]);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /clean/);
  assert.equal(readMetaJson(s.dir).lastIssued, 5);
});

test("commands that arrive in later tickets say so instead of inventing behaviour", (t) => {
  const s = sandbox(t);
  // `lookup` has left this list; its own tests live in lookup.test.mjs.
  for (const name of ["context", "link", "sync", "note"]) {
    const result = s.run([name]);
    assert.equal(result.status, 2, name);
    assert.match(result.stderr, /not part of this build yet/);
  }
  assert.equal(s.run(["frobnicate"]).status, 2);
  assert.match(s.run([]).stdout, /usage: req/);
});
