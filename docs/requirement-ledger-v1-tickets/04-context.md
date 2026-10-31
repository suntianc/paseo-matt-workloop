# 04 Context 引用式召回

**Blocked by:** 02
**Scope:** skills/requirement-ledger/scripts/
**Maps to:** E8

**Goal：** 实现 `req context <REQ>`：只组织指针、不拼接正文；区分三种交付状态；不依赖工作树。

## Acceptance criteria
- [ ] AC1: 按冻结稿 §5 顺序输出指针：需求摘要→关联 Run 的 Spec/Ticket/验收→ADR 引用→最终交付 SHA/证据→CodeGraph hint→（按需）Retro/Pitfalls/历史 ADR；**不复制 ADR/Spec/Review 正文**。— check: `node --test skills/requirement-ledger/scripts/test/context.test.mjs`
- [ ] AC2: 正确区分 **S1 已 finish 未 archive / S2 已归档有证据 / S3 已归档缺证据**；S1 不因 `evidence/index.json` 不存在而判交付失败。
- [ ] AC3: 不要求历史 `tip/` worktree 存在；优先引用保留的 `state.json`、提交 SHA、分支名、Spec 路径、`evidence/`。
- [ ] AC4: `refs.adr` / `refs.pitfalls` 读取时校验存在，失效标 dangling（只报告、不删、不猜替代）。
- [ ] AC5: CodeGraph 仅输出 `symbols`/`paths` 提示，附“索引可能滞后、以工作树为准”说明；台账不跑图查询、不存图谱。
- [ ] AC6: 当该 Run 处于**双重主关联**（纠错未完成）时，`context` **拒绝执行并提示先恢复 `link --correct`**，不任选其一归属。

**Keep as is:** lookup 行为。
**Not in this change:** 不缓存代码图谱；不改 Workloop。
