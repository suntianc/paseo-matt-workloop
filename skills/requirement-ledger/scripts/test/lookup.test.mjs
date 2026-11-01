// Tests for `req lookup`: the deterministic candidate search behind requirement
// recall. Every test drives the CLI, because the contract a caller sees is the
// command's JSON — score, matched terms and decision are read from it, never from
// an internal function.
// Run: node --test skills/requirement-ledger/scripts/test/lookup.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnBounded } from "./spawn.mjs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { emitRecord, fileNameFor, idFor, newRecord } from "../record.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "req.mjs");
const NOW = "2026-11-01T10:00:00+08:00";

// A throwaway WORKLOOP_ROOT with one or more repos, each keyed as a project the
// way `req` keys it. The ledger of every project can be seeded by hand, which is
// how a record with a summary and linked runs is produced without a later ticket.
function sandbox(t, projects = ["myapp"]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "req-lookup-")));
  const env = { ...process.env, WORKLOOP_ROOT: join(root, "wl"), GIT_CONFIG_NOSYSTEM: "1" };
  delete env.WORKLOOP_RUN;
  delete env.REQ_LOCK_WAIT_MS;
  const repos = {};
  for (const name of projects) {
    const repo = join(root, name);
    mkdirSync(repo, { recursive: true });
    spawnBounded("git", ["-C", repo, "init", "-q"], { encoding: "utf8" });
    repos[name] = repo;
  }
  const main = projects[0];
  const run = (args, options = {}) => spawnBounded(process.execPath, [CLI, ...args], {
    cwd: options.cwd ?? repos[main], env: { ...env, ...options.env }, encoding: "utf8",
  });
  const dirOf = (project) => join(root, "wl", project, ".requirements");
  const lookup = (args, options) => {
    const result = run(["lookup", ...args], options);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, repos, repo: repos[main], main, env, run, lookup, dirOf };
}

// A record written by hand: the fields a lookup scores — title, aliases, the
// summary prose and refs — plus whatever runs the test needs.
function seed(s, { project = s.main, n, title, aliases = [], summary = "", refs = {}, runs = [], status = "active", body = null }) {
  const dir = s.dirOf(project);
  mkdirSync(dir, { recursive: true });
  const record = {
    ...newRecord({ id: idFor(n), title, aliases, repoPath: s.repos[project], now: NOW }),
    status,
    runs,
  };
  if (Object.keys(refs).length) record.refs = refs;
  const prose = body ?? `## Summary\n${summary}\n\n## History\n\n## Notes\n`;
  const file = fileNameFor(record.id, title);
  writeFileSync(join(dir, file), emitRecord(record, prose));
  return { dir, file, record };
}

const runLinked = (feature, state) => ({ project: "myapp", feature, relation: "primary", base_sha: "3f2a", delivery: { state } });

// The standard ledger: a login requirement with aliases and a summary, plus two
// requirements about other capabilities. This is the corpus every scoring test
// reads, so a score can be recomputed by hand against these exact fields.
function corpus(t, projects) {
  const s = sandbox(t, projects);
  seed(s, {
    n: 1,
    title: "用户登录",
    aliases: ["登录", "认证", "sign-in", "login"],
    summary: "账号登录与认证，包含短信验证码校验。",
    runs: [runLinked("req-001-login", "delivered"), runLinked("req-001-captcha", "pending")],
  });
  seed(s, { n: 2, title: "结算与支付", aliases: ["checkout", "payment"], summary: "购物车结算、支付方式与发票。" });
  seed(s, { n: 3, title: "导出报表", aliases: ["export", "csv"], summary: "把报表导出为 CSV 文件。" });
  return s;
}

const ids = (answer) => answer.candidates.map((candidate) => candidate.id);
const titles = (answer) => answer.candidates.map((candidate) => candidate.title);

// ---------------------------------------------------------------- candidates

test("latin words in the request find the requirement, and the answer is one JSON object", (t) => {
  const s = corpus(t);
  const answer = s.lookup(["add a captcha to the sign-in flow", "--json"]);

  assert.deepEqual(Object.keys(answer), ["query", "project", "decision", "candidates"]);
  assert.equal(answer.query, "add a captcha to the sign-in flow");
  assert.equal(answer.project, "myapp");
  assert.deepEqual(ids(answer), ["REQ-001"], "the login requirement is the only candidate");
  assert.deepEqual(titles(answer), ["用户登录"]);

  const [candidate] = answer.candidates;
  assert.deepEqual(Object.keys(candidate), [
    "id", "title", "status", "score", "matched_terms", "summary_excerpt", "updated_at", "run_count", "last_delivery",
  ]);
  assert.equal(candidate.status, "active");
  assert.equal(candidate.updated_at, NOW);
  assert.match(candidate.score.toString(), /^\d(\.\d{1,2})?$/, "the score is a rounded number");
  assert.ok(candidate.score > 0 && candidate.score <= 1, `score in (0, 1]: ${candidate.score}`);
});

