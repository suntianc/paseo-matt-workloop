# 08 Fix two frozen-design behaviours that no ticket criterion covered

**Blocked by:** 07
**Scope:** skills/requirement-ledger/
**Found in:** final reviewer's report for tip `5cb571d0` (`reviews/final-1-5cb571d0.md`, `## Out of scope`)

**Goal：** the frozen design says two things the shipped code does not do. Both were reported as
suggestions because no ticket criterion named them; this ticket makes the code match the design,
and closes the small documentation drift the final review found around them.

## Symptom

1. `req new` appends to a ledger that belongs to a different repository. Design §3.1 and
   `skills/requirement-ledger/reference/storage.md:81` both say it must refuse.
2. `req lookup` prints no ambiguity marker for a run that is primary in two requirements, while
   design §6.5 and `reference/authorization.md:86` list `lookup` among the reads that must mark it.

## Reproduce

On the integration tip `5cb571d0`, with `WORKLOOP_ROOT` pointing at a temp dir and two checkouts
that share the project key `myapp`:

```
cd $WORKLOOP_ROOT/a/myapp && req new "From A" --alias login
cd $WORKLOOP_ROOT/b/myapp && req new "From B"
```

Actual: the second command printed `REQ-002  …/myapp/.requirements/REQ-002-from-b.md` and exit 0 —
it wrote into repo A's ledger.

For the second: link a run to `REQ-001`, hand-copy the same `runs:` block into `REQ-003` so the run
is primary twice, then compare the two readers:

```
req list            # REQ-001 ... [ambiguous myapp/login: REQ-003] From A
req lookup "登录" --json
```

Actual: `lookup` returns the candidate with `"last_delivery": "pending"` and no ambiguity field at
all, so a caller reading only `lookup` cannot tell the run's ownership is unresolved.

## Expected

1. `new` refuses, with a message naming the ledger's repository and the current one, and writes no
   file and no `_meta.json` change. A ledger with no recorded `repo_path`/`repo_remote` (older
   records, or a ledger created before this ticket) still accepts `new` — the check must not lock
   anyone out of an existing ledger that simply never recorded the fields.
2. `lookup` marks the affected candidate with `ambiguous: true` (JSON and the text form) whenever a
   run attached to that requirement is in the double-primary state, using the one predicate the
   other readers already share. `lookup` still answers; it must not refuse, and it must not pick a
   side.

## Known cause

Established by reading the tree at `5cb571d0`: `req new` never compares `repo_path`/`repo_remote`
(`scripts/store.mjs`, `createRecord`), and `scripts/lookup.mjs` has no relation between a candidate
and its runs beyond `run_count`/`last_delivery`, so it has nothing to mark from.

## Acceptance criteria
- [ ] AC1: `new` refuses to append to a ledger whose recorded `repo_path` or `repo_remote` disagrees with the current repository, leaving files and `_meta.json` untouched; a ledger that records neither field still accepts `new` — check: `node --test skills/requirement-ledger/scripts/test/store.test.mjs`
- [ ] AC2: The refusal is covered by a test that fails on `5cb571d0` and passes after the change, built the same way as the other store tests (temp `WORKLOOP_ROOT`, two checkouts with the same basename) — check: `node --test skills/requirement-ledger/scripts/test/store.test.mjs`
- [ ] AC3: `lookup` marks a candidate `ambiguous: true` (JSON and text) when one of its runs is primary in two requirements, still answers rather than refusing, and marks nothing on a clean ledger — check: `node --test skills/requirement-ledger/scripts/test/lookup.test.mjs`
- [ ] AC4: `reference/lookup.md`'s single-character sentence matches what the scorer does with a two-character title, and `--include` is documented in `reference/context.md` where the Commands table sends the reader — check: `node skills/tools/link-check.mjs`
- [ ] AC5: The whole suite stays green with the new cases included — check: `npm test`

**Keep as is:** every behaviour tickets 02–07 proved, in particular the double-primary refusal in `context`/`sync`/`link`, `show`/`list`/`doctor`'s existing marker, the delivery and history rules, and the worktree-free context contract.
**Not in this change:** 不改 `workloop.mjs` 或上游 skills；不引入 SQLite/daemon/HTTP；不做需求图谱；不删除任何现有测试。
