# Requirement Ledger —— Paseo Workloop 持续需求管理 v1 设计（修订版 / 冻结稿）

**文档性质：** 实施设计输入。v1 已按本设计实现，E1–E11 验收测试通过（合入 `fbfcc75`，审查修复 `db5c4a9`）；本文保持冻结，当前行为以 `skills/requirement-ledger/` 及其参考文档为准。
**设计基线：** 本地当前 HEAD `1e549f4`（相对 v3.1.0 `7f82056a` 仅领先 1 个提交，见 §0）。
**前置文档：** 上一版《Paseo Workloop 持续需求管理架构改造指导文档》v1.0（长期参考，不再作为第一阶段实现依据）。
**适用范围：** 第一阶段（Phase 1）最小可行需求台账；不实现 Event Router、Inbox、Subscription、SQLite、常驻服务、多租户、跨主机同步。
**状态：** ✅ **已冻结（v1.0-frozen，2026-11-01）** —— 经 R1–R4 四项工程修正后冻结，可作为实施基线；后续变更须走新的修订记录。

**冻结前的四项工程修正（R1–R4）：**

| 编号 | 修正 | 落点 |
|---|---|---|
| **R1** | `link --correct` 固定"先加新关联、后删旧关联"；中断只留双重主关联（可被 `doctor` 发现、可重试收敛），并记录纠错意图 | §6.4、§8、E10 |
| **R2** | 明确持久性 vs 原子性的 v1 边界：`rename` 原子 ≠ 掉电持久；关键元数据 `fsync(tmp)`+`fsync(dir)`，`doctor` 保守对账、永不调低/复用编号 | §3.3、§3.5 |
| **R3** | `completion` 被清空时，旧 `final_tip` 迁入 `delivery_history[]`（附 `superseded_at`/`reason`），当前回 `pending`，`sync` 幂等 | §3.2、§6.3、E11 |
| **R4** | E9 断言改为"仅检索本项目、不泄露他项目独有需求"，而非简单 `none`（同名需求也可能存在） | §9 / E9 |

---

## 0. 基线核对（本设计以本地 HEAD 为准）

| 项目 | 结论 | 依据 |
|---|---|---|
| v3.1.0 → HEAD | 相差 1 个提交 `1e549f4 "Add guarded validation and apply task-isolation review lessons"`，12 文件 +405/−10 | `git log 7f82056a..HEAD`、`git diff --stat` |
| 是否改动 `state.json` schema | **否**。`workloop.mjs` 的 diff 只加了 `logPath`、`exitCode/signal`、brief 变量，未触碰 `loadState/saveState/state.*` | `git diff 7f82056a..HEAD -- .../workloop.mjs` |
| 结论 | **Workloop 核心状态机在 HEAD 上可视为不动**，需求能力在它旁边新增，不依赖未推送改动 | — |

> 上一版文档中「Requirement Registry / Context Resolver / Workloop Adapter / SQLite / 事件队列」等，仅作为**长期演进参考**保留，不进入 v1 实现。

---

## 1. 范围：做什么 / 不做什么

**要解决的唯一问题：** 同一项目长期演进时，让一条新需求能够**准确关联到过去的业务能力、Spec、ADR、交付 Run 和代码上下文**，避免每次从零重新探索与手工恢复历史。

**v1 明确做：**
- 项目级、文件式的 **Requirement 台账**。
- 一个可被 Main 在需求澄清前调用的**确定性检索能力**（`req lookup`）。
- 一个**引用式**上下文组织能力（`req context`，只给指针、不复制正文）。
- 与现有 Quick / Direct / Full 的**最小接入**（`link` / `sync` / `note`）。
- 可人工纠错的归属元数据与审计（`doctor` / `link --correct`）。

**v1 明确不做（非目标）：**
- 不新增独立 LLM Router Agent、不建无人值守持续监听、不建事件队列 / Inbox / Subscription。
- 不引入 SQLite、数据库服务、常驻 daemon、HTTP 服务、跨主机同步、多租户。
- 不重构 `workloop.mjs` 状态机与核心命令，不改 Matt Pocock 上游 Skills。
- 不复制 ADR / Spec / Review / Retro 正文；不存 CodeGraph 图谱；不维护与 Workloop 竞争的任务状态。
- 不自动推送代码、建 PR、合并或部署。
- 不提供细粒度需求图谱（父子 / supersedes / depends-on）——v1 需求关系拍平。

---

## 2. 领域模型：Requirement 稳定身份与单主 Run 关联