test("an alias hit outranks a summary hit, and an exact title or alias scores highest", (t) => {
  const s = corpus(t);
  // "验证码" appears only in REQ-001's summary; "登录" is a title word and an alias;
  // "用户登录" is the title exactly.
  const bySummary = s.lookup(["验证码", "--json"]).candidates.find((c) => c.id === "REQ-001");
  const byTitle = s.lookup(["登录", "--json"]).candidates.find((c) => c.id === "REQ-001");
  const exact = s.lookup(["用户登录", "--json"]).candidates.find((c) => c.id === "REQ-001");

  assert.ok(bySummary, "the summary word finds the requirement");
  // Worked by hand: 验证码 contributes two bigrams (验证, 证码) out of the
  // summary's fourteen, so the summary field is covered 2 * 2 / (14 + 1) = 0.27,
  // and its weight of 0.6 brings that to 0.16.
  assert.equal(bySummary.score, 0.16, "the summary's own coverage, weighted");
  assert.equal(byTitle.score, 1, "登录 is an exact alias");
  assert.ok(bySummary.score < byTitle.score, `summary ${bySummary.score} < title/alias ${byTitle.score}`);
  assert.equal(exact.score, 1, "an exact title hit scores 1");
  assert.deepEqual(exact.matched_terms, ["用户登录"]);
});

test("matched terms are the request's own words, and the excerpt is copied from the record", (t) => {
  const s = corpus(t);
  const [candidate] = s.lookup(["验证码校验", "--json"]).candidates;
  assert.equal(candidate.id, "REQ-001");
  for (const term of candidate.matched_terms) {
    assert.ok("验证码校验".includes(term), `${term} is part of the query`);
  }
  assert.ok(candidate.summary_excerpt.includes(candidate.matched_terms[0]), "the excerpt is centred on a match");
  assert.match(candidate.summary_excerpt, /验证码/, "the excerpt quotes the record's own summary");
  assert.ok(readFileSync(join(s.dirOf("myapp"), "REQ-001-用户登录.md"), "utf8").includes(candidate.summary_excerpt.replace(/…/g, "")));
});

