# Ticketed runs: Direct and Full

## Before you start

- **Rex check.** Rex must be running: `rex ls --json` prints JSON (the script finds `rex` on PATH, else inside `Rex Beta.app`; `REX_CLI` overrides). If it doesn't, stop and tell the user. Don't fall back to in-session subagents: they have no tab, no turn files and no conversation the run can go on in.
- **You are the orchestrator in an interactive session of Claude Code, codex or pi**, and something must wake you when an agent's turn ends: every turn is a headless process in a Rex tab, and `WL wait` exits when one ends. How you run it depends on your CLI (see [async-supervision.md](async-supervision.md)): Claude Code runs it as a background command; pi runs it with the `bgrun` tool of pi-background-run; codex starts `WL wait --wake codex` in a background terminal. Without one of these, report that limitation; do not replace it with a polling loop. Run your CLI itself in a Rex tab when you can: the Rex server, not the app window, owns the processes in its tabs.
- **Launch settings.** Each role names a provider and the settings its CLI takes: `dsh` needs `mode` (a permission preset, such as `danger-full-access`) and takes `profile` (the dsh profile, default `headless`, which sets its model and effort); `devin` needs `mode` (`auto`, `accept-edits`, `smart`, `dangerous`) and takes `model`; `codex` needs `mode` (its sandbox: `read-only`, `workspace-write`, `danger-full-access`) and takes `model` and `thinking` (its reasoning effort); `pi` takes `model` (a pattern or `provider/id`) and `thinking`, and no `mode`, because it has none: its tools run as the user. Either role may use any of them. They come from the command's flags (`--provider`, `--mode`, `--model`, `--thinking`, `--profile`; `--review-…` for the reviewer), then the run's config, then `$WORKLOOP_ROOT/launch.json` (`{"executor": {…}, "reviewer": {…}}`), which the user keeps. `WL config --clear-launch executor` (or `reviewer`) drops that role's overrides, so it follows the file again. A role with no provider, a missing `mode`, or a setting its CLI does not take is refused before anything is created; `config` and `status` show it `UNRESOLVED` with the reason, so tell the user what it said. Don't choose a provider or model for them.
- **The `WL` shorthand.** Below, `WL` means `node <this skill's directory>/scripts/workloop.mjs --run <project>/<feature>`. Write it out in full in each command, because shell state may not persist between your tool calls.

## 1. Tickets

Tickets live at `<run dir>/issues/NN-slug.md` and the spec at `<run dir>/spec.md`, in the `to-tickets` local-file format. Each ticket has a "Blocked by" line listing ticket numbers, or "None".

Before writing them, run `WL scratch --feature <slug> --repo <repo>`, which creates and prints the run directory.

to-spec and to-tickets may tell you to publish to an issue tracker or to local files in the repo; write to the run directory instead, whatever the repo configures, and ignore their `/setup-matt-pocock-skills` request and triage labels.

A ticket may carry a `Scope:` line: comma-separated globs, relative to the repo root, naming the paths it may change (`src/parser/, test/parser.test.ts`). The script freezes a candidate only if every changed file matches it, renames and deletions included. Direct tickets must have one; for full-run tickets it is optional.

Every acceptance criterion ends in one of two ways. Either it names the command that proves it, `- [ ] AC1: <criterion> — check: \`<command>\``, one command per line; or it says why no command can: `- [ ] AC2: <criterion> — manual: <why>` (a real device, a judgement about wording). `init` and `import` refuse a criterion with neither, so a manual criterion is one the user saw and confirmed as manual, never one whose command was forgotten. Prefer a command: only a command joins the regression set; a manual criterion is checked once, by its reviewer or the final review. `integrate` re-reads the ticket and runs the run's checks, then this ticket's commands, then those of every integrated ticket — the **regression set** — from the root of the integrated tree, so a command must be **repeatable**: it runs at every later integration and at `finish`, under the same time limit as the checks. The run's checks run at every integration anyway, so no criterion needs to repeat them. Runs created before this rule read a criterion with neither as manual.

Every criterion is numbered, and the IDs are unique within their ticket; `init` and `import` refuse one with no ID or a repeated ID.

