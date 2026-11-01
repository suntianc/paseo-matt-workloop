// The ledger's Workloop integration, end to end: `link`, `sync` and `note`
// against a real git repository and a fake WORKLOOP_ROOT holding runs that look
// like Workloop's own (a `state.json` and an `events.jsonl` per run).
// Run: node --test skills/requirement-ledger/scripts/test/integration.test.mjs
import assert from "node:assert/strict";
import { spawnBounded } from "./spawn.mjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { emitRecord, fileNameFor, idFor, newRecord, parseRecord } from "../record.mjs";
import { ambiguousRuns } from "../relations.mjs";
import { readLog, readRequirements } from "../store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "req.mjs");
const NOW = "2026-11-01T10:00:00+08:00";

// A throwaway repository plus a throwaway WORKLOOP_ROOT: the developer's real
// ~/.workloop is never read or written. Run directories are written by hand, in
// the shape `workloop.mjs` init/finish/archive/evidence produce, because this
// ticket's subject is what the ledger makes of them.
function sandbox(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "req-integration-")));
  const repo = join(root, "myapp");
  mkdirSync(repo, { recursive: true });
  const env = {
    ...process.env,
    WORKLOOP_ROOT: join(root, "wl"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  };
  delete env.WORKLOOP_RUN;
  delete env.REQ_LOCK_WAIT_MS;
  const git = (...args) => {
    const result = spawnBounded("git", ["-C", repo, ...args], { env, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "shared.txt"), "base\n");
  git("add", "shared.txt");
  git("commit", "-q", "-m", "base");
  const baseSha = git("rev-parse", "HEAD");

  const dir = join(root, "wl", "myapp", ".requirements");
  const run = (args, options = {}) => spawnBounded(process.execPath, [CLI, ...args], {
    cwd: options.cwd ?? repo, env: { ...env, ...options.env }, encoding: "utf8",
  });
  const ok = (args, options) => {
    const result = run(args, options);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
    return `${result.stdout}${result.stderr}`;
  };
  const no = (pattern, args, options) => {
    const result = run(args, options);
    assert.notEqual(result.status, 0, `expected a refusal: ${args.join(" ")}\n${result.stdout}`);
    assert.match(`${result.stdout}${result.stderr}`, pattern);
    return `${result.stdout}${result.stderr}`;
  };

  // A run directory as Workloop leaves it: state.json plus the events it wrote.
  //
  //   s.writeRun({ state: { completion: { at: NOW, tip: s.commit() } } });
  const runDir = (feature = "feat") => join(root, "wl", "myapp", feature);
  function writeRun(options = {}) {
    const {
      feature = "feat", state = {}, events = [], integrationTip,
    } = options;
    const dirPath = runDir(feature);
    mkdirSync(join(dirPath, "issues"), { recursive: true });
    const full = {
      version: 1, project: "myapp", feature, runKey: `myapp-${feature}`, mode: "direct",
      repo, spec: join(dirPath, "issues", "01-ticket.md"), tickets: join(dirPath, "issues"),
      baseRef: "main", baseSha, integration: { branch: `workloop/${feature}`, worktree: join(dirPath, "tip"), tip: integrationTip ?? baseSha },
      config: {}, tasks: {}, seq: events.length + 1, createdAt: NOW,
      ...state,
    };
    writeFileSync(join(dirPath, "state.json"), `${JSON.stringify(full, null, 2)}\n`);
    writeFileSync(join(dirPath, "events.jsonl"), events.map((event, i) => `${JSON.stringify({ seq: i + 1, ts: NOW, ...event })}\n`).join(""));
    return { dir: dirPath, state: full };
  }
  function editRun(feature, edit) {
    const path = join(runDir(feature), "state.json");
    const state = JSON.parse(readFileSync(path, "utf8"));
    edit(state);
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
    return state;
  }
  function appendEvent(feature, event) {
    const path = join(runDir(feature), "events.jsonl");
    const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
    const seq = previous.split("\n").filter(Boolean).length + 1;
    writeFileSync(path, `${previous}${JSON.stringify({ seq, ts: NOW, ...event })}\n`);
  }
  // A delivery commit that really exists in the repository, so a recorded SHA is
  // one a reader can resolve rather than a string the ledger made up.
  let commits = 0;
  const commit = () => {
    commits += 1;
    writeFileSync(join(repo, "shared.txt"), `work ${commits}\n`);
    git("add", "shared.txt");
    git("commit", "-q", "-m", "work");
    return git("rev-parse", "HEAD");
  };
  // Everything a read-only command must leave alone: the run's own files, byte
  // for byte, and the set of names in the directory (a new file is a write too).
  function runSnapshot(feature = "feat") {
    const at = runDir(feature);
    const snapshot = { entries: readdirSync(at).sort() };
    for (const name of ["state.json", "events.jsonl"]) {
      if (existsSync(join(at, name))) snapshot[name] = readFileSync(join(at, name), "utf8");
    }
    return snapshot;
  }
  // A record written by hand, for states only an interrupted `link --correct`
  // leaves behind — constructed on disk rather than hoping a race happens.
  function writeRecord(n, { runs = [], outcomes = [], status = "active" } = {}) {
    mkdirSync(dir, { recursive: true });
    const record = { ...newRecord({ id: idFor(n), title: `Hand written ${n}`, repoPath: repo, now: NOW }), status, runs, outcomes };
    writeFileSync(join(dir, fileNameFor(record.id, record.title)), emitRecord(record, "## Summary\n\n## History\n\n## Notes\n"));
    if (!existsSync(join(dir, "_meta.json"))) {
      writeFileSync(join(dir, "_meta.json"), `${JSON.stringify({ project: "myapp", lastIssued: n, updated_at: NOW })}\n`);
    }
    return record.id;
  }
  // An audit line the ledger did not write in this process, for states only an
  // interruption produces.
  function writeLog(entry) {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "_log.jsonl");
    const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
    const seq = previous.split("\n").filter(Boolean).length + 1;
    writeFileSync(path, `${previous}${JSON.stringify({ seq, at: NOW, ...entry })}\n`);
  }
  const record = (n) => {
    const file = readdirSync(dir).find((name) => name.startsWith(`REQ-${String(n).padStart(3, "0")}-`));
    assert.ok(file, `REQ-${n} is in the ledger`);
    const { frontmatter, body } = parseRecord(readFileSync(join(dir, file), "utf8"));
    return { file, ...frontmatter, body };
  };
  const link = (req = "REQ-001", extra = []) => ok(["link", "myapp/feat", req, ...extra]);

  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root, repo, dir, env, run, ok, no, git, baseSha, runDir, writeRun, editRun, appendEvent, commit, runSnapshot, record, writeRecord, writeLog, link,
  };
}

