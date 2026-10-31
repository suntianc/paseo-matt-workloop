# Fixed-candidate validation

Use this when a validator or reviewer must measure committed work without changing it, when an external API fake may hide a boundary, or when a failed check needs diagnosis.

## Guard the candidate

Run commands through `../scripts/validate.mjs` with the expected full SHA and branch from the brief. Choose a new evidence directory outside the worktree; its parent must already exist. For example, with paths and commands supplied by the task:

```sh
node <skill>/scripts/validate.mjs \
  --repo <worktree> --expect-sha <full-sha> --expect-branch <branch> \
  --output <new-evidence-directory> \
  --preflight "pnpm typecheck" --preflight "pnpm lint" \
  --preflight "pnpm format" --check "pnpm test"
```

The helper requires a clean attached branch and records HEAD, branch, index, status and a content digest of tracked and non-ignored untracked files before and after each command. A changed field fails validation even when the command exited zero, stops the remaining checks, and leaves the changed worktree untouched for inspection. Preserve that receipt; reconciliation belongs to the orchestrator.

This detects persistent drift, including switching to detached HEAD at the same commit, staged lockfile changes and new source files. It is not a sandbox: an edit or checkout restored between snapshots is not detected. Ignored build outputs and external state are not fingerprinted; checks may create them. Use provider or filesystem restrictions when actual write prevention is needed.

`receipt.json` is written before dispatch and after every result. Each executed occurrence records its PID/token, full combined output log, exit code or timeout, timestamps and post-check snapshot. The embedded output is a bounded excerpt; the adjacent log holds the full output. The evidence directory is never overwritten. An interrupted receipt remains `complete: false`; a queued command or process creation is not a pass.

The timeout defaults to 30 minutes per command; `--timeout` sets a positive number of minutes up to 1440. Process cleanup uses the existing workloop check runner: the command's process group on POSIX, its reachable process tree on Windows. Deliberately detached processes and PID-reuse races retain the existing limitations described in [the run procedure](run.md). Recover an interrupted command from its saved PID/token and [recovery evidence](recovery.md), not by launching it again blindly.

## Order checks and preserve repetitions

Put cheap static checks in `--preflight`; those run before `--check` and `--repeat-check`, preserving order within each list. A failed preflight stops expensive browser tests. Select the commands required by the repository; the example is not a universal package-manager convention.

By default every supplied occurrence executes, including identical commands. Where the user has explicitly approved sharing an execution, `--reuse-identical` can reuse a successful **consecutive identical command** in this invocation only. Its receipt records `reusedFrom`, a zero-based index into `checks`; it does not invent an exit code for an execution that did not occur. Reuse requires the same repository snapshot and environment digest. Any intervening executed command clears reuse, because it may change ignored dependencies or other inputs.

Use `--repeat-check` for independent trials, timing observations, stress or external-state checks. These always execute and are never reused. Even consecutive reuse is suitable only for checks known to have equivalent inputs; ignored outputs and external services can change without a Git difference. No environment values are saved, only their digest.

This helper does not rewrite tickets, change criteria, or change how `integrate` and `finish` execute the regression set. Existing confirmed occurrences still run as agreed. For new tickets, reference a shared full-suite or smoke check deliberately rather than making every criterion repeat it accidentally; retain explicit repetitions that provide stability evidence.

## Validate the external contract

When a fake sits at an API boundary, calibrate the behavior that matters using a small real API observation or controlled return values reflecting that contract. Examples include a title query that accepts patterns rather than exact strings, or an API that activates a new object before returning its identity. A green fake test does not establish that the real API has the same semantics. Preserve the original failing schedule and correct inaccurate fixtures openly.

For an asynchronous API without atomic destination or cancellation support, model the lifecycle before adding more preflight reads:

| State | Evidence and responsibility |
|---|---|
| Preparing | No mutating dispatch yet; account for live work and reclaim only preparations proven abandoned with their owner. |
| Dispatched, outcome unknown | A reject or timeout does not prove no effect. Retain responsibility; do not infer an object to remove from URL or timing. |
| Known, uncommitted | Validate the actual result and coordinate its state; rollback only objects reliably attributable to this operation. Report cleanup failure honestly. |
| Completed | Treat the result as ordinary user state. Keep only provenance still needed by older unresolved observers. |

An extra read cannot close the gap between that read and an asynchronous browser mutation. Define the safe-failure contract, capacity policy and restart boundary, then test the last-read/dispatch gap, delayed results, cleanup failure and owner interruption. Avoid time-based forgetting of unresolved effects. Keep claims about original foreground restoration bounded by observable state and concurrent user actions.

## Diagnose a failed browser start

Keep the first exit, full output and skipped work separate from later successful commands. Before changing timeouts or adding retries, capture the executable/version, exact arguments, owned PID, unique profile, elapsed time, stderr and exit event. A launcher should clean up only processes it can prove it created, within a bound, while retaining useful failure evidence.

An empty stderr timeout needs more evidence, not a network or flakiness label. Where permitted, inspect the still-owned process before cleanup; a stack sample can establish where it is waiting without proving every trigger or the original lock owner. Record identity again before signalling. Never kill by process name or pattern.

Use a planned, bounded startup sample and the required full tests to measure recovery. Preserve each attempt and its conditions. Passing samples show operation under those conditions; they do not prove the original hang can never recur. Keep execution self-check, independent inspection of its artifacts, and independently rerun tests distinct in the report.
