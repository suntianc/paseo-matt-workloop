# Changelog

**English** · [简体中文](CHANGELOG.zh-CN.md)

## Unreleased

### Summary

Both READMEs and both workflow diagrams now show the 3.0.0 delivery gates: in Direct and Full the user confirms the tickets and their numbered criteria before the run starts, and a full run's verdict comes from an independent final reviewer before `finish`.

### Changes

- **Changed:** Both READMEs describe the gates briefly and leave their detail to the run reference, and both diagrams add a step where the user confirms the tickets and their numbered criteria before execution, plus an independent final review between integration and `finish` for full runs. The diagrams remain editable Excalidraw scenes exported by Excalidraw with the Virgil font embedded.

### Upgrade

No migration is needed: this release changes the READMEs, the changelogs and the exported diagram assets only. Runs in progress behave as described by the version that started them.

### Verification

- All 211 local tests pass (`npm test`).
- `npm run check:links` resolves every relative link and `skill://` reference across 52 markdown files.
- Both SVGs were exported from their updated scenes and opened in a browser; every node and label renders legibly, and each scene keeps its node grouping.

## [3.0.0] - 2026-10-27

### Summary

Checks now have a time limit, and `integrate` and `finish` run theirs as a background check phase; acceptance commands re-run on every integration as a regression set, every let-through finding is recorded in a waiver ledger, a full run's verdict comes from an independent final reviewer, and reviews stay inside the user-confirmed numbered criteria and four floor classes. Acknowledging an MCP response no longer needs a hand-written receipt file. The README workflow diagrams remain editable Excalidraw scenes with matching SVG exports.

### Changes

- **Added:** A time limit for every check the script runs: 30 minutes per command by default, at most 1440, set with `init --check-timeout <minutes>` or `config --check-timeout <minutes>`. `integrate` and `finish` run their checks and acceptance commands as a background check phase outside the run lock, so `status` and `watch` keep working, and a command that runs out of time is stopped with the processes it started — its process group on POSIX or its process tree on Windows; on POSIX a process that deliberately leaves the group is not stopped, and a stop that fails or cannot be confirmed keeps the check phase recorded for recovery.
- **Added:** Numbered acceptance criteria (`AC1: <criterion>`), each optionally naming the command that proves it, frozen once the user confirms them, with `criteria <NN> --reason "<the user's decision>"` recording an agreed change. `integrate` runs the checks, then the ticket's acceptance commands, then those of every integrated ticket — the regression set; `finish` runs the checks and the whole regression set again.
- **Added:** A waiver ledger. A rework `send` must name or `--waive <IDs> --reason "<why>"` every in-boundary blocking finding, `integrate --override "<why>"` records the findings it lets through, and `finish` prints every entry for the user. `status` shows how many findings were waived.
- **Added:** An independent final review for full runs. `final-review --prepare` creates the reviewer's worktree at the integration tip and prepares its `create_agent` request, which the orchestrator executes before acknowledging its response with `ack final --receipt -`; `finish` accepts only that reviewer's pass for the current tip, or a `changes_requested` once every in-boundary blocking finding is waived with `final-review --waive <IDs> --reason "<why>"`.
- **Added:** A review boundary. A blocking finding must cite one of the ticket's confirmed criteria or a floor class — `Regression`, `Data loss`, `Security`, `ADR`; anything else is a suggestion for the user. A re-review confirms the previous in-boundary blocking findings, re-runs the acceptance commands and looks for floor-class problems in the change since the previous candidate, and raises nothing else. A run caps rework at two rounds by default (`--max-rework-rounds`); going past the configured cap needs the user's agreement, recorded with `send --extra-round --reason`.
- **Added:** `ack <NN>|final --receipt -` reads the MCP response from stdin, bare or as `{action, result}`, and keeps a copy under the run's `messages/`; a bare response is taken for the action pending now. `status` says how long a prepared action has waited for its acknowledgement.
- **Added:** `config --clear-launch executor|reviewer` drops a role's run-level launch overrides, so agents started afterwards follow its edited Paseo profile again.
- **Changed:** The ticket templates and the run reference ask for bounded acceptance criteria: an unbounded "all", "every" or "never" names the scope it covers, and a known limit is written into the criterion.
- **Changed:** Export both diagrams from Excalidraw with the original Virgil handwriting font, group each node for editing, and link the source scenes from the READMEs.
- **Fixed:** `workloop.mjs` and `tidy-docs.mjs` ran nothing and exited 0 when reached through a symlinked directory, such as macOS `/tmp` or a linked skills folder. They now compare real paths and run.
- **Breaking:** A full run needs an independent final review before `finish`, started with `final-review --prepare`: a pass for the current tip, or a `changes_requested` whose in-boundary blocking findings are all waived. `final-review.md` no longer carries the verdict. A rework `send` must name or `--waive` each in-boundary blocking finding. Acceptance commands run again on every later integration, so they must be repeatable. Tickets in new runs need numbered criteria (`AC1: …`), frozen once the user confirms them, and findings outside the criteria and floor classes no longer block. Rework is capped at two rounds by default (`--max-rework-rounds`), and going past the configured cap needs the user's agreement (`send --extra-round --reason`).