test("the same query twice gives byte-identical output", (t) => {
  const s = corpus(t);
  const first = s.run(["lookup", "登录 captcha", "--json"]);
  const second = s.run(["lookup", "登录 captcha", "--json"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, second.stdout);
});

test("a query with no evidence in the corpus answers with no candidates", (t) => {
  const s = corpus(t);
  const answer = s.lookup(["会议室预订提醒", "--json"]);
  assert.deepEqual(answer.candidates, []);
  assert.equal(answer.decision, "none");
  assert.deepEqual(s.lookup(["!!!", "--json"]).candidates, [], "a query of punctuation has no terms to search for");
  // A one-letter title is not searchable either, and a one-letter request must
  // not become an "exact" hit against it.
  seed(s, { n: 4, title: "A", aliases: ["x"], summary: "" });
  assert.deepEqual(s.lookup(["a", "--json"]).candidates, []);
});

test("a Chinese fragment finds the requirement, rebuilt as whole fragments in matched_terms", (t) => {
  const s = corpus(t);
  const answer = s.lookup(["把登录加个验证码", "--json"]);
  assert.deepEqual(ids(answer), ["REQ-001"]);
  assert.equal(answer.decision, "strong");
  assert.deepEqual(answer.candidates[0].matched_terms, ["登录", "验证码"],
    "consecutive bigrams are joined back into the fragments the user wrote");
  assert.match(answer.candidates[0].summary_excerpt, /验证码/);

  // A title fragment that is not an alias still counts: 报表 sits inside 导出报表.
  const fragment = s.lookup(["报表", "--json"]);
  assert.deepEqual(ids(fragment), ["REQ-003"]);
  assert.deepEqual(fragment.candidates[0].matched_terms, ["报表"]);
  // Worked by hand: 导出报表 holds three bigrams (导出, 出报, 报表) and the query
  // covers one, so 2 * 1 / (3 + 1) = 0.5 at the title's weight of 1.
  assert.equal(fragment.candidates[0].score, 0.5, "the score is the title coverage, doubled and capped");
});

test("a single Chinese character is a low-scoring fragment, not a name match", (t) => {
  const s = corpus(t);
  // 码 appears in REQ-001's summary only. One character is weaker evidence than a
  // bigram, so it is recalled but cannot pass the threshold on its own.
  const answer = s.lookup(["码", "--json"]);
  const hit = answer.candidates.find((candidate) => candidate.id === "REQ-001");
  assert.ok(hit, "the character is a substring of the summary");
  assert.ok(hit.score > 0 && hit.score < 0.5, `a fragment scores low: ${hit.score}`);
  assert.equal(answer.decision, "none");
  assert.deepEqual(hit.matched_terms, ["码"]);

  // A character no record contains recalls nothing.
  assert.deepEqual(s.lookup(["猫", "--json"]).candidates, []);
});

test("Chinese is matched by character order, not by the presence of characters", (t) => {
  const s = corpus(t);
  // 表报 are the right characters in the wrong order; a substring/bigram match
  // must not fire, or every Chinese query would recall every requirement.
  assert.deepEqual(s.lookup(["表报", "--json"]).candidates, []);
});

// ---------------------------------------------------------------- decisions

test("two requirements that both answer to the word make the answer ambiguous", (t) => {
  const s = corpus(t);
  seed(s, { n: 4, title: "单点登录", aliases: ["登录", "sso"], summary: "跨系统的单点登录。" });
  const answer = s.lookup(["登录", "--json"]);
  assert.equal(answer.decision, "ambiguous");
  assert.deepEqual(ids(answer).sort(), ["REQ-001", "REQ-004"]);
  assert.equal(answer.candidates[0].score, answer.candidates[1].score, "neither candidate is preferred");

  const human = s.run(["lookup", "登录"]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /ambiguous/);
  assert.match(human.stdout, /confirm with the user/, "the answer asks for a decision instead of making one");

  // The display limit must not manufacture a lead: with one candidate shown, the
  // runner-up still exists in the numbers, so the answer stays ambiguous.
  const limited = s.lookup(["登录", "--limit", "1", "--json"]);
  assert.equal(limited.candidates.length, 1, "only the leader is shown");
  assert.equal(limited.decision, "ambiguous", "the hidden runner-up still counts");
});

test("the lead multiple decides when a clear leader counts as strong", (t) => {
  const s = corpus(t);
  // 登录 is REQ-001's alias (1.00) and one of three bigrams of REQ-004's title (0.50).
  seed(s, { n: 4, title: "登录审计", aliases: ["audit"], summary: "记录每次登录。" });
  const twice = s.lookup(["登录", "--json"]);
  assert.equal(twice.candidates[0].score, 1);
  assert.equal(twice.candidates[1].score, 0.5);
  assert.equal(twice.decision, "strong", "1 is twice 0.5, so the default lead of 2 is met");

  const wider = s.lookup(["登录", "--lead", "3", "--json"]);
  assert.equal(wider.decision, "ambiguous", "a factor of 3 is not met by the same numbers");
});

test("a threshold above every score answers none, and none does not claim the request is new", (t) => {
  const s = corpus(t);
  const answer = s.lookup(["报表", "--threshold", "0.6", "--json"]);
  assert.equal(answer.decision, "none");
  assert.deepEqual(ids(answer), ["REQ-003"], "the weak candidate is still shown as evidence");
  assert.ok(answer.candidates[0].score < 0.6);

  const human = s.run(["lookup", "报表", "--threshold", "0.6"]);
  assert.match(human.stdout, /REQ-003/, "the evidence is printed even when it decides nothing");
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /decision: none/);
  assert.doesNotMatch(human.stdout, /new requirement|is a new|全新的需求|新需求/);
  assert.match(human.stdout, /no evidence/);
});

test("top-N defaults to five and --limit trims it", (t) => {
  const s = corpus(t);
  for (let n = 4; n <= 7; n += 1) seed(s, { n, title: `报表变体 ${n}`, aliases: ["报表"], summary: "报表。" });
  const all = s.lookup(["报表", "--json"]);
  assert.equal(all.candidates.length, 5, "five candidates by default");
  const one = s.lookup(["报表", "--limit", "1", "--json"]);
  assert.deepEqual(ids(one), [ids(all)[0]], "the limit keeps the best candidate");
});

test("bad knobs are refused with a usage error rather than guessed at", (t) => {
  const s = corpus(t);
  for (const args of [["--threshold", "1.5"], ["--threshold", "high"], ["--lead", "0"], ["--limit", "0"], ["--limit", "2.5"]]) {
    const result = s.run(["lookup", "登录", ...args]);
    assert.equal(result.status, 2, `${args.join(" ")} -> ${result.status}`);
    assert.match(result.stderr, /must be a number/);
  }
  const empty = s.run(["lookup"]);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /needs the text to search for/);
});

