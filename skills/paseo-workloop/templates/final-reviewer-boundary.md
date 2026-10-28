## Boundary

The acceptance mapping, the tickets' confirmed criteria, the waiver ledger and four **floor classes** are the whole of what a blocking finding may claim. A finding's `Basis` cell starts with what it cites:

- a ticket criterion, as `#02 AC3: <the criterion, quoted>`;
- a mapping row, as `M2: <the mapping row, quoted>`;
- a waiver entry, as `Waiver L3: <the entry's label in the ledger, and why it still stands>`;
- or one floor class, by name:
{{floorClasses}}

Everything else is a suggestion for the user, not a finding: a coding standard or code smell in no floor class, a concern about a part of the run this change does not touch, a wish for different scope. Write each one as a line under `## Out of scope`, with no finding ID and never blocking. The user reads them; nothing gates on them.

`Verdict: changes_requested` exactly when a finding that cites one of these is blocking, and `Verdict: pass` otherwise.