const logOps = (dir) => readLog(dir).filter((entry) => !entry.unreadable);

// ------------------------------------------------------------------ link (E1, E4, E5)

test("link records the run's base SHA from state.json and opens a pending delivery", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  s.writeRun();
  const before = s.runSnapshot();

  const out = s.link();
  assert.match(out, /linked myapp\/feat .*REQ-001/);

  const [relation] = s.record(1).runs;
  assert.deepEqual(Object.keys(relation).sort(), ["base_sha", "delivery", "feature", "linked_at", "project", "relation"]);
  assert.equal(relation.project, "myapp");
  assert.equal(relation.feature, "feat");
  assert.equal(relation.relation, "primary");
  // The full SHA, not the seven-character short form `status --json` prints: the
  // command reads state.json, it does not shell out to Workloop's status.
  assert.equal(relation.base_sha, s.baseSha);
  assert.equal(relation.base_sha.length, 40);
  assert.deepEqual(relation.delivery, { state: "pending" });
  assert.match(relation.linked_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);

  // A read-only projection: the run directory is byte-for-byte what Workloop left.
  assert.deepEqual(s.runSnapshot(), before);
});

test("link on the same run and requirement again changes nothing", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  s.writeRun();
  s.link();
  const first = s.record(1);

  const out = s.link();
  assert.match(out, /already linked/);
  const second = s.record(1);
  assert.equal(second.rev, first.rev, "a repeated link does not write the file");
  assert.deepEqual(second.runs, first.runs);
  assert.equal(second.runs.length, 1, "one relation, not two");
  assert.equal(logOps(s.dir).filter((entry) => entry.op === "link").length, 1);
});

