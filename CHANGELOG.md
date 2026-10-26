# Changelog

**English** · [简体中文](CHANGELOG.zh-CN.md)

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
