# paseo-matt-skills

我的 Paseo workloop 技能集：把需求澄清、规格、任务拆分、执行、独立审查和串行集成串起来。
包含 15 个 [Matt Pocock skills](https://github.com/mattpocock/skills)，以及本地的
`paseo-workloop`、`codegraph`，共 17 个技能。

## 安装

需要 Node.js 20+、npm 和 Git。无需 clone，无需 npm 全局安装或 npm 登录：

```sh
npx --yes github:suntianc/paseo-matt-skills#main install
```

默认安装到 `~/.agents/skills`，复制全部技能、脚本、模板和维护工具，保留相邻目录结构。
安装结果独立于 npx 缓存；清理缓存不会影响技能使用。
重新启动或刷新 agent 后，用 `paseo-workloop` 开始工作。

按使用的 agent 指定技能目录。例如 Claude Code：

```sh
npx --yes github:suntianc/paseo-matt-skills#main install --target ~/.claude/skills
```

其他支持 Agent Skills 的 agent 可通过 `--target <技能目录>` 安装。
请确认对应 agent 会读取该目录；本命令不修改 agent 的全局配置。
多个 agent 使用不同目录时，分别执行安装和更新。

已有同名技能时，安装器会停止并列出冲突路径。先备份并移走冲突项，或选择其他目录，
再安装。它不会自动接管已有技能或跟随同名符号链接。

## 更新

```sh
npx --yes github:suntianc/paseo-matt-skills#main update

# 自定义目录需要传入与安装时相同的路径
npx --yes github:suntianc/paseo-matt-skills#main update --target ~/.claude/skills
```

`update` 每次从公开仓库拉取最新 `main`，即使 npx 缓存了旧安装器，也会获取新的技能内容。
完成后打印拉取的 commit。更新需要 Git 和网络访问。

安装器在目标目录的 `.paseo-matt-skills.json` 中记录所管理的文件。
更新前校验这些文件：有本地修改、新增文件、缺失文件或符号链接时，先停止，保留现状。
请先将本地定制备份到其他位置，再恢复原管理版本或换一个空目录安装。
其他技能不受影响；新版本移除的已管理技能也会移除。
更新失败会尝试回滚；强制终止进程或断电时，可从残留的 `.paseo-matt-skills-stage-*/old/`
恢复旧文件，确认没有安装进程运行后再移走 `.paseo-matt-skills.lock`。

```sh
# 预览并检查冲突，不写入目标文件
npx --yes github:suntianc/paseo-matt-skills#main install --dry-run
npx --yes github:suntianc/paseo-matt-skills#main update --dry-run

# 查看技能列表和帮助
npx --yes github:suntianc/paseo-matt-skills#main list
npx --yes github:suntianc/paseo-matt-skills#main --help
```

此处使用 npx 的 GitHub package specifier，详见 [npm npx 文档](https://docs.npmjs.com/cli/v11/commands/npx/)。
不依赖同名包发布到 npm registry，因此请保留命令中的 `github:suntianc/` 前缀。

## Workloop 运行条件

安装技能不会自动创建 Paseo profiles 或启动 daemon。实际运行 workloop 还需要：

- Git、Paseo CLI 和运行中的 Paseo daemon。
- Paseo agent session，带有 agent-scoped `create_agent`、`send_agent_prompt` 和 heartbeat 支持。
- 配置好 provider、model、mode 的 `wl-executor`、`wl-reviewer` profiles，或为本次 run 显式指定替代配置。

参见 [Workloop 技能](skills/paseo-workloop/SKILL.md)、
[技能集说明](skills/README.md)和 [Paseo 兼容说明](skills/paseo-workloop/reference/paseo-compat.md)。

`/tidy-docs` 需要额外按项目注册。默认安装目录下可执行：

```sh
node ~/.agents/skills/paseo-workloop/scripts/tidy-docs.mjs install --repo /path/to/repo
```

运行状态默认保存在 `~/.workloop`，与安装目录分开；更新技能不迁移或修改现有 run 状态。
正在使用旧版本脚本的 run，建议结束后再更新。

## 维护

本仓库是技能集的独立公开来源。只包含技能及分发工具，不包含个人插件、主题或运行数据。

```sh
npm test
npm run check:links
npm pack --dry-run
```

上游 15 个技能保持原样，来源 commit 记录在 [upstream.json](skills/tools/upstream.json)。
更新它们的方法见[上游同步说明](skills/README.md#updating-from-upstream)。
本地 workloop 的定制集中在本地技能及 briefs；未来改动直接维护此仓库。

本地代码采用 MIT；Matt Pocock 的原始 MIT 声明保留在
[THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES)，完整来源见 [NOTICE.md](NOTICE.md)。