test("link refuses a second, different primary requirement and names the way out", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  s.ok(["new", "Checkout"]);
  s.writeRun();
  s.link("REQ-001");

  const out = s.no(/already the primary of REQ-001.*--correct/s, ["link", "myapp/feat", "REQ-002"]);
  assert.match(out, /--reason/);
  assert.equal(s.record(2).runs.length, 0, "the refused requirement is untouched");
  assert.equal(s.record(1).runs[0].feature, "feat");
});

test("a failed link is retried on the run that already exists", (t) => {
  const s = sandbox(t);
  // The first attempt fails because the requirement is not there yet. The run was
  // already initialised, so the fix is the ledger side, not `WL init` again.
  s.writeRun();
  const before = s.runSnapshot();
  s.no(/no requirement REQ-001/, ["link", "myapp/feat", "REQ-001"]);
  assert.deepEqual(s.runSnapshot(), before);

  s.ok(["new", "User login"]);
  s.link("REQ-001");
  assert.equal(s.record(1).runs.length, 1);
  assert.deepEqual(s.runSnapshot(), before, "no second init, no workloop write");
});

test("link refuses a run that does not exist and a retired requirement", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  s.no(/no run at .*myapp\/feat/, ["link", "myapp/feat", "REQ-001"]);

  s.ok(["retire", "REQ-001"]);
  s.writeRun();
  s.no(/retired/, ["link", "myapp/feat", "REQ-001"]);
  assert.equal(s.record(1).runs.length, 0);
});

test("link refuses a run that belongs to another project's ledger", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  s.writeRun({ feature: "other", state: { project: "elsewhere", runKey: "elsewhere-other" } });
  s.no(/elsewhere/, ["link", "elsewhere/other", "REQ-001"]);
  assert.equal(s.record(1).runs.length, 0);
});

// ------------------------------------------------------------------ ambiguity predicate

test("ambiguousRuns names every run that two requirements claim as primary", (t) => {
  const s = sandbox(t);
  const relation = (feature = "feat") => ({ project: "myapp", feature, relation: "primary", base_sha: s.baseSha, delivery: { state: "pending" } });
  s.writeRecord(1, { runs: [relation()] });
  s.writeRecord(2, { runs: [] });
  const ledger = () => readRequirements(s.dir);
  assert.equal(ambiguousRuns(ledger()).size, 0, "one owner is not ambiguous");

  // The interruption `link --correct` can leave: the new relation written, the
  // old one not yet removed.
  s.writeRecord(2, { runs: [relation()] });
  s.writeRecord(3, { runs: [relation("other")] });
  const ambiguous = ambiguousRuns(ledger());
  assert.deepEqual([...ambiguous.keys()], ["myapp/feat"]);
  assert.deepEqual(ambiguous.get("myapp/feat"), ["REQ-001", "REQ-002"]);

  // A relation that is not `primary` does not claim the run.
  s.writeRecord(2, { runs: [{ ...relation(), relation: "secondary" }] });
  assert.equal(ambiguousRuns(ledger()).size, 0);
});

// ------------------------------------------------- correct (E10, R1, §6.4)

test("link --correct writes the new relation before it removes the old one, and logs the intent first", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  s.ok(["new", "Checkout"]);
  s.writeRun();
  s.link("REQ-001");
  const before = s.runSnapshot();

  const out = s.ok(["link", "myapp/feat", "REQ-002", "--correct", "--reason", "the ticket was for checkout"]);
  assert.match(out, /corrected: myapp\/feat REQ-001 → REQ-002/);
  assert.match(out, /delivery pending/);

  assert.equal(s.record(1).runs.length, 0, "the old requirement released the run");
  const [relation] = s.record(2).runs;
  assert.equal(relation.relation, "primary");
  assert.equal(relation.base_sha, s.baseSha, "the run's base SHA survives the move");

  // R1: the intent is in the log before either file moved, and the writes land in
  // the order that can only leave a double primary, never a gap.
  const entries = logOps(s.dir);
  const intent = entries.findIndex((entry) => entry.op === "correct");
  const added = entries.findIndex((entry) => entry.op === "link" && entry.id === "REQ-002");
  const removed = entries.findIndex((entry) => entry.op === "unlink" && entry.id === "REQ-001");
  assert.ok(intent >= 0, "the correction intent is recorded");
  assert.equal(entries[intent].run, "myapp/feat");
  assert.equal(entries[intent].from, "REQ-001");
  assert.equal(entries[intent].to, "REQ-002");
  assert.equal(entries[intent].reason, "the ticket was for checkout");
  assert.ok(intent < added, "the intent is written first");
  assert.ok(added < removed, "the new relation is added before the old one goes");
  assert.deepEqual(s.runSnapshot(), before, "a correction moves metadata only");
});

