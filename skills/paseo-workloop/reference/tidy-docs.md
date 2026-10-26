# Tidy a repo's documents

`/tidy-docs` is a per-project command for any agent that reads Agent Skills. The user installs it once on a machine, then runs it whenever the repo's documents need putting in order. This reference is the procedure you follow when they run it.

The work is one full run: a spec, tickets, executors and integration, like any other feature. The run moves documents and changes almost no product code, which makes it a good first run in an unfamiliar repo, because the grilling reads everything the repo documents about itself.

## 1. What it is

Register the command in the repo:

```
node <this skill's directory>/scripts/tidy-docs.mjs install --repo <repo>
```

It registers `/tidy-docs` on this machine, for any agent that reads Agent Skills, by writing the same project skill to two places: `.agents/skills/tidy-docs/` (the location pi and other Agent Skills agents scan) and `.claude/skills/tidy-docs/` (Claude Code). The skill comes from `templates/tidy-docs-skill.md`, with this machine's absolute paths filled into its `{{procedure}}` and `{{workloop}}` placeholders. Those paths are machine-specific, so `install` also adds both files to the repo's `.git/info/exclude`: they are never committed, because a path that is right on your machine is wrong on mine.

Run `install` again and it says the files are already there; if either differs, it refuses and touches neither rather than overwrite changes someone made. It doesn't commit anything.

The user then runs it as `/tidy-docs` in Claude Code, or as `/skill:tidy-docs` in pi. Because the tidying is a full run, the session that runs it must meet the workloop's prerequisites: read "Before you start" in [SKILL.md](../SKILL.md) and satisfy it first. A session that can't dispatch agents can't tidy a repo.

Installing the command isn't what makes the end-of-run check work, though, and a repo can have a registry without it: once a repo has a registry, every full run there also checks the documents it added before `finish` ([SKILL.md](../SKILL.md), step 4). That check is why tidying once keeps working: the next run that adds a `PROGRESS.md` notices it without anyone remembering to look.

## 2. Target state

When the run is finished, the repo keeps only these documents:

| Document | What it's for |
|---|---|
| `AGENTS.md` | Instructions for agents. `CLAUDE.md` holds just `@AGENTS.md`, so every provider reads one file. |
| `CODING_STANDARDS.md` or `CONTRIBUTING.md` | How code should be written. `code-review` looks for them, so its findings can cite them. |
| `GLOSSARY.md` | The domain's terms, and the context names the registry's Domain column uses. |
| `docs/adr/` | Valid ADRs only. A superseded ADR is deleted, and the history table points at it. |
| `docs/adr-history.md` | Superseded ADRs and removed documents, with a `git show` command for each original. Nothing here constrains an agent. |
| Product documents | README, CHANGELOG, and user, API and operations docs for people. These are kept current; a stale one is a bug. |

Everything else moves out of the repo:

- **Run documents** live in the run directory, `$WORKLOOP_ROOT/<project>/<feature>/`. Specs, tickets, briefs, reports and reviews belong there, not in the repo.
- **Open TODO and backlog items** live in `~/.workloop/<project>/backlog.md`, outside the repo. Read it only when choosing the next work, then work from a spec; the backlog is a list of candidates, not a plan.

## 3. The registry

The registry is a table under a `## Documents` heading in `AGENTS.md` at the repo root, or in `CLAUDE.md` when `AGENTS.md` doesn't exist:

```
| Path | Type | Domain |
|------|------|--------|
| AGENTS.md | instructions | global |
| docs/adr | adr | global |
| docs/adr-history.md | history | global |
| docs/api/billing.md | product | billing |
```

- **Path** is a repo-relative glob, with the same rules as a ticket's `Scope:` line: a bare directory name such as `docs/adr` covers the files below it. A file belongs to the first row that matches it, so put specific rows above general ones. The registry doesn't list the installed `/tidy-docs` skill files under `.agents/skills/tidy-docs/` and `.claude/skills/tidy-docs/`: git ignores them, so they aren't documents in the repo at all.
- **Domain** is a context name from the repo's `GLOSSARY.md` (or `GLOSSARY-MAP.md`), or `global` for documents that apply everywhere.

The Type column does most of the work: it says who reads the document, and so what happens to it.

| Type | What it holds | When agents read it | How it's maintained |
|---|---|---|---|
| `instructions` | Agent instructions | Every session | Rewritten in place |
| `standards` | Coding standards | When writing or reviewing code | Rewritten in place |
| `glossary` | Terms | When naming things | Updated as terms are settled |
| `adr` | Valid decisions | When the change touches their area | Superseded ones are deleted and indexed in history |
| `history` | `docs/adr-history.md` | Not day to day; only when superseding an ADR or tracing one | Rows appended, never edited |
| `product` | README, user, API and ops docs for people | When the change touches their domain | Must match the code |
| `generated` | Generated or vendored files | Never | Not edited by hand |