### 2.1 核心对象与权威来源

| 对象 | 职责 | 权威来源 |
|---|---|---|
| **Requirement** | 长期业务需求身份、当前摘要、关联 Run/交付/文档引用 | 本台账（`.requirements/`） |
| **Workloop Run** | 一次具体开发交付执行（`state.json` / `events.jsonl`） | Workloop（唯一权威） |
| **Workloop Task / Attempt** | Run 内的可执行票与尝试 | Workloop（编号 **run 内局部**） |
| Requirement ↔ Run 关联 | 需求与某次执行的关系元数据 | 本台账（只读引用 Workloop 状态） |

**最关键约束：系统只有一个 Coding 编排中心 = 现有 Workloop。** 台账不执行代码、不拥有 Run 状态机、不成为第二个调度器。

### 2.2 Requirement 粒度与 ID

- 一个 Requirement = 一条**可持续演化的业务能力 / 需求主题**（可多次交付），不是单条消息，也不是整个项目。
- ID 格式 `REQ-<n>`：最小 3 位补零（`REQ-001`），可自然增长（`REQ-1000`），**不设 999 上限**。
- **ID 永不复用、永不物理删除**；retire 只改 `status`，保留文件与编号。
- 改标题 / 文件名 / 正文**不改变 ID**；ID 是唯一身份。

### 2.3 基数

- 一个 Requirement **可关联多个 Run**。
- 一个 Run 在 v1 **只允许一个"主"（primary）Requirement**。
- 「单主 Requirement」≠「单业务能力」：若一次修改影响其他业务能力，应在该 Run 的**执行范围 / 验收标准 / 交付记录**中说明，而不是挂第二个主需求。只有确实存在两个独立业务目标时才**优先拆分**为两个需求。

---

## 3. 存储与写入协议

### 3.1 目录布局

```
$WORKLOOP_ROOT/<project>/.requirements/
├── _meta.json                 # 项目级编号分配记录 { project, lastIssued, updated_at }
├── _log.jsonl                 # 审计日志（仅审计，非权威、非跨文件事务）
├── REQ-001-user-login.md
├── REQ-002-checkout.md
└── ...
```

- **位置理由：** Workloop 现有 Run 目录是 `<project>/<feature>/`，而 `--feature` 校验为 `/^[a-z0-9][a-z0-9-]*$/`（**首字符必须字母/数字**，点号非法，`workloop.mjs:1786`），故 `.<name>` 形式的 `.requirements/` **与任何 Run 目录永不冲突**。
- **project key：** 复用 Workloop 现有 `project = slug(basename(repo))`（与 `workloop.mjs:1785` 一致），直接放在 `<project>/` 下。v1 **不新增 Project Registry**，接受"依赖目录名、同名仓库在单机上可能冲突"这一**既有局限**（Workloop 本身已如此）。
- **项目归属核验：** 每个 Requirement 记录 `repo_path`（规范化绝对路径）与 `repo_remote`（**脱敏**：去掉 userinfo / token）。跨路径或跨仓库不一致时**不得静默自动关联**；`new` 拒绝在不匹配的仓库下追加，`doctor` 报告冲突。
- **非 Git 托管：** 台账位于 `~/.workloop`，默认不在 Git 仓库；虽为可读 Markdown，**v1 不宣称具有 Git 版本历史，也不强加 Git 管理**。

### 3.2 Requirement 文件模型（Markdown + YAML frontmatter）

