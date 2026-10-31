#!/usr/bin/env node
// `req`, the requirement ledger's only entry point. A requirement is one Markdown
// file under `$WORKLOOP_ROOT/<project>/.requirements/`; this CLI mints numbers,
// replaces files atomically, retires them without deleting anything, and checks
// that the ledger still adds up.
//
// `PENDING` names the commands a later ticket adds. The dispatcher knows them so
// the answer is "not part of this build yet" rather than "unknown command".
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { runDoctor } from "./doctor.mjs";
import { appendNote, idFor, numberIn } from "./record.mjs";
import {
  ambiguousIn, ambiguousRuns, lastCorrection, newOutcome, newRelation, primaryHolders, relationIn, syncDelivery,
  withOutcome, withRelation, withoutRelation,
} from "./relations.mjs";
import { deliveryFrom, parseRunKey, readRun, RunError, runKeyOf, supersedeReason } from "./runstate.mjs";
import {
  appendLog, createRequirement, ledgerDir, listRequirementFiles, nextSeq, projectKey, readLog, readRequirement, readRequirements,
  saveRequirement, withLock,
} from "./store.mjs";
import { nowIso } from "./time.mjs";

const USAGE = `usage: req <command> [options]

  new <title> [--alias <term>]...   create a requirement and allocate its number
  list                              list this project's requirements
  show <REQ>                        print one requirement file
  retire <REQ>                      mark a requirement retired; file and number stay
  doctor [--repair-log]             report inconsistencies; fill recoverable audit gaps

Options:
  --project <slug>   operate on this project key instead of the repo's directory name
  --alias <term>     a search term for lookup (repeatable)
  --repair-log       append audit lines for recoverable gaps, without touching prose

Workloop (reads the run's state.json; never writes it):
  link <project>/<feature> <REQ> [--correct --reason "<why>"]
                                    record which requirement a run delivers, or move it
  sync <project>/<feature>          copy the run's delivery state into the ledger
  note <REQ> --outcome "<summary>" [--commit <sha>] [--verification "<how>"]
  note <REQ> "<text>"               record Quick work, or a note; creates no run

The ledger lives in $WORKLOOP_ROOT/<project>/.requirements/ and defaults to
~/.workloop. Run the command from inside the project's repository.`;

// Later tickets add these; the dispatcher knows their names so the answer is
// "not yet" rather than "unknown command".
const PENDING = {
  lookup: "search the ledger for candidates",
  context: "assemble a requirement's references",
};

const say = (line = "") => process.stdout.write(`${line}\n`);
const warn = (line) => process.stderr.write(`req: ${line}\n`);

class UsageError extends Error {}

function fail(message, code = 1) {
  warn(message);
  process.exit(code);
}

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      if (arg.startsWith("-") && arg !== "-") throw new UsageError(`unknown option ${arg}`);
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (["json", "repair-log", "correct", "help"].includes(name)) {
      flags[name] = true;
      continue;
    }
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    if (name === "alias") (flags.alias ??= []).push(value);
    else flags[name] = value;
  }
  return { positional, flags };
}

// The ledger sits beside the project's Workloop runs, so it needs the same key:
// slug(basename(repo)). Both rules are Workloop's; they are copied, not imported,
// because Workloop does not export them.
function locate(flags) {
  const cwd = process.cwd();
  const head = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const repo = head.status === 0 && head.stdout.trim() ? realpathSync(head.stdout.trim()) : null;
  const project = flags.project ?? (repo ? projectKey(repo) : null);
  if (!project) throw new UsageError("not inside a git repository: the ledger keys a project by its repository's directory name (or pass --project <slug>)");
  // The key becomes a directory name, so it takes Workloop's feature-name rule.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(project)) {
    throw new UsageError(`project key ${JSON.stringify(project)} is not usable: lowercase letters, digits and dashes, starting with a letter or digit`);
  }
  return { repo: repo ?? cwd, project, dir: ledgerDir(project), remote: repo ? gitRemote(repo) : null };
}

function gitRemote(repo) {
  const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  const direct = git("remote", "get-url", "origin");
  if (direct.status === 0) return sanitiseRemote(direct.stdout);
  const listed = git("remote");
  const name = listed.status === 0 ? listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean)[0] : null;
  if (!name) return null;
  const url = git("remote", "get-url", name);
  return url.status === 0 ? sanitiseRemote(url.stdout) : null;
}

