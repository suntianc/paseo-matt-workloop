# 更新日志

[English](CHANGELOG.md) · **简体中文**

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
