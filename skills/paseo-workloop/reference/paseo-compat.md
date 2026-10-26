# Paseo compatibility notes

These are dated observations. Each one says which version it was seen on and how `workloop.mjs` deals with it. Paseo changes quickly. If your version isn't listed, re-verify (see below) and update this file instead of trusting old notes.

Observations were made on two setups:

- **Windows:** Paseo 0.11.2 with omp 18.11.0.
- **macOS:** Paseo 0.11.4.

All were recorded on 2026-10-16.

## Deferred archival and session continuation (2026-10-26)

Verified on local macOS Paseo **0.13.0**, using an isolated repository with the configured `wl-executor` (Antigravity) and `wl-reviewer` (Codex) profiles:

- Prepared MCP send continued the original executor ID and worktree after review. The executor retained the initial session context and committed the follow-up in the same branch; a fresh reviewer checked the new candidate.
- `integrate` and `finish` retained the executor and both reviewer sessions, all idle and unarchived. Finish removed the tracked heartbeat.
- After retro assessment, `archive` captured three CLI transcripts, archived the workspace/sessions and removed the integrated worktrees. The branch and run evidence remained.
- **Archived CLI logs are provider/environment dependent.** Reading the archived Antigravity session failed with `spawn /Users/suntc/.local/bin/agy ENOENT`. The archived Codex reviewers remained readable through the CLI. The Antigravity pre-archive transcript remained readable and contained both turns. Use the saved `evidence/index.json` and transcript files for later retro; these are CLI activity transcripts, not a promise of complete provider-native tool payloads.

These observations cover this machine and small lifecycle fixture. Unrecoverable-session replacement, dirty-work preservation and post-integration repair isolation are covered by the real-Git/fake-Paseo tests, not by this live fixture.

## Notification-based workloop (2026-10-20)

