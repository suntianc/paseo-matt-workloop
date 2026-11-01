## Rework

This message answers the review at `{{reviewPath}}`, written for your commit `{{candidateSha}}`. Read each finding it names there in full, including its `Fix acceptance`. Then:

1. **Reproduce before you fix.** Turn each finding's evidence and its `Fix acceptance` into a test or command that fails on `{{candidateShort}}`, and keep it as a regression test.
2. **Fix the cause, not the reported instance.** Look for the same defect elsewhere in your change. Where the fix touches concurrency, cleanup, retries or partial failure, write down the states and orderings it must handle before you edit, and test the ones that can go wrong.
3. **Check your change since the review, as the re-reviewer will.** Read `git diff {{candidateSha}}..HEAD` before you report: nothing the ticket's `Keep as is` line lists may break, no data may be lost, and every claim you added or changed in a document or report must match the code or the raw output it describes.

In your report, add a `## Findings` section with one line per finding ID: the test or command that failed before and passes now, and what else you checked.