```yaml
---
id: REQ-007                      # 不可变；CLI 分配
title: 用户登录                   # 人可改
status: active                   # active | retired（CLI 改；retired 不再接新 Run，历史保留）
rev: 3                           # CLI 管理的修订号；人工改正文不会自动 +1（见 3.4）
created_at: 2026-11-01T10:00:00+08:00
updated_at: 2026-11-01T10:00:00+08:00
repo_path: /Users/x/project/myapp
repo_remote: github.com/owner/myapp        # 脱敏：无 userinfo/token
aliases: [登录, 认证, sign-in, login]        # 供词法召回
runs:
  - project: myapp
    feature: req-007-login                  # Run 定位用 <project>/<feature>，不用拼接 runKey
    relation: primary
    base_sha: 3f2a...                        # 记录时 Run 的 state.baseSha（只读）
    linked_at: 2026-11-01T10:05:00+08:00
    delivery:
      state: delivered                       # pending | delivered（delivered = 本地 finish 成功）
      final_tip: 9c1b...                      # = state.completion.tip
      delivered_at: 2026-11-02T18:00:00+08:00 # = state.completion.at
      archived_at: 2026-11-02T18:30:00+08:00  # = state.finishedAt（可选）
      evidence_dir: /Users/x/.workloop/myapp/req-007-login/evidence  # 可选；存在性单独校验
    delivery_history: []                    # 旧交付快照；completion 被清空时转入（见 6.3 / R3）
outcomes:                                    # Quick 轻量交付，无 Run
  - date: 2026-11-03T09:00:00+08:00
    summary: 修了登录按钮文案
    commit_sha: 1a2b...                       # 可选，须真实存在
    verification: 手动点击验证
refs:                                        # 只存引用，不存正文
  adr: [0007-session-tokens]
  pitfalls: [auth-cookie-domain]
  spec_hint: /Users/x/.workloop/myapp/req-007-login/spec.md
  codegraph:
    symbols: [AuthService.login]
    paths: [src/auth/]
---
## 摘要
<当前业务需求摘要，人写/改>

## 历史
- 2026-11-02 完成 v1 登录（关联 Run req-007-login）
- 2026-11-03 增加验证码（关联 Run req-007-login-captcha）

## 备注
```

**字段归属规则：**
- **机器字段**（`id` / `status` / `rev` / 时间戳 / `runs` / `delivery` / `outcomes` / `repo_*`）：通过 CLI 修改并校验，**不允许直接手改后不校验**。
- **人字段**（`title` / 摘要正文 / `aliases` / `refs`）：可人工编辑；`doctor` **只校验格式与存在性，不覆盖用户正文**。

### 3.3 ID 分配（永不复用，允许空缺，不允许回退）

- 分配源：项目级 `_meta.json` 的 `lastIssued`。
- 分配流程：`n = max(lastIssued, 现存文件最大编号) + 1` → **先原子持久化新的 `lastIssued=n`** → 再创建 `REQ-<n>-<slug>.md`。
- 允许因中断出现**编号空缺**（跳号），但**禁止回退或复用**已发出的编号。
- **持久性（明确 v1 保证范围，见 R2）：** `temp + rename` 只保证"原子替换"（读者不会看到半截文件），**不等于断电后一定持久**。故关键元数据写入（`_meta.json` 与需求文件）在 `rename` 前对临时文件 `fsync`、`rename` 后再对**目录** `fsync`，以提高持久性。
- **恢复校验：** 启动/`doctor` 时校验 `_meta.json` 完整性；若其损坏或与现存文件矛盾，**只向保守方向修复**——`lastIssued = max(现有文件最大编号, 可读的 lastIssued)`，**永不调低、永不复用**。
- `req doctor` 校验：`lastIssued ≥ 现存最大编号`；每个文件 `id ≤ lastIssued`；无重复 `id`；编号空缺本身不算错误。

### 3.4 修订号 `rev` 与人工修改的诚实边界

- `rev` 表示 **CLI 管理字段的修订版本**；每次经 CLI 成功写入 `+1`。
- 允许人工改标题/摘要等正文，但**不能声称所有手工修改都会自动 +1 或进入 `_log.jsonl`**。
- 为能发现未登记的人工修改：`_log.jsonl` 每条可携带正文/关键字段的内容摘要（如 `body_sha`）；`doctor` 报告"正文与最近一次登记摘要不一致"的**漂移**，但**不自动覆盖用户正文**，只报告并由用户决定是否 `req note` 登记。

### 3.5 写入安全（锁与原子替换）

- **项目级锁** `.requirements/.lock`：独占创建（flag `"wx"` + 写入 pid/时间）。复用 Workloop `withLock` 的**设计思想**，但**不 import 其内部函数**（`withLock` / `writeAtomic` / `recordAll` 均未导出，`workloop.mjs:362/379/393`），在 `req.mjs` 内实现一份等价最小逻辑（约 15 行）。
- **陈旧锁处理：** 依据 pid 存活判定；**无法确认已失效的锁，不贸然接管**，报错让用户处理（避免误抢运行中的写者）。
- **原子替换：** 同目录 temp 文件 + `rename`（读者永远看到完整文件）。
- **持久性 vs 原子性（v1 保证边界）：** `rename` 原子 ≠ 掉电持久。v1 **保证的是崩溃一致性**（进程被杀不产生半截/损坏文件，锁与再唤醒可恢复）；对**掉电级持久**只做**尽力而为**：关键元数据写前 `fsync(tmp)`、`rename` 后 `fsync(dir)`，并以 `doctor` 对账兜底，**不宣称电源故障下的严格事务性**。
- **审计日志非事务：** `_log.jsonl` 仅审计、非权威、**不是跨文件事务日志**。主文件写成功后再 `append` 审计行；若主文件已保存但审计追加失败 → 主文件仍权威，`doctor` 报"审计缺口"，`--repair-log` 补记。**不把两次文件写入当成天然事务。**