// The URL form with credentials in front of the host, and the scp form
// `git@github.com:owner/repo.git`, both become `github.com/owner/repo`:
// credentials never reach the ledger.
function sanitiseRemote(url) {
  let text = String(url ?? "").trim();
  if (!text) return null;
  const hadScheme = /^[a-z+]+:\/\//i.test(text);
  text = text.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "");
  // `git@github.com:owner/repo.git` separates host and path with a colon; a URL
  // with a scheme does not, so its colon may be a port and is left alone.
  if (!hadScheme) text = text.replace(/^([^/:]+):(?!\/)/, "$1/");
  return text.replace(/\/+$/, "").replace(/\.git$/, "") || null;
}

const normaliseId = (value) => {
  const match = /^(?:REQ-)?(\d+)$/i.exec(String(value ?? "").trim());
  return match ? idFor(Number(match[1])) : null;
};

// A requirement is found by the number in its file name. A file whose name and
// frontmatter id disagree is still reachable by the id it carries — `doctor`
// reports the disagreement, and reading it should not depend on which one wins.
function findRequirement(dir, id) {
  const files = listRequirementFiles(dir);
  const byNumber = files.find((file) => file.number === numberIn(id));
  if (byNumber) {
    try {
      return { file: byNumber.file, ...readRequirement(dir, byNumber.file) };
    } catch (error) {
      throw new Error(`${byNumber.file}: ${error.message}`);
    }
  }
  for (const candidate of files) {
    try {
      const record = readRequirement(dir, candidate.file);
      if (record.frontmatter.id === id) return { file: candidate.file, ...record };
    } catch {
      // A damaged file is `doctor`'s finding, not a reason to block another lookup.
    }
  }
  return null;
}

// ---------------------------------------------------------------- commands

function cmdNew({ positional, flags }) {
  const title = positional.join(" ").trim();
  if (!title) throw new UsageError('new needs a title: req new "User login" [--alias <term>]');
  const at = locate(flags);
  const created = createRequirement({
    project: at.project,
    repoPath: at.repo,
    repoRemote: at.remote,
    title,
    aliases: flags.alias ?? [],
  });
  say(`${created.id}  ${created.path}`);
  if (!created.audit.ok) warn(`the audit log could not be written (${created.audit.error}); run req doctor --repair-log`);
}

function cmdList({ flags }) {
  const at = locate(flags);
  const requirements = readRequirements(at.dir);
  if (!requirements.length) {
    say(`no requirements in ${at.dir}`);
    return;
  }
  const width = Math.max(...requirements.map((requirement) => (requirement.frontmatter?.id ?? requirement.file).length));
  const ambiguous = ambiguousRuns(requirements);
  for (const requirement of requirements) {
    if (requirement.error) {
      say(`${requirement.file.padEnd(width)}  unreadable  ${requirement.error}`);
      continue;
    }
    const { id, status, updated_at: updatedAt, title } = requirement.frontmatter;
    // A run two records claim is marked, not resolved (§6.5).
    const marks = ambiguousIn(requirement.frontmatter, ambiguous);
    const mark = marks.length ? `[${marks.map((run) => `ambiguous ${run.key}: ${run.also.join(", ")}`).join("; ")}] ` : "";
    say(`${id.padEnd(width)}  ${String(status).padEnd(7)}  ${String(updatedAt ?? "").slice(0, 10)}  ${mark}${title}`);
  }
}

function cmdShow({ positional, flags }) {
  const id = normaliseId(positional[0]);
  if (!id) throw new UsageError("show needs a requirement: req show REQ-001");
  const at = locate(flags);
  const found = findRequirement(at.dir, id);
  if (!found) throw new UsageError(`no requirement ${id} in ${at.dir}`);
  process.stdout.write(readFileSync(join(at.dir, found.file), "utf8"));
  if (Array.isArray(found.frontmatter?.runs) && found.frontmatter.runs.length) {
    for (const run of ambiguousIn(found.frontmatter, ambiguousRuns(readRequirements(at.dir)))) {
      warn(`${id} is ambiguous: ${run.key} is the primary of ${id} and ${run.also.join(", ")}, so a \`link --correct\` did not finish; ` +
        "its ownership is unresolved until that correction converges");
    }
  }
}

