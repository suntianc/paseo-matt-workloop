# paseo-matt-workloop

**English** · [简体中文](README.zh-CN.md)

Turn a development request into reviewed code on a local integration branch. Matt Pocock skills guide the work; Paseo runs the executors and reviewers.

For release history and upgrade notes, see the [changelog](CHANGELOG.md).

## 1. Skills

Start with **`paseo-workloop`** for orchestration, or use a supporting skill on its own. The collection includes 15 upstream skills and two local skills: `paseo-workloop` and `codegraph`.

| Skill | Use it to… |
| --- | --- |
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

![Requirements, Direct or Full route, execution, independent review, serial integration, and delivery](docs/assets/workloop.en.svg)

Choose the route with the user after clarifying the request:

| Route | Choose it when… | Prepare for approval |
| --- | --- | --- |
| **Direct** | Goal, scope, and acceptance checks are clear; no public behavior or shared interface changes are needed. | One ticket with a `Scope` and commands proving each acceptance criterion. |
| **Full** | The change needs design decisions, broader scope, or tickets that can run in parallel. | A spec, tickets with dependencies, and the testing approach. |

Both routes follow these gates:

| Stage | Complete when… |
| --- | --- |
| **Approve** | The user has confirmed the scope, tasks, and acceptance checks. |
| **Execute** | The executor has committed the ticket in a clean worktree and submitted a fresh `done` report with acceptance-check results. |
| **Review** | Independent review has passed for the frozen candidate commit against the ticket and verification evidence. Required rework produces a new candidate for review. |
| **Integrate** | The reviewed candidate has merged into the local integration branch and the configured checks pass. Conflicts return to the executor; failed checks roll back the merge. |
| **Finish** | All tickets are closed and `finish` passes its checks and completes cleanup. For Full, the current integration tip must also pass the orchestrator's documentation and overall review; defects go through repair tickets. |

Delivery is the local `workloop/<feature>` branch. Publishing, opening a PR, or merging into the main branch is the user's decision.

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

Before starting a run, establish these conditions:

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

**To orchestrate the run**, read and follow [paseo-workloop](skills/paseo-workloop/SKILL.md). It defines the commands, approval gates, role briefs, and integration procedure. Workloop keeps its tracker in the run directory, so it can start directly with its supporting skills.

Specs, tickets, briefs, reports, and state live in `~/.workloop/<project>/<feature>/` by default (`WORKLOOP_ROOT` overrides the root). Finish active runs before updating their scripts.

Use the reference matching the situation:

- **Before pausing while workers run:** follow [async supervision](skills/paseo-workloop/reference/async-supervision.md) to arm notifications and the fallback heartbeat.
- **After a session or operation is interrupted:** follow [recovery](skills/paseo-workloop/reference/recovery.md) to reconcile current state before taking another action.
- **To organize a project's documentation:** follow [tidy-docs](skills/paseo-workloop/reference/tidy-docs.md) for per-machine registration and the document workflow.
- **To maintain or sync this collection:** follow the [collection guide](skills/README.md); check commands are defined in [package.json](package.json).

## 5. Acknowledgments

- **[Matt Pocock / skills](https://github.com/mattpocock/skills)** — the upstream engineering and productivity skills that guide this workflow. Their contents remain unchanged; workloop adaptations live in the local skill and role briefs.
- **[Paseo](https://github.com/getpaseo/paseo)** — the runtime for coordinating independent coding agents, workspaces, and completion notifications.

Local code uses the [MIT License](LICENSE). Upstream notices are preserved in [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES); source versions and diagram attribution are recorded in [NOTICE.md](NOTICE.md).
