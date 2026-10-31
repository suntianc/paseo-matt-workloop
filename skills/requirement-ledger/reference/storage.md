# Storage

## Layout

```
$WORKLOOP_ROOT/<project>/.requirements/
├── _meta.json                 # { project, lastIssued, updated_at }
├── _log.jsonl                 # audit trail: not authoritative, not a transaction
├── REQ-001-user-login.md
└── REQ-002-checkout.md
```

`WORKLOOP_ROOT` defaults to `~/.workloop`, as it does for Workloop runs. `project` is the key Workloop uses, `slug(basename(repo))`, so the ledger sits beside that project's run directories. A Workloop feature name must match `^[a-z0-9][a-z0-9-]*$` and so cannot begin with a dot, which is why a `.requirements/` directory can never collide with a run directory.

v1 adds no project registry. Two checkouts with the same directory name share one project key on this machine, exactly as Workloop runs already do.

The ledger lives under `~/.workloop`, outside the Git repository. Its Markdown is readable by people, but v1 claims no Git history for it and imposes none.

## The record

One file per requirement: YAML frontmatter, then prose.

```yaml
---
id: REQ-007              # immutable, assigned by the CLI
title: User login        # yours to edit
status: active           # active | retired
rev: 3                   # CLI writes; a hand edit does not bump it
created_at: 2026-11-01T10:00:00+08:00
updated_at: 2026-11-01T10:00:00+08:00
repo_path: /Users/x/project/myapp
repo_remote: github.com/owner/myapp    # sanitised: no userinfo, no token
aliases: [login, sign-in, 登录]
runs:
  - project: myapp
    feature: req-007-login             # a run is located by <project>/<feature>
    relation: primary
    base_sha: 3f2a…                    # the run's state.baseSha, read at link time
    linked_at: 2026-11-01T10:05:00+08:00
    delivery:
      state: delivered                 # pending | delivered
      final_tip: 9c1b…                 # = state.completion.tip
      delivered_at: …                  # = state.completion.at
      archived_at: …                   # = state.finishedAt
      evidence_dir: …                  # optional; existence checked separately
    delivery_history: []               # superseded deliveries, append-only
outcomes: []                           # Quick work: date, summary, real commit_sha, verification
refs:
  adr: [0007-session-tokens]
  pitfalls: [auth-cookie-domain]
  spec_hint: /Users/x/.workloop/myapp/req-007-login/spec.md
  codegraph:
    symbols: [AuthService.login]
    paths: [src/auth/]
---
## Summary
The capability as it stands now.

## History
Dated milestones, each naming the run that delivered it.

## Notes
```

**Machine fields** — `id`, `status`, `rev`, the timestamps, `runs`, `delivery`, `delivery_history`, `outcomes` and `repo_*` — are written and validated through the CLI. Hand-editing them is how a ledger goes inconsistent.

**Human fields** — `title`, `aliases`, the prose and `refs` — are yours to edit. `doctor` checks their format and whether what they cite still exists; it never rewrites them.

`refs` holds citations only: ADR numbers, pitfall names, a spec path, CodeGraph hints. The prose behind each stays where it lives.

## Identity allocation

- The allocator reads `_meta.json.lastIssued`.
- The next number is `max(lastIssued, highest number among the existing files) + 1`.
- `lastIssued = n` is persisted atomically **before** `REQ-<n>-<slug>.md` is created. An interruption between the two leaves a gap in the numbering, which is harmless; a number is never handed out twice and never taken back.
- Repair runs upward only. A damaged or contradictory `_meta.json` is repaired to `max(highest existing number, the readable lastIssued)`, so `lastIssued` can only rise.
- `doctor` checks that `lastIssued` is at least the highest number present, that every file's `id` is at most `lastIssued`, and that no `id` repeats. A gap is not an error.

## Repository binding

Every record names the repository it belongs to: `repo_path`, as a normalised absolute path, and `repo_remote`, sanitised — userinfo and tokens stripped. `new` refuses to append to a ledger whose repository does not match, and `doctor` reports a mismatch. A cross-repository association is never silent.

## Revision and drift

`rev` counts writes made through the CLI, adding one per successful write. Hand-edited prose does not bump it, and v1 does not claim that every hand edit is counted or logged.

To make an unrecorded edit visible, each `_log.jsonl` line may carry a digest of the body it wrote. `doctor` reports prose that no longer matches the most recent recorded digest as **drift**, and leaves the prose alone; recording the edit is a decision for the user, taken with `note`.

## Writing safely

- **One lock per project.** `.requirements/.lock` is created exclusively (`flag "wx"`) holding a pid and a time. Workloop's own lock, atomic-write and journal helpers are not exported, so the CLI implements the same idea in a few lines rather than importing them.
- **Stale locks.** Liveness is decided by pid. A lock that cannot be shown to be dead is not taken over: the command fails and names the holder, because taking a live writer's lock loses work.
- **Replace, never rewrite in place.** Write a temp file in the same directory, then `rename`. A reader sees the old file or the new one, never half of either.
- **Crash consistency, and its limit.** `rename` is atomic; it is not durable. v1 guarantees crash consistency — a killed process leaves no corrupt file, and the lock plus a retry recovers — and does its best for power loss by `fsync`ing the temp file before the rename and the directory after it. It claims no strict transaction across a power cut; `doctor` is the backstop.
- **The audit log is not a transaction.** `_log.jsonl` records what happened; the requirement file is authoritative. The file is written first and the audit line appended after. If the append fails, the file still stands: `doctor` reports the audit gap and `--repair-log` writes the missing line. Two file writes are not a transaction.

## `doctor`

`req doctor` reports, repairing only where noted:

1. a duplicate `id`;
2. invalid frontmatter;
3. a run reference whose `<project>/<feature>/state.json` is gone;
4. more than one valid primary relation on the same run;
5. `_meta.json.lastIssued` disagreeing with the files present;
6. `rev` or `body_sha` gaps against `_log.jsonl` — `--repair-log` fills these;
7. dangling `refs.adr` or `refs.pitfalls` — reported, never deleted or guessed at;
8. `repo_path` or `repo_remote` disagreeing with the current repository.

`--repair-log` only appends recoverable audit lines. It never touches prose or a delivery SHA.
