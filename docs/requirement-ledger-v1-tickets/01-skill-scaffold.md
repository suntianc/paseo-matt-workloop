# 01 Skill 骨架与参考文档

**Blocked by:** None
**Scope:** skills/requirement-ledger/,skills/README.md,test/install.test.mjs,skills/tools/upstream.json
**Maps to:** 基础设施（无直接 E）

**Goal：** 建立 sibling skill 骨架与文档，声明边界；不改动 Workloop 核心。

## Acceptance criteria
- [ ] AC1: `skills/requirement-ledger/SKILL.md` 存在，含 `name: requirement-ledger`、`description`，并相对链接到 `reference/{domain,storage,lookup,context,authorization}.md` — check: `node skills/tools/link-check.mjs`
- [ ] AC2: `reference/` 下五个文档齐全，内容与冻结稿 §2–§6 一致（领域/存储/lookup/context/授权边界）。
- [ ] AC3: `skills/README.md` 在“Local skills”登记 `requirement-ledger` 及其职责；未把它列为 upstream。
- [ ] AC4: `SKILL.md` 明确“Main 在澄清前调用 `req lookup`；台账不执行代码、不拥有 Run 状态机”。
- [ ] AC5: 新增 skill 目录后仓库自身的登记处同步：`test/install.test.mjs` 的期望技能数与实际 `skills/*/SKILL.md` 数量一致，`skills/tools/upstream.json` 的 `local` 列表含 `requirement-ledger` — check: `npm test`

**Keep as is:** 现有本地/上游 skill 的组织方式、`paseo-workloop` 行为不变。
**Not in this change:** 不写 `req.mjs` 业务逻辑（在 T2 起）；不改 `workloop.mjs`。