### Upgrade

Finish runs that are in progress with the script they started with before updating. Runs created earlier read their tickets and reviews as before and keep the 30-minute default time limit per command; the numbered criteria and the rework-round cap apply to runs created with this version. The time limit and the cap can be changed with `config --check-timeout` and `config --max-rework-rounds`. Requires Node.js 20+, npm and Git.

```sh
npx --yes github:suntianc/paseo-matt-workloop#v3.0.0 install
```

For an existing managed installation, run `npx --yes github:suntianc/paseo-matt-workloop#v3.0.0 update` with the same target. `update` fetches current `main`; pinning the installer tag does not pin the update payload. For a project installation, append `--target <project skills directory>`.

### Verification

- All 211 local tests pass (`npm test`), covering the check phase and its time limit, the acceptance regression set, the waiver ledger, numbered criteria and the review boundary, the independent final review, receipts from stdin, cleared launch overrides, scripts reached through a symlinked directory, and the existing installer and document workflow. Workloop tests use real Git repositories and the fake Paseo CLI.
- `npm run check:links` resolves every relative link and `skill://` reference across 52 markdown files.
- The v3.0.0 tarball installed 19 skills through npx into a temporary path containing spaces and reached through the macOS `/tmp` symlink; the installed link check (53 markdown files) and the help of both workloop scripts passed, and the local `Agent.md` and `AGENTS.md` are not in the artifact.
- Not run locally for this change: Windows and Linux. On POSIX the time limit and recovery stop the check's process group, so a process that deliberately leaves that group is outside the contract.

## [2.0.0] - 2026-10-26

### Summary

Choose Quick for small tasks, retain ticketed-run sessions through retrospective assessment, and recover an executor without discarding its worktree. Retro outputs findings and suggestions for the user to decide.

### Changes

- **Added:** Quick execution in the current session, without mandatory tickets, workers or repeated clarification. Detailed Direct/Full mechanics are loaded only when needed.
- **Added:** A local suggestion-only `retro` entry point and the upstream `writing-for-agents` guide. Upstream retro text remains an unmodified reference; agent-facing writing uses the shared guide.
- **Changed:** Integration retains sessions and worktrees. `finish` checks delivery; `retro` records findings or a skip reason; `archive` saves activity transcripts and closes sessions together. Cancelled/replaced work is retained when it has not been integrated.
- **Fixed:** Session replacement reuses the original branch/worktree and preserves handoff context and review history. Worktree lookup handles Windows line endings and resolves short-path aliases before comparing recovery directories. Ordinary rework continues the original executor; post-integration repairs use a new ticket, session and worktree.
- **Breaking:** `finish` no longer cleans up. Complete `retro` assessment and run `archive`. `retry` now preserves the worktree by default; use `--new-worktree --reason <why>` for an intentional fresh attempt.