### 3.6 `req doctor` 检查清单

1. 重复 `id`；2. 无效 frontmatter；3. 悬空 Run 引用（对应 `<project>/<feature>/state.json` 不存在）；4. 同一 Run 存在多个有效主关联；5. `_meta.json.lastIssued` 与现存文件编号不一致；6. `rev` / `body_sha` 与 `_log.jsonl` 的审计缺口；7. 失效的 `refs.adr` / `refs.pitfalls` 引用（**只报告，不删、不猜替代**）；8. `repo_path` / `repo_remote` 与当前仓库不一致。
   - `--repair-log`：仅对可验证的审计缺口追加恢复记录，**不改正文、不改交付 SHA**。

---

## 4. Requirement Lookup：候选与歧义契约

### 4.1 输入输出

```
req lookup "<自然语言>" [--project <slug>] [--json]
```

- **只在当前项目范围内**检索，**不跨项目回退**。
- 候选生成：对每个 Requirement 的 `title + aliases + 摘要 + refs` 做**确定性的、可复现的**打分：
  - 拉丁文本：空白/非字母数字分词后的**词元重叠**；
  - **中文（无空格分词）：字符片段 / 子串匹配 + 字符二元组（bigram）重叠**作为补充，**不引入复杂中文分词库**；
  - 精确 title/alias 命中加权最高；`score` 由确定性算法给出，**不由模型编造**。
- 返回 top-N（默认 5）。

`--json` 结构：

```json
{
  "query": "把登录加个验证码",
  "project": "myapp",
  "decision": "strong",            // strong | ambiguous | none
  "candidates": [
    {
      "id": "REQ-007",
      "title": "用户登录",
      "status": "active",
      "score": 0.82,
      "matched_terms": ["登录", "验证"],
      "summary_excerpt": "……账号登录与认证……",
      "updated_at": "2026-11-01T…",
      "run_count": 2,
      "last_delivery": "delivered"
    }
  ]
}
```

### 4.2 判定与职责边界

- `decision` 仅为**建议**：`strong` = 最高分过绝对阈值且明显领先次高（如 ≥2×）；`ambiguous` = 多候选接近；`none` = 无过阈值。
- **`strong` 不等于归属已确认** —— Main 仍负责判断；必要时向用户确认。
- **`none` 不证明这是全新需求** —— 只说明当前词法检索没找到足够证据；由 Main 结合对话判断。
- `matched_terms` / `summary_excerpt` / `score` **全部来自实际字段与确定性算法**。
- **`req lookup` 只给证据、绝不自动分配归属，且无副作用**（不写台账；可选记一条 query 审计）。
- 第一版保持**少量明确参数**（绝对阈值、领先倍数、top-N），用测试样例校准，不铺开调参。

---

## 5. Context 引用式召回合同

```
req context <REQ> [--json]
```

**只组织指针、不拼接大段正文。** 召回顺序固定为：

1. Requirement 当前摘要、范围、最近变更（来自本文件）。
2. 关联 Run 的 Spec、Ticket 与验收结果（**路径引用**，Run 目录在归档后仍保留）。
3. 当前有效 ADR 的**引用**（`refs.adr`，读取时校验存在；失效则标 dangling）。
4. 已完成 Run 的最终交付 SHA 与证据（`delivery.final_tip`、`evidence_dir`）。
5. CodeGraph 查询 hint（`symbols`/`paths`），由 Main 决定是否实时调用。
6. 必要时再读 Retro / Pitfalls / 历史 ADR。

### 5.1 必须区分的三种状态（关键）

| 状态 | 判据（只读 `state.json`） | Context 行为 |
|---|---|---|
| **S1 已 finish、未 archive** | `state.completion` 存在、`state.finishedAt` 为空 | `delivery.state = delivered`；**不因 `evidence/index.json` 尚不存在就把交付判为失败或历史失效**；`evidence_dir` 标"待归档" |
| **S2 已归档且证据存在** | `state.finishedAt` 存在且 `evidence/index.json` 存在 | 输出 `archived_at` 与 `evidence_dir` |
| **S3 已归档但证据缺失/不可访问** | `state.finishedAt` 存在但 evidence 缺失 | 明确标 `evidence_available:false`，**报告、不臆造** |

