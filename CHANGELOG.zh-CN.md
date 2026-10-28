# 更新日志

[English](CHANGELOG.md) · **简体中文**

## [3.0.0] - 2026-10-27

### 摘要

脚本运行的每条检查现在都有时限，`integrate` 和 `finish` 的检查以后台检查阶段运行；验收命令在每次合入时作为回归集重跑；run 放过的每条发现都记入豁免记录；Full run 的结论由独立终审 reviewer 给出；审查只围绕用户确认的编号验收标准和四类底线问题；确认 MCP 响应不再需要手写回执文件。README 工作流程图仍使用可编辑的 Excalidraw 场景及其对应的 SVG 导出。

### 变更

- **新增：** 脚本运行的每条检查都有时限：默认每条命令 30 分钟，最长 1440 分钟，可用 `init --check-timeout <minutes>` 或 `config --check-timeout <minutes>` 设置。`integrate` 和 `finish` 在不持有 run 锁的后台检查阶段运行检查和验收命令，期间 `status`、`watch` 仍可用；超时的命令会连同它启动的进程一起停止——在 POSIX 上是进程组，在 Windows 上是进程树；在 POSIX 上主动脱离该组的进程不在停止范围内；停止失败或无法确认时，检查阶段会保留下来等待恢复。
- **新增：** 编号验收标准（`AC1: <criterion>`），并可标明证明它的命令；用户确认后冻结，用户同意变更时用 `criteria <NN> --reason "<the user's decision>"` 记录。`integrate` 依次运行检查、该 ticket 的验收命令和所有已合入 ticket 的验收命令（即回归集）；`finish` 再次运行检查和整个回归集。
- **新增：** 豁免记录。返修 `send` 必须点名或用 `--waive <IDs> --reason "<why>"` 豁免每条边界内的阻塞性发现；`integrate --override "<why>"` 记录它放行的发现；`finish` 列出每条记录供用户复核。`status` 显示已豁免发现的数量。
- **新增：** Full run 的独立终审。`final-review --prepare` 在集成提交处创建 reviewer 的 worktree 并准备 `create_agent` 请求，编排者执行该请求后，用 `ack final --receipt -` 确认其响应；`finish` 只接受该 reviewer 对当前提交的通过结论，或一条边界内阻塞性发现全部豁免后的 `changes_requested`（用 `final-review --waive <IDs> --reason "<why>"`）。
- **新增：** 审查边界。阻塞性发现必须引用该 ticket 已确认的标准之一或一类底线问题：`Regression`、`Data loss`、`Security`、`ADR`；其余只能作为给用户的建议。复审只确认上一轮的每条边界内阻塞性发现、重跑验收命令，并检查上一候选以来改动中的底线问题，不再提出其他发现。返修默认上限为两轮（`--max-rework-rounds`）；超过所配置的上限需要用户同意，并用 `send --extra-round --reason` 记录。
- **新增：** `ack <NN>|final --receipt -` 从标准输入读取 MCP 响应（原样或 `{action, result}` 形式），并在 run 的 `messages/` 下保留一份副本；原样响应按当前待确认的请求处理。`status` 会显示已准备的请求等待确认了多久。
- **新增：** `config --clear-launch executor|reviewer` 清除某个角色在 run 级的启动覆盖，之后启动的 agent 重新跟随修改后的 Paseo profile。
- **调整：** ticket 模板和 run 参考文档要求验收标准写明边界：“所有”“每个”“绝不”这类表述要写明适用范围，已知限制写进标准本身。
- **调整：** 两版流程图从 Excalidraw 导出，恢复第一版的 Virgil 手写字体，为每个节点编组，并在 README 中链接图源。
- **修复：** 通过符号链接目录（如 macOS 的 `/tmp` 或软链接的 skills 目录）调用 `workloop.mjs` 和 `tidy-docs.mjs` 时，脚本不执行任何操作却以 0 退出；现在比较真实路径，能正常运行。
- **不兼容变更：** Full run 在 `finish` 前必须有独立终审（用 `final-review --prepare` 启动）：对当前提交的通过结论，或一份边界内阻塞性发现全部豁免的 `changes_requested`；`final-review.md` 不再给出结论。返修 `send` 必须点名或 `--waive` 每条边界内的阻塞性发现。验收命令在之后每次合入时重跑，因此必须可重复执行。新 run 的 ticket 需要编号标准（`AC1: …`），用户确认后冻结；标准与底线问题之外的发现不再阻塞。返修默认上限为两轮（`--max-rework-rounds`），超过所配置的上限需要用户同意（`send --extra-round --reason`）。

