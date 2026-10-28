# paseo-matt-workloop

[English](README.md) · **简体中文**

将开发需求推进为本地集成分支上经过审查的代码。Matt Pocock skills 提供工作方法，Paseo 运行执行者和审查者。

查看版本变更和升级说明时，参阅 [更新日志](CHANGELOG.zh-CN.md)。

## 1. 技能清单

以 **`paseo-workloop`** 为编排入口，也可单独使用配套技能。整套收录 17 个上游技能来源，并提供本地 `paseo-workloop`、`codegraph` 和只输出建议的 `retro` 入口。

| 技能 | 用途 |
| --- | --- |
| [retro](skills/retro/SKILL.md) | 复盘重复问题并建议落地方式，由用户决定是否实施。 |
| [writing-for-agents](skills/writing-for-agents/SKILL.md) | 编写清晰、按需读取的 Agent 指令和参考资料。 |
| [paseo-workloop](skills/paseo-workloop/SKILL.md) | 通过 Paseo 协调任务、独立 worktree、独立审查、返工与串行集成。 |
| [grill-me](skills/grill-me/SKILL.md) | 与用户澄清需求目标、边界和设计选择。 |
| [grill-with-docs](skills/grill-with-docs/SKILL.md) | 在澄清需求时记录领域术语和架构决策。 |
| [grilling](skills/grilling/SKILL.md) | 按决策依赖分轮追问，在前提明确后提出后续问题。 |
| [domain-modeling](skills/domain-modeling/SKILL.md) | 统一领域术语，通过词汇表和 ADR 记录共识与决策。 |
| [to-spec](skills/to-spec/SKILL.md) | 将已达成共识的讨论整理为包含实现和测试决策的规格。 |
| [to-tickets](skills/to-tickets/SKILL.md) | 将规格拆成纵向任务，明确阻塞依赖。 |
| [implement](skills/implement/SKILL.md) | 按项目约定实现并验证规格或任务。 |
| [tdd](skills/tdd/SKILL.md) | 通过 red → green → refactor 开发，测试可观察行为。 |
| [code-review](skills/code-review/SKILL.md) | 从固定基线审查变更，核对项目规范和原始需求。 |
| [diagnosing-bugs](skills/diagnosing-bugs/SKILL.md) | 先复现、测量故障或性能回退，再选择修复方案。 |
| [codegraph](skills/codegraph/SKILL.md) | 在已有索引的仓库中导航符号、调用链和变更影响范围。 |
| [codebase-design](skills/codebase-design/SKILL.md) | 设计模块边界，用简洁接口封装复杂性。 |
| [improve-codebase-architecture](skills/improve-codebase-architecture/SKILL.md) | 寻找架构改进机会，通过 HTML 报告选择并讨论方案。 |
| [handoff](skills/handoff/SKILL.md) | 整理包含目标、决定、证据和未完成工作的交接文档。 |
| [wait-what](skills/wait-what/SKILL.md) | 请 Agent 重新解释上一条消息。 |
| [setup-matt-pocock-skills](skills/setup-matt-pocock-skills/SKILL.md) | 为单独使用上游工程技能配置任务跟踪和领域文档。 |

## 2. 工作流程

![Quick、Direct、Full 路线，以及合入、验收、复盘判断和集中归档](docs/assets/workloop.svg)

[可编辑的 Excalidraw 源文件](docs/assets/workloop.excalidraw) — 下载后可在 Excalidraw 中打开。

按任务需要选择流程。已有授权继续有效，澄清实质性问题，不在每个阶段重复确认。

| 路线 | 适用情况 | 执行方式 |
| --- | --- | --- |
| **Quick** | 目标明确、改动局部可逆、验证直接。 | 当前会话执行、验证、交付，无需开票或 Paseo daemon。 |
| **Direct** | 范围明确，值得委派执行并独立审查。 | 一张有范围的 ticket；合入后可追加 repair ticket。 |
| **Full** | 存在设计取舍、任务依赖或并行协作需要。 | spec、带依赖的 tickets，以及整体复核。 |