### 5.2 不依赖工作树的约束

归档 / cleanup 后 `tip/` 工作树可能已删除。**Context 不得要求历史 worktree 恒存在**；优先引用保留的 `state.json`、提交 SHA、分支名、Spec 路径与 `evidence/`（`cmdArchive` 保留 run 目录、`state.json`、`events.jsonl`、`evidence/`、`retro`，只删 worktree/branch/session，`workloop.mjs:2759–2805`）。

### 5.3 CodeGraph 边界

台账**只存检索提示**（`symbols`/`paths`），**不缓存、不复制代码图谱**；由 Main 实时调用（如 `codegraph_explore`）。输出附提示：**CodeGraph 索引可能滞后，须以当前工作树代码为准**。ADR 的历史技术决策仍由 Matt Pocock 文档机制负责，不交给 CodeGraph。

---

## 6. 与 Workloop 的接入边界（link / sync / note × Quick / Direct / Full）

### 6.1 零核心改动

- 新增独立 sibling skill：`skills/requirement-ledger/`，含 `scripts/req.mjs`。
- **`workloop.mjs` 的状态机与核心命令一行不改。**
- 对现有文件仅增加**指针**：`skills/paseo-workloop/SKILL.md` 增加 1–2 行"需求检索入口"；`reference/run.md` 视需要加一句。**不改 Matt Pocock 上游 Skills。**

### 6.2 主流程

```
用户提出需求
  → （可选）req lookup "<需求>"           # 候选 + 历史引用
  → Main 判断归属，必要时请用户确认
  → 按原流程选 Quick / Direct / Full
      ├─ Quick：req note --outcome …       # 轻量记录，不造 Run
      └─ Direct/Full：WL init … → req link <project>/<feature> <REQ>   # init 之后，只读 state.json
                      → （finish 后）req sync <project>/<feature>      # 补最终交付
                      → （archive 后）req sync …                       # 补归档/证据，不改最终 SHA
  → 后续 Run 状态一律以 Workloop 为准
```

### 6.3 三条命令的语义

**`req link <project>/<feature> <REQ>`**
- 幂等：同 Run 重复关联同 REQ 不产生重复记录。
- 唯一：同 Run 已有**不同**的有效主 REQ 时拒绝（除非显式纠错，见 6.4）。
- 可恢复：`WL init` 成功但 `link` 失败/中断时，确认原 Run 存在后可重试，**无需重新 init**。
- 只读 `state.json` 抓 `baseSha`（`status --json` 不含 baseSha、task 仅 7 位短 SHA，故**直接读 `state.json`**），记 `delivery.state=pending`。
- **不得把 init 时的 `integration.tip` 当作最终交付 SHA**。

**`req sync <project>/<feature>`**
- 只读 `state.json`（及可选 evidence index），把权威交付结果写回该 Run 的 `delivery`：
  - `delivered` iff `state.completion` 存在；
  - `final_tip = state.completion.tip`；`delivered_at = state.completion.at`；
  - `archived_at = state.finishedAt`（archive 完成时间；注意 `finishedAt` 名不副实，`status --json` 亦把它映射为 `archivedAt`，`workloop.mjs:2899`）；`evidence_dir` 若存在则填。
- 幂等：已记录且 `final_tip` 相同则不重复写；**归档后只补 `archived_at`/证据，不改原有最终 SHA**。
- **非单调 + 快照保留（R3）：** 归档前若 Run 被重新打开（`import/dispatch/send/freeze/review/integrate/retry/cancel` 会清空 `state.completion`，`workloop.mjs:378–380`），`delivered` 必须回落——但**不得丢失已验证的交付快照**：
  - 把旧的 `{final_tip, delivered_at, archived_at?}` 从 `delivery` 迁入 `delivery_history[]`，附 `superseded_at` 与 `reason`（如 `"reopened by integrate"`），并把当前 `delivery.state` 置回 `pending`、清空当前 `final_tip/delivered_at`；
  - `delivery_history` 只追加、不改写；同一旧快照重复 `sync` 不重复入历史（按 `final_tip + superseded_at` 去重，幂等）。
  - 归档后命令被禁（`workloop.mjs:3100`），`completion` 冻结，`delivered` 与最终 SHA 不再变化。