There is at most one document per type and domain for `instructions`, `standards`, `glossary` and `product`. A new document of a type and domain that already has one is merged into the existing document instead of being added beside it. That rule is what keeps `AGENTS.md` one file rather than a folder of notes.

The repo-root `AGENTS.md` and `CLAUDE.md` need no thought: they are always registered as `instructions`/`global`, with or without a row, and `CLAUDE.md` is usually just `@AGENTS.md`. Two consequences follow, and both stop the inventory reporting a problem where there is none: they never count towards duplicates, and a row for them is never stale. The row is optional; the registration isn't. An inventory still reports both files in `registered` as `instructions`/`global`, whether or not the table has a row for them, so a file that exists is never left out of the report.

## 4. Inventory

Run the inventory against the repo:

```
node <this skill's directory>/scripts/tidy-docs.mjs inventory --repo <repo>
```

Add `--json` to read it as data rather than as a report. It reads the registry and lists every Markdown file that git tracks, or that is untracked but not ignored, and that exists on disk. Its report has five parts: `registry` (the file it came from and its rows, or none), `registered` (each file with the type and domain of its row, including the repo-root `AGENTS.md` and `CLAUDE.md` even when no row covers them), `unregistered` (files no row matches), `stale` (rows that match no file) and `duplicates` (rows sharing a type and domain, for the four single-document types). It exits 0 for any report, including one full of problems, so read the report rather than the exit code; it exits 1 only for a usage error, a `## Documents` heading with no table, or a row whose type isn't in the list.

Add `--since <ref>` to limit `unregistered` to the files added or renamed since that ref. That's the form the end-of-run check uses, against the run's base commit, so it sees what this run added and not the repo's older backlog.

With no registry, almost every document is unregistered, and the job is larger: the run both builds the registry and sorts the files into it. The exceptions are the repo-root `AGENTS.md` and `CLAUDE.md`, which stay registered as `instructions`/`global` even with no table to hold them, as part 3 says.

## 5. Classify

For each unregistered document, read it, decide its type and domain, then choose its action:

| What it is | Action |
|---|---|
| Current and maintained (user, API, ops docs) | Keep and register it as `product` |
| Current but stale | Rewrite to the present, or remove |
| Rationale ("why we did it") | Turn the decisions that are still valid and meet the ADR bar into ADRs; remove the rest |
| Terms | Merge into `GLOSSARY.md` |
| Instructions for agents (rules files, prompt notes) | Merge into `AGENTS.md` |
| Process (plans, progress logs, summaries, handoffs, old `.scratch/`) | Remove; move open items to the backlog |
| Generated or vendored | Leave it alone, and register it as `generated` |

A document whose type and domain already has one is merged into that document rather than registered beside it. Fix the stale rows (point them at the file's new path, or delete them) and the duplicate rows in the same pass.

The default actions apply without asking. Ask the user, in one message, only about documents you can't classify and about which of the old decisions are still valid. The ADR bar is domain-modeling's: a decision that is hard to reverse, surprising without context, and the result of a real trade-off. A rationale document usually holds a few decisions that meet it and a lot of narrative that doesn't.

## 6. Carry it out as one full run

From here it's an ordinary full run, so [SKILL.md](../SKILL.md) applies:

1. `WL scratch --feature <slug> --repo <repo>` for the run directory.
2. Write the spec's Implementation Decisions from the classifications, and one ticket per kind of change: ADRs from the rationale documents, the glossary merge, `AGENTS.md` consolidation, the registry itself, and the removals. Removals and the registry both touch `AGENTS.md` and `docs/adr-history.md`, so give them a blocking edge or make one ticket own both files.
3. `WL init` with the run's checks. `WL config --check` replaces the whole check list rather than adding to it, so pass every check the run keeps.
4. ADRs settled during grilling go in through `WL decisions` before the first dispatch, in the integration worktree. See "Record decisions" in [SKILL.md](../SKILL.md).
5. Run the loop, then the final review and `finish`.

Each removed document gets a row in the "Removed documents" table of `docs/adr-history.md`. The `Original` column holds `git show <sha>:<path>`, where `<sha>` is the commit the change is based on, so the command works from any later checkout. Say in "What it was" what the document was, in one line, and where its still-open items went. Put the deletion and its row in the same commit, so `git log` never shows a document gone with no trace of what it said.

## After the run

The registry is the part that keeps working. It's in the repo, so the next run reads it, and the end-of-run check asks that run to classify any document it added rather than letting a stray file accumulate. Nothing checks that on every commit; this is a tidy-up that happens at the end of a run, not a gate that stops work.
