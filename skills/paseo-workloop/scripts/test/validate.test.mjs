import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { winQuote } from "../workloop.mjs";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../validate.mjs", import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "wl-validate-"));
  const repo = join(root, "repo");
  const git = (...args) => {
    const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  assert.equal(spawnSync("git", ["init", "-q", "-b", "candidate", repo]).status, 0);
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "source.txt"), "original\n");
  writeFileSync(join(repo, "lockfile"), "original\n");
  writeFileSync(join(repo, ".gitignore"), "generated\n");
  git("add", "."); git("commit", "-qm", "base");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "evidence");
  return { root, repo, output, git,
    run: (...args) => spawnSync(process.execPath, [CLI, "--repo", repo, "--output", output, ...args], { encoding: "utf8" }),
    receipt: () => JSON.parse(readFileSync(join(output, "receipt.json"), "utf8")),
  };
}
const programs = mkdtempSync(join(tmpdir(), "wl-validation-programs-"));
after(() => rmSync(programs, { recursive: true, force: true }));
let programId = 0;
const quote = (value) => process.platform === "win32" ? winQuote(value) : "'" + value.replaceAll("'", "'\\''") + "'";
const node = (source) => {
  const path = join(programs, `${programId++}.cjs`);
  writeFileSync(path, source);
  return `${quote(process.execPath)} ${quote(path)}`;
};

test("records a fixed candidate and full output, while allowing ignored build outputs", (t) => {
  const f = fixture(t);
  const r = f.run("--expect-sha", f.git("rev-parse", "HEAD"), "--expect-branch", "candidate", "--check",
    node("require('fs').writeFileSync('generated','build'); console.log('start'); for(let i=0;i<60;i++)console.log(i)"));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const receipt = f.receipt();
  assert.equal(receipt.complete, true); assert.equal(receipt.ok, true);
  assert.equal(receipt.checks[0].result.exitCode, 0);
  assert.match(readFileSync(receipt.checks[0].log, "utf8"), /^start\n/);
  assert.equal(receipt.checks[0].before.contents, receipt.checks[0].after.contents);
  assert.equal(f.git("status", "--porcelain"), "");
});

test("preflight failure retains exit and output, stops expensive checks, and refuses evidence overwrite", (t) => {
  const f = fixture(t);
  const marker = join(f.root, "should-not-run");
  const r = f.run("--check", node(`require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`),
    "--preflight", node("console.error('type failure'); process.exit(7)"));
  assert.equal(r.status, 1);
  const receipt = f.receipt();
  assert.equal(receipt.checks.length, 1);
  assert.equal(receipt.checks[0].phase, "preflight");
  assert.equal(receipt.checks[0].result.exitCode, 7);
  assert.match(readFileSync(receipt.checks[0].log, "utf8"), /type failure/);
  assert.equal(existsSync(marker), false);
  const original = readFileSync(join(f.output, "receipt.json"), "utf8");
  assert.equal(f.run("--check", node("process.exit(0)")).status, 1);
  assert.equal(readFileSync(join(f.output, "receipt.json"), "utf8"), original);
});

for (const [name, change, field] of [
  ["branch at the same SHA", "git switch -qc another", "branch"],
  ["detached HEAD", "git checkout -q --detach HEAD", "branch"],
  ["HEAD", "git -c commit.gpgsign=false commit -q --allow-empty -m changed", "head"],
  ["tracked contents", node("require('fs').writeFileSync('source.txt','changed')"), "contents"],
  ["staged lockfile", node("require('fs').writeFileSync('lockfile','changed')") + " && git add lockfile", "index"],
  ["untracked file", node("require('fs').writeFileSync('new.txt','changed')"), "contents"],
]) {
  test(`refuses successful commands that change ${name}, without resetting the worktree`, (t) => {
    const f = fixture(t);
    const r = f.run("--check", change, "--check", node("throw Error('must not run')"));
    assert.equal(r.status, 1);
    const receipt = f.receipt();
    assert.equal(receipt.checks.length, 1);
    assert.equal(receipt.checks[0].result.exitCode, 0);
    assert.equal(receipt.checks[0].drift.includes(field), true);
    assert.notDeepEqual(receipt.checks[0].before, receipt.checks[0].after);
    if (field === "branch") assert.notEqual(f.git("rev-parse", "--abbrev-ref", "HEAD"), "candidate");
    if (field === "contents") assert.notEqual(f.git("status", "--porcelain"), "");
  });
}

test("requires clean attached expected candidate before dispatch", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo, "source.txt"), "existing user work");
  assert.equal(f.run("--check", node("throw Error('must not run')")).status, 1);
  assert.equal(f.receipt().checks.length, 0);
  assert.equal(readFileSync(join(f.repo, "source.txt"), "utf8"), "existing user work");
});

test("rejects an incorrect expected SHA without running checks", (t) => {
  const f = fixture(t);
  assert.equal(f.run("--expect-sha", "0".repeat(40), "--check", node("throw Error('must not run')")).status, 1);
  assert.equal(f.receipt().checks.length, 0);
});

test("retains duplicate occurrences by default; explicit reuse maps successes and repeats still execute", (t) => {
  for (const reuse of [false, true]) {
    const f = fixture(t);
    const counter = join(f.root, "counter");
    const cmd = node(`const fs=require('fs');const p=${JSON.stringify(counter)};fs.appendFileSync(p,'x')`);
    const r = f.run(...(reuse ? ["--reuse-identical"] : []), "--check", cmd, "--check", cmd, "--repeat-check", cmd);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const receipt = f.receipt();
    assert.equal(receipt.checks.length, 3);
    assert.equal(readFileSync(counter, "utf8"), reuse ? "xx" : "xxx");
    assert.equal(receipt.checks[1].reusedFrom, reuse ? 0 : undefined);
    assert.equal(receipt.checks[2].reusedFrom, undefined);
  }
});

test("rejects receipts inside the worktree before creating files", (t) => {
  const f = fixture(t);
  const inside = join(f.repo, "evidence");
  const r = spawnSync(process.execPath, [CLI, "--repo", f.repo, "--output", inside, "--check", node("process.exit(0)")], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.equal(existsSync(inside), false);
  assert.equal(f.git("status", "--porcelain"), "");
});

test("does not reuse a success across an intervening command that changes ignored inputs", (t) => {
  const f = fixture(t);
  const check = node("if(require('fs').existsSync('generated'))process.exit(8)");
  const r = f.run("--reuse-identical", "--check", check,
    "--check", node("require('fs').writeFileSync('generated','changed dependency')"), "--check", check);
  assert.equal(r.status, 1);
  const receipt = f.receipt();
  assert.equal(receipt.checks.length, 3);
  assert.equal(receipt.checks[2].reusedFrom, undefined);
  assert.equal(receipt.checks[2].result.exitCode, 8);
});

test("records timeout and owned-process identity as failure", (t) => {
  const f = fixture(t);
  const r = f.run("--timeout", "0.01", "--check", node("console.log('started'); setInterval(()=>{},1000)"));
  assert.equal(r.status, 1);
  const receipt = f.receipt();
  assert.equal(receipt.ok, false);
  assert.equal(receipt.checks[0].result.timedOut, true);
  assert.equal(typeof receipt.checks[0].pid, "number");
  assert.match(receipt.checks[0].token, /^wl-check-/);
  assert.match(readFileSync(receipt.checks[0].log, "utf8"), /started/);
});