- **工作流要求：`finish` 成功后必须执行 `req sync`（R3 时间窗）**：`sync` 的快照依赖"finish 后已 sync"。若出现 `WL finish → 未 req sync → WL import（清空 completion）`，台账可能根本没有上一次成功交付的快照。v1 **不猜、不伪造**——缺失快照只能由**可验证的 Workloop 证据**（保留的 `state.json`/`events.jsonl`/提交 SHA）恢复；因此把 `req sync` 写成 Main 在 `finish` 后的**固定步骤**（同步写入 SKILL 指针与 `reference/run.md`），并配异常测试（见 E11）。
- **绝不把普通 `integration.tip` 误判为已验收版本**——只有 `completion.tip` 才是交付。

**`req note <REQ> [--outcome]`**
- Quick 轻量 Outcome（日期、摘要、可选真实 `commit_sha`、验证说明）或自由备注；**不生成 Run、不伪造 Run**。
- 对尚未建立需求身份的 Quick 工作，**不为了用 Quick 而强制建台账**；是否长期跟踪由业务决定。

### 6.4 受控的错误关联纠正

- 普通 `link` 遇到"该 Run 已有不同主 REQ"**拒绝**。
- 唯一纠错入口：`req link <project>/<feature> <REQ> --correct --reason "<原因>"`，须通过一致性检查。
- 纠错**保留原归属及修正历史**（写进正确文件 History + `_log.jsonl`）；即使对**已交付** Run 的**元数据**关联也允许经明确确认的审计纠错，但**不得改动 Workloop 的执行事实、验收结果或交付 SHA**。
- **写入顺序（R1）**：两个 Markdown 文件无法原子更新，因此固定为 **先写新关联（把 Run 加入 REQ-B）→ 再移除旧关联（从 REQ-A 移除）**。若中断，最坏留下"同一 Run 同时挂在 REQ-A 与 REQ-B"的**双重主关联**——这正是 `doctor` 检查项 4 能稳定发现的状态，且**不会**出现"两处都没有"的丢失态。
- **纠错意图可重试**：纠错开始时在 `_log.jsonl` 记一条 `{op:"correct", run, from:REQ-A, to:REQ-B, reason}` 的意图记录；重试时据此确定目标归属并收敛到唯一主关联（幂等：新关联已在则跳过，旧关联已无则跳过）。
- 上述仅纠**元数据**关联；**不改动 Workloop 的执行事实、验收结果或交付 SHA**。

---

### 6.5 双重主关联 = 模糊态：读取操作必须拒绝（不得任选其一）

`link --correct` 的"先加后删"在中断时可能留下"同一 Run 同时是 REQ-A 与 REQ-B 的主关联"。除 `doctor` 检出外，**所有依赖"唯一归属"的读取/写入操作必须拒绝该模糊态**，而**不是随便挑一个结果**：

- `req context`、`req sync`、`req link`（普通或纠错）在该 Run 处于双重主关联时 → **拒绝执行**，并提示"检测到未完成的 `link --correct`，先用 `--correct` 收敛或按意图重试"。
- 仅只读展示类（`req show` / `req list` / `req doctor` / `req lookup`）可继续，但**必须显式标注**该 Run `ambiguous: true`，不据其归属做任何自动判断。
- 恢复路径唯一：按 `_log.jsonl` 中记录的纠错意图（`{from,to,reason}`）收敛到唯一主关联；`doctor` 一致后解除模糊态。

---

## 7. CLI 参考（最小集，10 个）

| 命令 | 作用 | 关键约束 |
|---|---|---|
| `req new <title> [--alias …]` | 建需求，分配 `REQ-<n>` | 先持久化 `lastIssued` 再落文件；校验 repo 归属 |
| `req list` | 列本项目管理需求 | 仅当前 project |
| `req show <REQ>` | 展示需求全文/字段 | 只读 |
| `req lookup "<text>" [--json]` | 检索候选 | 无副作用，Main 裁决 |
| `req context <REQ> [--json]` | 组织引用式上下文 | 只给指针，不拼正文 |
| `req link <project>/<feature> <REQ> [--correct --reason]` | 建立/纠正主关联 | 幂等、唯一；纠错需 reason |
| `req sync <project>/<feature>` | 从 Workloop 权威状态同步交付 | 只读 `state.json`；不改历史 SHA |
| `req note <REQ> [--outcome …]` | Quick Outcome / 备注 | 不产生 Run |
| `req retire <REQ>` | 置 retired | 保留文件与编号，不复用 |
| `req doctor [--repair-log]` | 一致性检查/补审计 | 只报告，不自动改正文/交付 |

