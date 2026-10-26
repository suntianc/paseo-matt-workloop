# paseo-matt-workloop

[English](README.md) · **简体中文**

基于 Matt Pocock skills 和 Paseo 的开发工作流：从需求澄清到独立审查、代码集成，让每个任务都有明确范围、验证依据和交付记录。

## 1. 技能清单与描述

整套包含 **17 个技能**：15 个来自 [mattpocock/skills](https://github.com/mattpocock/skills)，`paseo-workloop` 和 `codegraph` 为本地技能。以 `paseo-workloop` 为入口，其余技能提供各阶段的方法与约定，也可以按需单独使用。

| 技能 | 描述 |
| --- | --- |
| [paseo-workloop](skills/paseo-workloop/SKILL.md) | 工作流入口。协调 Paseo 执行者和审查者，管理任务依赖、独立 worktree、审查、返工与串行集成。 |
| [grill-me](skills/grill-me/SKILL.md) | 通过追问澄清需求、边界和设计选择，建立双方共识。 |
| [grill-with-docs](skills/grill-with-docs/SKILL.md) | 在需求追问过程中梳理领域术语与架构决策；workloop 将决定先记录到 spec 或 ticket。 |
| [grilling](skills/grilling/SKILL.md) | 追问的底层方法：按决策依赖分轮提问，逐步解决尚未确定的问题。 |
| [domain-modeling](skills/domain-modeling/SKILL.md) | 统一领域术语，维护词汇表和架构决策记录（ADR）。 |
| [to-spec](skills/to-spec/SKILL.md) | 将已有讨论整理成可执行规格，明确方案、实现决策与测试约定。 |
| [to-tickets](skills/to-tickets/SKILL.md) | 将规格拆成可验证的纵向任务，标明任务间的阻塞依赖。 |
| [implement](skills/implement/SKILL.md) | 根据规格或任务实施改动，遵循项目约定并验证结果。 |
| [tdd](skills/tdd/SKILL.md) | 通过 red → green → refactor 推进测试驱动开发，优先验证可观察行为。 |
| [code-review](skills/code-review/SKILL.md) | 从固定提交或分支基线审查变更，分别核对项目规范和需求规格。 |
| [diagnosing-bugs](skills/diagnosing-bugs/SKILL.md) | 诊断难复现问题与性能回退，用复现、测量和证据定位原因。 |
| [codegraph](skills/codegraph/SKILL.md) | 在已建立索引的仓库中导航符号、调用链和变更影响范围。 |
| [codebase-design](skills/codebase-design/SKILL.md) | 分析模块边界与接口，寻找简化接口、封装复杂性和改善可测试性的机会。 |
| [improve-codebase-architecture](skills/improve-codebase-architecture/SKILL.md) | 扫描架构改进机会，生成 HTML 报告，再围绕选定方向讨论方案。 |
| [handoff](skills/handoff/SKILL.md) | 将当前会话的目标、决定、证据和未完成工作整理为交接文档。 |
| [wait-what](skills/wait-what/SKILL.md) | 当上一条解释没有讲清楚时，暂停并换一种方式重新说明。 |
| [setup-matt-pocock-skills](skills/setup-matt-pocock-skills/SKILL.md) | 单独使用上游工程技能时，配置项目的任务跟踪、标签和领域文档布局。workloop 使用自己的运行目录，无需先执行此技能。 |

上游技能保持原样，workloop 的执行差异集中在本地技能及 executor/reviewer briefs 中。来源版本见 [upstream.json](skills/tools/upstream.json)。

## 2. 工作流程图与描述

![Paseo workloop：需求共识、Direct 或 Full 路线、执行、独立审查、串行集成与交付](docs/assets/workloop.svg)

1. **澄清并确认需求。** 编排者与用户明确目标、范围和验收方式，再共同选择 Direct 或 Full 路线。
2. **准备任务并确认。** Direct 用一张带 `Scope` 和验收命令的 ticket 处理边界明确的小改动；Full 先形成 spec，再拆分带依赖关系的 tickets。用户确认后才启动 run。
3. **隔离执行。** 执行者在各自的 worktree 中实现任务、自检并提交。Full 可按依赖和并发预算启动多个执行者；编排者接收完成通知并协调问题。
4. **冻结候选并独立审查。** 审查者检查固定 commit，核对需求、规范和验证证据。需要返工时回到执行者，新的候选提交再次审查。执行者报告完成，并不代表任务已经通过验收。
5. **串行集成并验证。** 通过审查的候选依次合入本地 integration branch，并运行约定检查。冲突或检查失败时先修复，再审查和集成；检查失败会回滚本次合入。
6. **复核并交付。** Full 由编排者检查跨任务行为、文档与整体回归；发现问题就新增 repair ticket，走同一套执行和审查流程。Direct 跳过整体终审。最后 `finish` 重新检查并清理资源，保留本地 `workloop/<feature>` 分支，由用户决定发布。

详细操作和恢复约定见 [paseo-workloop](skills/paseo-workloop/SKILL.md) 与 [中断恢复说明](skills/paseo-workloop/reference/recovery.md)。

## 3. 安装

安装需要 **Node.js 20+、npm 和 Git**，支持 macOS、Linux 和 Windows。通过 GitHub 直接运行安装器，无需手动 clone、npm 全局安装或 npm 登录；请保留命令中的 `github:suntianc/` 前缀。

按 Agent 读取技能的位置分为两类：

| Agent 类型 | 安装位置 | 适用方式 |
| --- | --- | --- |
| **Claude 类** | `~/.claude/skills` | Claude Code，以及读取 Claude 技能目录的兼容 Agent。 |
| **通用 Agent 类** | `~/.agents/skills`（默认） | 读取通用 Agent Skills 目录的 Agent；使用其他技能目录时，通过 `--target` 指定实际目录。 |

安装目录需要位于 **Paseo daemon 及执行者、审查者实际运行的机器** 上。连接远程 host 时，在远程机器安装；如果不同 Agent 使用不同技能目录，就分别安装和更新。安装器不会修改 Agent 的全局配置。

### Claude 类

**macOS / Linux（sh、bash、zsh）：**

```sh
# 安装
npx --yes github:suntianc/paseo-matt-workloop#main install --target "$HOME/.claude/skills"

# 更新
npx --yes github:suntianc/paseo-matt-workloop#main update --target "$HOME/.claude/skills"
```

**Windows（PowerShell）：**

```powershell
# 安装
npx --yes github:suntianc/paseo-matt-workloop#main install --target "$HOME/.claude/skills"

# 更新
npx --yes github:suntianc/paseo-matt-workloop#main update --target "$HOME/.claude/skills"
```

### 通用 Agent 类

**macOS / Linux（sh、bash、zsh）：**

```sh
# 安装到默认的 ~/.agents/skills
npx --yes github:suntianc/paseo-matt-workloop#main install

# 更新
npx --yes github:suntianc/paseo-matt-workloop#main update
```

**Windows（PowerShell）：**

```powershell
# 安装到默认的 $HOME/.agents/skills
npx --yes github:suntianc/paseo-matt-workloop#main install

# 更新
npx --yes github:suntianc/paseo-matt-workloop#main update
```

如果 Agent 不读取默认目录，请在两个命令后都添加 `--target "实际技能目录"`。不要只安装入口技能：整套技能、脚本和模板需要保留相邻目录结构。

### 更新与冲突处理

安装结果独立于 npx 缓存。`update` 每次拉取公开仓库的最新 `main`，完成后打印来源 commit；安装和更新后，重新启动或刷新 Agent 的技能列表。

目标目录中的 `.paseo-matt-workloop.json` 记录安装器管理的内容。已有同名技能、托管目录内的本地修改、新增或缺失文件、符号链接都会触发检查并停止操作。请先备份本地定制，再恢复托管内容或换一个空目录安装。其他技能保持原样。

可先预览检查，或查看技能列表和参数；自定义目录需要照常传入 `--target`：

```sh
npx --yes github:suntianc/paseo-matt-workloop#main install --dry-run
npx --yes github:suntianc/paseo-matt-workloop#main update --dry-run
npx --yes github:suntianc/paseo-matt-workloop#main list
npx --yes github:suntianc/paseo-matt-workloop#main --help
```

更新失败会尝试回滚。若进程被强制终止或断电，可从残留的 `.paseo-matt-workloop-stage-*/old/` 恢复旧文件；确认没有安装进程运行后，再移走 `.paseo-matt-workloop.lock`。

## 4. 运行条件与使用说明

### 运行条件

安装技能与运行 workloop 分开。实际编排还需要：

- **Paseo 环境：** Git、Paseo CLI 和运行中的 daemon；在 Paseo agent session 中运行，设置有 `PASEO_AGENT_ID`。
- **编排工具：** 当前会话具备 agent-scoped `create_agent`、`send_agent_prompt` 及 heartbeat 支持，用于派发、消息、完成通知与兜底唤醒。
- **角色配置：** 在 Paseo 中创建 `wl-executor`、`wl-reviewer` profiles，配置各自的 provider、model、mode；也可显式指定替代配置。模型和权限模式由用户选择，技能安装器不会代为创建或更改。
- **项目基线：** 目标是 Git 仓库，启动时约定的检查在基线已经通过。`codegraph` 仅在目标仓库已有索引时使用，不要求所有项目安装 CodeGraph。

可先检查基础环境：

```sh
node --version
git --version
paseo --version
paseo agent ls -g --json
paseo provider ls --json
```

不同 Paseo 版本的行为与验证边界见 [兼容说明](skills/paseo-workloop/reference/paseo-compat.md)。缺少编排工具时，可以单独使用其他技能；完整 workloop 需要上述条件。

### 开始一次开发任务

在 Paseo 中打开目标项目，启动已加载这套技能的 Agent，用自然语言指明技能、目标和验收要求，例如：

```text
请使用 paseo-workloop，为这个项目增加 CSV 导出。
先和我确认需求、范围和验收方式，再选择 Direct 或 Full 路线。
```

Agent 会按第二章的流程组织需求、准备任务并请你确认。运行中由编排者与执行者、审查者沟通；涉及范围、产品决定或角色配置的问题再交给用户。

需要查询已有 run 时，可让编排者检查状态，也可以执行：

```sh
# 通用 Agent 类的默认安装位置；Claude 类改用 ~/.claude/skills
node ~/.agents/skills/paseo-workloop/scripts/workloop.mjs --run my-project/export-csv status --live
```

`my-project/export-csv` 是示例，请换成实际 run 名称。Windows PowerShell 中，脚本路径使用 `"$HOME/.agents/skills/paseo-workloop/scripts/workloop.mjs"`。

### 状态、交付与 tidy-docs

运行状态默认在 `~/.workloop/<project>/<feature>/`，可用 `WORKLOOP_ROOT` 调整。规格、任务、briefs、报告和审查记录留在 run 目录；不要手动编辑 `state.json`。更新技能不迁移运行状态，建议先结束正在使用旧脚本的 run。

`finish` 保留本地 `workloop/<feature>` 分支，不自动合入主分支或推送。发布、PR 等远程操作按用户另行授权执行。异步监督与通知恢复见 [async supervision](skills/paseo-workloop/reference/async-supervision.md)。

如需在项目里使用 `/tidy-docs`，先在对应机器注册一次：

```sh
# 通用 Agent 类；Claude 类将脚本路径改为 ~/.claude/skills 下的相同路径
node ~/.agents/skills/paseo-workloop/scripts/tidy-docs.mjs install --repo /path/to/repo
```

Windows PowerShell 同样使用 `"$HOME/.agents/skills/paseo-workloop/scripts/tidy-docs.mjs"`，并将 `--repo` 替换为实际项目路径。注册文件包含本机路径，会排除在项目 Git 提交之外。详见 [tidy-docs 说明](skills/paseo-workloop/reference/tidy-docs.md)。

### 维护这套技能

本仓库只分发技能及安装工具。维护者可执行以下检查，上游同步方式见 [技能集维护说明](skills/README.md#updating-from-upstream)：

```sh
npm test
npm run check:links
npm pack --dry-run
```

## 5. 致谢

感谢 **[Matt Pocock](https://github.com/mattpocock)** 和 **[Paseo](https://github.com/getpaseo)**：

- **[mattpocock/skills](https://github.com/mattpocock/skills)**：提供本仓库使用的 15 个上游技能，涵盖需求追问、领域建模、规格、任务拆分、实现、测试与审查。
- **[getpaseo/paseo](https://github.com/getpaseo/paseo)**：提供多 Agent 的运行与编排基础，让 workloop 可以通过独立执行者、审查者和 worktree 协作推进任务。

本地代码采用 [MIT License](LICENSE)。Matt Pocock 的原始 MIT 声明保留在 [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES)，来源版本与本地扩展说明见 [NOTICE.md](NOTICE.md)。