// ---------------------------------------------------------------- scope

test("lookup reads this project's ledger only, including when both projects share a title", (t) => {
  const s = corpus(t, ["myapp", "otherapp"]);
  seed(s, {
    project: "otherapp", n: 1, title: "用户登录", aliases: ["登录"], summary: "另一个项目自己的登录说明。",
  });
  seed(s, {
    project: "otherapp", n: 2, title: "发票归档", aliases: ["invoicing-only-in-otherapp"], summary: "只在另一个项目里存在的词。",
  });

  // A word that exists only in the other project finds nothing here.
  const leak = s.lookup(["invoicing-only-in-otherapp", "--json"]);
  assert.equal(leak.project, "myapp");
  assert.deepEqual(leak.candidates, [], "another project's unique requirement never leaks in");
  assert.equal(leak.decision, "none");

  // A title both projects share returns this project's record, and only it.
  const shared = s.lookup(["用户登录", "--json"]);
  assert.deepEqual(ids(shared), ["REQ-001"]);
  assert.match(shared.candidates[0].summary_excerpt, /账号登录与认证/, "the excerpt comes from this project's file");

  // The mirror image from the other repository: its own record, not mine.
  const other = s.lookup(["用户登录", "--json"], { cwd: s.repos.otherapp });
  assert.equal(other.project, "otherapp");
  assert.deepEqual(ids(other), ["REQ-001"]);
  assert.match(other.candidates[0].summary_excerpt, /另一个项目自己的登录说明/);

  // --project names the ledger to search, and still searches only that one.
  const named = s.lookup(["发票归档", "--project", "otherapp", "--json"]);
  assert.equal(named.project, "otherapp");
  assert.deepEqual(ids(named), ["REQ-002"]);
});

// ---------------------------------------------------------------- effects

function snapshot(dir) {
  if (!existsSync(dir)) return null;
  const files = {};
  for (const name of readdirSync(dir).sort()) files[name] = readFileSync(join(dir, name), "utf8");
  return files;
}

test("a lookup creates nothing, records nothing and assigns no owner", (t) => {
  const s = corpus(t);
  const dir = s.dirOf("myapp");
  const before = snapshot(dir);

  const answer = s.lookup(["把登录加个验证码", "--json"]);
  assert.ok(answer.candidates.length, "the query did find something");

  assert.deepEqual(snapshot(dir), before, "no file was added, changed or removed — no new requirement, no audit line, no lock");
  const human = s.run(["lookup", "把登录加个验证码"]);
  assert.equal(human.status, 0, human.stderr);
  assert.deepEqual(snapshot(dir), before, "the human output writes nothing either");

  // A project with no ledger gains no directory from being searched.
  const fresh = sandbox(t, ["unledgered"]);
  const searched = fresh.run(["lookup", "登录", "--json"]);
  assert.equal(searched.status, 0, searched.stderr);
  assert.equal(JSON.parse(searched.stdout).decision, "none");
  assert.equal(existsSync(fresh.dirOf("unledgered")), false);
});

// ---------------------------------------------------------------- record fields

test("run_count and last_delivery come from the record's linked runs", (t) => {
  const s = corpus(t);
  const [login] = s.lookup(["登录", "--json"]).candidates;
  assert.equal(login.run_count, 2);
  assert.equal(login.last_delivery, "pending", "the most recently linked run is pending");

  seed(s, {
    n: 4, title: "单点登录", aliases: ["sso"], summary: "跨系统的单点登录。",
    runs: [runLinked("req-004-sso", "delivered")],
  });
  const sso = s.lookup(["sso", "--json"]).candidates[0];
  assert.equal(sso.id, "REQ-004");
  assert.equal(sso.run_count, 1);
  assert.equal(sso.last_delivery, "delivered");

  seed(s, { n: 5, title: "二次验证", aliases: ["2fa"], summary: "短信二次验证。" });
  const bare = s.lookup(["2fa", "--json"]).candidates[0];
  assert.equal(bare.run_count, 0);
  assert.equal(bare.last_delivery, null);
});

test("a requirement with no summary still matches on its name, with an empty excerpt", (t) => {
  const s = sandbox(t);
  seed(s, { n: 1, title: "审计日志", aliases: ["audit-log"], summary: "" });
  const [candidate] = s.lookup(["audit-log", "--json"]).candidates;
  assert.equal(candidate.id, "REQ-001");
  assert.equal(candidate.summary_excerpt, "");
});

