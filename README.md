# paseo-matt-workloop

**English** · [简体中文](README.zh-CN.md)

Turn a development request into reviewed code on a local integration branch. Matt Pocock skills guide the work; Paseo runs the executors and reviewers.

For release history and upgrade notes, see the [changelog](CHANGELOG.md).

## 1. Skills

Start with **`paseo-workloop`** for orchestration, or use a supporting skill on its own. The collection includes 17 upstream skill sources, with local `paseo-workloop`, `codegraph` and a suggestion-only `retro` entry point.

| Skill | Use it to… |
| --- | --- |
| [retro](skills/retro/SKILL.md) | Review recurring problems and suggest improvements for the user to decide, without applying them. |
| [writing-for-agents](skills/writing-for-agents/SKILL.md) | Write clear, selectively loaded instructions and references for agents. |
| [paseo-workloop](skills/paseo-workloop/SKILL.md) | Coordinate tickets, isolated worktrees, independent review, rework, and serial integration through Paseo. |
| [grill-me](skills/grill-me/SKILL.md) | Clarify a request's goal, boundaries, and design choices with the user. |
| [grill-with-docs](skills/grill-with-docs/SKILL.md) | Clarify a request while capturing domain vocabulary and architectural decisions. |
| [grilling](skills/grilling/SKILL.md) | Interview in rounds, asking each question after its prerequisite decisions are settled. |
| [domain-modeling](skills/domain-modeling/SKILL.md) | Establish shared terminology and record decisions in a glossary and ADRs. |
| [to-spec](skills/to-spec/SKILL.md) | Turn an agreed discussion into a spec with implementation and testing decisions. |
| [to-tickets](skills/to-tickets/SKILL.md) | Split a spec into vertical slices with explicit blocking dependencies. |
| [implement](skills/implement/SKILL.md) | Implement and verify a spec or ticket using the project's conventions. |
| [tdd](skills/tdd/SKILL.md) | Develop through red → green → refactor, testing observable behavior. |
| [code-review](skills/code-review/SKILL.md) | Review changes from a fixed baseline against repository standards and the originating spec. |
| [diagnosing-bugs](skills/diagnosing-bugs/SKILL.md) | Reproduce and measure a bug or performance regression before choosing a fix. |
| [codegraph](skills/codegraph/SKILL.md) | Navigate symbols, call paths, and change impact in an indexed repository. |
| [codebase-design](skills/codebase-design/SKILL.md) | Design module boundaries that keep interfaces small and encapsulate complexity. |
| [improve-codebase-architecture](skills/improve-codebase-architecture/SKILL.md) | Find architecture improvements, inspect an HTML report, and explore a selected proposal. |
| [handoff](skills/handoff/SKILL.md) | Prepare a handoff containing the goal, decisions, evidence, and unfinished work. |
| [wait-what](skills/wait-what/SKILL.md) | Ask the agent to explain its previous message again. |
| [setup-matt-pocock-skills](skills/setup-matt-pocock-skills/SKILL.md) | Configure issue tracking and domain documents for standalone use of the upstream engineering skills. |

## 2. Workflow

![Quick, Direct and Full routes; user confirmation, integrate, independent final review, finish, retro assessment and archive](docs/assets/workloop.en.svg)

[Editable Excalidraw source](docs/assets/workloop.en.excalidraw) — download and open it in Excalidraw.

Choose enough process for the task. Existing authorization carries forward; clarify material gaps rather than asking the same questions at each stage.

| Route | Choose it when… | Work |
| --- | --- | --- |
| **Quick** | The goal is clear, the change is local and reversible, and verification is straightforward. | Execute in the current session, verify and deliver. No ticket or Paseo daemon required. |
| **Direct** | A bounded task benefits from delegation and independent review. | One scoped ticket; follow-up repairs may be imported after integration. |
| **Full** | Design choices, dependencies or parallel work need coordination. | A spec, dependent tickets whose numbered criteria the user confirms, and an independent final review before `finish`. |

Direct and Full use this lifecycle:

| Stage | Result |
| --- | --- |
| **Execute and review** | The executor commits and reports evidence; an independent reviewer checks the frozen candidate against the ticket's confirmed, numbered criteria (`AC1`, `AC2`, …) or one of four floor classes — `Regression`, `Data loss`, `Security`, `ADR`. Anything else is a suggestion for the user, not a blocker. Rework continues in the original executor session and worktree. |
| **Integrate** | Merge the reviewed candidate, then run the checks, this ticket's acceptance commands and the regression set — the acceptance commands of every ticket integrated so far. Unlock dependent tickets while retaining child sessions and worktrees. Failed merges, checks or acceptance commands return to the original executor. |
| **Finish** | Re-run the checks and the whole regression set. Full also requires an independent final reviewer's pass for the current integration tip, or a `changes_requested` whose blocking findings are all waived; the orchestrator's `final-review.md` maps the acceptance evidence and carries no verdict. `finish` lists every waived finding for the user to review. Keep sessions for retrospective assessment. |
| **Retro** | Assess the whole run for recurring failures, business pitfalls, repeated wrong behavior or repeated exploration. Present findings and suggested destinations, or record a brief no-retro reason. Suggestions are not applied automatically. |
| **Archive** | Save CLI activity transcripts and the agent/attempt index, then archive sessions together. Integrated trees are removed; unmerged or dirty cancelled/replaced work is retained. User decisions on retro suggestions do not delay archival. |

