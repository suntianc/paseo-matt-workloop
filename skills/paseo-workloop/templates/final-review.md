Integration tip: <sha of the integration branch this mapping is for>

<!-- Written by the orchestrator once every ticket is closed. It is the acceptance
     mapping an independent final reviewer verifies, not a verdict: `final-review --prepare`
     starts that reviewer on this tip, and `finish` accepts only its report.
     Number every row M1, M2, …: a blocking finding may cite one. -->

## Acceptance

| Row | Spec item | Evidence on the integrated tree |
|-----|-----------|---------------------------------|
| M1 | ... | test / command / file that shows it works |

## Notes for the final reviewer

Anything the reviewer should know: what changed since the previous round, which
checks are slow, where the run is most likely to have drifted.
