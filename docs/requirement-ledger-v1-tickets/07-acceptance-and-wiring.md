# 07 E1–E11 验收与接线

**Blocked by:** 03, 04, 05, 06
**Scope:** skills/requirement-ledger/,skills/paseo-workloop/SKILL.md,skills/paseo-workloop/reference/run.md,package.json
**Maps to:** E1–E11（全部）

**Goal：** 用真实临时 git 仓库 + 假 state 风格，跑通冻结稿 §9 的 E1–E11；并把检索入口接进 Workloop 说明（仅指针）。

## Acceptance criteria
- [ ] AC1: E1–E11 各自有独立端到端断言并通过 — check: `node --test skills/requirement-ledger/scripts/test/acceptance.test.mjs`
  - E1 建档→Direct 模拟→link(pending)→sync(delivered)；E2 换词/中文/别名命中且不新建；E3 歧义；E4 link 幂等；E5 第二主 REQ 拒绝；E6 Quick outcome 无 Run；E7 医生三类问题；E8 归档后仍可取证据；**E9 仅本项目、不泄露他项目独有需求（含同名需求）**；E10 纠错先加后删+可重试+**双重关联时 context/sync/link 拒绝**；E11 finish 未 archive 交付、归档后 sync 不改 SHA、completion 清空转 history、**finish 后漏 sync→import 清空不伪造、仅证据恢复**。
- [ ] AC2: `skills/paseo-workloop/SKILL.md` 增加简短“需求检索入口”指针（引用 `requirement-ledger`），`reference/run.md` 视需要加一句；**不改上游 Skills**。
- [ ] AC3: `package.json` 的 `test` 脚本纳入新测试文件；`npm test` 全绿，**原有 `workloop.test.mjs` / `validate` / `tidy-docs` 不受影响** — check: `npm test`
- [ ] AC4: `node skills/tools/link-check.mjs` 通过。
- [ ] AC5: 明确“服务端 / 事件 / SQLite”不在本次范围，若需另开演进票（条件 A/B/C）。

**Keep as is:** Workloop 全部既有测试与行为；Quick/Direct/Full 流程不变。
**Not in this change:** 不实现 Event Router / Inbox / Subscription / SQLite / 多租户 / 跨主机。