### 升级说明

更新前，用 run 启动时的脚本把进行中的 run 跑到 finish。之前创建的 run 仍按原方式读取 ticket 和审查，并继续使用每条命令 30 分钟的默认时限；编号标准和返修轮数上限适用于本版本创建的 run。时限和轮数上限可分别用 `config --check-timeout` 和 `config --max-rework-rounds` 调整。需要 Node.js 20+、npm 和 Git。

```sh
npx --yes github:suntianc/paseo-matt-workloop#v3.0.0 install
```

已有托管安装使用同一目标目录执行 `npx --yes github:suntianc/paseo-matt-workloop#v3.0.0 update`；`update` 拉取当前 `main`，固定安装器 tag 不会固定更新内容。项目安装在命令末尾添加 `--target <项目 skills 目录>`。

### 验证

- 本地 211 项测试全部通过（`npm test`），覆盖检查阶段及时限、验收回归集、豁免记录、编号标准与审查边界、独立终审、从标准输入确认回执、清除启动覆盖、经符号链接目录调用脚本，以及既有的安装器和文档工作流。Workloop 测试使用真实 Git 仓库和模拟 Paseo CLI。
- `npm run check:links` 检查 52 个 markdown 文件的全部相对链接和 `skill://` 引用，均通过。
- v3.0.0 tarball 通过 npx 安装到含空格、且经 macOS `/tmp` 符号链接访问的临时路径，共 19 个技能；安装后的链接检查（53 个 markdown 文件）与两个 workloop 脚本的 help 均通过；本地 `Agent.md`、`AGENTS.md` 未进入制品。
- 本次改动未在本机验证 Windows 和 Linux。在 POSIX 上，时限和恢复会停止检查的进程组，主动脱离该组的进程不在约束范围内。

## [2.0.0] - 2026-10-26

### 摘要

简单任务可选择 Quick；票据流程保留会话到复盘判断结束；替换执行者时保留原工作区。Retro 只输出发现和建议，由用户决定是否落实。

### 变更

- **新增：** Quick 在当前会话直接执行，无需强制开票、启动子代理或重复澄清；Direct/Full 的详细机制按需读取。
- **新增：** 本地只输出建议的 `retro` 入口，以及上游 `writing-for-agents` 指南。上游 retro 原文作为未修改的参考保留，Agent 文档使用统一写作指南。
- **调整：** 合入后保留会话和工作区；`finish` 验收交付，`retro` 记录发现或跳过理由，`archive` 保存活动记录并集中归档。取消或替换 attempt 中未合入的工作保留。
- **修复：** 替换会话默认复用原 branch/worktree，保留交接上下文与审查历史。Worktree 查询兼容 Windows 换行，比较恢复目录前会展开短路径别名；普通返修继续原执行者，合入后 repair 使用新票、新会话和新工作区。
- **不兼容变更：** `finish` 不再执行清理，需完成 `retro` 判断后执行 `archive`；`retry` 默认保留工作区，确需新建时使用 `--new-worktree --reason <why>`。

### 升级说明

更新前，使用原脚本完成正在运行的任务。新 run 使用 `finish → retro → archive`；需要新工作区的恢复操作显式传入 `--new-worktree`。需要 Node.js 20+、npm 和 Git。

