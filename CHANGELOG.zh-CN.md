# 更新日志

[English](CHANGELOG.md) · **简体中文**

## [2.0.0] - 2026-10-26

### 摘要

简单任务可选择 Quick；票据流程保留会话到复盘判断结束；替换执行者时保留原工作区。Retro 只输出发现和建议，由用户决定是否落实。

### 变更

- **新增：** Quick 在当前会话直接执行，无需强制开票、启动子代理或重复澄清；Direct/Full 的详细机制按需读取。
- **新增：** 本地只输出建议的 `retro` 入口，以及上游 `writing-for-agents` 指南。上游 retro 原文作为未修改的参考保留，Agent 文档使用统一写作指南。
- **调整：** 合入后保留会话和工作区；`finish` 验收交付，`retro` 记录发现或跳过理由，`archive` 保存活动记录并集中归档。取消或替换 attempt 中未合入的工作保留。
- **修复：** 替换会话默认复用原 branch/worktree，保留交接上下文与审查历史。Worktree 查询使用 NUL 分隔的 Git 记录，兼容 Windows 换行；普通返修继续原执行者，合入后 repair 使用新票、新会话和新工作区。
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
