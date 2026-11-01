// `req doctor`: the ledger's single consistency pass. It compares the records
// against each other, against `_meta.json`, against the runs they cite and against
// the repository they belong to, and reports what does not add up. Repairs run in
// the conservative direction only: `lastIssued` may rise, never fall; `--repair-log`
// appends the missing audit line and never touches prose, status or a delivery SHA.
//
// Each check answers with findings instead of throwing, so one damaged file never
// hides the rest. Everything that is only a disagreement — a run that moved away, a
// half-finished `link --correct`, a stale ADR reference — is reported and left for
// the user to settle; `doctor` does not pick an owner, delete a relation or guess a
// replacement.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { bodyDigest, idFor, numberIn, recordProblems } from "./record.mjs";
import { DOC_DIRS, resolveDocRef } from "./refs.mjs";
import { ambiguousRuns, lastCorrection, runsOf } from "./relations.mjs";
import {
  appendLog, highestNumber, ledgerDir, listRequirementFiles, nextSeq, readLog, readMeta, readRequirements,
  sameRepoPath, sanitiseRemote, workloopRoot, writeMeta, withLock,
} from "./store.mjs";
import { nowIso } from "./time.mjs";

export function runDoctor({ project, repairLog = false, now = nowIso(), io, repo = null, remote = null } = {}) {
  const dir = ledgerDir(project);
  const findings = [];
  if (!existsSync(dir)) return { dir, findings, requirements: [], lastIssued: 0 };

  return withLock(dir, () => {
    const requirements = readRequirements(dir);
    const parsed = requirements.filter((requirement) => !requirement.error);

    for (const requirement of requirements) {
      if (requirement.error) {
        findings.push({ code: "invalid-frontmatter", file: requirement.file, message: `${requirement.file}: ${requirement.error}` });
        continue;
      }
      for (const problem of recordProblems(requirement.frontmatter)) {
        findings.push({ code: "invalid-frontmatter", file: requirement.file, message: `${requirement.file}: ${problem}` });
      }
    }

    const seen = new Map();
    for (const requirement of parsed) {
      const id = requirement.frontmatter.id;
      if (typeof id !== "string" || !id) continue;
      if (seen.has(id)) findings.push({ code: "duplicate-id", id, file: requirement.file, message: `duplicate id ${id} in ${seen.get(id)} and ${requirement.file}` });
      else seen.set(id, requirement.file);
      if (/^REQ-\d{3,}$/.test(id) && id !== idFor(requirement.number)) {
        findings.push({ code: "file-id-mismatch", id, file: requirement.file, message: `${requirement.file} holds id ${id}` });
      }
    }

    let lastIssued = repairMeta({ dir, project, files: listRequirementFiles(dir), parsed, findings, now, io });

    checkDanglingRuns({ parsed, findings });
    checkDoublePrimaries({ dir, parsed, findings });
    checkRepoBinding({ parsed, findings, repo, remote });
    checkRefs({ parsed, findings });
    checkAudit({ dir, parsed, findings, repairLog, now });

    return { dir, findings, requirements, lastIssued };
  });
}

// ---------------------------------------------------------------- cross-file checks

const isRun = (run) => typeof run?.project === "string" && Boolean(run.project) &&
  typeof run?.feature === "string" && Boolean(run.feature);

// A relation is a pointer to a run whose `state.json` is the authority. A pruned
// run directory and a mistyped relation look the same from here, so a missing file
// is reported with the path that was looked at — and the relation is not touched.
function checkDanglingRuns({ parsed, findings }) {
  for (const requirement of parsed) {
    const id = requirement.frontmatter.id;
    for (const run of runsOf(requirement.frontmatter)) {
      if (!isRun(run)) continue;
      const path = join(workloopRoot(), run.project, run.feature, "state.json");
      if (existsSync(path)) continue;
      findings.push({
        code: "dangling-run",
        id,
        run: `${run.project}/${run.feature}`,
        path,
        message: `${id}: run ${run.project}/${run.feature} has no state.json at ${path}; the relation is reported, not removed`,
      });
    }
  }
}