Write each criterion with its bound: what is observed, under which conditions, on which platforms. A reviewer holds a criterion to its letter, so an unbounded word — "all", "every", "never", "always" — becomes a demand no change can meet when the system cannot guarantee it ("every descendant process is stopped" against an OS that reuses process IDs). Name the scope the word covers ("the check's process group is stopped"), and state a known limit as part of the criterion rather than leaving it for review to discover.

**Confirmed and frozen.** Present the tickets and their criteria to the user before `init`, and start the run only after they confirm them. `init` and `import` record each ticket's criteria as its confirmed set, and from then on that set is frozen: `dispatch`, `freeze` and `integrate` refuse a ticket whose criteria differ — a reworded criterion, a changed command, an added or removed ID — naming the IDs that changed. Only the user's agreement changes them: `WL criteria <NN> --reason "<the user's decision>"` records the new set and the reason, and the refused command then proceeds. `WL finish` lists every recorded change with its reason. Review rulings stay in the review report: the spec and the tickets hold only what the user settled, and a change they agree to is either recorded this way or written as a repair ticket.

When designing new criteria, list the unique check commands and how many times each will execute in a complete regression pass. For a suite repeated across criteria, choose focused commands for distinct behaviors or group the behaviors under one criterion with one suite command when that keeps acceptance clear. Keep explicit repetitions when they measure stability. Present this execution count with the tickets before confirmation; the runner executes occurrences, not unique commands. In an existing run, preserve every confirmed occurrence unless the user agrees to change it. See [validation](validation.md) for fixed-candidate guards, cheap preflight checks and explicit reuse receipts; its optional reuse does not change this script's regression execution.

State what must not change. A ticket may carry `**Keep as is:**` (existing behaviour near the change that must still work) and `**Not in this change:**` (related additions the user did not ask for), written from the user's words: a request to add something keeps what is already there. These lines are what lets the user spot a ticket that removes a feature or adds an interaction they never asked for, and what tells the reviewer that changing a kept behaviour is a `Regression`. Give a kept behaviour a numbered criterion when it must be proved.

When presenting tickets, point out any boundary you chose rather than took from the user — what to retain, what to delete, which cases count — so they confirm it rather than discover it later.

Executors never talk to the user, so every ticket must be implementable without asking anyone. Any gap you leave comes back later as a `question` report.

### A direct run

Write one ticket from [templates/direct-ticket.md](../templates/direct-ticket.md) as `<run dir>/issues/01-<slug>.md`, the only ticket in that directory; there is no spec, the ticket is the spec. Give each criterion the command that proves it, so the reviewer can re-run it and `integrate` and `finish` can check it again.

Use the scope and acceptance already agreed with the user. Ask only about material gaps or decisions the request leaves open.

### A full run

The run needs a spec at `<run dir>/spec.md` and its tickets. If these don't exist yet, create them with the user from the grilling's outcome, by reading and following the sibling skills. They may not be invocable as tools from here, so read the files:

1. [to-spec](../../to-spec/SKILL.md) for the spec. Don't stop at its step 2 to confirm the testing seams.
2. [to-tickets](../../to-tickets/SKILL.md) for vertical slices with blocking edges, written to the run directory.

Skip to-spec's User Stories section: user-visible behaviour goes into the tickets' acceptance criteria. The spec keeps Problem Statement, Solution, Implementation Decisions, Testing Decisions and Out of Scope.

Summarize the testing approach and ticket breakdown. Existing authorization carries forward; resolve material scope or design questions before dispatch. A single bounded ticket may use Direct.

## 2. Start the run

```
WL init --feature <slug> --repo <repo> [--base <ref>] --check "<test command>" [--check "<typecheck>"]
        [--setup "<install command>"] [--check-timeout <minutes>] [--provider p --mode m] [--review-provider p --review-mode m] [--max-executors 2] [--max-reviewers 1]
        [--direct]
```

`init` does the following:

- Resolves both roles' launch settings before it creates anything.
- Creates the integration branch `workloop/<feature>` off the base, in a worktree of its own. Your checkout is never touched.
- Imports the ticket graph from the run directory's `issues/`. With `--direct` it requires exactly one ticket and uses it as the spec. `WL import` allows one follow-up repair at a time after integration, with a `Scope:` and a dependency on the integrated ticket; broader scope belongs in Full.
- Sets up the checks. `--check` commands run on the integration tree after every merge, and must already pass on the base. Every check the script runs (at `init`, `decisions`, `integrate` and `finish`) has the run's **time limit**, `--check-timeout`, in minutes per command (default 30, at most 1440; decimals allowed). A check that runs out of time is stopped with the processes it spawned (its process group on POSIX, its process tree on Windows) and fails saying it timed out after N minutes; on POSIX, any process left in its group when it ends is stopped too, before the result counts. A process the check deliberately detaches (a daemon, `setsid`) is outside that contract: neither the time limit nor recovery stops it, so a check suite must not leave one behind. On Windows there is no process group, so processes left by a wrapper that died on its own cannot be reached. A stop is confirmed before it counts; if it fails, the command says cleanup failed, names the process group or pid and the error, and changes nothing it would otherwise undo: `integrate` and `finish` keep the check phase recorded for recovery, `decisions` keeps its commit, and `init` keeps the integration worktree and branch. Follow the command's instructions: it names the check's token and how to list the processes, so you can confirm they are still the check's before stopping anything. One limitation is accepted: a pid or process group can be reused in the instant between the script verifying it and signalling it, and that is not guarded against.
- Sets the **round cap**: a ticket gets 2 rework rounds (default), then it waits for the user. `--max-rework-rounds <n>` or `WL config --max-rework-rounds <n>` changes it.
- Stores run state in the run directory, `$WORKLOOP_ROOT/<project>/<feature>/` (default `~/.workloop`). The run directory holds everything about the run: the spec and tickets you wrote, briefs, messages, reports, reviews and state. Only the script writes `state.json` and `events.jsonl`. Nothing for the run is written into the repo except code and commits.

A launch change applies to agents started after it; `WL status` shows which settings each role will start with and where they come from.

### Record decisions

If the grilling decided ADR or glossary changes, write them in the integration worktree (`init` prints its path; `WL status --json` shows it as `integration.worktree`), then run `WL decisions` before the first dispatch. It commits those files to the integration branch as one commit and runs the checks, so the first executors branch off a tip that includes the decisions they explain. Use it for nothing else.

- **Superseding an ADR**, in the same change: write the new ADR, delete the old file, and add a row to `docs/adr-history.md`. Create that file from [templates/adr-history.md](../templates/adr-history.md) if it doesn't exist. `docs/adr/` then holds only valid ADRs; the deleted one stays in git, and the history table points at it.
- **Numbering** the new ADR: the highest number in `docs/adr/` or in the history table, plus one. This replaces domain-modeling's "scan `docs/adr/`", so a number is never reused.
- **`Premise:`** An ADR may carry one optional line, `Premise: <the condition the decision depends on>`, only when the decision depends on a condition that can change. Then a later grilling has a stated condition to test against.
- **Reading history.** Read `docs/adr-history.md` only when superseding an ADR or when the user asks to trace history. It's an index for people, not a constraint for agents.

## 3. The loop

Repeat until every ticket is done or cancelled:

1. **`WL status`.** This prints the task table and suggests next steps. After a restart, or whenever you're unsure, use `WL status --live`.
2. **`WL dispatch <NN>`** for each frontier ticket the executor budget allows — `--note` or `--note-file` adds task-specific guidance. It creates the worktree, writes [templates/executor-brief.md](../templates/executor-brief.md), filled in, and starts the executor's first turn in a tab of the run's Rex session.
3. **Arm `WL wait` the way your CLI is woken, then end this turn.** It returns when a running turn ends (or after 110 minutes: arm it again) and says what that turn left: its report, its verdict, or where its output is when it left none.
4. **When you are woken**, read what `wait` printed (codex gets it as the queued message), act using the table below, and return to step 1. A turn ending is a wake-up, not acceptance.

Read [reference/async-supervision.md](async-supervision.md) for how turns, tabs and `wait` fit together. Arm `wait` again before each pause while a turn runs, including after answering an unrelated user message: nothing else wakes you.

