# Requirement Ledger v1 —— 开发 Ticket 索引

**规格（spec）：** [`../requirement-ledger-v1-design.md`](../requirement-ledger-v1-design.md)（v1.0-frozen）
**格式：** 本目录每个 `NN-slug.md` 为一张 ticket，采用本仓 `to-tickets` 本地文件格式（`Blocked by` / `Scope` / 编号 AC / `Keep as is` / `Not in this change`），可直接：
- 复制进某次 run 的 `issues/`；或
- `WL init --tickets docs/requirement-ledger-v1-tickets` / `WL import`。

## 依赖图（先做 T1，再做 T2；T3/T4 可并行；T5 依赖 T2；T6 依赖 T2+T5；T7 收口）

```
T1 scaffold
 └─ T2 store & ids
      ├─ T3 lookup ──┐
      ├─ T4 context ─┤
      └─ T5 link/sync/note ── T6 doctor ── T7 acceptance+wiring
```

| Ticket | 标题 | Blocked by | 主要覆盖 |
|---|---|---|---|
| 01 | Skill 骨架与参考文档 | None | 目录/登记 |
| 02 | 台账存储、编号分配、锁与审计 | 01 | E1/E7 部分 |
| 03 | Lookup 检索与歧义 | 02 | E2/E3 |
| 04 | Context 引用式召回 | 02 | E8 |
| 05 | Workloop 接入 link/sync/note | 02 | E1/E4/E5/E6/E10/E11 |
| 06 | Doctor 全量一致性 | 02,05 | E7/E10 |
| 07 | E1–E11 验收与接线 | 03,04,05,06 | 全部 E |

## 实施顺序（按用户确认的 5 个工作包；与上面 Ticket 一一对应）

| 顺序 | 工作包 | 对应 Ticket | 主要验收（E#） |
|---|---|---|---|
| 1 | Requirement 文件模型、ID、锁与审计 | T1 + T2（含 `doctor` 基础检查） | `new/list/show/retire/doctor`；E1 部分、E7 部分 |
| 2 | 中文及英文词法检索 | T3 | `lookup`；E2/E3/E9 |
| 3 | Run 关联与交付状态同步 | T5（`link/sync`；`doctor` 跨文件检查并入 T6） | E1/E4/E5/E10/E11 |
| 4 | 上下文引用与 Quick Outcome | T4 + T5 的 `note` | `context/note`；E6/E8 |
| 5 | Skill 接入、异常恢复、回归测试 | T6 + T7 | E1–E11 全通过；原 Workloop 无回归 |

> **两条实施必验边界（已写入文档 §6.3/§6.5/§8 与 E10/E11）：**
> 1. **双重主关联（纠错中断）**：`req context/sync/link` 必须**拒绝**并提示恢复 `link --correct`，不得任选其一；`show/list/doctor` 可读但标 `ambiguous`。
> 2. **`delivery_history` 时间窗**：`finish → 未 sync → import 清空 completion` 时台账可能无快照；v1 **不伪造**，只由可验证 Workloop 证据恢复，并把 `req sync` 定为 `finish` 后固定步骤。

## 全局约束（每张 ticket 都适用）
- **不修改** `skills/paseo-workloop/scripts/workloop.mjs` 的状态机与核心命令。
- **不改** Matt Pocock 上游 Skills（`node tools/upstream-sync.mjs <clone> --check` 仍通过）。
- **不引入** SQLite / daemon / HTTP / Event Router / Subscription。
- 台账位于 `$WORKLOOP_ROOT/<project>/.requirements/`，非 Git 仓库；`workloop.mjs` 只被**只读**读取 `state.json`。
- 测试沿用本仓习惯：真实临时 git 仓库 + 假 state / fake-paseo 风格，可重复断言。
