// `req doctor`: compare the ledger's records, its `_meta.json` and its audit log
// and report what does not add up. Repairs run in the conservative direction only:
// `lastIssued` may rise, never fall; `--repair-log` appends the missing audit line
// and never touches prose, status or a delivery SHA.
//
// Each check answers with findings instead of throwing, so one damaged file never
// hides the rest. Cross-file checks — dangling run references, two primaries on one
// run, dead `refs` — are their own ticket; they join here as further passes over
// the same context.
import { existsSync } from "node:fs";

import { bodyDigest, idFor, numberIn, recordProblems } from "./record.mjs";
import {
  appendLog, highestNumber, ledgerDir, listRequirementFiles, nextSeq, readLog, readMeta, readRequirements,
  writeMeta, withLock,
} from "./store.mjs";
import { nowIso } from "./time.mjs";

export function runDoctor({ project, repairLog = false, now = nowIso(), io } = {}) {
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

    checkAudit({ dir, parsed, findings, repairLog, now });

    return { dir, findings, requirements, lastIssued };
  });
}

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
