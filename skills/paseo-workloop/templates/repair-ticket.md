# NN: Fix <what is broken, as a user or caller would put it>

Blocked by: <number of each ticket whose integrated work this repairs>

Found in: <final review of <tip sha>, or where else you saw it>

<!-- Written by the orchestrator for a defect found on the integration tip, usually in the final review.
     Save it next to the other tickets as `NN-fix-<cause>.md` with the next free number, then `workloop import`.
     The executor has only this file, the spec and the code to go on, so the ticket must stand on its own.
     - Reproduce: a command you ran yourself on the integration tip, and what it printed. Not something an agent told you.
     - Keep what you saw (Symptom, Reproduce) apart from what you think caused it (Known cause).
     - Say what must be true when it's fixed. Prescribe the fix only if you know it. -->

## Symptom

What goes wrong, in one or two sentences.

## Reproduce

On the integration tip `<sha>`:

```
<command>
```

Actual output:

```
<what it printed, trimmed to the part that shows the defect>
```

## Expected

What the same command should print or do, and the spec item that says so.

## Known cause

What you have established, with the evidence: file and line, a log line, a bisect. Mark a guess as a guess. Write "Unknown" if you haven't established it.

## Acceptance

- [ ] The command under Reproduce gives the expected result.
- [ ] A regression test fails on `<sha>` and passes with the fix.
- [ ] The run's checks pass.