function cmdRetire({ positional, flags }) {
  const id = normaliseId(positional[0]);
  if (!id) throw new UsageError("retire needs a requirement: req retire REQ-001");
  const at = locate(flags);
  if (!existsSync(at.dir)) throw new UsageError(`no requirements in ${at.dir}`);
  const outcome = withLock(at.dir, () => {
    const found = findRequirement(at.dir, id);
    if (!found) throw new UsageError(`no requirement ${id} in ${at.dir}`);
    if (found.frontmatter.status === "retired") return { already: true };
    const saved = saveRequirement({
      dir: at.dir,
      file: found.file,
      record: { ...found.frontmatter, status: "retired" },
      body: found.body,
      op: "retire",
      previous: { status: found.frontmatter.status },
    });
    return { already: false, saved };
  });
  say(outcome.already ? `${id} is already retired` : `${id} retired`);
  if (outcome.saved && !outcome.saved.audit.ok) {
    warn(`the audit log could not be written (${outcome.saved.audit.error}); run req doctor --repair-log`);
  }
}

function cmdDoctor({ flags }) {
  const at = locate(flags);
  const report = runDoctor({ project: at.project, repairLog: Boolean(flags["repair-log"]) });

  const readable = report.requirements.filter((requirement) => !requirement.error);
  say(`doctor: ${readable.length} requirement${readable.length === 1 ? "" : "s"}, lastIssued ${report.lastIssued}`);
  for (const requirement of readable) {
    const { id, status, rev, title } = requirement.frontmatter;
    say(`  ${id}  ${status}  rev ${rev}  ${title}`);
  }
  if (!report.findings.length) {
    say("clean: the records, _meta.json and the audit log agree");
    return;
  }
  say(`findings: ${report.findings.length}`);
  for (const finding of report.findings) {
    say(`  - ${finding.message}${finding.repaired ? " [repaired]" : ""}`);
  }
  process.exitCode = report.findings.some((finding) => !finding.repaired) ? 1 : 0;
}

// ------------------------------------------------------- Workloop: link, sync, note

const short = (sha) => (typeof sha === "string" && sha.length > 7 ? sha.slice(0, 7) : String(sha ?? ""));

// The requirement a command names, with `findRequirement`'s rule (the number in
// the file name first, then the id the record carries) applied to the full list,
// which `link`, `sync` and `note` need anyway for the ambiguity check.
function findIn(requirements, id) {
  const byNumber = requirements.find((requirement) => requirement.number === numberIn(id));
  if (byNumber) {
    if (byNumber.error) throw new Error(`${byNumber.file}: ${byNumber.error}`);
    return byNumber;
  }
  return requirements.find((requirement) => !requirement.error && requirement.frontmatter.id === id) ?? null;
}

// A full-length SHA or nothing: `status --json` prints seven characters, and a
// truncated SHA recorded as if it were the commit would be a guess.
function baseShaOf(state) {
  if (typeof state.baseSha !== "string" || !state.baseSha) {
    throw new Error("state.json has no baseSha: the commit the run started from cannot be recorded, and recording a short one would be a guess");
  }
  return state.baseSha;
}

// §6.5: two primaries is a question the ledger does not answer by choosing, and
// every read that needs one owner refuses it the same way.
function ambiguityError(key, holders, intent) {
  const lines = [`${key} is the primary of ${holders.join(" and ")}: a \`link --correct\` did not finish, and nothing here picks one of them.`];
  if (intent?.from && intent?.to && holders.includes(intent.to) && holders.includes(intent.from)) {
    lines.push(`The recorded intent moves it from ${intent.from} to ${intent.to} ("${intent.reason}"). Converge it with:`);
    lines.push(`  req link ${key} ${intent.to} --correct --reason "${intent.reason}"`);
  } else {
    lines.push(`Converge it with \`req link ${key} <REQ> --correct --reason "<why>"\`.`);
  }
  return new Error(lines.join("\n"));
}

// `link` records a relation; it never touches what Workloop says, so a run whose
// repository differs from the record's is a warning the operator can act on, not a
// silent association (doctor reports the same mismatch as a finding).
function repoWarnings(at, record, run) {
  const recorded = record.frontmatter.repo_path;
  const repo = run.state.repo;
  if (typeof recorded !== "string" || typeof repo !== "string" || !recorded || !repo) return [];
  try {
    if (realpathSync(recorded) === realpathSync(repo)) return [];
  } catch {
    return [];
  }
  return [`${record.frontmatter.id} belongs to ${recorded}, but the run was created in ${repo}`];
}

