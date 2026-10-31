# 06 Doctor 全量一致性

**Blocked by:** 02, 05
**Scope:** skills/requirement-ledger/scripts/
**Maps to:** E7、E10

**Goal：** 让 `req doctor` 成为台账一致性的单一诊断入口，覆盖跨文件与悬空引用。

## Acceptance criteria
- [ ] AC1: 检查项齐全：重复 `id`、无效 frontmatter、`lastIssued` 不一致、审计缺口、悬空 Run 引用（`state.json` 不存在）、同一 Run 多主关联、`repo_path`/`repo_remote` 不匹配、失效 ADR/Pitfall 引用。— check: `node --test skills/requirement-ledger/scripts/test/doctor.test.mjs`
- [ ] AC2: 悬空 Run 引用：人为移走某 Run 的 `state.json` 后被检出并指明。
- [ ] AC3: 纠错中断产生的“一 Run 多主关联”被稳定检出，并提示按纠错意图重试。
- [ ] AC4: `--repair-log` 仅修复可验证的审计缺口；**不修改正文、不改交付 SHA、不删历史关联**。
- [ ] AC5: doctor 只报告、不自动覆盖用户内容（`title`/摘要/aliases/refs 保持原样）。

**Keep as is:** 其余命令行为不变。
**Not in this change:** 不自动“修复”语义冲突，只报告。