| `wait` / current status shows | Do |
|---|---|
| executor's turn ended, `report=done` | Run `WL review <NN>`. It freezes the commit as the candidate and starts a reviewer with [templates/reviewer-brief.md](../templates/reviewer-brief.md). |
| executor's turn ended, `report=question` | Read the report. Answer it yourself if it's a fact or something the spec or code settles. A conflict with an ADR is the user's decision, like a product decision: ask the user and run `WL hold <NN> --reason "<why>"` while you wait. Answer with `WL send <NN> --text "<answer>"` or `--file`: a new turn in the same conversation. No ADR is written mid-run: if the user overrules an ADR, note it for the finish report. |
| executor's turn ended, `report=blocked` | Fix the environment or the ticket, then `send`. If the ticket itself is wrong, rewrite it and `send` the change, or `cancel` it. |
| a turn ended with no fresh report | Read the end of the turn's output, the log `wait` names (`turns/<agent>-<n>.log`; the tab shows it too). Then `send` a message restating what is missing; it goes on in the same conversation. |
| a turn ended with an error exit | Read its log. Resolve the cause and `send` to go on in the same conversation where possible; use the [recovery guidance](recovery.md) when the conversation cannot continue. A transient error alone is not a reason to replace it. |
| `review` refuses: changes outside the ticket's Scope | If the executor didn't need those files, `send` a correction to revert them. If the ticket does need them, ask the user: widen the `Scope:` line (the next `review` reads it; no import needed), or, in a direct run, switch to a full run. |
| reviewer's turn ended, verdict `pass` | Start `WL integrate <NN>` as a background command (see **Integration** below). |
| reviewer's turn ended, verdict `changes_requested` | Account for every blocking finding inside the review's boundary: decide which are must-fix yourself, because `blocking` is only the reviewer's opinion, and record each decision — name the finding in the rework message, waive it with `send --waive <IDs> --reason`, or let it through with `integrate --override` — because the script refuses a silent one. A finding outside the boundary is a suggestion, so it needs neither. See below. |
| final reviewer's turn ended with a report | Read `reviews/final-<round>-<tipShort>.md`: `pass` goes to `WL finish`; `changes_requested` takes repair tickets or `WL final-review --waive <IDs> --reason "<why>"`. See *Final review and finish* below. |
| final reviewer's turn ended with no fresh report | Read its log. Start another round at the same tip with `WL final-review --again`. |
| `wait` timed out, turns still running | Arm `WL wait` again and end this turn. It prints how long ago each turn last printed; look at a tab only on an anomaly, such as one silent for long. |

**When review requests changes**, write a rework message containing:

- the finding IDs,
- what to change,
- the evidence that proves each fix.

`send` appends the review's path and the rework method to the message — reproduce each finding first, fix its cause, then check the change since as the re-review will — so the message need not restate them. Send it with `WL send <NN> --file <message>`. Every blocking finding **inside the review's boundary** must be **accounted for**: named in the message as a whole word, or listed in `--waive <IDs> --reason "<why it stands>"`. A finding outside the boundary is a suggestion and needs no waiver, and a review whose findings table cannot be read only gets a warning. A waiver is recorded in the same save as the send. The ticket goes back to running; review it again when it reports `done`. If you judge every in-boundary blocking finding non-blocking, run `WL integrate <NN> --override "<why>"` instead: it records those findings, or a note that the review was missing or unreadable, together with the reason.

Every finding the run lets through that way goes into the **waiver ledger**, with its reason, task, review and candidate. `WL status` prints `waived findings: N` and `WL status --json` carries the ledger, so a waiver is never invisible, and `WL finish` prints the whole ledger (task, ID, axis, location, basis, kind, reason) for the user, who judges each entry.

**The review boundary.** The user confirmed the tickets' numbered criteria before `init`, so a review only gates on what they settle: a blocking finding must cite one of the ticket's criteria (`AC2: …`) or one of four floor classes — `Regression`, `Data loss`, `Security`, `ADR`. Anything else belongs in the review's `## Out of scope` section as a suggestion, with no finding ID. The script reads the same `Basis` cells: it reports out-of-boundary blocking findings as suggestions for the user, gates `integrate` only on in-boundary ones, and accounts only for those in a rework `send`. Do not route a suggestion to an executor as rework on the reviewer's word. One that names a defect against a confirmed criterion in code the round did not change — a late finding — is yours to settle: confirm it and have it fixed (a rework round, or a repair ticket after integration, each counted against the cap below), or note why it does not hold. Take to the user only what you cannot settle, such as a dispute over what a criterion means. Every other suggestion, and every product decision, is theirs; `finish` lists all of them either way.

