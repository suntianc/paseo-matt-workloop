Verdict: pass
Integration tip: <sha of the integration branch you reviewed>

<!-- Written by the orchestrator itself, not a dispatched agent, once every ticket is integrated.
     Scope: `git diff <baseSha>..<integration tip>` (both shown by `workloop status`).
     Verdict is changes_requested if anything below fails. In that case write repair tickets, `import`, dispatch them,
     and redo this review on the new tip. `finish` only accepts a pass for the current tip. -->

## Acceptance

| Spec item | Evidence on the integrated tree |
|-----------|---------------------------------|
| ... | test / command / file that shows it works |

## Cross-ticket review

Look for problems that per-ticket reviews can't see:

- interface drift between tickets built in parallel
- duplicated or contradictory logic
- leftover scaffolding
- dead code created by combining the tickets

## Regression

Record the commands you ran on the integration worktree and their results: the full test suite, the build or typecheck, and a real run of the changed surface. Note anything you skipped and why.

## Repair tickets

None, or the ticket files you created for repairs.
