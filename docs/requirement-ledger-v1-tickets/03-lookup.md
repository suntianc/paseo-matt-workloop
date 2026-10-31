# 03 Lookup 检索与歧义

**Blocked by:** 02
**Scope:** skills/requirement-ledger/scripts/,skills/requirement-ledger/reference/lookup.md
**Maps to:** E2、E3

**Goal：** 实现 `req lookup` 的确定性候选与歧义契约（含中文子串/二元组），只给证据、不自动归属。

## Acceptance criteria
- [ ] AC1: 拉丁文本按词元重叠、中文按字符子串+bigram 打分；`aliases` 生效；`score`/`matched_terms`/`summary_excerpt` 由确定性算法产生，可复现。— check: `node --test skills/requirement-ledger/scripts/test/lookup.test.mjs`
- [ ] AC2: `--json` 输出符合冻结稿 §4.1 结构（`decision` ∈ strong|ambiguous|none，top-5，可配阈值）。
- [ ] AC3: 换措辞/中文片段/同义词命中既有 REQ，且**不因命中自动创建新需求**（lookup 无写副作用）。
- [ ] AC4: 多候选接近时 `decision=ambiguous`；无过阈值时 `none`（`none` 不声称是全新需求）。
- [ ] AC5: 仅在当前 `project` 内检索；不读取其他项目目录。

**Keep as is:** `new/list/show/retire`、doctor 基础检查。
**Not in this change:** 不引入 embedding/向量库/FTS/分词库；不做 context（T4）。