test("link --correct needs a reason, and a correction already done changes nothing", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  s.ok(["new", "Checkout"]);
  s.writeRun();
  s.link("REQ-001");
  s.no(/--reason/, ["link", "myapp/feat", "REQ-002", "--correct"]);
  assert.equal(s.record(1).runs.length, 1, "a refused correction writes nothing");

  s.ok(["link", "myapp/feat", "REQ-002", "--correct", "--reason", "wrong owner"]);
  const converged = s.record(2);
  const out = s.ok(["link", "myapp/feat", "REQ-002", "--correct", "--reason", "wrong owner"]);
  assert.match(out, /already linked/);
  assert.equal(s.record(2).rev, converged.rev, "a repeated correction writes nothing");
  assert.equal(logOps(s.dir).filter((entry) => entry.op === "correct").length, 1, "one intent, not two");
});

test("a correction moves a delivered run's metadata without touching its delivery", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  s.ok(["new", "Checkout"]);
  const tip = s.commit();
  s.writeRun({ state: { completion: { at: NOW, tip } } });
  s.link("REQ-001");
  s.ok(["sync", "myapp/feat"]);

  s.ok(["link", "myapp/feat", "REQ-002", "--correct", "--reason", "recorded against the wrong requirement"]);
  const [relation] = s.record(2).runs;
  assert.equal(relation.delivery.state, "delivered");
  assert.equal(relation.delivery.final_tip, tip);
  assert.equal(relation.delivery.delivered_at, NOW);
});

test("an interrupted correction is visible, refuses every owner-dependent command, and converges on retry", (t) => {
  const s = sandbox(t);
  const tip = s.commit();
  const relation = () => ({ project: "myapp", feature: "feat", relation: "primary", base_sha: s.baseSha, linked_at: NOW, delivery: { state: "pending" } });
  // The state `link --correct` leaves when it stops between its two writes: the
  // new relation written, the old one not yet removed, and the intent on record.
  s.writeRecord(1, { runs: [relation()] });
  s.writeRecord(2, { runs: [relation()] });
  s.writeRecord(3, { runs: [] });
  s.writeLog({ op: "correct", run: "myapp/feat", from: "REQ-001", to: "REQ-002", reason: "wrong owner" });
  s.writeRun({ state: { completion: { at: NOW, tip } } });

  // Not a state any command resolves by choosing.
  const refused = /did not finish/;
  s.no(refused, ["sync", "myapp/feat"]);
  s.no(refused, ["link", "myapp/feat", "REQ-003"]);
  s.no(refused, ["link", "myapp/feat", "REQ-001"]);
  const recovery = s.no(refused, ["sync", "myapp/feat"]);
  assert.match(recovery, /req link myapp\/feat REQ-002 --correct --reason "wrong owner"/, "the recorded intent is the recovery path");

  // Reading still works, marked, and infers nothing.
  const shown = s.run(["show", "REQ-001"]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /^---\nid: REQ-001/, "show still prints the record");
  assert.match(shown.stderr, /ambiguous/);
  assert.match(shown.stderr, /myapp\/feat/);
  const listed = s.ok(["list"]);
  assert.match(listed, /^REQ-001\s+active\s+\S+\s+\[ambiguous myapp\/feat: REQ-002\].*Hand written 1$/m);

  // Retry along the recorded intent: it converges to one primary and writes no
  // second intent.
  const retried = s.ok(["link", "myapp/feat", "REQ-002", "--correct", "--reason", "wrong owner"]);
  assert.match(retried, /resumed the recorded intent/);
  assert.equal(s.record(1).runs.length, 0);
  assert.equal(s.record(2).runs.length, 1);
  assert.equal(logOps(s.dir).filter((entry) => entry.op === "correct").length, 1);

  // Converged, so an owner-dependent command runs again.
  s.ok(["sync", "myapp/feat"]);
  assert.equal(s.record(2).runs[0].delivery.state, "delivered");

  // A second retry is a no-op.
  const again = s.ok(["link", "myapp/feat", "REQ-002", "--correct", "--reason", "wrong owner"]);
  assert.match(again, /already linked/);
});