function cmdLink({ positional, flags }) {
  if (positional.length !== 2) {
    throw new UsageError('link needs a run and a requirement: req link <project>/<feature> <REQ> [--correct --reason "<why>"]');
  }
  const [address, idText] = positional;
  const { project, feature } = parseRunKey(address);
  const id = normaliseId(idText);
  if (!id) throw new UsageError(`link needs a requirement id: req link ${address} REQ-001`);
  if (flags.correct && !flags.reason) {
    throw new UsageError('--correct needs --reason "<why>": the reason stays with the record and in _log.jsonl');
  }
  const at = locate(flags);
  if (at.project !== project) {
    throw new UsageError(`run ${address} belongs to project ${project}, but this ledger is ${at.project} (${at.dir}); ` +
      `run the command in that project's repository or pass --project ${project}`);
  }
  // `link` reads the run, and a run that is not there is not a link to record.
  // `--correct` moves recorded metadata, so it still works when the run directory
  // has gone — that is how a dangling relation gets repaired.
  let run = null;
  let absent = null;
  try {
    run = readRun({ project, feature });
  } catch (error) {
    if (!flags.correct) throw error;
    absent = error;
  }
  const key = runKeyOf(project, feature);

  const outcome = withLock(at.dir, () => {
    const requirements = readRequirements(at.dir);
    const target = findIn(requirements, id);
    if (!target) throw new Error(`no requirement ${id} in ${at.dir}`);
    if (target.frontmatter.status === "retired") throw new Error(`${id} is retired: a retired requirement takes no new run`);

    const holders = primaryHolders(requirements, project, feature);
    const others = holders.filter((holder) => holder !== id);
    const intent = lastCorrection(readLog(at.dir), key);
    const relate = () => {
      if (!run) throw new Error(`${absent.message}; there is no relation to move either`);
      return newRelation({ project, feature, baseSha: baseShaOf(run.state) });
    };

    if (holders.length === 1 && holders[0] === id) {
      return { kind: "already", record: target, relation: relationIn(target.frontmatter, project, feature) };
    }

    if (!flags.correct) {
      if (holders.length > 1) throw ambiguityError(key, holders, intent);
      if (holders.length === 1) {
        throw new Error(`${key} is already the primary of ${holders[0]}; one run delivers one primary requirement in v1. ` +
          `To move it: req link ${key} ${id} --correct --reason "<why>"`);
      }
      const relation = relate();
      const saved = saveRequirement({
        dir: at.dir, file: target.file, record: withRelation(target.frontmatter, relation), body: target.body,
        op: "link", extra: { run: key, relation: "primary", base_sha: relation.base_sha },
      });
      return { kind: "linked", record: target, relation, saved, warnings: repoWarnings(at, target, run) };
    }

    // `--correct`: the one controlled way to move a run's primary requirement. It
    // moves metadata only — never the run's execution facts or its delivery SHA.
    if (others.length > 1) {
      throw new Error(`${key} is the primary of ${holders.join(" and ")}; one reason cannot say which of them is wrong. ` +
        `Converge them one correction at a time, and read \`req doctor\`.`);
    }
    const from = others[0] ?? null;
    if (!from) {
      // Nothing holds the run yet, so there is nothing to correct: link it.
      if (!run) throw new Error(`${absent.message}; there is no recorded relation here to correct either`);
      const relation = relate();
      const saved = saveRequirement({
        dir: at.dir, file: target.file, record: withRelation(target.frontmatter, relation), body: target.body,
        op: "link", extra: { run: key, relation: "primary", base_sha: relation.base_sha },
      });
      return { kind: "linked", record: target, relation, saved, warnings: repoWarnings(at, target, run) };
    }
    const fromRecord = findIn(requirements, from);
    if (!fromRecord) {
      throw new Error(`${key} is recorded under ${from}, but ${from} is not in ${at.dir}; a correction cannot finish by guesswork`);
    }
    const resumed = Boolean(intent && intent.from === from && intent.to === id);
    const reason = resumed ? intent.reason : String(flags.reason).trim();
    if (!resumed) {
      // The intent goes in before either requirement moves (R1): an interruption is
      // then explainable from the log, and a retry converges on it.
      const entries = readLog(at.dir);
      appendLog(at.dir, { seq: nextSeq(entries), at: nowIso(), op: "correct", run: key, from, to: id, reason });
    }
    // Add the new relation first, remove the old one second. An interruption leaves
    // the run in two requirements — visible, reported, recoverable — never in none.
    const carried = relationIn(fromRecord.frontmatter, project, feature) ?? relate();
    const added = saveRequirement({
      dir: at.dir, file: target.file, record: withRelation(target.frontmatter, carried), body: target.body,
      op: "link", extra: { run: key, from, to: id, reason },
    });
    const removed = saveRequirement({
      dir: at.dir, file: fromRecord.file, record: withoutRelation(fromRecord.frontmatter, project, feature), body: fromRecord.body,
      op: "unlink", extra: { run: key, from, to: id, reason },
    });
    const warnings = run ? repoWarnings(at, target, run) : [`${key} has no state.json: the relation moved as recorded metadata, without re-reading the run`];
    return { kind: "corrected", record: target, from, to: id, resumed, reason, carried, added, removed, warnings };
  });

  const record = outcome.record.frontmatter.id;
  if (outcome.kind === "already") {
    say(`already linked: ${key} is the primary of ${record}`);
    say(describeDelivery(outcome.relation?.delivery ?? { state: "pending" }));
    return;
  }
  if (outcome.kind === "linked") {
    say(`linked ${key} → ${record} (primary, base ${short(outcome.relation.base_sha)})`);
    say(describeDelivery(outcome.relation.delivery));
  } else {
    say(`corrected: ${key} ${outcome.from} → ${outcome.to} (${outcome.resumed ? "resumed the recorded intent" : "intent recorded first"}: "${outcome.reason}")`);
    say(describeDelivery(outcome.carried.delivery));
  }
  for (const warning of outcome.warnings ?? []) warn(warning);
}