**A re-review is narrow.** After a rework the next reviewer's brief adds the previous review, its candidate, and the change since it, and its method is exactly: confirm each previous in-boundary blocking finding (fixed or not, keeping its ID), re-run every acceptance command, and look for floor-class problems in the change since. It raises no other new findings. Treat a "new" finding as what it is — a suggestion — rather than reading it as a reason for another round; the round count is what the cap below counts. A final review round after a reported one is narrow in the same way (below).

**The round cap.** A run allows 2 rework rounds per ticket (`--max-rework-rounds` at `init`, or `WL config --max-rework-rounds <n>`: 0 or a whole number). Only a rework `send` opens a round: a nudge after a `pass`, and a `--merge-tip` send, return the ticket to running without spending one. A `send` that would start a round past the cap refuses and says the task waits for the user: take the question to them. If they decide to go on, `WL send <NN> --extra-round --reason "<the user's decision>"` proceeds and records the round, and `WL finish` lists every extra round with that reason.

Boundary findings (`B1`, `B2`, … from a direct run's reviewer) follow the Scope rule in the table: an overstep the ticket doesn't need goes back as rework; one it does need goes to the user.

**Drift** to look for in logs and diffs:

- files or refactors outside the ticket's scope;
- tests that are disabled, skipped or weakened;
- repeated attempts that bring no new evidence;
- changes to shared interfaces that another ticket depends on;
- remote writes, credential use, or deletions outside the worktree.

**To intervene**, press Ctrl-C in the agent's tab (or have the user do it) and confirm with `WL status --live` that its turn ended. Then `WL send` a complete restatement of the remaining work: it starts the next turn in the same conversation. A running turn cannot be steered; every message is a turn of its own.

**Integration.** `WL integrate` merges the candidate into the integration branch with `--no-ff` and runs the checks, then the ticket's acceptance commands, then the regression set. If any of them fails, it rolls back. An acceptance failure names the command and the ticket it belongs to (`#02 acceptance \`<cmd>\` fails after merging #05`): route it to the executor of the ticket being integrated, since that change broke it. On success the next tickets can start, and its commands join the regression set. The executor, reviewers and worktree stay available until the whole run has been assessed for retro and archived. `--override "<why>"` integrates a candidate you decided to let through despite an in-boundary blocking finding; those findings join the waiver ledger.

**`integrate` and `finish` are background commands.** Their checks can take up to the time limit per command, so start one in the background and return to supervision. The checks run as a **check phase**, outside the run lock: meanwhile `status`, `wait`, `note`, `hold`, `unhold`, `send` and `import` work. While that phase is live, `config` and `send` to the ticket being integrated refuse, naming the phase, the ticket and the pid: the candidate and the checks stay the ones being checked. An interrupted phase admits `config`, so the checks themselves can be changed before the recovery. When the checks end, the command re-checks its gates on the current state and records nothing if one no longer holds, rolling the merge back. A check phase whose process died (a killed shell, a crash) is an **interrupted check phase**: `status` reports it, and you recover it by rerunning the same command (see [recovery.md](recovery.md)).

- **On a conflict** nothing is merged. Run `WL send <NN> --merge-tip`. The executor merges the tip and reports `done`; then review again and integrate.
- **On a check or acceptance failure, or a time-out**, `send` the output to the executor. A time-out can also mean the limit is too short for the suite; raise it with `WL config --check-timeout <minutes>` only when the output shows the checks were still progressing.

**Escalate rather than loop.**

- When rework stops producing useful evidence or progress, revisit the cause; use `hold` if a user decision is needed. If it's a bug hunt, read [diagnosing-bugs](../../diagnosing-bugs/SKILL.md).
- If an executor's session cannot recover, `WL retry <NN> --reason "<why>"` replaces the agent while retaining the worktree, branch and handoff. Dispatch again. Add `--file <handoff>` for useful context; use `--new-worktree` only when the existing tree cannot safely continue. Make sure the old agent's turn has ended (Ctrl-C in its tab) before replacement.
- If a direct run outgrows its ticket (a `question` report, a Scope refusal or a Boundary finding shows the change needs more than the ticket says) and the user wants the larger change, stop the executor if it's running, then cancel the open ticket and close the run through finish, retro assessment and archive. Start a full run under a new feature name, because `workloop/<feature>` still exists. `archive` leaves unmerged or dirty attempts intact and lists them for the user.

## 4. Final review and finish

**A direct run has no final review.** Its reviewer already re-ran the acceptance checks, and any follow-up repair is reviewed independently against the current integration tip. Once the ticket is integrated, go to `WL finish` below.

**Documents come first.** In a full run, once every ticket is closed, `WL status` lists the documents the run added that the repo's registry doesn't hold. For each one, classify it per [reference/tidy-docs.md](tidy-docs.md) and fix it with a repair ticket before the final review: remove process documents, and add a registry row for real ones, merging into an existing document of the same type and domain where there is one. `finish` refuses until that's done. A repo with no registry is never blocked; if `/tidy-docs` is installed in it, `finish` reminds you to run it. Direct runs skip this, because their `Scope:` line already refuses files outside the ticket.

Then write the **acceptance mapping**. The verdict comes from an independent final reviewer, not from you: `final-review` starts one on the integration tip, and `finish` accepts only that reviewer's report for that tip.

1. Copy [templates/final-review.md](../templates/final-review.md) into the run directory as `final-review.md` and fill it in from `git diff <baseSha>..<tip>` in the integration worktree. Number every row `M1`, `M2`, …: each maps a spec item or a manual criterion to evidence on the integrated tree. Add notes the reviewer should have. There is no verdict line, because you are not the judge of your own run.
2. Run `WL final-review`. It refuses until the run's gates hold — every ticket closed, the document step quiet, no live check phase, and a mapping written for the current tip — and names what is missing. It creates branch `wl-<feature>-final-<round>` and a worktree of its own at the tip, writes [templates/final-reviewer-brief.md](../templates/final-reviewer-brief.md), and starts the final reviewer's turn in a Rex tab.
3. `WL wait` in the background while it runs: the final reviewer's turn is waited for like any other. Its brief tells it to check the run across tickets, verify every mapping row, re-run the checks and the whole regression set, re-assess every waiver, and run the changed surface. It writes `reviews/final-<round>-<tipShort>.md`.

**The final reviewer's boundary.** A blocking finding cites a ticket criterion (`#02 AC3`), a mapping row (`M2`), a waiver entry (`Waiver L3`, its label in the ledger) or one of the four floor classes. A cross-ticket problem on no such basis is a suggestion for the user: nothing gates on it, and `finish` lists it. The script reads the same line.

**On `Verdict: pass`** for the current tip, go to `WL finish`. **On `Verdict: changes_requested`**, every blocking finding inside the boundary is either fixed or let through:

- fix it with repair tickets (below), integrate them, and start a new round at the new tip with `WL final-review`; or
- record why it stands with `WL final-review --waive <IDs> --reason "<why>"`. Each ID must be a blocking finding of the current report; one outside the boundary is a suggestion and needs no waiver. The entry joins the waiver ledger as `final`, and `finish` prints it for the user.

A second round at the same tip needs `--again` (`WL final-review --again`); one at a moved tip does not. Earlier rounds stay in the run's state and history, and `archive` cleans up their worktrees and branches, retaining a dirty one for the user.

**A later final round is narrow too.** Once a round has written its report, the next round's brief adds that report, its tip and the change since, and its method is exactly: confirm each previous in-boundary blocking finding (keeping its ID), verify the mapping and re-run the checks and the regression set, re-assess every waiver, and look for floor-class problems in the change since. Anything else is a suggestion, settled as the review boundary above says.

**Repair cycles are capped like rework rounds.** Each new tip after a reported round is one repair cycle, and a round at the same tip (`--again`) is none. `WL final-review` refuses a cycle past the run's cap and says the run waits for the user; if they decide to go on, `WL final-review --extra-round --reason "<the user's decision>"` starts the round and records the decision, and `finish` lists it with the ticket rounds past the cap. Ask before writing the repair tickets, not after: `WL status` says when the next cycle would pass the cap.

**If you find defects**, fix them with repair tickets:

1. Write `NN-fix-<cause>.md` next to the other tickets, from [templates/repair-ticket.md](../templates/repair-ticket.md), blocked by the ticket it repairs. Run the reproduction yourself on the integration tip and paste what it printed. The executor has only the ticket to go on, so a secondhand or guessed repro sends it after the wrong thing.
2. Run `WL import`.
3. Take the repair tickets through the loop.

A post-integration repair gets a new ticket, session and worktree at the current integration tip, and includes the original acceptance behavior it must preserve. The original sessions stay read-only evidence and the original tickets stay done. Integrating the repairs moves the tip, so the old report no longer counts: `WL status` leads back to `final-review`.

**`WL finish`** re-runs the checks and the whole regression set (start it as a background command, like `integrate`) and records that delivery is complete. It refuses until the current round's verdict for this tip is a `pass` or fully waived, and names what is missing. A regression-set command that fails on the tip fails the finish; fix it with a repair ticket. It prints the waiver ledger — every entry's task, ID, axis, location, basis, kind and reason — for the user, or says there are none, then the run's history of the boundary: every round that went past the cap with its reason and every out-of-boundary blocking finding, or that there were none, and how many `## Out of scope` suggestions the reviews raised. It writes all of those suggestions, by ticket and review, to `suggestions.md` in the run directory and prints its path; a suggestion a later round repeats sits next to the first. Tell the user the count and the path rather than pasting the list. It retains the integration tree and every agent's turn files.

**After `finish` succeeds**, run `req sync <project>/<feature>` from the [requirement-ledger](../../requirement-ledger/SKILL.md) skill: the ledger's delivery snapshot depends on that step, and once a later `import` clears `state.completion`, nothing else can reconstruct it.

Assess the whole run with [retro](../../retro/SKILL.md): recurring third-party failures, business pitfalls, repeated wrong behavior or repeated exploration are useful signals; a serious one-off loss or unauthorized action also deserves a look. If none apply, record `WL retro --skip --reason "<brief reason>"`. Otherwise present the findings and suggested destinations to the user, save them with `WL retro --file <report>`, and leave implementation to the user's decision. Findings that are project traps become proposed pitfall entries, written only once the user agrees; see [pitfalls](pitfalls.md).

Then `WL archive` writes each agent's turns (prompts and CLI output) and an agent/attempt index under `evidence/`, closes the run's Rex session, deletes `scratch/` (where each brief sends what its agent can regenerate) and removes integrated worktrees, and a clean final reviewer's worktree and branch with them. Unmerged or dirty cancelled/replaced work, and a dirty final-review worktree, are retained and listed. An interrupted archive can be rerun. When the run is linked to a requirement, run `req sync <project>/<feature>` again after archival: it fills `archived_at` and evidence, and the final SHA never moves. `WL evidence` can also write them before retro; `turns/` keeps every turn's original files.

Report the branch, checks, any accepted findings, retro result and retained work. Retro suggestions need no approval before archiving; implementing them is a separate task.

## Rules

- Executors and reviewers never talk to the user. You are their only contact, and the only contact the user has about the run.
- Never fake progress. A ticket is done when it's integrated with the checks passing. Delivery completes at `finish`; archival completes separately after retro assessment.
- No remote writes (pushes, PRs, issue comments) unless the user asks for them separately.
- Launch settings are the user's. When they're missing, refused, or make an agent fail, tell the user; don't substitute your own.
- **Long commands run in the background; the turn ends and their exit wakes you.** Start `wait`, `integrate`, `finish` and any other long check as a background command, keep its ID, and end your turn; collect its exit code and output when it completes, before acting. Never equate dispatch with success, never poll in a shell loop, and never read logs to pass the time.
- After any interruption, reconcile before acting: see [reference/recovery.md](recovery.md).
- If the script refuses a step, fix the cause; don't work around it by hand. If the script itself is wrong, tell the user.
