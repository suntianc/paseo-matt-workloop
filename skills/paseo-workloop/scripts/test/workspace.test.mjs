import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const runner = fileURLToPath(new URL("../agent-run.mjs", import.meta.url));

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workloop-workspace-")));
  const repo = join(root, "repo"), worktree = join(root, "task"), called = join(root, "called");
  const git = (...args) => {
    const r = spawnSync("git", args, { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    assert.equal(r.status, 0, r.stderr);
  };
  git("init", "-q", "-b", "main", repo);
  git("-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "base");
  git("-C", repo, "worktree", "add", "-qb", "task", worktree);
  const cli = join(root, "codex");
  writeFileSync(cli, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(called)}, process.cwd());\nconsole.log('{"type":"thread.started","thread_id":"test"}');\n`);
  chmodSync(cli, 0o755);
  const prompt = join(root, "prompt.md");
  writeFileSync(prompt, "test");
  const spec = { provider: "codex", settings: { mode: "read-only" }, prompt, log: join(root, "turn.log"), meta: join(root, "meta.json"), cwd: worktree, workspace: { root: worktree, branch: "task" } };
  const run = () => {
    const file = join(root, "spec.json");
    writeFileSync(file, JSON.stringify(spec));
    return spawnSync(process.execPath, [runner, file], { encoding: "utf8", cwd: repo, env: { ...process.env, PATH: `${root}:${process.env.PATH}`, NO_COLOR: "1" } });
  };
  return { repo, worktree, called, spec, git, run, meta: () => JSON.parse(readFileSync(spec.meta, "utf8")) };
}

test("agent starts in the expected worktree and records its actual identity", () => {
  const f = fixture(), r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(f.called, "utf8"), f.worktree);
  assert.deepEqual(f.meta().workspace, { root: f.worktree, branch: "task" });
  assert.match(readFileSync(f.spec.log, "utf8"), /workspace: .*task.*branch=task/);
});

test("a stale cwd pointing at the main checkout refuses before invoking the provider", () => {
  const f = fixture();
  f.spec.cwd = f.repo;
  const r = f.run();
  assert.equal(r.status, 2);
  assert.equal(existsSync(f.called), false);
  assert.match(readFileSync(f.spec.log, "utf8"), /workspace mismatch/);
  assert.equal(f.meta().exitCode, 2);
});

test("switching branches after dispatch refuses before invoking the provider", () => {
  const f = fixture();
  f.git("-C", f.worktree, "checkout", "-qb", "other");
  assert.equal(f.run().status, 2);
  assert.equal(existsSync(f.called), false);
});

test("an old turn spec without workspace identity still runs", () => {
  const f = fixture();
  delete f.spec.workspace;
  assert.equal(f.run().status, 0);
  assert.equal(existsSync(f.called), true);
});