Every check has a time limit — 30 minutes by default, at most 1440 — and `integrate` and `finish` run theirs as a background check phase outside the run lock. The user confirms each ticket's numbered criteria before the run starts, and from then on they are frozen; a re-review confirms the previous in-boundary blocking findings, re-runs the acceptance commands and looks for floor-class problems in the change since, and raises nothing else. Rework is capped at two rounds by default, and every finding the run lets through is recorded, with its reason, in a waiver ledger that `finish` prints; the [run reference](skills/paseo-workloop/reference/run.md) holds each gate's rules.

Recoverable errors continue in the same session. If the executor session is lost, `retry` replaces it in the existing worktree; `--new-worktree` explicitly starts a fresh tree. A defect found **after integration** is a new repair ticket with a new session and worktree from the latest integration tip.

Use `retro` whenever useful, during a run or after archival. Mid-run retro leaves execution running and does not replace the assessment after `finish`. For agent-facing documentation, use `writing-for-agents`; `tidy-docs` handles organization and placement.

Ticketed runs deliver the local `workloop/<feature>` branch. Publishing, opening a PR, or merging into the main branch remains the user's decision.

## 3. Installation

Use **Node.js 20+, npm, and Git** on the machine where Paseo runs the agents. For a remote Paseo host, install on that host.

Choose the directory your agent reads. The commands below work in macOS/Linux shells and Windows PowerShell.

### Claude-compatible agents

For Claude Code and agents that read `~/.claude/skills`:

```sh
# Install
npx --yes github:suntianc/paseo-matt-workloop#main install --target "$HOME/.claude/skills"

# Update the same directory
npx --yes github:suntianc/paseo-matt-workloop#main update --target "$HOME/.claude/skills"
```

### General agents

For agents that read the default `~/.agents/skills` directory:

```sh
# Install
npx --yes github:suntianc/paseo-matt-workloop#main install

# Update
npx --yes github:suntianc/paseo-matt-workloop#main update
```

For another skills directory, add `--target "path/to/skills"` to both commands. Keep the whole collection together: workloop resolves its supporting skills and resources through sibling paths.

Installation is complete when the command succeeds and your agent discovers `paseo-workloop` after restarting or refreshing its skills. Installed files persist outside the npx cache; `update` fetches the current GitHub `main` and prints its commit.

**If installation or update reports a conflict**, back up the named local content, then restore the managed copy or install into an empty directory. The installer tracks ownership in `.paseo-matt-workloop.json` and preserves unrelated skills. Add `--dry-run` to check a target before writing; use `--help` for the available installer options.

## 4. Runtime requirements and usage

### Prepare the runtime

Before starting a Direct or Full run, establish these conditions (Quick does not need Paseo):

| Requirement | Ready when… |
| --- | --- |
| **Paseo daemon** | `paseo agent ls -g --json` returns JSON from the intended host. |
| **Agent session** | The orchestrator runs inside Paseo with `PASEO_AGENT_ID`, agent-scoped `create_agent` and `send_agent_prompt` tools, and heartbeat support. |
| **Role profiles** | `wl-executor` and `wl-reviewer`, or explicitly selected alternatives, resolve to the user's chosen provider, model, and mode. Configure them in Paseo. |
| **Project baseline** | The target is a Git repository and the checks chosen for the run already pass on its base. |

For version-dependent behavior or a failed prerequisite, consult the [Paseo compatibility notes](skills/paseo-workloop/reference/paseo-compat.md) before starting workers. The other skills can be used independently of this runtime; `codegraph` applies when the project already has an index.

### Start a run

Open the project in Paseo with an agent that has loaded the collection. Describe the goal and acceptance expectations:

```text
Use paseo-workloop to add CSV export to this project.
Agree with me on scope and acceptance checks before starting the run.
```

**To orchestrate the run**, read and follow [paseo-workloop](skills/paseo-workloop/SKILL.md). It selects a route and links the relevant execution, recovery and archival procedure. Workloop keeps its tracker in the run directory, so it can start directly with its supporting skills.

Specs, tickets, briefs, reports, retrospectives, captured activity and state live in `~/.workloop/<project>/<feature>/` by default (`WORKLOOP_ROOT` overrides the root). Finish active runs before updating their scripts.

Use the reference matching the situation:

- **Before pausing while workers run:** follow [async supervision](skills/paseo-workloop/reference/async-supervision.md) to arm notifications and the fallback heartbeat.
- **After a session or operation is interrupted:** follow [recovery](skills/paseo-workloop/reference/recovery.md) to reconcile current state before taking another action.
- **To organize a project's documentation:** follow [tidy-docs](skills/paseo-workloop/reference/tidy-docs.md) for per-machine registration and the document workflow.
- **To maintain or sync this collection:** follow the [collection guide](skills/README.md); check commands are defined in [package.json](package.json).

## 5. Acknowledgments

- **[Matt Pocock / skills](https://github.com/mattpocock/skills)** — the upstream engineering and productivity skills that guide this workflow. Upstream sources remain unchanged; workloop adaptations live in local skills and role briefs. The local retro entry point keeps the original under `retro/reference/upstream.md` as reference.
- **[Paseo](https://github.com/getpaseo/paseo)** — the runtime for coordinating independent coding agents, workspaces, and completion notifications.

Local code uses the [MIT License](LICENSE). Upstream notices are preserved in [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES); source versions and diagram attribution are recorded in [NOTICE.md](NOTICE.md).
