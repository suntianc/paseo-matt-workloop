# NN: Fix <what is broken, as a user or caller would put it>

Blocked by: <number of each ticket whose integrated work this repairs>

Found in: <the final reviewer's report at <tip sha>, or where else you saw it>

<!-- Written by the orchestrator for a defect found on the integration tip, usually one the final reviewer reported.
     Save it next to the other tickets as `NN-fix-<cause>.md` with the next free number, then `workloop import`.
     The executor has only this file, the spec and the code to go on, so the ticket must stand on its own.
     - Reproduce: a command you ran yourself on the integration tip, and what it printed. Not something an agent told you.
     - Keep what you saw (Symptom, Reproduce) apart from what you think caused it (Known cause).
     - Say what must be true when it's fixed. Prescribe the fix only if you know it.
     - Give the acceptance items the command that proves them, after `— check: \`<command>\``: integration runs it again at every later integration and at finish, from the root of the integrated tree, so it must be repeatable.
     - Number the items `AC1`, `AC2`, …: `import` records them, and a later change is recorded with `WL criteria` after the user agrees to it.
     - Bound every item: the reviewer holds it to its letter. Replace "all", "every", "never" with the scope they cover, and write a known limit into the item. -->

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

- [ ] AC1: The command under Reproduce gives the expected result — check: `<the command under Reproduce>`
- [ ] AC2: A regression test fails on `<sha>` and passes with the fix.
- [ ] AC3: The run's checks pass.