Direct 和 Full 使用以下生命周期：

| 阶段 | 结果 |
| --- | --- |
| **执行与审查** | 执行者提交改动与证据；独立 reviewer 只按该 ticket 已确认的编号验收标准（`AC1`、`AC2` 等）或四类底线问题（`Regression`、`Data loss`、`Security`、`ADR`）审查冻结候选。其余意见作为建议交给用户，不阻塞。返修继续使用原执行者会话和 worktree。 |
| **合入** | 合入已审查的候选，然后依次运行检查、该 ticket 的验收命令，以及所有已合入 ticket 的验收命令组成的回归集。解除后续任务依赖，保留子代理会话与工作区。合入冲突、检查或验收命令失败时交回原执行者。 |
| **验收完成** | 重跑检查和整个回归集。Full 还需要独立终审 reviewer 对当前集成提交给出通过结论，或一份阻塞性发现已全部豁免的 `changes_requested`；编排者的 `final-review.md` 只记录验收对应关系，不再给出结论。`finish` 列出所有豁免的发现供用户复核。会话保留供复盘。 |
| **Retro** | 以整个 run 为单位，检查重复三方故障、业务坑、错误行为与重复摸索。输出发现和落地建议，或记录简短的无需复盘理由。建议不自动实施。 |
| **集中归档** | 保存 CLI 活动记录和 Agent/attempt 索引，再统一归档会话。已合入的工作区清理；取消或替换 attempt 中未合入、未提交的工作保留。用户是否采纳建议不阻塞归档。 |

`integrate` 和 `finish` 在后台的检查阶段运行检查和验收命令，不持有 run 锁，因此运行期间 `status`、`watch` 仍可用。每条命令都有时限：默认 30 分钟，最长 1440 分钟，可用 `init` 或 `config` 的 `--check-timeout` 调整。超时的命令会连同它启动的进程一起停止——在 POSIX 上是进程组，在 Windows 上是进程树；在 POSIX 上主动脱离该组的进程不在停止范围内；停止失败或无法确认时，检查阶段会保留下来等待恢复。验收命令在之后每次合入和 `finish` 时都会重跑，因此必须可重复执行。

ticket 的验收标准在用户确认后冻结；之后如需变更，用 `criteria <NN> --reason "<the user's decision>"` 记录，`finish` 会列出每次变更。复审只确认上一轮的每条边界内阻塞性发现、重跑验收命令，并检查上一候选以来改动中的底线问题，不再提出其他发现。返修默认上限为两轮（`--max-rework-rounds`），超过所配置的上限需要用户同意，并用 `send --extra-round --reason` 记录。run 放过的每条发现都会连同理由记录在案——返修时豁免、`integrate --override` 放行，或终审后豁免——`status` 显示其数量。

可恢复错误继续原会话。会话丢失时，`retry` 默认替换执行者并复用工作区；确需新建工作区时显式使用 `--new-worktree`。**合入后**发现缺陷，使用新的 repair ticket、会话和工作区，从最新集成提交开始修复。

可以在执行中或归档后主动调用 `retro`。中途复盘不停止执行，也不替代 `finish` 后的收尾判断。Agent 文档使用 `writing-for-agents` 编写；`tidy-docs` 负责分类和存放。

票据流程交付本地 `workloop/<feature>` 分支。是否发布、创建 PR 或合入主分支，由用户决定。

## 3. 安装

在 Paseo 运行 Agent 的机器上准备 **Node.js 20+、npm 和 Git**。连接远程 Paseo host 时，在该 host 安装。

按 Agent 读取技能的位置选择目录。以下命令适用于 macOS/Linux shell 和 Windows PowerShell。

### Claude 类

适用于 Claude Code，以及读取 `~/.claude/skills` 的兼容 Agent：

```sh
# 安装
npx --yes github:suntianc/paseo-matt-workloop#main install --target "$HOME/.claude/skills"

# 更新同一目录
npx --yes github:suntianc/paseo-matt-workloop#main update --target "$HOME/.claude/skills"
```

### 通用 Agent 类