test("a correction that cannot name which requirement to release refuses instead of picking", (t) => {
  const s = sandbox(t);
  const relation = () => ({ project: "myapp", feature: "feat", relation: "primary", base_sha: s.baseSha, delivery: { state: "pending" } });
  s.writeRecord(1, { runs: [relation()] });
  s.writeRecord(2, { runs: [relation()] });
  s.writeRecord(3, { runs: [] });
  s.writeRun();
  const out = s.no(/one reason cannot say which/, ["link", "myapp/feat", "REQ-003", "--correct", "--reason", "tidy up"]);
  assert.match(out, /one correction at a time/);
  assert.equal(s.record(1).runs.length, 1);
  assert.equal(s.record(2).runs.length, 1);
  assert.equal(s.record(3).runs.length, 0);
});

// ------------------------------------------------- sync (E1, E8, E11, R3)

const ARCHIVED = "2026-11-02T18:30:00+08:00";
const LATER = "2026-11-05T09:00:00+08:00";

test("sync records state.completion as the delivery, never the integration tip", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  const delivered = s.commit();
  // The integration tip is where the work happened to be; only completion is an
  // accepted delivery.
  s.writeRun({ integrationTip: s.baseSha, state: { completion: { at: NOW, tip: delivered } } });
  s.link();
  const before = s.runSnapshot();

  const out = s.ok(["sync", "myapp/feat"]);
  assert.match(out, /myapp\/feat → REQ-001/);
  assert.ok(out.includes(`delivered ${delivered.slice(0, 7)} at ${NOW}`), out);

  const [relation] = s.record(1).runs;
  assert.deepEqual(relation.delivery, { state: "delivered", final_tip: delivered, delivered_at: NOW });
  assert.notEqual(relation.delivery.final_tip, s.baseSha, "the base commit is not a delivery");
  assert.equal(relation.delivery.archived_at, undefined, "not archived yet");
  assert.deepEqual(s.runSnapshot(), before, "sync writes only the ledger");
});

test("sync after archive only fills the archive time and the evidence directory", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  const delivered = s.commit();
  s.writeRun({ state: { completion: { at: NOW, tip: delivered } } });
  s.link();
  // finish, then sync — before any evidence index exists (E11: the first sync does
  // not wait for one).
  s.ok(["sync", "myapp/feat"]);
  assert.equal(s.record(1).runs[0].delivery.archived_at, undefined);

  s.editRun("feat", (state) => {
    state.finishedAt = ARCHIVED;
    state.evidence = { completion: NOW, capturedAt: ARCHIVED, path: join(s.runDir(), "evidence", "index.json") };
  });
  const out = s.ok(["sync", "myapp/feat"]);
  assert.ok(out.includes(`archived ${ARCHIVED}`), out);
  assert.ok(out.includes(`evidence ${join(s.runDir(), "evidence")}`), out);

  const delivery = s.record(1).runs[0].delivery;
  assert.deepEqual(delivery, {
    state: "delivered",
    final_tip: delivered,
    delivered_at: NOW,
    archived_at: ARCHIVED,
    evidence_dir: join(s.runDir(), "evidence"),
  });

  // Repeating it writes nothing: same file, same revision.
  const settled = s.record(1);
  const again = s.ok(["sync", "myapp/feat"]);
  assert.match(again, /in sync/);
  assert.equal(s.record(1).rev, settled.rev);
  assert.deepEqual(s.record(1).runs, settled.runs);

  // The writes `link` and `sync` made are in the audit log too, so `doctor` finds
  // nothing to repair after them.
  assert.match(s.ok(["doctor"]), /clean: the records/);
});