**Run 定位统一用 `<project>/<feature>`**（同 Workloop `--run`），**不解析拼接的 `runKey`**（`${project}-${feature}` 无法无歧义拆分）。

---

## 8. 并发、错误恢复与一致性

| 场景 | 策略 |
|---|---|
| 主文件已写、审计 append 失败 | 主文件权威；`doctor` 报审计缺口；`--repair-log` 补记 |
| `link` 中途失败（init 已完成） | 确认 Run 存在后重试 `link`，不重新 init |
| 纠错两文件更新中断 | 固定"先加新、后删旧"顺序；中断只留**双重主关联**（不丢），`doctor` 据此发现，按意图重试幂等收敛 |
| 双重主关联（纠错未完成） | `context/sync/link` **拒绝执行并提示恢复**；`show/list` 标 `ambiguous`；按 `_log` 纠错意图收敛后再解除 |
| `finish` 后漏了 `req sync` | **不伪造**历史快照；只能由可验证 Workloop 证据恢复；工作流上 `req sync` 为 `finish` 后固定步骤 |
| 编号已持久化但文件未落 | 允许编号空缺；下次分配取 `max(lastIssued, 现存最大)+1`，不回退 |
| 陈旧锁 | pid 存活判定；不能确认失效则拒绝接管 |
| Run 已归档 | 只读保留的 `state.json`/证据；不要求 worktree 存在 |
| 跨仓库路径不一致 | 拒绝静默关联；`doctor` 报告 |

---

## 9. 验收矩阵（v1 最小集，E1–E11）

| 编号 | 场景 | 预期 |
|---|---|---|
| **E1** | 建 REQ-001 → Direct Run → `link`（`delivery=pending`，记 `base_sha`）→ finish/archive 后 `sync` 补 `final_tip` | `show` 显示 `delivered`、`final_tip`、`delivered_at`、`archived_at` |
| **E2** | 换措辞/同义词/中文片段查询命中 REQ-001（alias/字符匹配生效） | 返回 REQ-001；**不因命中自动建新需求** |
| **E3** | 歧义查询 ≥2 候选 | `decision=ambiguous`，需人工确认，无自动归属 |
| **E4** | 同 Run 重复 `link` 同 REQ | 幂等，单条记录 |
| **E5** | 同 Run 普通 `link` 第二个主 REQ | 拒绝 |
| **E6** | Quick 改动 → `note --outcome`（含真实 commit SHA） | 记录 Outcome，**不产生 Run** |
| **E7** | 移走某 Run 的 `state.json`；造重复 ID；造 rev 缺日志 | `doctor` 分别报悬空 / 重复 ID / 审计缺口；`--repair-log` 可补缺口（不含前两者） |
| **E8** | 归档后 | `show`/`context` 仍定位 evidence；`sync` 可读保留的 `state.json` |
| **E9** | 用**另一项目独有**的需求词查询；并构造两项目存在**同名**需求的情形 | 只检索本项目数据，**不返回、不泄露其他项目独有的 Requirement**；同名需求也只命中本项目那条（断言的是"项目作用域 + 无泄露"，**不是**简单返回 `none`） |
| **E10** | Run 错连 REQ-A；普通 `link` REQ-B 被拒；`--correct --reason` 后；并模拟纠错中断成双重主关联 | 先加 REQ-B、后删 REQ-A；中断留双重关联并被 `doctor` 发现；此态下 `context/sync/link` **拒绝执行并提示恢复**（不任选其一），`show/list` 标注 `ambiguous`；按意图重试收敛为唯一；可审计、幂等、满足唯一主约束 |
| **E11** | finish 成功但未 archive；随后 archive 再 `sync`；另造 (a) 归档前 import 清空 completion、(b) `finish → 未 sync → import 清空` | 首次 `sync` 认定 `delivered`、不要求 evidence index 先存在；归档后再 `sync` 仅补归档/证据、不改 SHA；(a) 旧 `final_tip` 迁入 `delivery_history`、当前回 `pending`、重复 sync 幂等；(b) 台账无快照时**不伪造**，只能由可验证 Workloop 证据恢复，且不破坏后续 |

---

## 10. 演进条件（三个**独立**触发，不捆绑迁移）

