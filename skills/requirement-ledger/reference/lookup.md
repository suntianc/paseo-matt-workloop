# Lookup

`lookup` answers one question: given the words of a request, which existing requirements might it belong to? It is deterministic, scoped to one project, and free of side effects.

```
node scripts/req.mjs lookup "<text>" [--project <slug>] [--json]
```

## Candidates

Every requirement's `title`, `aliases`, summary and `refs` are scored:

- **Latin text** is split on whitespace and non-alphanumerics, then scored by token overlap.
- **Chinese**, which offers no gaps to split on, is scored by substring and character-bigram overlap. v1 adds no segmentation library. A single character still counts as a fragment, at half the weight of a bigram: enough to recall the requirement. A one-character query that is exactly a title or alias keeps the exact-match score of 1; otherwise the character reaches at most 0.5 — exactly the default threshold — and only on a one- or two-character title or alias, with a longer field below it.
- An exact title or alias hit weighs most.
- The score comes from that algorithm. A model never supplies it or adjusts it.

Five candidates come back by default. The limit decides how many are printed, never how the
decision is reached: `strong` is always measured against the full ranking, including a runner-up
the reader is not shown. It never trims the catalog.

## Reading the answer

```json
{
  "query": "add a captcha to login",
  "project": "myapp",
  "decision": "strong",
  "candidates": [
    {
      "id": "REQ-007",
      "title": "User login",
      "status": "active",
      "score": 0.82,
      "matched_terms": ["login", "captcha"],
      "summary_excerpt": "…account login and authentication…",
      "updated_at": "2026-11-01T…",
      "run_count": 2,
      "last_delivery": "delivered"
    }
  ]
}
```

A candidate whose record holds a run that another requirement also holds as primary carries `ambiguous: true`, in JSON and in the text reply: the search still answers, and that run's ownership stays unresolved until the `link --correct` finishes.

`decision` is advice about those numbers and nothing more:

| Value | Means |
|---|---|
| `strong` | The best score passes an absolute threshold and clearly leads the runner-up, by about twice its score. |
| `ambiguous` | Several candidates sit close together. The answer adds the catalog. |
| `none` | Nothing passes the threshold. The answer adds the catalog. |

Neither decision is a verdict: `strong` is not a confirmed owner, and `none` says the vocabulary found nothing rather than that the product lacks it, so it is not proof of a new requirement. Main judges from the conversation, and asks the user only when it cannot tell.

## The catalog

A request worded differently from every record — "验证码" against a record that says "captcha" — finds no candidate, and only a reader of the conversation can tell where it belongs. So when the decision is `none` or `ambiguous`, the answer adds `catalog`: every readable requirement of the project, in number order, quoted from its record and not scored.

```json
"catalog": [
  { "id": "REQ-007", "title": "User login", "status": "active", "aliases": ["login", "sign-in"], "summary": "Account login and authentication…" }
]
```

`summary` is the start of the record's summary, cut at 100 characters. An entry whose record holds a run another requirement also claims as primary carries `ambiguous: true`, as a candidate does. A `strong` answer has no `catalog`, and an empty ledger answers with an empty one.

Main reads it with the conversation and decides: one of these, or none, which makes the request a new requirement. It asks the user only when it cannot tell, naming at most three. When the user confirms a requirement the words missed, the term they used goes into that record's `aliases`; a term added on Main's own judgement would turn a wrong guess into next time's strong match. The catalog has no size limit.

`matched_terms`, `summary_excerpt` and `score` come from stored fields and the algorithm, so they can be quoted back to the user as evidence.

## Scope and effects

The search covers the current project only, with no fallback to another. Requirements belonging to other projects are not returned, including one that happens to share a name with a requirement here: a name match in another project is still another project's requirement.

A lookup writes nothing to the ledger, records nothing in its audit log and assigns nothing.

The first version keeps a few explicit knobs — an absolute threshold, a lead multiple, top-N — calibrated from test cases rather than tuned in place.
