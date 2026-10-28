# 01: <what this change makes work>

**What to build:** <the end-to-end behaviour this change makes work, from the user's perspective>

**Keep as is:** <existing behaviour near this change that must still work afterwards, in the user's terms>

**Not in this change:** <related additions the user did not ask for, which the executor must not add>

**Blocked by:** None

**Scope:** <paths this change may touch, relative to the repo root, comma-separated; globs allowed, e.g. src/foo/**, test/foo.test.ts>

**Status:** ready-for-agent

<!-- Written by the orchestrator for a direct run, from the grilling, and approved by the user before `init --direct`.
     Save it as `<run dir>/issues/01-<slug>.md`, the only ticket in that directory.
     `WL scratch` prints the run directory.
     The approval is how the user confirms you understood them, so say everything you settled; the executor has only this file and the code.
     - Keep as is / Not in this change: write both from the user's words, not from what seems convenient. "Add X" keeps what is already there; list it, so a ticket that removes it is visible when the user reads it. Give a kept behaviour a criterion when it must be proved. Delete a line that has nothing to say.
     - The Scope line is checked against the diff: a candidate touching any other file is refused. List directories as `dir/`.
     - Leave out public behaviour, shared interfaces and open product decisions. If the change needs them, it isn't a direct run.
     - The reviewer re-runs every command below, and integration and finish run them again, so give each criterion a command that can run again on any later tree. Nothing reviews the change after the reviewer.
     - Number the criteria `AC1`, `AC2`, …: the user confirms them with the ticket, and a later change is recorded with `WL criteria` after they agree to it.
     - Bound every criterion: the reviewer holds it to its letter. Replace "all", "every", "never" with the scope they cover, and write a known limit into the criterion. -->

- [ ] AC1: <criterion> — check: `<command that proves it>`
- [ ] AC2: The run's checks pass.