test("a retired requirement is still recalled, labelled retired", (t) => {
  const s = corpus(t);
  seed(s, { n: 4, title: "旧版登录", aliases: ["legacy-sso"], summary: "已经退场的登录方式。", status: "retired" });
  const [candidate] = s.lookup(["legacy-sso", "--json"]).candidates;
  assert.equal(candidate.id, "REQ-004");
  assert.equal(candidate.status, "retired");
});

test("a damaged record is skipped instead of failing the whole search", (t) => {
  const s = corpus(t);
  const dir = s.dirOf("myapp");
  writeFileSync(join(dir, "REQ-009-broken.md"), "# not a record\n");
  const answer = s.lookup(["登录", "--json"]);
  assert.deepEqual(ids(answer), ["REQ-001"]);
});

test("a requirement created by new is found by its alias without any further setup", (t) => {
  const s = sandbox(t);
  assert.equal(s.run(["new", "User login", "--alias", "sign-in"]).status, 0);
  assert.equal(s.run(["new", "Invoice export", "--alias", "csv"]).status, 0);
  const answer = s.lookup(["sign in please", "--json"]);
  assert.deepEqual(ids(answer), ["REQ-001"]);
  assert.equal(answer.decision, "strong");
});

test("refs are searchable as supporting evidence, below a name match", (t) => {
  const s = corpus(t);
  seed(s, {
    n: 4, title: "会话令牌", aliases: ["sessions"], summary: "签发与撤销会话令牌。",
    refs: { adr: ["0007-session-tokens"], codegraph: { symbols: ["AuthService.login"], paths: ["src/auth/"] } },
  });
  const byRefs = s.lookup(["session-tokens", "--json"]).candidates;
  const hit = byRefs.find((candidate) => candidate.id === "REQ-004");
  assert.ok(hit, "an ADR name in refs recalls the requirement that cites it");
  // Worked by hand: the refs field holds seven Latin terms (0007, session,
  // tokens, authservice, login, src, auth); the query covers two, so
  // 2 * 2 / (7 + 1) = 0.5, weighted by refs' 0.6 = 0.3.
  assert.equal(hit.score, 0.3, "refs are scored like the summary, and weaker than a name");
  assert.ok(hit.score < 1, "a citation is weaker evidence than the requirement's own name");
});

// ---------------------------------------------------------------- ambiguity

test("a lookup marks a candidate whose run is another requirement's primary too, and still answers", (t) => {
  const s = sandbox(t);
  // `login` is an exact alias of all three; the shared run is the primary of
  // REQ-001 and REQ-003, the unfinished-correction state of §6.5.
  const shared = runLinked("req-001-login", "delivered");
  seed(s, { n: 1, title: "用户登录", aliases: ["login"], summary: "账号登录。", runs: [shared] });
  seed(s, { n: 2, title: "结算与支付", aliases: ["login"], summary: "结算。" });
  seed(s, { n: 3, title: "账号安全", aliases: ["login"], summary: "账号安全。", runs: [shared] });

  const answer = s.lookup(["login", "--json"]);
  assert.deepEqual(ids(answer), ["REQ-001", "REQ-002", "REQ-003"], "the search still answers");
  const marked = answer.candidates.filter((candidate) => candidate.ambiguous === true).map((candidate) => candidate.id);
  assert.deepEqual(marked, ["REQ-001", "REQ-003"], "only the holders of the double primary are marked");
  assert.equal("ambiguous" in answer.candidates.find((candidate) => candidate.id === "REQ-002"), false,
    "a candidate with no runs carries no ambiguity field");

  const human = s.run(["lookup", "login"]);
  assert.equal(human.status, 0, human.stderr);
  assert.equal(human.stdout.match(/ambiguous: true/g)?.length, 2, "the text form marks the same two candidates");

  // Converging the relation clears the mark: the answer is read from the files
  // each time, never cached.
  seed(s, { n: 3, title: "账号安全", aliases: ["login"], summary: "账号安全。" });
  assert.equal(s.lookup(["login", "--json"]).candidates.some((candidate) => "ambiguous" in candidate), false);
});

test("a clean ledger marks no candidate ambiguous", (t) => {
  const s = corpus(t);
  for (const query of ["登录", "checkout", "csv"]) {
    const answer = s.lookup([query, "--json"]);
    assert.equal(answer.candidates.some((candidate) => "ambiguous" in candidate), false, query);
  }
  const human = s.run(["lookup", "登录"]);
  assert.equal(human.status, 0, human.stderr);
  assert.doesNotMatch(human.stdout, /ambiguous: true/);
});