// §6.5 / E10: one run claimed as primary by two records is what an interrupted
// `link --correct` leaves behind. It is never resolved by choosing: the report
// names both holders and points at the correction intent in `_log.jsonl`, which is
// the only way back to a single owner.
function checkDoublePrimaries({ dir, parsed, findings }) {
  const ambiguous = ambiguousRuns(parsed);
  const log = ambiguous.size ? readLog(dir) : [];
  for (const key of [...ambiguous.keys()].sort()) {
    const holders = ambiguous.get(key);
    const intent = lastCorrection(log, key);
    const resumes = Boolean(intent) && holders.includes(intent.from) && holders.includes(intent.to);
    const command = resumes
      ? `req link ${key} ${intent.to} --correct --reason "${intent.reason}"`
      : `req link ${key} <REQ> --correct --reason "<why>"`;
    findings.push({
      code: "double-primary",
      run: key,
      ids: holders,
      message: `${key} is the primary of ${holders.join(" and ")}: a \`link --correct\` did not finish; ` +
        `converge it with \`${command}\`${resumes ? " (the intent recorded in _log.jsonl)" : ""}`,
    });
  }
}

// The record says which repository it belongs to; the ledger is being read from
// one repository. `repo_remote` is compared and printed only in its sanitised
// form, so a credential — even one a hand edit left in a record — never reaches a
// finding.
function checkRepoBinding({ parsed, findings, repo, remote }) {
  if (!repo) return;
  for (const requirement of parsed) {
    const { id, repo_path: recordedPath, repo_remote: recordedRemote } = requirement.frontmatter;
    if (typeof recordedPath === "string" && recordedPath && !sameRepoPath(recordedPath, repo)) {
      findings.push({
        code: "repo-mismatch",
        id,
        field: "repo_path",
        message: `${id}: repo_path ${recordedPath} is not the repository this ledger is read from (${repo}); reported, not rewritten`,
      });
    }
    const recorded = typeof recordedRemote === "string" ? sanitiseRemote(recordedRemote) : null;
    if (typeof remote === "string" && remote && recorded && recorded !== remote) {
      findings.push({
        code: "repo-mismatch",
        id,
        field: "repo_remote",
        message: `${id}: repo_remote ${recorded} differs from this repository's ${remote}; reported, not rewritten`,
      });
    }
  }
}

// `refs` are citations, and a citation that no longer resolves is a fact about the
// repository, not a reason to edit what the user wrote. An ADR is a file under
// `docs/adr/`; a pitfall is an entry in a topic page under `docs/pitfalls/`, named
// by the slug of its heading (or by a page of its own). `refs.mjs` owns the rule,
// and `context` reads a reference through the same resolver.
function checkRefs({ parsed, findings }) {
  for (const requirement of parsed) {
    const { id, repo_path: repoPath, refs } = requirement.frontmatter;
    if (!isMapping(refs)) continue;
    // A repository that is gone is the repo check's finding; resolving citations
    // inside it would report every one of them as dangling for one cause.
    if (typeof repoPath !== "string" || !repoPath || !existsSync(repoPath)) continue;
    for (const [kind, where] of Object.entries(DOC_DIRS)) {
      const entries = refs[kind];
      if (entries === undefined) continue;
      if (!Array.isArray(entries)) {
        findings.push({
          code: "refs-format",
          id,
          ref: kind,
          message: `${id}: refs.${kind} must be a list of names, found ${JSON.stringify(entries)}; reported, not rewritten`,
        });
        continue;
      }
      for (const entry of entries) {
        if (typeof entry !== "string" || !entry.trim()) {
          findings.push({
            code: "refs-format",
            id,
            ref: kind,
            message: `${id}: refs.${kind} holds ${JSON.stringify(entry)}, which is not a name; reported, not rewritten`,
          });
          continue;
        }
        const name = entry.trim();
        if (resolveDocRef(repoPath, kind, name).status === "ok") continue;
        findings.push({
          code: "dangling-ref",
          id,
          ref: kind,
          name,
          message: `${id}: refs.${kind} cites "${name}", which no longer resolves in ${join(repoPath, where)}; ` +
            "the reference is reported, not deleted or replaced",
        });
      }
    }
  }
}

