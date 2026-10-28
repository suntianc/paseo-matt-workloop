# Pitfalls

A project's pitfalls are its traps: situations where the obvious move goes wrong in this repo. They live in `docs/pitfalls/`, travel with the repo, and are read by the next agent that walks into the same situation. They are experience, not rules, requirements or review gates.

Retro finds problems; this reference turns the ones that are traps into entries. [retro](../../retro/SKILL.md) itself is unchanged: it still produces findings and suggestions only.

## From retro to proposal

After a retro, go through its findings and sort each one:

- **A pitfall** names a concrete trigger (a path, command, tool, interface, error text or business state) and a way out that works here. It comes from this repo's code, configuration or environment, or from how a tool or external system this project uses behaves. It cost something in this run (rework, a wrong conclusion, lost work) and the retro has the evidence.
- **Advice about how agents work** ("check the original log", "keep to what the user asked") applies anywhere. It stays a retro suggestion with its usual destinations: a skill, a brief, a reviewer rule. It does not go into pitfalls.
- **An agent overstepping** (killing processes by name, editing outside its scope, acting without authorization) is a behaviour to forbid, not a trap in the repo. It goes to the brief or instruction file that governs that agent.
- **Already covered** by a test, a hook or `AGENTS.md`: nothing to record.

The test for every candidate: would the next agent who meets this trigger act differently after reading it? If not, it isn't an entry.

## Boundaries

One entry is one trigger and one way out.

- Same trigger, same way out as an existing entry: add a line to that entry's Sources. Don't write a second entry.
- Different trigger or different way out: a separate entry, even when both feel like "the same kind of problem". Merging by kind is how entries turn into slogans.
- Generalise only as far as the cases you have seen. If the run showed it for Pyright, write Pyright, not "any static checker".

## Writing an entry

Use [templates/pitfall-entry.md](../templates/pitfall-entry.md). The five fields are the whole entry, about five lines.

Two kinds of detail look alike. Keep the detail that lets someone recognise the trap: the directory name, the missing `.venv`, the error text. Leave out the detail that tells the story of the run: how many methods were mapped, which review round found it, the commit SHAs. That story stays in the retro.

**Confirm** is the field that keeps an entry honest: a check anyone can run today, on any machine, that shows the trap is still there. Its result must change once the trap is fixed. Running the triggering case gives one result, and the fixed or avoided case gives another; for example, the same tests fail with the default setting and pass with the workaround. A check that prints the same thing either way only restates a static fact (a class has five mixins, nine node processes are running); a candidate that can't get a better one is usually advice, not a pitfall. An entry whose trap has gone is removed.

## Evidence

Copy what the entry cites into the repo, so its Sources open on any machine:

- The run's `retro.md`, to `docs/pitfalls/evidence/<run>/retro.md`.
- Only the small files the entry names, such as a repro script or a log excerpt, beside it. Never a whole `evidence/` directory, worktree copy or full log.

Before proposing, remove credentials, tokens, personal data and business data from every copied file. Links inside a copied retro may still point at the local run directory; they don't need to resolve.

## Layout

```
docs/pitfalls/
  README.md          index: one row per entry
  <topic>.md         entries, grouped by where they're met: testing.md, git.md, an external system
  evidence/<run>/    copied retro.md and cited files
```

The index is what agents read first, so it is keyed by trigger:

```
| Trigger | Entry |
|---|---|
| Running pytest from a path containing `integration` | [Tests silently skipped](testing.md#...) |
```

Group pages by where an agent meets the trap (a tool, a directory, an external system), not by the kind of mistake. When creating the directory, register it in the repo's `## Documents` table as `docs/pitfalls | pitfalls | global` (see [document organization](tidy-docs.md)).

## Proposing and recording

Present the proposal to the user with the retro: each new entry or the line to add to an existing one, written out in full, and the files to copy. Write nothing until the user agrees. A rejected candidate is simply dropped; it remains in the retro.

Once agreed, recording is a Quick change in the user's checkout: write the entries, the index rows and the copied evidence, verify the links, and report the files changed. Committing follows the project's usual practice.

When an entry has been turned into a test, a hook or a rule, propose removing it; its retro stays in `evidence/`.

## Reading

At the start of a task, read `docs/pitfalls/README.md` if it exists and open only the entries whose trigger matches the tools, paths and interfaces the task touches. An entry describes what happened when it was recorded; where it disagrees with the code, the code is right, and the entry is a candidate for removal.
