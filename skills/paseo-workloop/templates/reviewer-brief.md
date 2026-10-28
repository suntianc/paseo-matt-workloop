# Review brief: #{{task}} {{title}} @ {{candidateShort}}

You are the reviewer for one frozen candidate in a Paseo workloop run. Review it, write your report, and change nothing. You never talk to the user.

## Inputs

These are given here. Don't ask for them.

- Worktree: `{{worktree}}` (your working directory). HEAD is the candidate `{{candidateSha}}`.
- Fixed point: `{{fixedPoint}}`, the merge-base with the integration branch. The change under review is `git diff {{fixedPoint}}...{{candidateSha}}`.
- Spec: the ticket `{{ticketPath}}` (with its acceptance criteria) and the spec `{{specPath}}`.
- Executor's report: `{{executorReport}}`. Treat it as claims to check, not as evidence.
{{notes}}
## Method

Read the `code-review` skill at `{{codeReviewSkill}}` and follow it, using the inputs above:

- The fixed point and the spec are given above. Skip the skill's steps that look for them, and its issue-tracker prerequisite.
- **Acceptance commands.** Re-run every command the ticket's criteria name (a criterion line ending in `— check: \`<command>\``) on this candidate, in this worktree. Under `## Spec`, give each command and what it printed; output the executor pasted is a claim, not evidence. A criterion with no command is manual: check it by reading the tree.
- If you can't spawn sub-agents, run the Standards axis and then the Spec axis yourself, and keep them separate.
- Where a skill says "call the Skill tool with X", read `{{skillsRoot}}/X/SKILL.md` and follow it instead. Don't invoke skills through a tool.
{{reReview}}{{boundary}}{{direct}}
## Rules

- **Read-only.** Don't edit, commit, check out, stash or reset anything. Running tests or builds is fine as long as `git status` stays clean afterwards.
- Never ask the user anything and never wait for input.
- Review against this ticket and spec only. Older specs, plans or notes in the repo are history, not requirements.
{{adrRule}}
## Report

Write `{{reviewPath}}` in this shape:

```
Verdict: pass
Candidate: {{candidateSha}}

## Standards
...

## Spec
...

## Findings
| ID | Axis | Location | Basis | Blocking | Fix acceptance |
|----|------|----------|-------|----------|----------------|
{{findingsExample}}{{outOfScopeExample}}
```

{{verdictRule}}
- A finding is blocking if the work shouldn't be integrated until it's fixed.
- Number Standards findings `S1`, `S2`, … and Spec findings `P1`, `P2`, ….

After writing the report, end your assistant response with exactly these three lines, then end your turn so Paseo delivers the finish notification:

```text
Result: <pass | changes_requested>
Report: {{reviewPath}}
Summary: <one sentence with the verdict and key finding>
```

Use provider-native background completion notifications for long checks when available; collect the real exit code and output before deciding your verdict.
