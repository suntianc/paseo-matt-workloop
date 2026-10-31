#!/usr/bin/env node
// `req`, the requirement ledger's only entry point. A requirement is one Markdown
// file under `$WORKLOOP_ROOT/<project>/.requirements/`; this CLI mints numbers,
// replaces files atomically, retires them without deleting anything, and checks
// that the ledger still adds up.
//
// `lookup`, `context`, `link`, `sync` and `note` are named in the dispatcher and
// answer that they are not part of this build yet.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { runDoctor } from "./doctor.mjs";
import { idFor, numberIn } from "./record.mjs";
import {
  createRequirement, ledgerDir, listRequirementFiles, projectKey, readRequirement, readRequirements,
  saveRequirement, withLock,
} from "./store.mjs";

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

The ledger lives in $WORKLOOP_ROOT/<project>/.requirements/ and defaults to
~/.workloop. Run the command from inside the project's repository.`;

// Later tickets add these; the dispatcher knows their names so the answer is
// "not yet" rather than "unknown command".
const PENDING = {
  lookup: "search the ledger for candidates",
  context: "assemble a requirement's references",
  link: "record which requirement a run delivers",
  sync: "copy a run's delivery state into the ledger",
  note: "record Quick work or a note",
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
  for (const requirement of requirements) {
    if (requirement.error) {
      say(`${requirement.file.padEnd(width)}  unreadable  ${requirement.error}`);
      continue;
    }
    const { id, status, updated_at: updatedAt, title } = requirement.frontmatter;
    say(`${id.padEnd(width)}  ${String(status).padEnd(7)}  ${String(updatedAt ?? "").slice(0, 10)}  ${title}`);
  }
}

function cmdShow({ positional, flags }) {
  const id = normaliseId(positional[0]);
  if (!id) throw new UsageError("show needs a requirement: req show REQ-001");
  const at = locate(flags);
  const found = findRequirement(at.dir, id);
  if (!found) throw new UsageError(`no requirement ${id} in ${at.dir}`);
  process.stdout.write(readFileSync(join(at.dir, found.file), "utf8"));
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

const COMMANDS = { new: cmdNew, list: cmdList, show: cmdShow, retire: cmdRetire, doctor: cmdDoctor };

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
    if (error instanceof UsageError) fail(error.message, 2);
    fail(error.message);
  }
}

main(process.argv.slice(2));