test("sync refuses a run that is not linked, and one in another project", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  s.writeRun({ state: { completion: { at: NOW, tip: s.commit() } } });
  s.no(/not linked to a requirement/, ["sync", "myapp/feat"]);

  s.writeRun({ feature: "elsewhere", state: { project: "other", runKey: "other-elsewhere" } });
  s.no(/belongs to project other/, ["sync", "other/elsewhere"]);
});

test("a reopened run keeps the superseded delivery in history and falls back to pending", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  const first = s.commit();
  s.writeRun({ state: { completion: { at: NOW, tip: first } } });
  s.link();
  s.ok(["sync", "myapp/feat"]);
  assert.equal(s.record(1).runs[0].delivery.state, "delivered");

  // `integrate` after finish clears state.completion and reopens the run.
  s.editRun("feat", (state) => { state.completion = null; });
  s.appendEvent("feat", { kind: "integrate" });

  const out = s.ok(["sync", "myapp/feat"]);
  assert.match(out, /superseded .*\(reopened by integrate\)/);
  assert.match(out, /delivery pending/);

  const relation = s.record(1).runs[0];
  assert.deepEqual(relation.delivery, { state: "pending" }, "no final_tip, no delivered_at on a pending delivery");
  assert.equal(relation.delivery_history.length, 1);
  const [superseded] = relation.delivery_history;
  assert.equal(superseded.final_tip, first);
  assert.equal(superseded.delivered_at, NOW);
  assert.match(superseded.superseded_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  assert.equal(superseded.reason, "reopened by integrate");
  const written = s.record(1);

  // Idempotent: the second sync has nothing left to supersede, and says where the
  // snapshot went instead of claiming there never was one.
  const settled = s.ok(["sync", "myapp/feat"]);
  assert.match(settled, /in sync: delivery pending/);
  assert.match(settled, /1 superseded snapshot kept in delivery_history/);
  assert.equal(s.record(1).rev, written.rev);
  assert.equal(s.record(1).runs[0].delivery_history.length, 1);

  // The run finishes again; history keeps the old snapshot, the delivery is new.
  const second = s.commit();
  s.editRun("feat", (state) => { state.completion = { at: LATER, tip: second }; });
  s.ok(["sync", "myapp/feat"]);
  const reworked = s.record(1).runs[0];
  assert.equal(reworked.delivery.state, "delivered");
  assert.equal(reworked.delivery.final_tip, second);
  assert.equal(reworked.delivery_history.length, 1, "append-only, not rewritten");
  assert.equal(reworked.delivery_history[0].final_tip, first);
});

test("a completion cleared before any sync leaves nothing to fabricate", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  const delivered = s.commit();
  // `finish` happened, `req sync` did not, then `import` cleared the completion:
  // the ledger never saw that delivery, so it holds no snapshot of it.
  s.writeRun({ integrationTip: delivered, state: { completion: null } });
  s.appendEvent("feat", { kind: "import" });
  s.link();

  const out = s.ok(["sync", "myapp/feat"]);
  assert.match(out, /state\.json has no completion/);
  assert.match(out, /Nothing is recorded and nothing is invented/);
  assert.match(out, /delivery pending/);

  const relation = s.record(1).runs[0];
  assert.deepEqual(relation.delivery, { state: "pending" });
  assert.equal(relation.delivery_history ?? undefined, undefined, "no invented history");
  const text = readFileSync(join(s.dir, s.record(1).file), "utf8");
  assert.doesNotMatch(text, /delivered|final_tip/, "the ledger claims no delivery it cannot verify");
  assert.equal(relation.base_sha, s.baseSha);

  // And it does not break what follows: a real completion is recorded as usual.
  const second = s.commit();
  s.editRun("feat", (state) => { state.completion = { at: LATER, tip: second }; });
  s.ok(["sync", "myapp/feat"]);
  assert.equal(s.record(1).runs[0].delivery.final_tip, second);
});

// ------------------------------------------------- note (E6)

