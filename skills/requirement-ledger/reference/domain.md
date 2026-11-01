# Requirements, runs and the primary relation

## What a requirement is

A requirement is one long-lived business capability or theme that can be delivered more than once. It is not a chat message, not a ticket, and not the project. "User login" is a requirement; "add a captcha to login" is work that belongs to it.

Its id has the form `REQ-<n>`: at least three digits, zero-padded (`REQ-001`), and growing naturally past the padding (`REQ-1000`). The id is the identity — it survives a changed title, a renamed file and rewritten prose. Ids are never reused and never deleted; retiring a requirement changes its `status` and keeps both the file and the number.

## Which store is authoritative

| Object | Holds | Authority |
|---|---|---|
| Requirement | Identity, current summary, and references to runs, deliveries and documents | the ledger, in `.requirements/` |
| Workloop run | One development delivery: tickets, attempts, reviews, completion | Workloop exclusively, in `state.json` and `events.jsonl` |
| Task and attempt | The executable tickets of one run, and their tries | Workloop; numbering is **local to the run** |
| Requirement ↔ run relation | Which requirement a run delivered, and how | the ledger, as a read-only projection of Workloop state |

Everything the ledger says about a run is a projection taken from that run's `state.json`. When the two disagree, Workloop is right, and a `sync` is how the projection catches up.

## One orchestration centre

Workloop is the only place that decides what gets built, by whom, in what order, and whether it passed; the ledger schedules nothing and never dispatches. The constraints this puts on each command are in [authorization](authorization.md).

## Cardinality

- One requirement takes **many runs**. A capability is delivered, revised and delivered again.
- One run takes **exactly one primary requirement** in v1.
- A single primary requirement is not a single capability. When a change also touches another capability, say so in that run's execution scope, acceptance criteria or delivery record. Two independent business goals are two requirements, and the run links to one of them as primary. `link --correct --reason` is the only way to move a run to another requirement.
- v1 relations are flat: no parent and child, no supersedes, no depends-on.
