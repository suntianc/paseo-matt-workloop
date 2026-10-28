## Boundary

The user confirmed this ticket's acceptance criteria before the work started, and those criteria plus four **floor classes** are the whole of what a blocking finding may claim. A finding's `Basis` cell starts with what it cites:

- a confirmed criterion, as `AC2: <the criterion, quoted>`;
- or one floor class, by name:
{{floorClasses}}

Everything else is a suggestion for the user, not a finding: a coding standard or code smell in no floor class, a concern about a part of the spec this ticket does not touch, a wish for different scope. Write each one as a line under `## Out of scope`, with no finding ID and never blocking. The user reads them; nothing gates on them.

`Verdict: changes_requested` exactly when a finding that cites a criterion or a floor class is blocking, and `Verdict: pass` otherwise.