适用于读取默认目录 `~/.agents/skills` 的 Agent：

```sh
# 安装
npx --yes github:suntianc/paseo-matt-workloop#main install

# 更新
npx --yes github:suntianc/paseo-matt-workloop#main update
```

使用其他技能目录时，在两个命令后都加上 `--target "实际技能目录"`。保持整套技能相邻存放，workloop 通过相对路径读取配套技能和资源。

命令成功后，重启或刷新 Agent 的技能列表；能发现 `paseo-workloop` 即完成安装。安装文件独立于 npx 缓存；`update` 每次拉取 GitHub 最新 `main` 并打印来源 commit。

**安装或更新提示冲突时**，先备份所列的本地内容，再恢复托管副本或换一个空目录安装。安装器通过 `.paseo-matt-workloop.json` 记录归属，保留其他技能。添加 `--dry-run` 可在写入前检查目标目录；其他参数见 `--help`。

## 4. 运行条件与使用说明

### 准备运行环境

启动 Direct 或 Full run 前，确认以下条件（Quick 不需要 Paseo）：

| 条件 | 就绪标准 |
| --- | --- |
| **Paseo daemon** | `paseo agent ls -g --json` 能从预期 host 返回 JSON。 |
| **Agent 会话** | 编排者位于 Paseo 会话中，具有 `PASEO_AGENT_ID`、agent-scoped `create_agent` 和 `send_agent_prompt` 工具，以及 heartbeat 支持。 |
| **角色配置** | `wl-executor`、`wl-reviewer` 或显式指定的替代配置，能解析为用户选择的 provider、model 和 mode；在 Paseo 中配置。 |
| **项目基线** | 目标是 Git 仓库，本次 run 选定的检查在基线上已经通过。 |

遇到版本差异或前置条件不满足时，先查阅 [Paseo 兼容说明](skills/paseo-workloop/reference/paseo-compat.md)，再启动 worker。其他技能可以独立于这套编排环境使用；`codegraph` 适用于项目已有索引的情况。

### 开始一次 run

在 Paseo 中打开项目，使用已加载这套技能的 Agent，说明目标和验收要求：

```text
请使用 paseo-workloop，为这个项目增加 CSV 导出。
启动 run 前，先和我确认范围及验收检查。
```

**编排 run 时**，读取并遵循 [paseo-workloop](skills/paseo-workloop/SKILL.md)。其中选择执行路线，并链接相应的执行、恢复和归档步骤。Workloop 在运行目录中维护自己的任务跟踪，可直接使用配套技能启动。

规格、任务、briefs、报告、复盘结果、活动记录和状态默认保存在 `~/.workloop/<project>/<feature>/`，可通过 `WORKLOOP_ROOT` 调整根目录。更新脚本前，先结束使用旧脚本的活动 run。

按当前情况查阅对应说明：

- **worker 仍在运行、编排者即将暂停时：** 按 [异步监督](skills/paseo-workloop/reference/async-supervision.md) 配置通知和兜底 heartbeat。
- **会话或操作中断后：** 按 [恢复说明](skills/paseo-workloop/reference/recovery.md) 核对当前状态，再执行下一步。
- **需要整理项目文档时：** 按 [tidy-docs](skills/paseo-workloop/reference/tidy-docs.md) 完成本机注册和文档工作流。
- **维护或同步这套技能时：** 按 [技能集指南](skills/README.md) 操作；检查命令以 [package.json](package.json) 为准。

## 5. 致谢

- **[Matt Pocock / skills](https://github.com/mattpocock/skills)**：为这套工作流提供上游工程与效率技能。上游来源保持原样，适配集中在本地技能和角色 briefs 中。本地 retro 入口将上游原文保留在 `retro/reference/upstream.md` 作为参考。
- **[Paseo](https://github.com/getpaseo/paseo)**：提供独立编程 Agent、工作区与完成通知的编排基础。

本地代码采用 [MIT License](LICENSE)。上游声明保留在 [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES)，来源版本与流程图归属记录见 [NOTICE.md](NOTICE.md)。