function describeDelivery(delivery) {
  if (delivery?.state !== "delivered") return "delivery pending";
  const parts = [`delivered ${short(delivery.final_tip)} at ${delivery.delivered_at || "(no completion time recorded)"}`];
  if (delivery.archived_at) parts.push(`archived ${delivery.archived_at}`);
  if (delivery.evidence_dir) parts.push(`evidence ${delivery.evidence_dir}`);
  return parts.join("\n");
}

function cmdSync({ positional, flags }) {
  if (positional.length !== 1) throw new UsageError("sync needs a run: req sync <project>/<feature>");
  const { project, feature } = parseRunKey(positional[0]);
  const at = locate(flags);
  if (at.project !== project) {
    throw new UsageError(`run ${positional[0]} belongs to project ${project}, but this ledger is ${at.project} (${at.dir}); ` +
      `run the command in that project's repository or pass --project ${project}`);
  }
  const run = readRun({ project, feature });
  const target = deliveryFrom(run.state);
  const key = runKeyOf(project, feature);
  const reason = supersedeReason(run.dir);

  const outcome = withLock(at.dir, () => {
    const requirements = readRequirements(at.dir);
    const ambiguous = ambiguousRuns(requirements);
    if (ambiguous.has(key)) throw ambiguityError(key, ambiguous.get(key), lastCorrection(readLog(at.dir), key));
    const holders = primaryHolders(requirements, project, feature);
    if (!holders.length) throw new Error(`${key} is not linked to a requirement; run req link ${key} REQ-001 first`);
    const record = findIn(requirements, holders[0]);
    const relation = relationIn(record.frontmatter, project, feature);
    const applied = syncDelivery(relation, target, { reason });
    if (!applied.changes.length) return { kind: "in-sync", record, relation, target, conflict: applied.conflict };
    const saved = saveRequirement({
      dir: at.dir, file: record.file,
      record: { ...record.frontmatter, runs: record.frontmatter.runs.map((entry) => (entry === relation ? applied.relation : entry)) },
      body: record.body, op: "sync", extra: { run: key, changes: applied.changes.join(",") },
    });
    return { kind: "written", record, relation: applied.relation, changes: applied.changes, target, saved };
  });

  const record = outcome.record.frontmatter.id;
  const delivery = outcome.relation.delivery ?? { state: "pending" };
  const history = outcome.relation.delivery_history?.length ?? 0;
  if (outcome.kind === "in-sync") {
    say(`${key} → ${record}`);
    if (outcome.target.state === "pending" && delivery.state !== "delivered" && !history) {
      // E11b: nothing in state.json to record, and no snapshot here to fall back
      // on. The ledger says so instead of inventing a delivery.
      say("state.json has no completion, and this ledger holds no snapshot of a delivery for this run.");
      say("Nothing is recorded and nothing is invented: only Workloop's own evidence (state.json, events.jsonl, a commit SHA) can say what was delivered.");
      say(describeDelivery(delivery));
      return;
    }
    say(`in sync: ${describeDelivery(delivery)}`);
    if (history) say(`${history} superseded snapshot${history === 1 ? "" : "s"} kept in delivery_history`);
    if (outcome.conflict) {
      warn(`state.json reports ${short(outcome.conflict.reported)}, but the archived delivery is fixed at ${short(outcome.conflict.recorded)}; ` +
        "an archived SHA is not rewritten");
    }
    return;
  }

  say(`${key} → ${record}`);
  if (outcome.changes.includes("superseded")) {
    const last = outcome.relation.delivery_history?.at(-1);
    say(`superseded ${short(last?.final_tip)} (${last?.reason}) → delivery_history`);
  }
  say(describeDelivery(delivery));
}