The default skill now uses prepared agent-scoped MCP requests and acknowledged receipts; see [async-supervision.md](async-supervision.md). These observations were checked against the locally installed Paseo 0.12.0 bundle and current official [MCP](https://paseo.sh/docs/mcp.md) and [orchestration](https://paseo.sh/docs/orchestration-workflows.md) documentation. They do not establish the version or behavior of another host.

- Agent-scoped MCP `create_agent` and `send_agent_prompt` default to finish/error/permission notifications. The workloop sets `notifyOnFinish: true` explicitly. Top-level callers do not have that callback.
- Notifications are delivered with `steer`; agent-originated sends also default to steer, with interruption fallback when steering is unavailable. The old preemption observation below is historical, not a universal current rule. Workloop rework still requires idle workers.
- CLI `agent run --background` remains a legacy alias for `--no-wait`. The 0.12.0 CLI/session creation path does not register the MCP finish callback, so the workloop does not equate background CLI dispatch with notified delegation.
- CLI `heartbeat create/delete` requires `PASEO_AGENT_ID` and targets that conversation. One-shot heartbeats accept `--cron`, `--timezone`, `--max-runs 1`, `--expires-in` and `--name`. **Correction after a remote bug report:** both `schedule ls` and `schedule inspect` filter to `target.type === "new-agent"`, so they cannot discover heartbeats. The earlier claim that `schedule ls` exposed them was wrong; the fake CLI originally repeated that mistake.
- The workloop now journals every heartbeat ID and pending creation in state, replays old watch receipts for migration, and deletes by acknowledged ID. It optionally reads the same daemon's local schedule store for crash recovery, with exact name/owner/type checks; it never writes those files or uses a local store when `PASEO_HOST` is set. Ambiguous remote creations block another create until reconciled.
- The heartbeat deletion CLI first inspects the ID and verifies the target belongs to `PASEO_AGENT_ID`; on success its JSON result is `{id, status: "deleted"}`. Only its explicit missing-ID error counts as confirmed absence; transport errors do not. A live local 0.12.0 lifecycle check confirmed three create/renew operations left counts `1, 1, 1`, were hidden from `schedule ls`, and left `0` after stopping.
- The bundle's finish observers live in memory; no restart-persistence guarantee was established. Use recovery checks and the heartbeat fallback after a restart.

## Historical CLI observations

| Observation | Seen on | How the script handles it |
|---|---|---|
| Host-tool injection (`set_host_tools`) doesn't reach omp sessions. All 40 Paseo host tools return "No such tool". | 0.11.2 × omp 18.11.0 | Every operation goes through the `paseo` CLI from the shell. |
| `worktree create --mode branch-off` without `--base` branches off the **repo's default branch**, not your current HEAD. | 0.11.4 (help text) | Always passes `--base <integration branch>` and checks the new worktree's HEAD before starting an agent. |
| `worktree create --json` returns `{name, branchName, worktreePath}`. | 0.11.2 | Reads `worktreePath`. Falls back to `path`/`cwd`, then to `git worktree list`. |
| Slashes in `--new-branch` are flattened (`feat/x` becomes `feat-x`). | 0.11.2 | Executor branches have no slashes (`wl-<feature>-<NN>-<attempt>`). A renamed branch is treated as an error. |
| `worktree ls` and `worktree archive` fail because the CLI sends no repo root. `worktree ls` without `--cwd` still errors with "cwd or repoRoot is required". | 0.11.2; the `ls` error also on 0.11.4 | Never uses them. Finds worktrees with `git worktree list --porcelain`. |
| `agent run` takes the prompt only as a positional argument; there's no prompt file. | 0.11.2, 0.11.4 | The prompt is a single line that points at a brief file. |
| `agent run --json` returns `{agentId, status, cwd}`. | 0.11.2 | Reads `agentId`, falling back to `id`. |
| `agent inspect --json` uses PascalCase keys (`Status`, `Archived`, `PendingPermissions`, `UpdatedAt`). `agent ls --json` uses camelCase. | 0.11.4 | Reads both cases. |
| `agent ls` lists only the current directory's agents unless you pass `-g`. `--label k=v` filters. | 0.11.4 | Always passes `-g` and filters by the run's labels (`workloop`, `task`, `attempt`, `role`). |
| `agent send` to a **running** agent preempts it: the in-flight call aborts and the new message runs at once. Whether the interrupted turn resumes was not established. | 0.11.2 (probed with agent f8a8c42e) | `send` refuses unless the executor, and any reviewer on its worktree, is idle. |
| `agent send` accepts `--prompt-file <path>` and `--no-wait`. | 0.11.4 (help text) | Messages are written to `messages/` and sent as files, which avoids quoting problems. |
| `workspace archive <id>` removes the worktree directory and closes the workspace's agents, but **the branch survives**. A later `agent send` fails with "Working directory does not exist". | 0.11.2 | Cleanup archives the workspace, then runs `git branch -d`, which refuses unmerged work. Repairs after cleanup use new tickets and new agents. |
| `worktree archive` is documented to remove the branch as well. | 0.11.4 (help text) | Not used. The script handles the branch whether or not it is still there. |
| On Windows the CLI is a `.cmd` shim, which Node can only start through a shell. | Windows | Runs it through `cmd.exe` with quoted arguments. Set `PASEO_CLI` to the CLI's `.js` entry point to bypass the shell. |
| Permission requests: `paseo permit ls`, `paseo permit allow <agent> [req]`, `paseo permit deny <agent> [req]`. | 0.11.4 (help text) | Not wrapped. Patrol reports pending requests and the orchestrator answers them. |
| Agent profiles have no CLI. The app keeps them in `$PASEO_HOME/config.json` (default `~/.paseo`) under `daemon.agentProfiles`, as `{id, name, provider, model?, modeId?, thinkingOptionId?, featureValues?, notes?}`. The `list_profiles` MCP tool serves the same list. This is an internal format. | 0.11.4 (read from the app's source; not yet seen with a profile saved) | Reads the file directly. If `PASEO_HOST` is set, the daemon's file is on another machine, so it reads nothing and the run needs `--provider`. If profiles exist in the app but `status` says there are none in the file, they have moved: re-verify. |
| `agent run` has no `--profile` and no way to pass provider features (`featureValues`, such as Codex `fast_mode`). It takes `--provider`, `--model`, `--mode` and `--thinking`. Its create request carries no `featureValues` at all, and `agent update` sets only name, thinking and labels. | 0.11.4 (help text; CLI source `commands/agent/run.js`) | Turns a profile into those four flags. Warns that the agent starts without the profile's features. |
| Whether an agent runs without stopping for approval depends on the provider. For opencode and the ACP providers (copilot, cursor, kimi, kiro, trae), this is the `auto_accept` feature, which the CLI can't pass, so their agents wait on every permission request. Claude and Codex set it through the mode, which the CLI passes. Pi has no modes and no features, and asks only when a Pi extension opens a dialog. For opencode, Paseo maps a legacy `--mode full-access` to `build` with `auto_accept` on. | 0.11.4 (read from the daemon's source; not run) | Nothing special. Prefer a provider whose profile has no features. The `full-access` mapping is unused. |
| `provider ls --json` returns `[{provider, label, status, enabled, defaultMode, modes}]`, where `status` is `available` or `unavailable`. | 0.11.4 | Refuses to start an agent whose provider is missing from the list or not `available`. |

## Re-verifying

These commands are read-only and safe against a live daemon:

```
paseo --version
paseo agent ls -g --json
paseo workspace ls --json
paseo worktree create --help    # what does --base default to?
paseo agent run --help          # prompt options
paseo agent send --help
paseo provider ls --json
```

To check where profiles are kept, create a profile in the app, then look for it under `daemon.agentProfiles` in `$PASEO_HOME/config.json`. `workloop status` on any run shows which profile each role resolves to.

The lifecycle facts, such as what `workspace archive` removes, need a throwaway repository, and the check creates a real worktree and agent. Start a run with one trivial ticket, take it through `dispatch → review → send → review → integrate → finish → retro → archive`, and compare what you see with the table.

The script's own tests run against a fake CLI (`scripts/test/fake-paseo.mjs`) that mimics the shapes above. If you find a difference, update the fake too.
