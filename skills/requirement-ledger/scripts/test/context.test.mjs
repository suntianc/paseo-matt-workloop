// `req context`: the pointers it returns, in the order the frozen design fixes,
// the three delivery states that look alike, and the refusals. Every fixture is a
// throwaway git repository and a throwaway WORKLOOP_ROOT; the developer's real
// ~/.workloop is never read or written.
// Run: node --test skills/requirement-ledger/scripts/test/context.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { emitRecord, fileNameFor, idFor, newRecord, parseRecord } from "../record.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "req.mjs");
const NOW = "2026-11-01T10:00:00+08:00";
const DELIVERED = "2026-11-02T18:00:00+08:00";
const ARCHIVED = "2026-11-02T18:30:00+08:00";

// A throwaway repository, plus the run directories Workloop would have left in a
// throwaway WORKLOOP_ROOT. The run fixtures are written by hand in the shape
// `init`/`finish`/`evidence`/`archive` produce, because what is under test is what
// the ledger makes of them.
function sandbox(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "req-context-")));
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
    const result = spawnSync("git", ["-C", repo, ...args], { env, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "shared.txt"), "base\n");
  git("add", "shared.txt");
  git("commit", "-q", "-m", "base");
  const baseSha = git("rev-parse", "HEAD");

  const dir = join(root, "wl", "myapp", ".requirements");
  const run = (args, options = {}) => spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd ?? repo, env: { ...env, ...options.env }, encoding: "utf8",
  });
  const ok = (args, options) => {
    const result = run(args, options);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
    return `${result.stdout}${result.stderr}`;
  };
  const no = (pattern, args, options) => {
    const result = run(args, options);
    assert.notEqual(result.status, 0, `expected a refusal: ${args.join(" ")}\n${result.stdout}${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, pattern);
    return `${result.stdout}${result.stderr}`;
  };

  let commits = 0;
  const commit = () => {
    commits += 1;
    writeFileSync(join(repo, "shared.txt"), `work ${commits}\n`);
    git("add", "shared.txt");
    git("commit", "-q", "-m", "work");
    return git("rev-parse", "HEAD");
  };

  const runDir = (feature = "feat") => join(root, "wl", "myapp", feature);
  // A run directory as Workloop leaves it: state.json plus whatever documents the
  // run produced. `integration.worktree` points at a `tip/` that is never created:
  // archival deletes it, and `context` must not need one.
  function writeRun({ feature = "feat", state = {}, tickets = true } = {}) {
    const at = runDir(feature);
    mkdirSync(join(at, "issues"), { recursive: true });
    if (tickets) writeFileSync(join(at, "issues", "01-login.md"), TICKET_BODY);
    const full = {
      version: 1, project: "myapp", feature, runKey: `myapp-${feature}`, mode: "full",
      repo, spec: join(at, "spec.md"), tickets: join(at, "issues"),
      baseRef: "main", baseSha,
      integration: { branch: `workloop/${feature}`, worktree: join(at, "tip"), tip: baseSha },
      config: {}, tasks: {}, seq: 1, createdAt: NOW,
      ...state,
    };
    writeFileSync(join(at, "state.json"), `${JSON.stringify(full, null, 2)}\n`);
    if (!existsSync(full.spec) && full.spec.startsWith(at)) writeFileSync(full.spec, SPEC_BODY);
    return { dir: at, state: full };
  }
  const editRun = (feature, edit) => {
    const path = join(runDir(feature), "state.json");
    const state = JSON.parse(readFileSync(path, "utf8"));
    edit(state);
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
    return state;
  };
  // The evidence index `WL evidence` and `archive` write, and the state field that
  // points at it.
  function writeEvidence(feature = "feat", { index = true } = {}) {
    const at = runDir(feature);
    mkdirSync(join(at, "evidence"), { recursive: true });
    if (index) writeFileSync(join(at, "evidence", "index.json"), `${JSON.stringify({ completion: DELIVERED, capturedAt: ARCHIVED, agents: [] }, null, 2)}\n`);
    editRun(feature, (state) => {
      state.evidence = { completion: DELIVERED, capturedAt: ARCHIVED, path: join(at, "evidence", "index.json") };
    });
  }
  function writeReport(feature, name, text) {
    mkdirSync(join(runDir(feature), "reviews"), { recursive: true });
    writeFileSync(join(runDir(feature), "reviews", name), text);
  }
  function writeDoc(kind, ref, text) {
    mkdirSync(join(repo, "docs", kind), { recursive: true });
    writeFileSync(join(repo, "docs", kind, ref), text);
  }

  // A record written by hand: `refs`, `runs` and the prose are what this ticket
  // reads, so each test states them instead of driving five commands to reach them.
  function writeRecord(n, { runs = [], outcomes = [], refs = {}, status = "active", body = RECORD_BODY, title = `Requirement ${n}` } = {}) {
    mkdirSync(dir, { recursive: true });
    const record = { ...newRecord({ id: idFor(n), title, repoPath: repo, now: NOW }), status, runs, outcomes, refs };
    writeFileSync(join(dir, fileNameFor(record.id, title)), emitRecord(record, body));
    if (!existsSync(join(dir, "_meta.json"))) {
      writeFileSync(join(dir, "_meta.json"), `${JSON.stringify({ project: "myapp", lastIssued: n, updated_at: NOW })}\n`);
    }
    return record.id;
  }
  const relation = (feature = "feat", delivery = { state: "pending" }) => ({
    project: "myapp", feature, relation: "primary", base_sha: baseSha, linked_at: NOW, delivery,
  });
  const recordFile = (n) => {
    const file = readdirSync(dir).find((name) => name.startsWith(`REQ-${String(n).padStart(3, "0")}-`));
    assert.ok(file, `REQ-${n} is in the ledger`);
    return join(dir, file);
  };
  const record = (n) => parseRecord(readFileSync(recordFile(n), "utf8"));
  // Everything in the ledger directory, byte for byte: a read command that writes
  // anything at all shows up here.
  function ledgerSnapshot() {
    if (!existsSync(dir)) return {};
    const files = {};
    for (const name of readdirSync(dir)) {
      if (name === ".lock") continue;
      files[name] = readFileSync(join(dir, name), "utf8");
    }
    return files;
  }
  const context = (args) => ok(["context", ...args]);
  const contextJson = (args) => JSON.parse(context([...args, "--json"]));

  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root, repo, dir, env, run, ok, no, git, baseSha, commit, runDir, writeRun, editRun, writeEvidence, writeReport, writeDoc,
    writeRecord, relation, record, recordFile, ledgerSnapshot, context, contextJson,
  };
}

const SPEC_BODY = "# Spec\n\nSPEC BODY: the login requirement in full.\n";
const TICKET_BODY = "# Ticket\n\nTICKET BODY: add session tokens.\n";
const REVIEW_BODY = "REVIEW BODY\n\nVerdict: pass\n";
const MAPPING_BODY = "| ID | Criterion | Proof |\n|---|---|---|\n| M1 | login works | MAPPING BODY |\n";
const ADR_BODY = "# 7: Session tokens\n\nADR BODY: tokens live in an HttpOnly cookie.\n";
const PITFALL_BODY = "# Cookie domain\n\nPITFALL BODY: a cookie set on the wrong domain is silently dropped.\n";

const RECORD_BODY = `## Summary

Login and authentication for the storefront: sessions, tokens, sign-out.

## History

- 2026-11-02 finished v1 login (run req-007-login)
- 2026-11-03 added a captcha (run req-007-login-captcha)

## Notes
`;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const headers = (text) => text.split("\n").filter((line) => line.startsWith("# "));

// ------------------------------------------------------------------ AC1: pointers, in order

test("context returns the six groups of pointers in the frozen order, and copies no document body", (t) => {
  const s = sandbox(t);
  const sha = s.commit();
  s.writeDoc("adr", "0007-session-tokens.md", ADR_BODY);
  s.writeDoc("pitfalls", "auth-cookie-domain.md", PITFALL_BODY);
  const { state } = s.writeRun({
    state: {
      completion: { at: DELIVERED, tip: sha },
      finishedAt: ARCHIVED,
      finalReview: { round: 1, tip: sha, verdict: "pass", path: join(s.runDir(), "reviews", "final-1-abc1234.md") },
      tasks: { 1: { id: "1", status: "done", review: { path: join(s.runDir(), "reviews", "01-abc1234.md") } } },
    },
  });
  s.writeEvidence();
  writeFileSync(join(s.runDir(), "final-review.md"), MAPPING_BODY);
  s.writeReport("feat", "final-1-abc1234.md", REVIEW_BODY);
  s.writeReport("feat", "01-abc1234.md", REVIEW_BODY);
  s.writeRecord(7, {
    title: "User login",
    runs: [s.relation("feat", { state: "delivered", final_tip: sha, delivered_at: DELIVERED, archived_at: ARCHIVED })],
    refs: {
      adr: ["0007-session-tokens"],
      pitfalls: ["auth-cookie-domain"],
      spec_hint: join(s.runDir(), "spec.md"),
      codegraph: { symbols: ["AuthService.login"], paths: ["src/auth/"] },
    },
  });

  const text = s.context(["REQ-007"]);
  assert.deepEqual(headers(text), ["# 1 requirement", "# 2 runs", "# 3 adrs", "# 4 deliveries", "# 5 codegraph"]);

  // Step 1 is the record's own current state, so its summary and latest change are
  // quoted; steps 2-5 are pointers, so no other document's body appears.
  assert.match(text, /Login and authentication for the storefront: sessions, tokens, sign-out\./);
  assert.match(text, /2026-11-03 added a captcha \(run req-007-login-captcha\)/);
  for (const body of [/SPEC BODY/, /TICKET BODY/, /REVIEW BODY/, /MAPPING BODY/, /ADR BODY/, /PITFALL BODY/]) {
    assert.doesNotMatch(text, body);
  }

  assert.match(text, new RegExp(escape(join(s.runDir(), "spec.md"))));
  assert.match(text, new RegExp(escape(join(s.runDir(), "issues"))));
  assert.match(text, new RegExp(escape(join(s.runDir(), "final-review.md"))));
  assert.match(text, new RegExp(escape(join(s.runDir(), "reviews", "01-abc1234.md"))));
  assert.match(text, new RegExp(escape(join(s.runDir(), "evidence"))));
  assert.match(text, new RegExp(escape(join(s.repo, "docs", "adr", "0007-session-tokens.md"))));
  assert.match(text, new RegExp(sha.slice(0, 7)));
  assert.match(text, /AuthService\.login/);
  assert.match(text, /src\/auth\//);
  assert.match(text, /index may lag the working tree/i);
});

test("context --json keeps the same order and names every pointer as a path", (t) => {
  const s = sandbox(t);
  const sha = s.commit();
  s.writeDoc("adr", "0007-session-tokens.md", ADR_BODY);
  s.writeRun({
    state: {
      completion: { at: DELIVERED, tip: sha },
      finishedAt: ARCHIVED,
      tasks: { 1: { id: "1", status: "done", review: { path: join(s.runDir(), "reviews", "01-abc1234.md") } } },
    },
  });
  s.writeEvidence();
  writeFileSync(join(s.runDir(), "final-review.md"), MAPPING_BODY);
  s.writeReport("feat", "01-abc1234.md", REVIEW_BODY);
  s.writeRecord(7, {
    title: "User login",
    runs: [s.relation("feat", { state: "delivered", final_tip: sha, delivered_at: DELIVERED })],
    refs: { adr: ["0007-session-tokens"], codegraph: { symbols: ["AuthService.login"], paths: ["src/auth/"] } },
  });

  const json = s.contextJson(["REQ-007"]);
  assert.deepEqual(Object.keys(json), ["requirement", "runs", "adrs", "deliveries", "codegraph"]);
  assert.equal(json.requirement.id, "REQ-007");
  assert.equal(json.requirement.title, "User login");
  assert.equal(json.requirement.status, "active");
  assert.equal(json.requirement.file, s.recordFile(7));
  assert.match(json.requirement.summary.text, /sessions, tokens, sign-out/);
  assert.equal(json.requirement.summary.file, s.recordFile(7));
  assert.equal(json.requirement.latest_change.date, "2026-11-03");
  assert.equal(json.requirement.scope.repo_path, s.repo);

  const [run] = json.runs;
  assert.equal(run.run, "myapp/feat");
  assert.equal(run.relation, "primary");
  assert.equal(run.state_path, join(s.runDir(), "state.json"));
  assert.equal(run.state_available, true);
  assert.equal(run.branch, "workloop/feat");
  assert.equal(run.base_sha, s.baseSha);
  assert.deepEqual(run.spec, { path: join(s.runDir(), "spec.md"), exists: true });
  assert.deepEqual(run.tickets, { path: join(s.runDir(), "issues"), exists: true });
  assert.deepEqual(run.acceptance.mapping, { path: join(s.runDir(), "final-review.md"), exists: true });
  assert.deepEqual(run.acceptance.reports.map((report) => report.path), [join(s.runDir(), "reviews", "01-abc1234.md")]);

  assert.deepEqual(json.adrs, [{ ref: "0007-session-tokens", path: join(s.repo, "docs", "adr", "0007-session-tokens.md"), status: "ok" }]);
  const [delivery] = json.deliveries;
  assert.equal(delivery.state, "delivered");
  assert.equal(delivery.final_tip, sha);
  assert.equal(delivery.delivered_at, DELIVERED);
  assert.equal(delivery.evidence_available, true);
  assert.deepEqual(json.codegraph.symbols, ["AuthService.login"]);
  assert.deepEqual(json.codegraph.paths, ["src/auth/"]);
  assert.match(json.codegraph.note, /no graph/i);
});

test("a requirement with no run and no refs still answers in the same order", (t) => {
  const s = sandbox(t);
  s.writeRecord(1, { body: "## Summary\n\nNothing has been delivered yet.\n" });
  const before = s.ledgerSnapshot();

  const text = s.context(["REQ-001"]);
  assert.deepEqual(headers(text), ["# 1 requirement", "# 2 runs", "# 3 adrs", "# 4 deliveries", "# 5 codegraph"]);
  assert.match(text, /no run linked/);
  assert.match(text, /no ADR reference recorded/);
  assert.match(text, /\(none recorded\)/);
  const json = s.contextJson(["REQ-001"]);
  assert.deepEqual(json.runs, []);
  assert.deepEqual(json.adrs, []);
  assert.deepEqual(json.deliveries, []);
  assert.equal(json.requirement.latest_change, null);

  // Reading is not writing: no audit line, no rev bump, nothing new in the directory.
  assert.deepEqual(s.ledgerSnapshot(), before);
});

// --------------------------------------------------- AC2: the three delivery states

// The delivery half of the reply, from `state.json` alone. The three states look
// alike and mean different things, so each one is built on disk rather than argued.
const delivered = (json) => json.deliveries[0];

test("S1: finished but not archived is delivered, with the evidence awaiting archive", (t) => {
  const s = sandbox(t);
  const sha = s.commit();
  s.writeRun({ state: { completion: { at: DELIVERED, tip: sha } } });
  s.writeRecord(1, { runs: [s.relation("feat", { state: "pending" })] });
  // Nothing has archived this run, so no evidence index exists yet.
  assert.equal(existsSync(join(s.runDir(), "evidence")), false);

  const text = s.context(["REQ-001"]);
  const json = s.contextJson(["REQ-001"]);
  const delivery = delivered(json);

  assert.equal(delivery.state, "delivered", "a completion is a delivery; archive is a later step");
  assert.equal(delivery.final_tip, sha);
  assert.equal(delivery.delivered_at, DELIVERED);
  assert.equal(delivery.archived_at, null);
  assert.equal(delivery.evidence_status, "pending-archive");
  assert.equal(delivery.evidence_available, false);
  assert.match(text, /delivered/);
  assert.match(text, /pending archive/i);
  // Not archived yet is not a failure, and not history: the reply must not say the
  // delivery or its evidence is missing.
  assert.doesNotMatch(text, /evidence.*\bmissing\b/i);
  assert.doesNotMatch(text, /fail/i);
  // Nothing was created to make the evidence appear.
  assert.equal(existsSync(join(s.runDir(), "evidence")), false);
});

test("S2: archived with evidence reports the archive time and the evidence directory", (t) => {
  const s = sandbox(t);
  const sha = s.commit();
  s.writeRun({ state: { completion: { at: DELIVERED, tip: sha }, finishedAt: ARCHIVED } });
  s.writeEvidence();
  s.writeRecord(1, { runs: [s.relation("feat", { state: "delivered", final_tip: sha, delivered_at: DELIVERED, archived_at: ARCHIVED })] });

  const json = s.contextJson(["REQ-001"]);
  const delivery = delivered(json);
  assert.equal(delivery.state, "delivered");
  assert.equal(delivery.archived_at, ARCHIVED);
  assert.equal(delivery.evidence_dir, join(s.runDir(), "evidence"));
  assert.equal(delivery.evidence_status, "available");
  assert.equal(delivery.evidence_available, true);

  const text = s.context(["REQ-001"]);
  assert.match(text, new RegExp(escape(ARCHIVED)));
  assert.match(text, new RegExp(escape(join(s.runDir(), "evidence"))));
});

test("S3: archived without its evidence says so, and invents no replacement", (t) => {
  const s = sandbox(t);
  const sha = s.commit();
  s.writeRun({ state: { completion: { at: DELIVERED, tip: sha }, finishedAt: ARCHIVED } });
  s.writeEvidence();
  rmSync(join(s.runDir(), "evidence", "index.json"));

  s.writeRecord(1, { runs: [s.relation("feat", { state: "delivered", final_tip: sha, delivered_at: DELIVERED, archived_at: ARCHIVED })] });
  const json = s.contextJson(["REQ-001"]);
  const delivery = delivered(json);
  assert.equal(delivery.state, "delivered", "the delivery still happened; only its evidence is gone");
  assert.equal(delivery.final_tip, sha);
  assert.equal(delivery.archived_at, ARCHIVED);
  assert.equal(delivery.evidence_available, false);
  assert.equal(delivery.evidence_status, "missing");
  assert.match(delivery.evidence_note, /index\.json/);

  const text = s.context(["REQ-001"]);
  assert.match(text, /missing/);
  assert.equal(existsSync(join(s.runDir(), "evidence", "index.json")), false, "nothing is created to fill the gap");
});

test("S3: an evidence directory that is gone entirely is still reported as missing", (t) => {
  const s = sandbox(t);
  const sha = s.commit();
  s.writeRun({ state: { completion: { at: DELIVERED, tip: sha }, finishedAt: ARCHIVED } });
  s.writeEvidence();
  rmSync(join(s.runDir(), "evidence"), { recursive: true, force: true });
  s.writeRecord(1, { runs: [s.relation("feat", { state: "delivered", final_tip: sha, delivered_at: DELIVERED, archived_at: ARCHIVED })] });

  const delivery = delivered(s.contextJson(["REQ-001"]));
  assert.equal(delivery.state, "delivered");
  assert.equal(delivery.evidence_available, false);
  assert.equal(delivery.evidence_status, "missing");
  assert.equal(delivery.evidence_dir, join(s.runDir(), "evidence"));
});

test("a run that has not finished is reported as pending, with no delivery SHA", (t) => {
  const s = sandbox(t);
  s.writeRun();
  s.writeRecord(1, { runs: [s.relation()] });

  const json = s.contextJson(["REQ-001"]);
  assert.equal(delivered(json).state, "pending");
  assert.equal(delivered(json).final_tip, null);
  assert.match(s.context(["REQ-001"]), /pending/);
});

// ------------------------------------------------------- AC3: no worktree required

test("context never needs the run's worktree, which archival deletes", (t) => {
  const s = sandbox(t);
  const sha = s.commit();
  s.writeRun({ state: { completion: { at: DELIVERED, tip: sha }, finishedAt: ARCHIVED } });
  s.writeEvidence();
  s.writeRecord(1, { runs: [s.relation("feat", { state: "delivered", final_tip: sha, delivered_at: DELIVERED, archived_at: ARCHIVED })] });

  const state = JSON.parse(readFileSync(join(s.runDir(), "state.json"), "utf8"));
  assert.equal(existsSync(state.integration.worktree), false, "the fixture has no tip/ worktree, exactly as after archive");

  const text = s.context(["REQ-001"]);
  const json = s.contextJson(["REQ-001"]);
  assert.match(text, /workloop\/feat/);
  assert.match(text, new RegExp(escape(s.baseSha.slice(0, 7))));
  assert.equal(json.runs[0].branch, "workloop/feat");
  assert.equal(json.runs[0].base_sha, s.baseSha);
  assert.equal(delivered(json).final_tip, sha);
});

test("with state.json gone, context still cites the ledger's recorded delivery", (t) => {
  const s = sandbox(t);
  const sha = s.commit();
  s.writeRun({ state: { completion: { at: DELIVERED, tip: sha }, finishedAt: ARCHIVED } });
  s.writeEvidence();
  s.writeRecord(1, {
    runs: [s.relation("feat", {
      state: "delivered", final_tip: sha, delivered_at: DELIVERED, archived_at: ARCHIVED, evidence_dir: join(s.runDir(), "evidence"),
    })],
  });
  const before = s.ledgerSnapshot();
  rmSync(join(s.runDir(), "state.json"));

  const text = s.context(["REQ-001"]);
  const json = s.contextJson(["REQ-001"]);
  const delivery = delivered(json);
  assert.equal(json.runs[0].state_available, false);
  assert.equal(json.runs[0].spec, null, "a document only state.json named is not guessed");
  assert.equal(delivery.state, "delivered");
  assert.equal(delivery.source, "ledger");
  assert.equal(delivery.final_tip, sha);
  assert.equal(delivery.archived_at, ARCHIVED);
  assert.equal(delivery.evidence_available, true, "the recorded evidence directory is still checked, not assumed");
  assert.match(text, /state\.json is missing/);
  // Read only: the record's own bytes did not change.
  assert.deepEqual(s.ledgerSnapshot(), before);
});

test("a run whose state.json is gone is a dangling reference, not a failed read", (t) => {
  const s = sandbox(t);
  s.writeRecord(1, { runs: [s.relation("gone")] });
  const text = s.context(["REQ-001"]);
  assert.match(text, /myapp\/gone/);
  assert.match(text, /\(missing\)/);
  const json = s.contextJson(["REQ-001"]);
  assert.equal(json.runs[0].state_available, false);
  assert.equal(delivered(json).state, "pending");
  assert.equal(delivered(json).final_tip, null);
});

// ----------------------------------------------- AC4: broken references are reported

test("a broken ADR reference is reported as dangling: not deleted, not replaced", (t) => {
  const s = sandbox(t);
  s.writeDoc("adr", "0007-session-tokens.md", ADR_BODY);
  s.writeRecord(1, { refs: { adr: ["0007-session-tokens", "0099-retired-sessions"] } });
  const before = s.ledgerSnapshot();

  const json = s.contextJson(["REQ-001"]);
  assert.deepEqual(json.adrs.map((adr) => adr.ref), ["0007-session-tokens", "0099-retired-sessions"]);
  assert.equal(json.adrs[0].status, "ok");
  assert.equal(json.adrs[0].path, join(s.repo, "docs", "adr", "0007-session-tokens.md"));
  assert.equal(json.adrs[1].status, "dangling");
  assert.equal(json.adrs[1].path, null, "no path is invented for a reference that does not resolve");
  assert.match(json.adrs[1].reason, /docs\/adr/);

  const text = s.context(["REQ-001"]);
  assert.match(text, /0099-retired-sessions  dangling/);
  // Reporting never edits the record: the broken reference survives it.
  assert.deepEqual(s.ledgerSnapshot(), before);
  assert.match(readFileSync(s.recordFile(1), "utf8"), /0099-retired-sessions/);
});

test("a bare ADR number resolves to its one file, and an ambiguous one is not chosen for", (t) => {
  const s = sandbox(t);
  s.writeDoc("adr", "0007-session-tokens.md", ADR_BODY);
  s.writeRecord(1, { refs: { adr: ["0007"] } });
  assert.equal(s.contextJson(["REQ-001"]).adrs[0].path, join(s.repo, "docs", "adr", "0007-session-tokens.md"));

  // Two ADRs now carry 0007: which one the record meant is the record's question.
  s.writeDoc("adr", "0007-session-cookies.md", ADR_BODY);
  const [adr] = s.contextJson(["REQ-001"]).adrs;
  assert.equal(adr.status, "dangling");
  assert.equal(adr.path, null);
  assert.match(adr.reason, /several files match: 0007-session-cookies\.md, 0007-session-tokens\.md/);
});

test("pitfalls are read only when asked for, and a dangling one is marked then", (t) => {
  const s = sandbox(t);
  s.writeDoc("pitfalls", "auth-cookie-domain.md", PITFALL_BODY);
  s.writeRecord(1, { refs: { pitfalls: ["auth-cookie-domain", "deleted-rule"] } });

  const plain = s.context(["REQ-001"]);
  assert.doesNotMatch(plain, /auth-cookie-domain|deleted-rule/, "§5.6 stays out of the default reply");

  const json = s.contextJson(["REQ-001", "--include", "pitfalls"]);
  assert.deepEqual(json.pitfalls.map((pitfall) => [pitfall.ref, pitfall.status]), [["auth-cookie-domain", "ok"], ["deleted-rule", "dangling"]]);
  const text = s.context(["REQ-001", "--include", "pitfalls"]);
  assert.match(text, /# 6 pitfalls/);
  assert.match(text, /deleted-rule  dangling/);
  assert.doesNotMatch(text, /PITFALL BODY/);
});

// ------------------------------------------------------------- AC5: CodeGraph hints

test("CodeGraph appears only as hints, with the standing caveat, and stores nothing", (t) => {
  const s = sandbox(t);
  s.writeRecord(1, { refs: { codegraph: { symbols: ["AuthService.login", "SessionStore.find"], paths: ["src/auth/"] } } });
  const before = s.ledgerSnapshot();
  const repoBefore = readdirSync(s.repo).sort();

  const text = s.context(["REQ-001"]);
  const json = s.contextJson(["REQ-001"]);
  assert.deepEqual(json.codegraph.symbols, ["AuthService.login", "SessionStore.find"]);
  assert.deepEqual(json.codegraph.paths, ["src/auth/"]);
  assert.match(json.codegraph.note, /stores no graph/i);
  assert.match(json.codegraph.note, /index may lag the working tree/i);
  assert.match(text, /index may lag the working tree/i);
  // Hints only: no query is run, nothing about the code is quoted, and no graph is
  // cached anywhere the ledger or the repository can see.
  assert.doesNotMatch(text, /class AuthService|function login/);
  assert.deepEqual(s.ledgerSnapshot(), before);
  assert.deepEqual(readdirSync(s.repo).sort(), repoBefore);
});

// --------------------------------------------- AC6: double primary refuses (E10, §6.5)

test("context refuses a run that two requirements claim, and points at the recovery", (t) => {
  const s = sandbox(t);
  s.writeRun();
  s.writeRecord(1, { runs: [s.relation()] });
  s.writeRecord(2, { runs: [s.relation()] });
  s.writeRecord(3, { title: "Unrelated" });
  const before = s.ledgerSnapshot();

  const out = s.no(/link --correct/, ["context", "REQ-002"]);
  assert.match(out, /myapp\/feat is the primary of REQ-001 and REQ-002/);
  assert.match(out, /--reason/);
  assert.doesNotMatch(out, /# 1 requirement/, "a refusal is not a partial reply");
  assert.deepEqual(s.ledgerSnapshot(), before, "the refusal writes nothing");

  // The refusal is about that run's ownership, not about the ledger: an unrelated
  // requirement still reads.
  assert.match(s.context(["REQ-003"]), /# 1 requirement/);
});

test("the refusal names the exact command when a correction intent was recorded", (t) => {
  const s = sandbox(t);
  s.writeRun();
  s.writeRecord(1, { runs: [s.relation()] });
  s.writeRecord(2, { runs: [s.relation()] });
  // What `link --correct` writes before either file moves (R1).
  const path = join(s.dir, "_log.jsonl");
  writeFileSync(path, `${JSON.stringify({
    seq: 1, at: NOW, op: "correct", run: "myapp/feat", from: "REQ-001", to: "REQ-002", reason: "the ticket was for checkout",
  })}\n`);

  const out = s.no(/link --correct/, ["context", "REQ-001"]);
  assert.match(out, /The recorded intent moves it from REQ-001 to REQ-002 \("the ticket was for checkout"\)/);
  assert.match(out, /req link myapp\/feat REQ-002 --correct --reason "the ticket was for checkout"/);
});

// ------------------------------------------------------------- the optional sections

test("retrospectives, history and superseded deliveries come only when asked for", (t) => {
  const s = sandbox(t);
  const old = s.commit();
  const sha = s.commit();
  s.writeRun({
    state: {
      completion: { at: DELIVERED, tip: sha },
      finishedAt: ARCHIVED,
      retro: { status: "done", path: join(s.runDir(), "retros", "1-abc.md") },
    },
  });
  mkdirSync(join(s.runDir(), "retros"), { recursive: true });
  writeFileSync(join(s.runDir(), "retros", "1-abc.md"), "RETRO BODY\n");
  s.writeRecord(1, {
    runs: [{
      ...s.relation("feat", { state: "pending" }),
      delivery_history: [{ final_tip: old, delivered_at: NOW, superseded_at: ARCHIVED, reason: "reopened by integrate" }],
    }],
    // A Quick delivery with no run of its own (§6.3).
    outcomes: [{ date: "2026-11-03T09:00:00+08:00", summary: "fixed the login button copy", commit_sha: old }],
  });

  const plain = s.context(["REQ-001"]);
  assert.doesNotMatch(plain, /# 6 /, "step 6 is not in the default reply");

  const json = s.contextJson(["REQ-001", "--include", "retro,history"]);
  assert.deepEqual(Object.keys(json).slice(-2), ["retrospectives", "history"]);
  assert.equal(json.retrospectives[0].path.path, join(s.runDir(), "retros", "1-abc.md"));
  assert.equal(json.retrospectives[0].status, "done");
  assert.equal(json.history.changes.at(-1).date, "2026-11-03");
  assert.equal(json.history.outcomes[0].summary, "fixed the login button copy");
  assert.equal(json.history.superseded[0].final_tip, old);
  assert.equal(json.history.superseded[0].reason, "reopened by integrate");

  const text = s.context(["REQ-001", "--include", "retro,history"]);
  assert.match(text, /# 6 retrospectives/);
  assert.match(text, /# 6 history/);
  assert.match(text, new RegExp(escape(join(s.runDir(), "retros", "1-abc.md"))));
  assert.match(text, /reopened by integrate/);
  assert.match(text, /fixed the login button copy/);
  assert.doesNotMatch(text, /RETRO BODY/);
});

// ----------------------------------------------------------------------------- usage

test("context needs a requirement, and refuses a section it does not have", (t) => {
  const s = sandbox(t);
  s.writeRecord(1);
  s.no(/context needs a requirement/, ["context"]);
  s.no(/no requirement REQ-009/, ["context", "REQ-009"]);
  const out = s.no(/not a section/, ["context", "REQ-001", "--include", "retros"]);
  assert.match(out, /retro, pitfalls, history/);
  s.no(/needs a value/, ["context", "REQ-001", "--include"]);
});

test("a state.json that cannot be read is said to be unreadable, not missing", (t) => {
  const s = sandbox(t);
  s.writeRun();
  s.writeRecord(1, { runs: [s.relation()] });
  writeFileSync(join(s.runDir(), "state.json"), "{ this is not json");

  const text = s.context(["REQ-001"]);
  assert.match(text, /\(unreadable\)/);
  assert.equal(s.contextJson(["REQ-001"]).runs[0].state_available, false);
});