// A `--commit` is kept only if the repository can resolve it: a SHA the ledger
// cannot check is a SHA it should not write down.
function resolveCommit(repo, value) {
  const text = String(value ?? "").trim();
  if (!/^[0-9a-f]{4,40}$/i.test(text)) throw new UsageError(`--commit ${JSON.stringify(text)} is not a commit SHA`);
  const found = spawnSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `${text}^{commit}`], { encoding: "utf8" });
  const sha = found.status === 0 ? found.stdout.trim() : "";
  if (!sha) throw new UsageError(`--commit ${text}: no such commit in ${repo}. A Quick outcome records a commit that exists, or none`);
  return sha;
}

function cmdNote({ positional, flags }) {
  const id = normaliseId(positional[0]);
  if (!id) throw new UsageError('note needs a requirement: req note REQ-001 --outcome "<summary>" [--commit <sha>]');
  const text = positional.slice(1).join(" ").trim();
  const isOutcome = flags.outcome !== undefined;
  if (isOutcome && text) throw new UsageError("note takes --outcome or a free note, not both");
  if (!isOutcome && !text) throw new UsageError('note needs --outcome "<summary>" or a note to append: req note REQ-001 "…"');
  if (!isOutcome && (flags.commit !== undefined || flags.verification !== undefined)) {
    throw new UsageError("--commit and --verification describe an --outcome; a free note takes neither");
  }
  if (isOutcome && !String(flags.outcome).trim()) throw new UsageError("--outcome needs a summary");
  const at = locate(flags);
  const commitSha = flags.commit === undefined ? null : resolveCommit(at.repo, flags.commit);

  const outcome = withLock(at.dir, () => {
    const requirements = readRequirements(at.dir);
    const found = findIn(requirements, id);
    if (!found) {
      throw new Error(`no requirement ${id} in ${at.dir}: a Quick change does not create one just to have somewhere to write`);
    }
    const now = nowIso();
    if (isOutcome) {
      const entry = newOutcome({ summary: String(flags.outcome).trim(), commitSha, verification: flags.verification?.trim() || null, now });
      const saved = saveRequirement({
        dir: at.dir, file: found.file, record: withOutcome(found.frontmatter, entry), body: found.body,
        op: "note", extra: { outcome: entry.summary, ...(commitSha ? { commit_sha: commitSha } : {}) },
      });
      return { kind: "outcome", record: found, entry, saved };
    }
    const line = `- ${now.slice(0, 10)} ${text}`;
    const saved = saveRequirement({
      dir: at.dir, file: found.file, record: found.frontmatter, body: appendNote(found.body, line), op: "note", extra: { note: text },
    });
    return { kind: "note", record: found, line, saved };
  });

  const record = outcome.record.frontmatter.id;
  if (outcome.kind === "outcome") {
    const { entry } = outcome;
    say(`noted ${record}: ${entry.summary}${entry.commit_sha ? ` (commit ${short(entry.commit_sha)})` : ""}`);
    say("recorded as a Quick outcome; no run, and nothing in Workloop, is involved.");
  } else {
    say(`noted ${record}: ${outcome.line.slice(2)}`);
  }
}

const COMMANDS = {
  new: cmdNew, list: cmdList, show: cmdShow, retire: cmdRetire, doctor: cmdDoctor,
  link: cmdLink, sync: cmdSync, note: cmdNote,
};

function main(argv) {
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const [name, ...rest] = argv;
  if (PENDING[name]) fail(`${name} is not part of this build yet (${PENDING[name]}); see the requirement-ledger skill`, 2);
  const command = COMMANDS[name];
  if (!command) fail(`unknown command ${JSON.stringify(name)}\n\n${USAGE}`, 2);
  try {
    const { positional, flags } = parse(rest);
    if (flags.help) {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    command({ positional, flags });
  } catch (error) {
    if (error instanceof UsageError || (error instanceof RunError && error.code === "usage")) fail(error.message, 2);
    fail(error.message);
  }
}

main(process.argv.slice(2));
