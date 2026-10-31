# Interrupted validation handoff

This records incomplete work, not an acceptance verdict.

## Candidate and interruption

- Worktree, expected branch and full SHA; observed status.
- Exact platform/tool error and step identifier, or explicitly “not supplied”.
- Scope paused; no rejected action was retried or disguised.

## Completed commands

| Occurrence / criterion | Command | Actual exit or timeout | Durable receipt and full log | Execution owner |
|---|---|---|---|---|

Retain first failures and subsequent successes as separate occurrences. A missing exit is unknown. Keep command dispatch, successful process completion and verified external effect distinct.

## Observations and unfinished work

- Confirmed finding with its criterion/floor-class basis and evidence.
- Source-only observation or hypothesis, explicitly unconfirmed.
- Prepared but unexecuted experiments.
- Remaining command occurrences and mapping rows, preserving required repetitions.

## Owned processes and recovery

- Recorded PID/token, exact command, unique temporary profile/cwd and current identity evidence.
- Whether cleanup was attempted, its actual result and anything still unknown.
- Last source/branch/HEAD check; no automatic reset or cleanup of another process's work.
- Smallest permitted continuation scope, or the exact blocked step.
