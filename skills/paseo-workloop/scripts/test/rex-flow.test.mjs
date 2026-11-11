// The rex-local flow end to end, against real git and a fake rex CLI: agents are
// turns in Rex tabs, a turn's end is its process exiting, and `wait` is what
// reports it. Guards against: a turn started on a guessed provider, a busy or
// unknown agent treated as idle, a rework that cannot go on in the executor's
// conversation, a `wait` that misses a turn that already ended or never returns.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "workloop.mjs");
const FAKE = join(HERE, "fake-rex.mjs");
const CHECK = `node -e "process.exit(0)"`;
const LAUNCH = { executor: { provider: "dsh", mode: "danger-full-access" }, reviewer: { provider: "devin", mode: "dangerous", model: "review-model" } };

function sandbox({ launch = LAUNCH, init = true, tickets = { "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: works — manual: a reviewer reads it\n" } } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workloop-rex-")));
  const repo = join(root, "repo");
  writeFileSync(join(root, "gitconfig"), "");
  const env = {
    ...process.env, WORKLOOP_ROOT: join(root, "wl"), REX_CLI: FAKE, FAKE_REX_DB: join(root, "rex.json"),
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  };
  delete env.WORKLOOP_RUN;
  delete env.FAKE_REX_FAIL;
  delete env.CODEX_THREAD_ID; // tests may run inside a codex session
  mkdirSync(env.WORKLOOP_ROOT, { recursive: true });
  if (launch) writeFileSync(join(env.WORKLOOP_ROOT, "launch.json"), JSON.stringify(launch));
  const g = (cwd, ...args) => {
    const r = spawnSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const runDir = join(root, "wl", "repo", "feat");
  mkdirSync(join(runDir, "issues"), { recursive: true });
  g(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "shared.txt"), "base\n");
  g(repo, "add", "shared.txt");
  g(repo, "commit", "-q", "-m", "base");
  writeFileSync(join(runDir, "spec.md"), "# Spec\n");
  for (const [f, c] of Object.entries(tickets)) writeFileSync(join(runDir, "issues", f), c);
  const wl = (...args) => {
    const r = spawnSync(process.execPath, [CLI, "--run", "repo/feat", ...args], { env, cwd: repo, encoding: "utf8" });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const ok = (...args) => { const r = wl(...args); assert.equal(r.code, 0, r.out); return r.out; };
  const no = (pattern, ...args) => { const r = wl(...args); assert.notEqual(r.code, 0, r.out); assert.match(r.out, pattern); return r.out; };
  const state = () => JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  const db = () => JSON.parse(readFileSync(env.FAKE_REX_DB, "utf8"));
  const editDb = (fn) => { const d = db(); fn(d); writeFileSync(env.FAKE_REX_DB, JSON.stringify(d)); };
  const block = (id) => db().blocks.find((b) => b.id === id);
  // A turn ends: its meta file says how, as agent-run writes it, and its tab's program exits.
  const endTurn = (agentId, { code = 0, session = `sess-${agentId}` } = {}) => {
    const turn = state().agents[agentId].turns.at(-1);
    writeFileSync(`${turn.base}.json`, JSON.stringify({ provider: "x", session, exitCode: code }));
    editDb((d) => { d.blocks.find((b) => b.id === turn.block).exit = code; });
    return turn;
  };
  // The executor commits, writes its report, and its turn ends.
  const work = (id, { status = "done", file = `f${id}.txt` } = {}) => {
    const t = state().tasks[id];
    writeFileSync(join(t.worktree, file), `ticket ${id} ${Date.now()}\n`);
    g(t.worktree, "add", "-A");
    g(t.worktree, "commit", "-q", "-m", `work ${id}`);
    writeFileSync(join(runDir, "reports", `${id}-${t.attempt}.md`), `Status: ${status}\nCommit: ${g(t.worktree, "rev-parse", "HEAD")}\n\n## Summary\nDid it.\n`);
    return endTurn(t.agentId);
  };
  const reviewed = (id, verdict = "pass", findings = "") => {
    const t = state().tasks[id];
    writeFileSync(t.review.path, `Verdict: ${verdict}\nCandidate: ${t.candidateSha}\n${findings}`);
    return endTurn(t.review.agentId);
  };
  // A command in the background. `.waiting` resolves once `wait` has seen the running
  // turns ("waiting on …"), so a test ends a turn only after wait is watching it.
  const start = (...args) => {
    const child = spawn(process.execPath, [CLI, "--run", "repo/feat", ...args], { env, cwd: repo });
    let out = "";
    let watching;
    const waiting = new Promise((resolve) => { watching = resolve; });
    child.stdout.on("data", (d) => { out += d; if (/waiting on /.test(out)) watching(); });
    child.stderr.on("data", (d) => { out += d; });
    const done = new Promise((resolve) => child.on("close", (code) => { watching(); resolve({ code, out }); }));
    done.waiting = waiting;
    return done;
  };
  const initArgs = ["init", "--feature", "feat", "--repo", repo, "--check", CHECK];
  if (init) ok(...initArgs);
  return { initArgs, root, repo, env, runDir, g, wl, ok, no, state, db, editDb, block, endTurn, work, reviewed, start };
}

test("a ticket goes from dispatch to archive with every agent a turn in the run's Rex session", async () => {
  const sb = sandbox();
  const out = sb.ok("dispatch", "01");
  assert.match(out, /dispatched: dsh mode=danger-full-access ← .*launch\.json in Rex tab "#01 exec a1"/);
  const s = sb.state();
  const t = s.tasks["01"];
  const exec = s.agents[t.agentId];
  assert.equal(exec.role, "executor");
  assert.ok(existsSync(t.worktree) && t.worktree.startsWith(sb.runDir), "the worktree is under the run");
  const tab = sb.block(exec.turns[0].block);
  assert.equal(tab.session, s.rex.session);
  assert.deepEqual(sb.db().blocks.filter((b) => b.session === s.rex.session && !b.closed).map((b) => b.id), [tab.id], "the first agent is the session's only tab");
  assert.equal(tab.label, "#01 exec a1");
  assert.equal(tab.cwd, t.worktree);
  assert.ok(tab.keepOpen, "the tab stays open after the turn, so its output can be read");
  assert.match(tab.argv.join(" "), /agent-run\.mjs .*turns\/.*-1\.spec\.json$/);
  const spec = JSON.parse(readFileSync(tab.argv.at(-1), "utf8"));
  assert.deepEqual([spec.provider, spec.settings, spec.session], ["dsh", { mode: "danger-full-access" }, null]);
  assert.deepEqual(spec.workspace, { root: t.worktree, branch: t.branch });
  assert.match(readFileSync(spec.prompt, "utf8"), /Read the task brief at .*briefs/);

  // While the turn runs, nothing that needs an idle executor proceeds.
  sb.no(/executor .* is running \(Rex tab "#01 exec a1"\)/, "freeze", "01");
  assert.match(sb.ok("status", "--live"), /01 +running +a1 .* running/);

  // `wait` reports the turn that ends, and what it left.
  const waitRun = sb.start("wait", "--for", "1");
  await waitRun.waiting;
  sb.work("01");
  const w = await waitRun;
  assert.equal(w.code, 0, w.out);
  assert.match(w.out, /waiting on "#01 exec a1"/);
  assert.match(w.out, /turn ended: "#01 exec a1" \(exit 0\); #01 reports done/);
  assert.match(w.out, /next: .*review 01/);

  // The reviewer is devin with its model, in the same worktree.
  assert.match(sb.ok("review", "01"), /reviewer devin model=review-model mode=dangerous .* started on [0-9a-f]{8} in Rex tab "#01 review/);
  const r1 = sb.state().tasks["01"].review;
  assert.equal(sb.state().agents[r1.agentId].cwd, t.worktree);
  sb.reviewed("01", "changes_requested", "\n## Findings\n| ID | Axis | Location | Basis | Blocking | Fix acceptance |\n|----|------|----------|-------|----------|----------------|\n| S1 | Standards | f01.txt:1 | AC1: quoted | yes | fixed |\n");

  // The rework is the executor's next turn, in the conversation its first turn named.
  writeFileSync(join(sb.root, "rework.md"), "Fix S1: reproduce it, then fix the cause.");
  assert.match(sb.ok("send", "01", "--file", join(sb.root, "rework.md")), /message 1 sent; the executor goes on in Rex tab "#01 exec a1 · 1"/);
  const exec2 = sb.state().agents[t.agentId];
  assert.equal(exec2.turns.length, 2);
  const spec2 = JSON.parse(readFileSync(`${exec2.turns[1].base}.spec.json`, "utf8"));
  assert.equal(spec2.session, `sess-${t.agentId}`);
  assert.match(readFileSync(spec2.prompt, "utf8"), /Fix S1[\s\S]*This continues task #01/);
  assert.ok(sb.block(exec2.turns[0].block).closed, "the previous turn's tab closes; its files stay");
  assert.ok(existsSync(`${exec2.turns[0].base}.prompt.md`));

  sb.work("01", { file: "fix.txt" });
  sb.ok("review", "01");
  sb.reviewed("01");
  assert.match(sb.ok("integrate", "01"), /#01 integrated/);

  // The final review: its own worktree and tab, then finish and archive.
  const tip = sb.state().integration.tip;
  writeFileSync(join(sb.runDir, "final-review.md"), `Integration tip: ${tip}\n\n## Acceptance\n\n| Row | Spec item | Evidence on the integrated tree |\n|-----|-----------|---------------------------------|\n| M1 | item | evidence |\n`);
  assert.match(sb.ok("final-review"), /final review round 1: devin .* started in Rex tab "final r1/);
  const round = sb.state().finalReview;
  writeFileSync(round.path, `Verdict: pass\nIntegration tip: ${tip}\n`);
  const fw = sb.start("wait");
  await fw.waiting;
  sb.endTurn(round.agentId);
  assert.match((await fw).out, /turn ended: "final r1 [0-9a-f]{8}" \(exit 0\); verdict pass/);
  sb.ok("finish");
  sb.ok("retro", "--skip", "--reason", "test");
  sb.ok("archive");
  const done = sb.state();
  assert.ok(done.finishedAt);
  assert.ok(sb.db().sessions.find((x) => x.id === done.rex.session).killed, "archive closes the run's Rex session");
  const index = JSON.parse(readFileSync(join(sb.runDir, "evidence", "index.json"), "utf8"));
  assert.equal(index.agents.length, 4); // executor, two reviewers, final reviewer
  const transcript = readFileSync(join(sb.runDir, "evidence", `${t.agentId}.txt`), "utf8");
  assert.match(transcript, /=== turn 1 · #01 exec a1[\s\S]*=== turn 2 · #01 exec a1 · 1[\s\S]*Fix S1/);
});

test("no launch settings, an unknown provider, or a setting the CLI does not take refuses before anything is created", () => {
  const none = sandbox();
  unlinkSync(join(none.env.WORKLOOP_ROOT, "launch.json"));
  none.no(/executor: no launch settings: the run sets no --provider, and .*launch\.json has no "executor" entry/, "dispatch", "01");
  assert.ok(!existsSync(join(none.runDir, "worktrees")), "no worktree was made");
  const sb = sandbox();
  sb.no(/executor: provider "paseo" is not one this run can start \(dsh, devin, codex, pi\)/, "dispatch", "01", "--provider", "paseo");
  sb.no(/executor: dsh takes no model \(its model and effort come from the dsh profile; set --profile\)/, "dispatch", "01", "--model", "m");
  // init reads them too, so a run never starts with a role it cannot launch.
  const missing = sandbox({ launch: { ...LAUNCH, executor: { provider: "dsh" } }, init: false });
  missing.no(/executor: dsh needs --mode/, ...missing.initArgs);
});

test("an agent Rex cannot report on is not idle", () => {
  const sb = sandbox();
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.env.FAKE_REX_FAIL = "block call";
  sb.no(/cannot tell whether executor .* is still running: rex block call process failed \(exit 1\): Error: fake failure of block call/, "freeze", "01");
  delete sb.env.FAKE_REX_FAIL;
  assert.match(sb.ok("freeze", "01"), /#01 frozen at/);
});

test("a turn that left no conversation id cannot be gone on in; retry is the way", () => {
  const sb = sandbox();
  sb.ok("dispatch", "01");
  const t = sb.state().tasks["01"];
  sb.endTurn(t.agentId, { session: null });
  sb.no(/left no conversation id .*; `retry` the task instead/, "send", "01", "--text", "go on");
  assert.equal(sb.state().agents[t.agentId].turns.length, 1, "no second turn was started");
});

test("wait returns at once when nothing runs, and after its limit when nothing ends", async () => {
  const sb = sandbox();
  assert.match(sb.ok("wait"), /no turn is running\nnext: .*dispatch 01/);
  sb.ok("dispatch", "01");
  const r = await sb.start("wait", "--for", "0.01");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no turn ended in 0\.01m; "#01 exec a1" last printed/);
  assert.match(r.out, /run `wait` in the background again/);
  sb.no(/wait --for takes a positive number of minutes/, "wait", "--for", "soon");
});

test("a turn that ended before wait started is reported, not waited for", () => {
  const sb = sandbox();
  sb.ok("dispatch", "01");
  sb.endTurn(sb.state().tasks["01"].agentId, { code: 3 });
  // It is no longer running, so there is nothing to wait on; wait says what it left.
  const out = sb.ok("wait");
  assert.match(out, /no turn is running\n"#01 exec a1" ended \(error 3\); it left no fresh report: read its output in .*-1\.log/);
  assert.match(sb.ok("status", "--live"), /01 +running +a1 .* error:3/);
});

test("a turn that exits without a report names its log and the ways on", async () => {
  const sb = sandbox();
  sb.ok("dispatch", "01");
  const t = sb.state().tasks["01"];
  const w = sb.start("wait");
  await w.waiting;
  sb.endTurn(t.agentId, { code: 1 });
  const out = (await w).out;
  assert.match(out, /turn ended: "#01 exec a1" \(exit 1, exit status 1\); it left no fresh report: read its output in .*turns\/.*-1\.log, then `send 01 --text <what to do>` to go on, or `retry 01 --reason <why>`/);
});

test("a dispatch Rex refused leaves the task running with its worktree, and the rerun adopts it", () => {
  const sb = sandbox();
  sb.env.FAKE_REX_FAIL = "new";
  sb.no(/rex new .*failed .*fake failure of new/, "dispatch", "01");
  const t = sb.state().tasks["01"];
  assert.equal(t.status, "running");
  assert.equal(t.agentId, undefined, "no agent is recorded for a turn that never started");
  assert.ok(existsSync(t.worktree));
  delete sb.env.FAKE_REX_FAIL;
  writeFileSync(join(t.worktree, "kept.txt"), "work in the tree survives\n");
  assert.match(sb.ok("dispatch", "01"), /dispatched: .* in Rex tab "#01 exec a1"/);
  const again = sb.state().tasks["01"];
  assert.equal(again.worktree, t.worktree);
  assert.equal(sb.g(sb.repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l === `branch refs/heads/${t.branch}`).length, 1, "one worktree for the branch");
  assert.equal(readFileSync(join(again.worktree, "kept.txt"), "utf8"), "work in the tree survives\n");
  assert.equal(Object.keys(sb.state().agents).length, 1, "one agent");
});

test("later turns share the session; a closed session is recreated with only the new turn", () => {
  const ticket = (name) => `# ${name}\n\nBlocked by: None\n\n- [ ] AC1: works — manual: a reviewer reads it\n`;
  const sb = sandbox({ tickets: { "01-a.md": ticket("01"), "02-b.md": ticket("02"), "03-c.md": ticket("03") } });
  sb.ok("config", "--max-executors", "3");
  sb.ok("dispatch", "01");
  const firstSession = sb.state().rex.session;
  sb.env.FAKE_REX_FAIL = "window new";
  sb.no(/rex window new failed .*fake failure of window new/, "dispatch", "02");
  delete sb.env.FAKE_REX_FAIL;
  sb.ok("dispatch", "02");
  assert.equal(sb.state().rex.session, firstSession);
  assert.deepEqual(sb.db().blocks.filter((b) => b.session === firstSession && !b.closed).map((b) => b.label), ["#01 exec a1", "#02 exec a1"]);

  sb.editDb((d) => {
    d.sessions.find((s) => s.id === firstSession).killed = true;
    for (const block of d.blocks) if (block.session === firstSession) block.closed = true;
  });
  sb.ok("dispatch", "03");
  const nextSession = sb.state().rex.session;
  assert.notEqual(nextSession, firstSession);
  assert.deepEqual(sb.db().blocks.filter((b) => b.session === nextSession && !b.closed).map((b) => b.label), ["#03 exec a1"]);
});

test("a run the Paseo workloop started is only shown: plain status works, everything else is refused", () => {
  const sb = sandbox();
  const file = join(sb.runDir, "state.json");
  const s = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(s.host, "rex");
  delete s.host;
  s.config.executor = { profile: "wl-executor" }; // a Paseo run names Paseo profiles
  writeFileSync(file, JSON.stringify(s));
  const events = readFileSync(join(sb.runDir, "events.jsonl"), "utf8");
  const out = sb.ok("status");
  assert.match(out, /^run repo\/feat · Paseo run · base/);
  assert.match(out, /01 +ready +a1/);
  assert.doesNotMatch(out, /UNRESOLVED|launch\.json/, "its launch settings are Paseo's, not shown as this copy's");
  assert.match(out, /next: started by the Paseo workloop: continue it with that copy of the skill \(this one is rex-local\)/);
  const json = JSON.parse(sb.ok("status", "--json"));
  assert.equal(json.launch, null);
  assert.deepEqual(json.next, ["started by the Paseo workloop: continue it with that copy of the skill (this one is rex-local)"]);
  for (const args of [["status", "--live"], ["dispatch", "01"], ["note", "--text", "x"], ["wait"]]) {
    sb.no(/was started by the Paseo workloop; continue it with that copy of the skill \(this one is rex-local\)\. `status` without --live shows it\./, ...args);
  }
  assert.equal(readFileSync(join(sb.runDir, "events.jsonl"), "utf8"), events, "nothing was recorded");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), s, "the state is untouched");
});

test("a role's thinking setting reaches its turn, and pi starts with no mode", () => {
  const sb = sandbox({ launch: { executor: { provider: "codex", mode: "danger-full-access", thinking: "high" }, reviewer: { provider: "pi", model: "magpie/x", thinking: "low" } } });
  sb.ok("dispatch", "01");
  const t = sb.state().tasks["01"];
  const exec = sb.state().agents[t.agentId];
  const spec = JSON.parse(readFileSync(`${exec.turns[0].base}.spec.json`, "utf8"));
  assert.deepEqual([spec.provider, spec.settings], ["codex", { mode: "danger-full-access", thinking: "high" }]);
  sb.work("01");
  assert.match(sb.ok("review", "01"), /reviewer pi model=magpie\/x thinking=low ← .*launch\.json started on/);
  const rev = sb.state().agents[sb.state().tasks["01"].review.agentId];
  assert.deepEqual(JSON.parse(readFileSync(`${rev.turns[0].base}.spec.json`, "utf8")).settings, { model: "magpie/x", thinking: "low" });
});

test("wait --wake codex queues what it printed into the codex session that started it", async () => {
  const sb = sandbox();
  const log = join(sb.root, "codex.jsonl");
  Object.assign(sb.env, { WORKLOOP_CODEX_CLI: join(HERE, "fake-codex.mjs"), FAKE_CODEX_LOG: log });
  sb.no(/--wake codex needs CODEX_THREAD_ID: start it from the codex session it should wake/, "wait", "--wake", "codex");
  sb.env.CODEX_THREAD_ID = "thread-1";
  sb.no(/--wake takes codex, not "pi" \(Claude Code and pi with pi-background-run wake/, "wait", "--wake", "pi");
  // Nothing runs: waking would only bring the orchestrator back to start this again.
  sb.no(/no turn is running, so there is nothing to wake you for/, "wait", "--wake", "codex");
  assert.ok(!existsSync(log), "no queue call");

  sb.ok("dispatch", "01");
  const w = sb.start("wait", "--wake", "codex");
  await w.waiting;
  sb.work("01");
  const r = await w;
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /woke codex session thread-1/);
  const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(calls.length, 1);
  const [cmd, flag, thread, mflag, message, resume] = calls[0];
  assert.deepEqual([cmd, flag, thread, mflag, resume], ["queue", "--thread", "thread-1", "--message", "--resume"]);
  assert.match(message, /^\[workloop repo\/feat\]\nturn ended: "#01 exec a1" \(exit 0\); #01 reports done in .*reports\/01-a1\.md\nnext: review 01/);
  assert.match(message, /start `node .*workloop\.mjs' --run '.*' wait --wake codex` in a background terminal again\.$/);
});

test("wait --wake codex says so when the queue fails, and a timeout wakes the session too", async () => {
  const sb = sandbox();
  const log = join(sb.root, "codex.jsonl");
  Object.assign(sb.env, { WORKLOOP_CODEX_CLI: join(HERE, "fake-codex.mjs"), FAKE_CODEX_LOG: log, CODEX_THREAD_ID: "thread-2" });
  sb.ok("dispatch", "01");
  const timedOut = await sb.start("wait", "--for", "0.01", "--wake", "codex");
  assert.equal(timedOut.code, 0, timedOut.out);
  assert.match(JSON.parse(readFileSync(log, "utf8").trim()).at(4), /no turn ended in 0\.01m; "#01 exec a1" last printed/);
  sb.env.FAKE_CODEX_EXIT = "1";
  const failed = await sb.start("wait", "--for", "0.01", "--wake", "codex");
  assert.notEqual(failed.code, 0);
  assert.match(failed.out, /could not wake codex session thread-2: Error: fake queue failure/);
});

test("integrate keeps each check's output, runs a shared command once, and a retry on the same tree runs only what did not pass", async () => {
  // c1 is both a run check and the ticket's criterion; the second check fails until FLAKY_OK exists.
  const c1 = `node -e "require('fs').appendFileSync(process.env.COUNT_LOG, 'c1\\n')"`;
  const flaky = `node -e "console.log('flaky ran'); process.exit(require('fs').existsSync(process.env.FLAKY_OK) ? 0 : 1)"`;
  const sb = sandbox({ init: false, tickets: { "01-a.md": `# 01: A\n\nBlocked by: None\n\n- [ ] AC1: counts — check: \`${c1}\`\n` } });
  const count = join(sb.root, "count.log");
  const okFile = join(sb.root, "flaky-ok");
  const log = join(sb.root, "codex.jsonl");
  Object.assign(sb.env, { COUNT_LOG: count, FLAKY_OK: okFile, WORKLOOP_CODEX_CLI: join(HERE, "fake-codex.mjs"), FAKE_CODEX_LOG: log, CODEX_THREAD_ID: "thread-3" });
  writeFileSync(okFile, ""); // init runs the checks on the base
  sb.ok("init", "--feature", "feat", "--repo", sb.repo, "--check", c1, "--check", flaky);
  unlinkSync(okFile);
  writeFileSync(count, "");
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  sb.reviewed("01");

  // The environment fails the second check: rolled back, and the message names the whole log.
  const failed = sb.wl("integrate", "01", "--wake", "codex");
  assert.notEqual(failed.code, 0, failed.out);
  assert.match(failed.out, /checks: 2 ran; logs in .*evidence\/checks\/integrate-01-/);
  assert.match(failed.out, /fails after merging[\s\S]*Whole output: .*evidence\/checks\/integrate-01-[^/]+\/02\.log/);
  assert.equal(readFileSync(count, "utf8"), "c1\n", "the criterion that repeats a check runs once");
  const logDir = readdirSync(join(sb.runDir, "evidence", "checks"));
  assert.equal(logDir.length, 1);
  assert.match(readFileSync(join(sb.runDir, "evidence", "checks", logDir[0], "02.log"), "utf8"), /flaky ran/);
  // --wake codex queued what it printed and how it ended.
  const woke = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1));
  assert.match(woke[4], /^\[workloop repo\/feat\]\nchecks: 2 ran[\s\S]*`integrate` failed: [\s\S]*Whole output:/);

  // Fixed outside the tree: the retry merges to the same tree and runs only what did not pass.
  writeFileSync(okFile, "");
  const retried = sb.ok("integrate", "01");
  assert.match(retried, /checks: 1 ran, 1 passed earlier on this tree and were not run again/);
  assert.match(retried, /#01 integrated/);
  assert.equal(readFileSync(count, "utf8"), "c1\n");

  // finish on the tree the integration checked runs nothing again.
  const tip = sb.state().integration.tip;
  writeFileSync(join(sb.runDir, "final-review.md"), `Integration tip: ${tip}\n\n## Acceptance\n\n| Row | Spec item | Evidence on the integrated tree |\n|-----|-----------|---------------------------------|\n| M1 | item | evidence |\n`);
  sb.ok("final-review");
  const round = sb.state().finalReview;
  writeFileSync(round.path, `Verdict: pass\nIntegration tip: ${tip}\n`);
  sb.endTurn(round.agentId);
  const finished = sb.ok("finish", "--wake", "codex");
  assert.match(finished, /checks: 0 ran, 2 passed earlier on this tree/);
  assert.match(JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1))[4], /delivery checked[\s\S]*`finish` finished/);
  assert.equal(readFileSync(count, "utf8"), "c1\n");
});

test("full checks run only at the end, and the final reviewer's validate receipt on the tip stands for them", () => {
  const full = `node -e "require('fs').appendFileSync(process.env.COUNT_LOG, 'full\\n')"`;
  const sb = sandbox({ init: false });
  const count = join(sb.root, "count.log");
  sb.env.COUNT_LOG = count;
  sb.ok("init", "--feature", "feat", "--repo", sb.repo, "--check", CHECK, "--full-check", full);
  assert.deepEqual(sb.state().config.fullChecks, [full]);
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  sb.reviewed("01");
  assert.match(sb.ok("integrate", "01"), /checks: 1 ran;/);
  assert.ok(!existsSync(count), "integrate does not run the full checks");

  const tip = sb.state().integration.tip;
  writeFileSync(join(sb.runDir, "final-review.md"), `Integration tip: ${tip}\n\n## Acceptance\n\n| Row | Spec item | Evidence on the integrated tree |\n|-----|-----------|---------------------------------|\n| M1 | item | evidence |\n`);
  sb.ok("final-review");
  const round = sb.state().finalReview;
  assert.ok(readFileSync(readdirSync(join(sb.runDir, "briefs")).filter((f) => f.startsWith("final-")).map((f) => join(sb.runDir, "briefs", f))[0], "utf8").includes(full), "the final brief lists the full checks");
  // The final reviewer runs the full checks on the tip through validate.mjs.
  const v = spawnSync(process.execPath, [join(HERE, "..", "validate.mjs"), "--repo", round.worktree, "--expect-sha", tip, "--expect-branch", round.branch,
    "--output", join(sb.runDir, "evidence", "final-1-full"), "--check", full], { env: sb.env, encoding: "utf8" });
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.equal(readFileSync(count, "utf8"), "full\n");
  writeFileSync(round.path, `Verdict: pass\nIntegration tip: ${tip}\n`);
  sb.endTurn(round.agentId);
  const out = sb.ok("finish");
  assert.match(out, /checks: 0 ran, 2 passed earlier on this tree/);
  assert.match(out, /not run again: `node -e .*full.*` \(passed: .*evidence\/final-1-full\/check-1\.log\)/);
  assert.equal(readFileSync(count, "utf8"), "full\n", "finish does not run the full checks a second time");
  // --fresh runs them, receipts or not.
  assert.match(sb.ok("finish", "--fresh"), /checks: 2 ran;/);
  assert.equal(readFileSync(count, "utf8"), "full\nfull\n");
});

function readyForFinal() {
  const sb = sandbox();
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  sb.reviewed("01");
  sb.ok("integrate", "01");
  const tip = sb.state().integration.tip;
  writeFileSync(join(sb.runDir, "final-review.md"), `Integration tip: ${tip}\n\n## Acceptance\n\n| Row | Spec item | Evidence on the integrated tree |\n|-----|-----------|---------------------------------|\n| M1 | item | evidence |\n`);
  return sb;
}

test("final review prepares its own ignored environment before launching the reviewer", () => {
  const sb = readyForFinal();
  writeFileSync(join(sb.state().integration.worktree, ".gitignore"), ".env\n");
  // Ignore the local environment in every worktree without changing the candidate.
  const exclude = sb.g(sb.repo, "rev-parse", "--git-path", "info/exclude");
  writeFileSync(join(sb.repo, exclude), ".env\n");
  unlinkSync(join(sb.state().integration.worktree, ".gitignore"));
  sb.ok("config", "--setup", `node -e "require('fs').writeFileSync('.env', 'test-only')"`);
  sb.ok("final-review");
  const round = sb.state().finalReview;
  assert.equal(readFileSync(join(round.worktree, ".env"), "utf8"), "test-only");
  assert.equal(sb.g(round.worktree, "rev-parse", "HEAD"), round.tip);
  assert.equal(sb.g(round.worktree, "status", "--porcelain"), "");
});

test("failed final setup keeps the same round retryable without launching an agent", () => {
  const sb = readyForFinal();
  const before = sb.state();
  const tabs = sb.db().blocks.length;
  sb.ok("config", "--setup", `node -e "console.error('setup denied');process.exit(7)"`);
  sb.no(/final review setup failed[\s\S]*setup denied/, "final-review");
  assert.equal(sb.state().finalReview, undefined);
  assert.deepEqual(sb.state().agents, before.agents);
  assert.equal(sb.db().blocks.length, tabs);
  const evidence = join(sb.runDir, "evidence");
  const firstAttempt = readdirSync(evidence).find((name) => name.startsWith("final-setup-r1-"));
  const receipt = JSON.parse(readFileSync(join(evidence, firstAttempt, "receipt.json"), "utf8"));
  assert.equal(receipt.complete, true);
  assert.equal(receipt.checks[0].ok, false);
  const firstLog = readFileSync(join(evidence, firstAttempt, receipt.checks[0].log), "utf8");
  assert.match(firstLog, /setup denied/);
  sb.ok("config", "--setup", CHECK);
  sb.ok("final-review");
  assert.equal(sb.state().finalReview.round, 1);
  assert.equal(readdirSync(evidence).filter((name) => name.startsWith("final-setup-r1-")).length, 2);
  assert.equal(readFileSync(join(evidence, firstAttempt, receipt.checks[0].log), "utf8"), firstLog);
});

test("final setup that edits the candidate cannot start a reviewer", () => {
  const sb = readyForFinal();
  const before = sb.state();
  sb.ok("config", "--setup", `node -e "require('fs').appendFileSync('shared.txt', 'changed')"`);
  sb.no(/setup changed the final review candidate/, "final-review");
  assert.equal(sb.state().finalReview, undefined);
  assert.deepEqual(sb.state().agents, before.agents);
  sb.no(/uncommitted or untracked changes/, "final-review");
});