### Upgrade

Finish active runs with their existing scripts before updating. New runs use `finish → retro → archive`; recovery that needs a fresh worktree explicitly passes `--new-worktree`. Requires Node.js 20+, npm and Git.

```sh
npx --yes github:suntianc/paseo-matt-workloop#v2.0.0 install
```

For an existing managed installation, run `npx --yes github:suntianc/paseo-matt-workloop#v2.0.0 update` with the same target. `update` fetches current `main`; pinning the installer tag does not pin the update payload. For a project installation, append `--target <project skills directory>`. For legacy installations without a manifest, back up and move aside this collection's same-name entries before installing; preserve unrelated project skills.

### Verification

- All 122 local tests pass, covering installation, real-Git/fake-Paseo lifecycle behavior, recovery, repair isolation and document handling. Focused follow-up checks cover archived evidence reads.
- On local macOS Paseo 0.13.0, an isolated run verified prepared MCP dispatch/review, same-session continuation, integration, retained sessions at finish, heartbeat cleanup and deferred archival. Pre-archive transcripts remain readable; archived Antigravity CLI logs failed with `agy ENOENT`, so later retro uses saved evidence. See the compatibility notes for scope.
- Skill validation, upstream source comparison and relative-link checks pass. Both workflow diagrams were rendered and inspected.
- The v2.0.0 tarball installs 19 skills through npx into a temporary path containing spaces; installed links and CLI help pass. Local `Agent.md` and `AGENTS.md` are excluded from the package.

## [1.0.0] - 2026-10-25

### Summary

The first standalone release of Paseo workloop and its supporting skills, with an npx installer and documentation in English and Simplified Chinese.

### Changes

- **Added:** A collection of 17 skills: 15 upstream Matt Pocock skills plus the local `paseo-workloop` and `codegraph` skills, including their scripts, templates, and references.
- **Added:** Direct runs for bounded single-ticket changes and Full runs for specs and dependent tickets, with isolated worktrees, independent candidate review, and serial integration checks.
- **Added:** GitHub-based npx installation and managed updates. Installation persists outside the npx cache; updates fetch current `main`, preserve unrelated skills, and stop on local modifications or unmanaged conflicts.
- **Added:** English and Simplified Chinese READMEs, matching workflow diagrams, and editable diagram sources. English is the default language.

### Upgrade

Requires Node.js 20+, npm, and Git. This is the first release; no migration from an earlier release is required. Install this version into the default `~/.agents/skills` directory:

```sh
npx --yes github:suntianc/paseo-matt-workloop#v1.0.0 install
```

For Claude-compatible agents, add `--target "$HOME/.claude/skills"`. Existing same-name skills must be backed up and moved aside before a new managed installation can take ownership.

For an existing managed installation, update from current `main` using the same target directory:

```sh
npx --yes github:suntianc/paseo-matt-workloop#main update
```

A fixed installer tag pins `install`; `update` always fetches current `main`. Running workloop also requires a Paseo daemon, agent-scoped orchestration tools, heartbeat support, and configured executor/reviewer roles. See [runtime requirements](README.md#4-runtime-requirements-and-usage).

### Verification

- All 115 local tests pass, covering the installer, workloop, heartbeat lifecycle, and document workflow. Workloop tests use real Git repositories and a fake Paseo CLI.
- Skill links, bilingual document links, and packaged files have been checked. Both READMEs, diagrams, licenses, and changelogs are included; local agent instructions are excluded.
- The packed installer installs all 17 skills in a temporary directory, with the installed links and workloop CLI checked. These checks establish package and workflow behavior; they do not establish compatibility with every Paseo host or provider.

[1.0.0]: https://github.com/suntianc/paseo-matt-workloop/releases/tag/v1.0.0

[2.0.0]: https://github.com/suntianc/paseo-matt-workloop/releases/tag/v2.0.0

[3.0.0]: https://github.com/suntianc/paseo-matt-workloop/releases/tag/v3.0.0
