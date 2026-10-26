<!-- An index of ADRs and documents that are no longer current. Create it as `docs/adr-history.md` from the first supersede or removal.
     Agents don't read this file day to day. `docs/adr/` holds only valid ADRs, so nothing here constrains anyone.
     Read it only when superseding an ADR or when the user asks to trace history.
     Every deleted original stays in git: fetch it with the command in its row. -->

# ADR history

## Superseded ADRs

| ADR | Title | Superseded on | Superseded by | Why | Original |
|---|---|---|---|---|---|
| 0007 | In-memory session cache | 2026-10-20 | ADR-0012 | Sessions outlive one process | `git show <sha>:docs/adr/0007-in-memory-session-cache.md` |

## Removed documents

| Path | Removed on | What it was | Original |
|---|---|---|---|
| `PROGRESS.md` | 2026-10-20 | A progress log; open items moved to the backlog | `git show <sha>:PROGRESS.md` |

<!-- Both tables are newest-last. `<sha>` is the commit the change was based on, so the command works from any later checkout.
     You never reuse a number: the next ADR number is the highest in `docs/adr/` or in the table above, plus one. -->