test("note --outcome records a Quick delivery and creates no run", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  const commit = s.commit();

  const out = s.ok(["note", "REQ-001", "--outcome", "Fixed the login button copy", "--commit", commit, "--verification", "clicked through it"]);
  assert.match(out, /noted REQ-001: Fixed the login button copy/);
  assert.match(out, /no run/);

  const record = s.record(1);
  assert.equal(record.outcomes.length, 1);
  const [outcome] = record.outcomes;
  assert.equal(outcome.summary, "Fixed the login button copy");
  assert.equal(outcome.commit_sha, commit, "the full SHA of a commit that exists");
  assert.equal(outcome.verification, "clicked through it");
  assert.match(outcome.date, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  assert.equal(record.runs.length, 0, "a Quick outcome is not a run");
  assert.equal(record.rev, 2, "one CLI write");

  // Nothing under the project's Workloop root but the ledger itself.
  assert.deepEqual(readdirSync(join(s.root, "wl", "myapp")), [".requirements"]);
  assert.equal(existsSync(s.runDir()), false);
  assert.equal(logOps(s.dir).at(-1).op, "note");
});

test("note --commit refuses a SHA that is not a commit in this repository", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  const out = s.no(/no such commit|is not a commit SHA/, ["note", "REQ-001", "--outcome", "x", "--commit", "deadbeefdeadbeef"]);
  assert.match(out, /Quick outcome records a commit that exists/);
  assert.equal(s.record(1).outcomes.length, 0);

  s.no(/is not a commit SHA/, ["note", "REQ-001", "--outcome", "x", "--commit", "not-a-sha"]);
  assert.equal(s.record(1).rev, 1, "a refused note writes nothing");
});

test("note does not create a requirement for work that is not tracked", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  s.no(/does not create one/, ["note", "REQ-999", "--outcome", "tweak the invoice footer"]);
  assert.deepEqual(readdirSync(s.dir).filter((name) => name.startsWith("REQ-")), ["REQ-001-user-login.md"]);
});

test("note appends a free note to the record's Notes section and leaves the rest alone", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  const before = s.record(1);

  s.ok(["note", "REQ-001", "discussed splitting the captcha work"]);
  const after = s.record(1);
  assert.match(after.body, /^## Notes\n- \d{4}-\d\d-\d\d discussed splitting the captcha work$/m);
  assert.match(after.body, /^## Summary$/m);
  assert.match(after.body, /^## History$/m);
  assert.deepEqual(after.outcomes, before.outcomes);
  assert.equal(after.runs.length, 0);

  // A second note stacks under the first instead of replacing it.
  s.ok(["note", "REQ-001", "and again"]);
  assert.equal(s.record(1).body.match(/^- \d{4}-\d\d-\d\d /gm).length, 2);
});

test("note refuses to mix an outcome with free text, and needs one of them", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  s.no(/not both/, ["note", "REQ-001", "--outcome", "x", "some text"]);
  s.no(/--outcome/, ["note", "REQ-001"]);
  s.no(/describe an --outcome/, ["note", "REQ-001", "a note", "--commit", s.baseSha]);
  assert.equal(s.record(1).rev, 1);
});

test("a run is addressed as <project>/<feature>, never as its runKey", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  s.writeRun();
  s.no(/<project>\/<feature>/, ["link", "myapp-feat", "REQ-001"]);
  s.no(/<project>\/<feature>/, ["sync", "myapp-feat"]);
  assert.equal(s.record(1).runs.length, 0);
});

test("link --correct moves a relation whose run directory is gone", (t) => {
  const s = sandbox(t);
  const relation = () => ({ project: "myapp", feature: "feat", relation: "primary", base_sha: s.baseSha, linked_at: NOW, delivery: { state: "pending" } });
  s.writeRecord(1, { runs: [relation()] });
  s.writeRecord(2, { runs: [] });
  // No state.json at all: the run directory went away, the relation stayed.
  s.no(/no run at/, ["link", "myapp/feat", "REQ-002"]);
  const out = s.ok(["link", "myapp/feat", "REQ-002", "--correct", "--reason", "the run directory was pruned"]);
  assert.match(out, /corrected: myapp\/feat REQ-001 → REQ-002/);
  assert.match(out, /no state\.json/);
  assert.equal(s.record(1).runs.length, 0);
  const [moved] = s.record(2).runs;
  assert.equal(moved.base_sha, s.baseSha, "the recorded base SHA moves with the relation");
  assert.equal(existsSync(join(s.runDir(), "state.json")), false, "a correction creates no run");
});
