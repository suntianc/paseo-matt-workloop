# 05 Workloop 接入：link / sync / note

**Blocked by:** 02
**Scope:** skills/requirement-ledger/scripts/
**Maps to:** E1、E4、E5、E6、E10、E11、R1、R3

**Goal：** 实现 `req link` / `req sync` / `req note`，**只读** `state.json`，不写 Workloop 状态；覆盖纠错与交付/归档语义。

## Acceptance criteria
- [ ] AC1: `link <project>/<feature> <REQ>` 只读定位并读取 `state.json` 的 `baseSha`（不依赖 `status --json`），记 `delivery.state=pending`；同 Run 重复关联同 REQ **幂等**；不同主 REQ **拒绝**。— check: `node --test skills/requirement-ledger/scripts/test/integration.test.mjs`
- [ ] AC2: `link --correct --reason` 固定“**先加新关联、后删旧关联**”；中断只留**双重主关联**可被 doctor 发现；`_log.jsonl` 记纠错意图；重试按意图收敛、幂等（R1）。
- [ ] AC3: `sync` 中 `delivered` iff `state.completion` 存在；`final_tip=state.completion.tip`、`delivered_at=state.completion.at`、`archived_at=state.finishedAt`；**从不把 `integration.tip` 当交付 SHA**。
- [ ] AC4: `completion` 被清空（import/config/…）时，旧快照迁入 `delivery_history[]`（附 `superseded_at`/`reason`），当前回 `pending`；重复 `sync` 幂等不乱写（R3）。
- [ ] AC5: `note --outcome` 记录 Quick 结果（日期/摘要/可选真实 commit SHA/验证），**不产生 Run**；未建档的 Quick 不强建台账。
- [ ] AC6: 归档后 `sync` 仅补 `archived_at`/证据，不改最终 SHA。
- [ ] AC7: 同一 Run 处于**双重主关联**时，`sync`/`link` **拒绝执行并提示恢复 `link --correct`**，不任选其一（`show/list/doctor` 可继续但标注 `ambiguous`）。
- [ ] AC8: 明确 **`finish` 成功后执行 `req sync` 为固定工作流步骤**；配异常测试 `finish → 未 sync → import 清空 completion`：台账无快照时**不伪造**，只能由可验证 `state.json`/`events.jsonl`/提交 SHA 恢复。

**Keep as is:** Workloop 的 `state.json`/`events.jsonl` 一字不改；Run 状态仍以 Workloop 为准。
**Not in this change:** 不自动 push/PR/merge；不重建 todo/任务状态。