const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// A readable `lastIssued` is a floor: files and ids can only push it up. A missing
// one is rebuilt from what is on disk; an unreadable one is replaced by the same
// floor, which cannot resurrect an unknown number but at least stops it lowering.
function repairMeta({ dir, project, files, parsed, findings, now, io }) {
  const meta = readMeta(dir);
  const floor = Math.max(highestNumber(files), ...parsed.map((requirement) => numberIn(requirement.frontmatter.id) || 0), 0);
  const target = Math.max(meta.lastIssued, floor);

  if (meta.problem === "missing") {
    if (target === 0) return meta.lastIssued;
    writeMeta(dir, { project, lastIssued: target, now }, io);
    findings.push({ code: "meta-missing", message: `_meta.json is missing; rebuilt with lastIssued ${target}`, repaired: true });
    return target;
  }
  if (meta.problem) {
    writeMeta(dir, { project, lastIssued: target, now }, io);
    findings.push({ code: "meta-unreadable", message: `_meta.json cannot be trusted (${meta.problem}); rebuilt with lastIssued ${target}`, repaired: true });
    return target;
  }
  if (meta.lastIssued < floor) {
    writeMeta(dir, { project, lastIssued: target, now }, io);
    findings.push({
      code: "last-issued-below-files",
      message: `_meta.json lastIssued ${meta.lastIssued} is below the highest requirement number ${floor} (repaired to ${target})`,
      repaired: true,
    });
    return target;
  }
  // Readable, but stored as text: the value is kept and only its form is rewritten.
  if (meta.typeMismatch) {
    writeMeta(dir, { project, lastIssued: target, now }, io);
    findings.push({
      code: "meta-type",
      message: `_meta.json lastIssued ${JSON.stringify(meta.rawLastIssued)} is stored as text; written back as ${target} without lowering it`,
      repaired: true,
    });
    return target;
  }
  return meta.lastIssued;
}

// The audit log is a record of writes, not a second copy of the ledger: a missing
// or outdated line is reported, and only `--repair-log` writes the catch-up line.
function checkAudit({ dir, parsed, findings, repairLog, now }) {
  const log = readLog(dir);
  let seq = nextSeq(log);
  const latest = new Map();
  for (const entry of log) {
    if (entry?.unreadable !== undefined) {
      findings.push({ code: "log-unreadable-line", message: `_log.jsonl: unreadable line ${JSON.stringify(entry.unreadable)}` });
      continue;
    }
    if (typeof entry?.id === "string" && Number.isInteger(entry.rev)) latest.set(entry.id, entry);
  }

  for (const requirement of parsed) {
    const { id, rev } = requirement.frontmatter;
    if (typeof id !== "string" || !/^REQ-\d{3,}$/.test(id)) continue;
    const digest = bodyDigest(requirement.body);
    const entry = latest.get(id);
    let reason = null;
    if (!entry) reason = "missing";
    else if (entry.rev < rev) reason = "stale";
    else if (entry.body_sha !== digest) reason = "drift";
    if (!reason) continue;

    const finding = {
      code: `audit-${reason}`,
      id,
      file: requirement.file,
      message: {
        missing: `${id}: the audit log has no line for this file`,
        stale: `${id}: the file is at rev ${rev} but the audit log stops at rev ${entry?.rev}`,
        drift: `${id}: the prose no longer matches the last recorded write (drift)`,
      }[reason],
    };
    if (repairLog) {
      const appended = appendLog(dir, {
        seq: seq++, at: now, op: "log-repair", id, rev, body_sha: digest, file: requirement.file, reason,
      });
      if (appended.ok) finding.repaired = true;
      else finding.message += `; the repair line could not be written (${appended.error})`;
    }
    findings.push(finding);
  }
}
