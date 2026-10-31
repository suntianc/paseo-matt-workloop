# Lookup

`lookup` answers one question: given the words of a request, which existing requirements might it belong to? It is deterministic, scoped to one project, and free of side effects.

```
node scripts/req.mjs lookup "<text>" [--project <slug>] [--json]
```

## Candidates

Every requirement's `title`, `aliases`, summary and `refs` are scored:

- **Latin text** is split on whitespace and non-alphanumerics, then scored by token overlap.
- **Chinese**, which offers no gaps to split on, is scored by substring and character-bigram overlap. v1 adds no segmentation library.
- An exact title or alias hit weighs most.
- The score comes from that algorithm. A model never supplies it or adjusts it.

Five candidates come back by default.

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

`decision` is advice about those numbers and nothing more:

| Value | Means |
|---|---|
| `strong` | The best score passes an absolute threshold and clearly leads the runner-up, by about twice its score. |
| `ambiguous` | Several candidates sit close together. Ask the user which one this is. |
| `none` | Nothing passes the threshold. |

Two readings it does not support:

- **`strong` is not a confirmed owner.** Main judges, and asks the user when the answer changes what gets built.
- **`none` is not proof of a new requirement.** It says the word search found no evidence, which is a fact about vocabulary rather than about the product. Main decides from the conversation.

`matched_terms`, `summary_excerpt` and `score` come from stored fields and the algorithm, so they can be quoted back to the user as evidence.

## Scope and effects

The search covers the current project only, with no fallback to another. Requirements belonging to other projects are not returned, including one that happens to share a name with a requirement here: a name match in another project is still another project's requirement.

A lookup writes nothing to the ledger and assigns nothing. An optional audit line records that the query happened.

The first version keeps a few explicit knobs — an absolute threshold, a lead multiple, top-N — calibrated from test cases rather than tuned in place.