```sh
npx --yes github:suntianc/paseo-matt-workloop#v2.0.0 install
```

已有托管安装使用同一目标目录执行 `npx --yes github:suntianc/paseo-matt-workloop#v2.0.0 update`；`update` 拉取当前 `main`，固定安装器 tag 不会固定更新内容。项目安装在命令末尾添加 `--target <项目 skills 目录>`。无托管清单的旧安装需先备份并移开本套同名条目，再安装；保留业务专用技能。

### 验证

- 本地 122 项测试全部通过，覆盖安装、真实 Git/模拟 Paseo 生命周期、恢复、repair 隔离和文档处理；追加的针对性检查覆盖归档后的证据读取。
- 本机 macOS Paseo 0.13.0 的隔离 run 验证了 prepared MCP 派发/审查、原会话续做、合入、finish 保留会话、heartbeat 清理和延后归档。归档前记录仍可读；归档后的 Antigravity CLI 日志报 `agy ENOENT`，后续复盘使用保存的证据。验证范围见兼容说明。
- Skill 校验、上游来源比对及相对链接检查通过；两版流程图均已渲染检查。
- v2.0.0 tarball 通过 npx 在含空格的临时路径安装了 19 个技能，安装后链接检查与 CLI help 通过；本地 `Agent.md`、`AGENTS.md` 未进入制品。

## [1.0.0] - 2026-10-25

### 摘要

首次独立发布 Paseo workloop 及配套技能，提供 npx 安装器，以及英文和简体中文文档。

### 变更

- **新增：** 整套 17 个技能，包括 15 个 Matt Pocock 上游技能、本地 `paseo-workloop` 和 `codegraph`，以及相应脚本、模板和参考文档。
- **新增：** Direct 路线处理范围明确的单 ticket 改动，Full 路线处理 spec 和带依赖的 tickets；通过独立 worktree、独立候选审查和串行集成检查推进任务。
- **新增：** 基于 GitHub 的 npx 安装和托管更新。安装结果独立于 npx 缓存；更新拉取当前 `main`，保留其他技能，遇到本地修改或未托管冲突时停止。
- **新增：** 英文和简体中文 README、对应流程图及可编辑图源，默认语言为英文。

### 升级说明

需要 Node.js 20+、npm 和 Git。这是首次发布，无需从旧版迁移。将此版本安装到默认的 `~/.agents/skills` 目录：

```sh
npx --yes github:suntianc/paseo-matt-workloop#v1.0.0 install
```

Claude 类 Agent 添加 `--target "$HOME/.claude/skills"`。已有同名技能时，先备份并移走，再由新安装接管。

已有托管安装使用相同的目标目录，从当前 `main` 更新：

```sh
npx --yes github:suntianc/paseo-matt-workloop#main update
```

固定安装器 tag 会固定 `install` 的内容；`update` 始终拉取当前 `main`。运行 workloop 还需要 Paseo daemon、agent-scoped 编排工具、heartbeat 支持，以及已配置的执行者和审查者角色。详见 [运行条件](README.zh-CN.md#4-运行条件与使用说明)。

### 验证

- 本地 115 项测试全部通过，覆盖安装器、workloop、heartbeat 生命周期和文档工作流。Workloop 测试使用真实 Git 仓库和模拟 Paseo CLI。
- 已检查技能链接、双语文档链接和打包文件。制品包含两版 README、流程图、许可证及 changelog，排除本地 Agent 指令。
- 打包后的安装器可在临时目录安装全部 17 个技能，安装后的链接和 workloop CLI 已检查。这些检查证明安装包和工作流行为，不代表已验证所有 Paseo host 或 provider 的兼容性。

[1.0.0]: https://github.com/suntianc/paseo-matt-workloop/releases/tag/v1.0.0

[2.0.0]: https://github.com/suntianc/paseo-matt-workloop/releases/tag/v2.0.0

[3.0.0]: https://github.com/suntianc/paseo-matt-workloop/releases/tag/v3.0.0
