# paseo-workloop skills

This directory contains the skill collection. Run the commands below from `skills/` (`cd skills` from the repository root).

This collection holds a set of agent skills for taking a feature from idea to integrated code. It has two layers:

- **Upstream skills, unmodified.** Seventeen skill sources come from [mattpocock/skills](https://github.com/mattpocock/skills), at the commit recorded in [tools/upstream.json](tools/upstream.json). They are kept byte-for-byte identical to upstream.
- **Local skills.**
  - [paseo-workloop](paseo-workloop/SKILL.md) routes Quick work to the current session and Direct/Full runs to Paseo. It is the main entry point.
  - [retro](retro/SKILL.md) provides a suggestion-only entry point; its unmodified upstream source is retained under `retro/reference/upstream.md`.
  - [codegraph](codegraph/SKILL.md) covers the CodeGraph code index.

Upstream source copies are never edited here. The retro wrapper narrows its upstream reference to findings and suggestions. Whatever the workloop needs done differently goes into its own briefs: [executor](paseo-workloop/templates/executor-brief.md) and [reviewer](paseo-workloop/templates/reviewer-brief.md). These tell each agent which steps of the upstream skill to skip or replace. Because upstream stays untouched, updating is a copy.

## Skills

| Skill | Source | Used by the workloop for |
|---|---|---|
| grill-me, grill-with-docs, grilling, domain-modeling | upstream | reaching a shared understanding with the user |
| to-spec, to-tickets | upstream | the spec and the local ticket files |
| implement, tdd | upstream | executors |
| code-review | upstream | reviewers |
| diagnosing-bugs | upstream | escalations |
| writing-for-agents | upstream | agent-facing documents and skills |
| retro | local entry point, upstream reference | whole-run findings and suggestions; no automatic implementation |
| codebase-design, improve-codebase-architecture, handoff, wait-what | upstream | not used directly |
| setup-matt-pocock-skills | upstream | not needed by the workloop, whose runs keep their own tracker; run it only to use upstream skills on their own |
| paseo-workloop | local | orchestration |
| codegraph | local | code navigation, when a repo is indexed |

These skills were removed: `implement-spec`, `loop-me` and `chief-of-staff`.

- `implement-spec` runs a spec with in-session subagents, which is what paseo-workloop does with Paseo agents.
- The other two are upstream's in-progress skills.

All three remain upstream; they are not included in this standalone collection.

## Installing

For the supported npx installation and update commands, see the repository's
root README. The installer copies this complete directory to your selected
skills directory and keeps its resources together.

Point your agent harness's skills directory at this directory, or copy or link its skill directories into it.

Keep the skills together. paseo-workloop links to its sibling skills by relative path (`../to-tickets/SKILL.md`), and it gives executors and reviewers absolute paths into this directory.

The workloop doesn't need `setup-matt-pocock-skills`, because a run keeps its spec and tickets in its run directory. Run setup only to use upstream skills on their own, such as `triage`.

To use `/tidy-docs` in a repo, register it once per machine with `node paseo-workloop/scripts/tidy-docs.mjs install --repo <repo>`. It installs an Agent Skills project skill, so it works in Claude Code as `/tidy-docs` and in pi or other Agent Skills agents as `/skill:tidy-docs`. The installed files hold this machine's paths, so they're excluded from git rather than committed. See [tidy docs](paseo-workloop/reference/tidy-docs.md).

Direct and Full runs also need (Quick does not):

- Node.js 18.3 or later;
- git;
- the Paseo CLI, with its daemon running;
- a Paseo agent session with agent-scoped `create_agent`/`send_agent_prompt` tools and heartbeat support for asynchronous supervision; see [async supervision](paseo-workloop/reference/async-supervision.md). A Claude Code Stop hook is provided for optional automatic renewal;
- two Paseo agent profiles, `wl-executor` and `wl-reviewer`, created in the app under Settings → host → Agents → Agent profiles. Executors and reviewers start with their provider, model, mode and thinking level. Choose a mode that doesn't stop to ask for permission at every step, since nobody watches these agents. Without the profiles, the run refuses to start any agent until you name another profile or a provider.

| Environment variable | Default | Meaning |
|---|---|---|
| `WORKLOOP_ROOT` | `~/.workloop` | Where run state is kept, as `<root>/<project>/<feature>/`. |
| `WORKLOOP_RUN` | none | The default for `--run`. |
| `PASEO_CLI` | `paseo` | The Paseo command. On Windows, point it at the CLI's `.js` entry to avoid going through `cmd.exe`. |
| `PASEO_TIMEOUT_MS` | `30000` | Timeout for each Paseo CLI call; timed-out writes require reconciliation before retry. |
| `PASEO_HOME` | `~/.paseo` | Paseo's home directory; its `config.json` holds the agent profiles. If `PASEO_HOST` is set (a daemon on another machine), profiles aren't read and the run needs `--provider`. |

### Harness notes

**The Skill tool.** Upstream skills say "call the Skill tool with X". Claude Code has that tool. Harnesses that expose skills differently, such as omp with `skill://<name>`, need a standing rule in their global instructions:

> When a skill says to call the Skill tool with X and you have no Skill tool, read skill X's `SKILL.md` and follow it.

The workloop's briefs already tell executors and reviewers to do this.

**User-only skills.** `disable-model-invocation: true` marks a skill that only the user should start: grill-me, to-spec, to-tickets, implement, and others. Claude Code honours the flag. Other harnesses may ignore it, in which case the model can start those skills on its own. paseo-workloop never invokes them; it reads them as files.

**Paseo versions.** Version-specific Paseo behaviour is recorded in [paseo-workloop/reference/paseo-compat.md](paseo-workloop/reference/paseo-compat.md).

## Updating from upstream

Clone upstream somewhere outside this repository. The sync tool only reads the clone; it never runs anything from it. Then:

```
node tools/upstream-sync.mjs <clone> --check   # what differs (line endings ignored)
node tools/upstream-sync.mjs <clone>           # copy, and record the clone's commit
git diff                                       # read what changed upstream
node tools/link-check.mjs
```

To add another upstream skill, list it under `skills` in `tools/upstream.json` with its upstream category, then sync. An entry may use `{ "category": "engineering", "reference": "retro/reference/upstream.md" }` to preserve upstream as a reference beneath a local entry point. Local skills are listed under `local`.

## Checks

```
node --test paseo-workloop/scripts/test/workloop.test.mjs   # workloop CLI, against a fake paseo
node tools/link-check.mjs                                   # relative links and skill:// references
node tools/upstream-sync.mjs <clone> --check                # upstream skills are unmodified
```

The workloop tests use real git repositories and a stand-in for the Paseo CLI ([fake-paseo.mjs](paseo-workloop/scripts/test/fake-paseo.mjs)), so they show the logic is right but not that it matches Paseo itself. If you upgrade Paseo, re-verify the compatibility notes.