| 条件 | 触发判据（可观测） | 仅升级该模块 |
|---|---|---|
| **A：真实异步事件接入** | 需要在无人打开 Paseo 会话下持续接收 GitHub / IM 等外部事件，且人工分诊已无法满足 | 增加 Source Adapter、Event Inbox、Subscription；**是否需独立 Router LLM 取决于新事件能否用确定性规则归属** |
| **B：Lookup 效果不满足** | 用**固定真实查询样例**持续评估，显示词法召回经常漏检 | 先改检索方式（项目内全文索引 / 候选排序 / 语义检索），**不等于需要 Event Router 或 daemon** |
| **C：文件存储的一致性/并发不足** | 出现真实的多写者、跨进程事务、复杂并发更新或文件锁不可靠 | 再考虑 SQLite；**不意味着同时引入监听服务或 Router Agent** |

> 评测以**候选召回率、错误关联率、人工确认次数**为准，**不以"需求数超过 N 条"作为升级依据**。

---

## 11. 与上一版提案的主要收敛（Delta）

| 上一版 | 本修订版 v1 |
|---|---|
| 独立 LLM Router + Event Router + Inbox + Subscription | 仅 `req lookup` 可调用能力；Router/监听推迟到条件 A |
| SQLite + 8 张表 + 常驻服务 | 文件式 `.requirements/`（Markdown + `_meta.json` + `_log.jsonl`）；SQLite 仅条件 C |
| Context Resolver 复制/拼接历史 | `req context` 只给指针，正文由 Main 现读、CodeGraph 现查 |
| Registry 可能成为第二编排中心 | 明确单一编排中心 = Workloop；台账只存只读投影 |
| 18 条含 webhook/离线/多主机 R 集 | E1–E11 单机闭环验收；外部事件场景移入演进条件 A |
| Workloop Adapter 5 接口 HTTP 化 | 零核心改动；`link`/`sync`/`note` 三条命令 + 只读 `state.json` |

---

## 12. 附录：与本地 HEAD 对齐的代码事实（行号 = `skills/paseo-workloop/scripts/workloop.mjs`）

- `--feature` 校验 `/^[a-z0-9][a-z0-9-]*$/`（首字符字母/数字）：`:1786`。
- `project = slug(basename(repo))`；Run 目录 `join(workloopRoot(), project, feature)`：`:1785–1790`。
- `workloopRoot()` / `resolveRunDir()` **未导出**：`:345`、`:348–353` → 外部脚本按 `WORKLOOP_ROOT||~/.workloop` + `project/feature` 自行拼并校验 `state.json`。
- `finish` 写 `s.completion ||= {at, tip}`：`:2668`。
- `archive` 写 `s.finishedAt = now()`：`:2800`；`status --json` 映射 `archivedAt ← finishedAt`：`:2899`；`finishedAt` 后绝大多数命令被拒：`:3100`。
- `state.completion` 被 `import/config/decisions/worktree/prepare/dispatch/send/freeze/review/integrate/retry/cancel` 清空（`CLEARS_COMPLETION`）：`:378–380`。
- `evidence` 结构 `{completion, capturedAt, path}`：`:2735`；`archive` 要求 `s.evidence.completion === s.completion.at`：`:2531`。
- `archive` 保留 run 目录/`state.json`/`events.jsonl`/`evidence/`/`retro`，只删 worktree/branch/session：`:2759–2805`（`:2803` 明示 evidence/retro 保留）。
- `withLock` / `writeAtomic` / `recordAll` **未导出**：`:362/379/393` → 台账自建等价最小逻辑，不 import。
- `status --json` **不含 `baseSha`**，task 仅 7 位短 `candidate`、无 `mergeSha`：`:2899`、`:2893` → `link`/`sync` **直接读 `state.json`**（含完整 `baseSha`、`t.mergeSha`）。
- `runKey = ${project}-${feature}`：`:1849` → 因 project/feature 均含短横，**定位用 `<project>/<feature>`**。
- `evidence/index.json = {capturedAt, completion, format, agents[]}`：`:2733`。

---

## 13. 实施阶段待拆票（本文件不实现）

- `skills/requirement-ledger/SKILL.md` + `reference/{domain,storage,lookup,context,authorization}.md`。
- `skills/requirement-ledger/scripts/req.mjs`（`new/list/show/lookup/context/link/sync/note/retire/doctor`）。
- 最小锁 + 原子写 + `_meta.json` 编号分配 + `_log.jsonl` 审计。
- 中文/拉丁混合打分器 + 可配置阈值与样例校准。
- E1–E11 测试（真实临时 git 仓库 + 假 Paseo 风格，沿用现有 `fake-paseo` 习惯）。
- `skills/paseo-workloop/SKILL.md` 增加检索入口指针；`skills/README.md` 登记新本地模块。

> 设计已冻结；以上留待实施阶段单独拆票，不在本轮实现。
