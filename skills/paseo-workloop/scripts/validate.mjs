#!/usr/bin/env node
// Read-only command validation with durable receipts. Detection, not a sandbox:
// transient changes restored before a snapshot and ignored outputs are outside it.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runOneCheck } from "./workloop.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
function git(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.error || r.status !== 0) throw new Error(r.error?.message || r.stderr.trim() || `git ${args[0]} failed`);
  return r.stdout;
}

export function snapshot(repo) {
  const contents = createHash("sha256");
  const files = git(repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0").filter(Boolean);
  for (const name of [...new Set(files)].sort()) {
    const path = join(repo, name);
    contents.update(name).update("\0");
    if (!existsSync(path) && !isSymlink(path)) { contents.update("missing\0"); continue; }
    const stat = lstatSync(path);
    contents.update(String(stat.mode)).update("\0");
    if (stat.isSymbolicLink()) contents.update(readlinkSync(path));
    else if (stat.isFile()) contents.update(readFileSync(path));
    else throw new Error(`Unsupported tracked entry: ${name}`);
    contents.update("\0");
  }
  return {
    head: git(repo, "rev-parse", "HEAD").trim(),
    branch: git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim(),
    index: digest(git(repo, "ls-files", "--stage", "-z")),
    status: git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all"),
    contents: contents.digest("hex"),
  };
}
function isSymlink(path) {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}
const differences = (before, after) => Object.keys(before).filter((key) => before[key] !== after[key]);
const inside = (root, path) => {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
};

export async function main(argv) {
  const { values: opts } = parseArgs({ args: argv, options: {
    repo: { type: "string" }, output: { type: "string" },
    "expect-sha": { type: "string" }, "expect-branch": { type: "string" },
    "preflight": { type: "string", multiple: true },
    check: { type: "string", multiple: true },
    "repeat-check": { type: "string", multiple: true },
    "reuse-identical": { type: "boolean" }, timeout: { type: "string" },
  } });
  if (!opts.output) throw new Error("--output needs a new directory outside the worktree (its parent must exist)");
  const minutes = Number(opts.timeout ?? 30);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) throw new Error("--timeout takes minutes > 0 and <= 1440");
  const repo = realpathSync(git(resolve(opts.repo ?? "."), "rev-parse", "--show-toplevel").trim());
  const output = join(realpathSync(dirname(resolve(opts.output))), basename(resolve(opts.output)));
  if (inside(repo, output)) throw new Error("--output must be outside the worktree");
  const entries = [
    ...(opts.preflight ?? []).map((cmd) => ({ cmd, phase: "preflight" })),
    ...(opts.check ?? []).map((cmd) => ({ cmd, phase: "check" })),
    ...(opts["repeat-check"] ?? []).map((cmd) => ({ cmd, phase: "repeat", repeat: true })),
  ];
  if (!entries.length || entries.some(({ cmd }) => !cmd.trim())) throw new Error("Provide non-empty --preflight, --check or --repeat-check commands");
  mkdirSync(output, { mode: 0o700 }); // EEXIST preserves previous receipts, including failures.
  const path = join(output, "receipt.json");
  const receipt = { version: 1, repo, startedAt: new Date().toISOString(), complete: false, ok: false, checks: [] };
  const save = () => { writeFileSync(`${path}.tmp`, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 }); renameSync(`${path}.tmp`, path); };
  save();
  try {
    const initial = snapshot(repo);
    receipt.initial = initial;
    if (initial.status) throw new Error("Validation requires a clean worktree; existing changes were preserved");
    if (initial.branch === "HEAD") throw new Error("Validation requires an attached branch");
    if (opts["expect-sha"] && initial.head !== opts["expect-sha"]) throw new Error("HEAD does not match --expect-sha (use the full commit SHA)");
    if (opts["expect-branch"] && initial.branch !== opts["expect-branch"]) throw new Error("Branch does not match --expect-branch");
    // The environment stays in this process; receipts contain only its digest.
    const environment = digest(JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b))));
    receipt.environment = environment;
    const successes = new Map();
    for (const entry of entries) {
      const before = snapshot(repo);
      const drift = differences(initial, before);
      if (drift.length) throw new Error(`Worktree changed before the next check: ${drift.join(", ")}`);
      const check = { ...entry, startedAt: new Date().toISOString(), before };
      receipt.checks.push(check);
      const key = digest(JSON.stringify([repo, before, environment, entry.cmd]));
      if (opts["reuse-identical"] && !entry.repeat && successes.has(key)) {
        check.reusedFrom = successes.get(key);
        check.ok = true;
        save();
        continue;
      }
      // An intervening command may change ignored dependencies or other
      // inputs that the repository snapshot cannot see. Reuse only a run of
      // consecutive identical checks, never a success from before another command.
      successes.clear();
      save();
      check.log = join(output, `check-${receipt.checks.length}.log`);
      const result = await runOneCheck(entry.cmd, repo, Math.max(1, Math.round(minutes * 60000)), (pid, token) => {
        check.pid = pid; check.token = token; save();
      }, check.log);
      check.result = result;
      check.finishedAt = new Date().toISOString();
      check.after = snapshot(repo);
      check.drift = differences(initial, check.after);
      check.ok = result.ok && check.drift.length === 0;
      save();
      if (!check.ok) throw new Error(check.drift.length ? `Read-only validation changed: ${check.drift.join(", ")}; left untouched` : "Check failed; first result retained");
      if (!entry.repeat) successes.set(key, receipt.checks.length - 1);
    }
    receipt.ok = true;
  } catch (error) { receipt.error = error.message; }
  finally { receipt.complete = true; receipt.finishedAt = new Date().toISOString(); save(); }
  console.log(`${receipt.ok ? "passed" : "failed"}: ${path}`);
  return receipt.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
