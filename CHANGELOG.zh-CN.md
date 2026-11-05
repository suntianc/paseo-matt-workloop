# 更新日志

[English](CHANGELOG.md) · **简体中文**

## [4.0.0] - 2026-11-04

### 摘要

三项改动依据维护者机器上 19 个已记录 run 的数据精简工作流。`dispatch`、`review`、`send` 只保留所有已记录 run 都在用的 MCP 预备路径，裸命令改为拒绝。新 run 的每条验收标准都写明怎么验证：给出命令，或说明为何没有命令能验证，让手工验收成为用户确认过的选择，而不是漏写的命令。`finish` 把各轮评审的范围外建议写进一个文件，不再打印成百上千行。

### 变更

- **不兼容变更：** 不带 `--prepare` 的 `dispatch`、`review`、`send` 改为拒绝，与 `final-review` 一致；`dispatch --dry-run` 仍只打印。通过 `paseo agent run` / `paseo agent send` 启动或发消息的旧路径已删除，连同对未记录的同标签 agent 的认领，以及 CLI 启动会丢失 profile features 的警告。已记录 run 中全部 342 次 dispatch、review、send 都走预备路径。`status --live` 现在提示用回执对账未记录的同标签 agent，[恢复参考](skills/paseo-workloop/reference/recovery.md)同步说明。
- **调整：** 本版本创建的 run 中，每条验收标准须以 ``— check: `<命令>` `` 或 `— manual: <为何没有命令能验证>` 结尾。`init` 和 `import` 拒绝两者皆无、两者皆有、理由为空或仍是占位符的标准，并指出 ticket 与行号。理由属于已确认标准的一部分，修改须经 `criteria --reason`。此规则取代原先对整张 ticket 没有命令的警告。[Direct](skills/paseo-workloop/templates/direct-ticket.md) 与[修复](skills/paseo-workloop/templates/repair-ticket.md) ticket 模板展示两种结尾，并删去每次合入都会检查的 “The run's checks pass.”。
- **调整：** `finish` 把每条 `## Out of scope` 建议按 ticket 和评审分组写入 run 目录下的 `suggestions.md`，只打印每个 ticket 的建议条数和文件路径，不再列出全文。
- **修复：** 跨多行的一条建议会被读成多条，评审在 `## Out of scope` 下收尾的围栏块（`Result:`、`Summary:`）也会被当成建议。现在每个条目算一条建议，围栏块跳过；在一个已记录 run 上，275 行打印输出变为 115 条建议。`workloop-audit` 按同一方式计数。

### 升级说明

调用裸 `dispatch`、`review`、`send` 的脚本须加 `--prepare`，执行打印出的 MCP 请求并用 `ack` 确认，技能本身早已如此要求。本版本之前创建的 run 仍把没有 `check:` 或 `manual:` 的标准读作手工验收；只有之后创建的 run 需要新结尾。进行中的 run 可以直接更新：它不带新规则的标记，预备命令也没有变化。运行需要 Node.js 20+、npm 和 Git。

```sh
npx --yes github:suntianc/paseo-matt-workloop#v4.0.0 install
```

已有托管安装使用同一目标目录执行 `npx --yes github:suntianc/paseo-matt-workloop#v4.0.0 update`；`update` 拉取当前 `main`，固定安装器 tag 不会固定更新内容。项目安装在命令末尾添加 `--target <项目 skills 目录>`。

### 验证

- 全部 390 个本地测试通过（`npm test`），覆盖裸 `dispatch`、`review`、`send` 被拒且不改状态、dry run 仍只打印、状态无法解释的同标签 agent 阻止再次派发、`init`、`import`、`criteria` 与 Direct run 中的验收规则、旧 run 保留裸标准，以及 `suggestions.md` 合并折行条目并跳过围栏块。
- 在四个有建议的已记录 run 上对比提取结果：275 → 115、132 → 83、61 → 17、36 → 36 条，没有残留收尾块。
- `npm run check:links` 解析了 66 个 Markdown 文件中的全部相对链接和 `skill://` 引用。
- v4.0.0 安装包（133 个文件）通过 npx 安装到含空格、经 macOS `/tmp` 符号链接访问的临时路径，共 21 个技能；安装结果的链接检查（67 个 Markdown 文件）通过，`workloop.mjs`、`validate.mjs`、`tidy-docs.mjs`、`req.mjs`、`audit.mjs` 均打印用法。本地 `Agent.md`、`AGENTS.md` 不在制品中。
- 代码提交（`10eeb1e`..`7cdaa6f`）在 Ubuntu 和 Windows、Node 20 和 22 上的 CI 全部通过，其中 `7cdaa6f` 修正了一个按 Windows 分隔符比较工作区路径的测试；发布提交只改动版本号和 changelog。本次未在本地运行 Windows 和 Linux。

## [3.2.2] - 2026-11-03

### 摘要

请求的措辞和所有需求都对不上时，编排者不再面对一个空结果去猜：需求台账的字面检索没有命中、或有几个相近候选时，`lookup` 会列出本项目的整本台账，由编排者结合对话判断归属，只有拿不准时才问用户。旧版 Workloop（还没有 `completion` 字段时）归档的 run 现在记为已交付，而不是未交付，因此可以用项目早期的 run 建立台账；仓库 remote 带端口时，`req new` 不再拒绝写入台账。

### 变更

- **新增：** `req lookup` 的判断为 `none` 或 `ambiguous` 时，结果中增加 `catalog`：本项目的全部需求，按编号排列，包括状态、别名和摘要的前 100 个字符，均摘自记录本身，且不受 `--limit` 截断。`strong` 的结果结构不变。台账和 Workloop 技能现在写明：由 Main 结合对话判断归属，拿不准时才问用户，最多给出三个候选；只有用户确认后才把这次的说法加入该需求的别名，以免一次猜错在下次变成"明确命中"。[lookup 参考](skills/requirement-ledger/reference/lookup.md)删除了 lookup 从未写入的审计日志说明。
- **修复：** 旧版 Workloop 在有 `completion` 之前归档的 run 只有 `finishedAt`，没有 `completion`，因此 `req sync` 会把它记为未交付，尽管其提交已经在主分支上。这类 run 同样没有当前每次归档都会先写入的 `archiveStartedAt`；现在，当它的所有 ticket 都已完成、且集成提交已越过起点时，按冻结的 `integration.tip` 记为已交付：`delivered_at` 取自 `lastIntegratedAt`，`sync` 和 `context` 显示 `basis: legacy-integration-tip`。含已取消 ticket 或没有任何集成的旧版 run 仍为未交付。[context 参考](skills/requirement-ledger/reference/context.md)说明了这条规则。
- **修复：** 带端口的 remote（如 `http://git.example:8765/owner/repo`）清洗后是 `git.example:8765/owner/repo`，比较时再清洗一次就变成了 `git.example/8765/owner/repo`，因此当台账记录保存的是完整 URL 时，`req new` 会把它当作另一个仓库的台账而拒绝写入。现在清洗结果再清洗一次不会改变：没有 scheme 时，主机后跟数字端口的冒号会保留，除非前面带用户名、表明是 scp 地址。

### 升级说明

无需迁移。已经把旧版 run 以未交付状态 link 进台账的，下次执行 `req sync <project>/<feature>` 时会记录其交付。需要 Node.js 20+、npm 和 Git。

```sh
npx --yes github:suntianc/paseo-matt-workloop#v3.2.2 install
```

已有托管安装使用同一目标目录执行 `npx --yes github:suntianc/paseo-matt-workloop#v3.2.2 update`；`update` 拉取当前 `main`，固定安装器 tag 不会固定更新内容。项目安装在命令末尾添加 `--target <项目 skills 目录>`。

### 验证

- 全部 389 个本地测试通过（`npm test`），包括：lookup 在 `none`、带 `--limit 1` 的 `ambiguous`、空台账、长摘要、已退役需求和被两条需求同时认领的 run 下的 catalog；以及旧版 run 的 `sync` 和 `context`，其中含已取消 ticket、集成提交未前进、按当前方式归档和未归档的情况都保持未交付；以及包括带端口在内的 remote 清洗两次结果不变，台账记录保存完整 URL 时 `new` 仍可写入。
- `npm run check:links` 在 66 个 Markdown 文件中解析了所有相对链接和 `skill://` 引用。
- v3.2.2 tarball（133 个文件）经 npx 安装到一个路径含空格、经 macOS `/tmp` 符号链接访问的临时目录，安装了 21 个技能；安装后的链接检查（67 个 Markdown 文件）通过，`workloop.mjs`、`validate.mjs`、`tidy-docs.mjs`、`req.mjs` 和 `audit.mjs` 均打印出用法。本地的 `Agent.md` 和 `AGENTS.md` 不在制品中。
- 以只读方式读取维护者机器上的 18 次 run：安装后的 `runstate.mjs` 判定 9 次因 completion 已交付、7 次为旧版交付、2 次（一次已取消、一次未完成）未交付。为本仓库用其 3 次 run 和 git 历史建立的 7 条需求台账通过 `req doctor`；对字面无法确定归属的请求，安装后的 `lookup` 列出了全部 7 条需求。
- 代码提交（`ec168e1`）在 Ubuntu 和 Windows、Node 20 和 22 上的 CI 全部通过；发布提交只改动版本号和 changelog。本次未在本地运行 Windows 和 Linux。

## [3.2.1] - 2026-11-02

### 摘要

运行目录不再随每次审查持续膨胀。对比不同提交的 reviewer 和执行者会把整棵代码树解包到 run 的 `evidence/` 中，而 `archive` 会一直保留它们：在维护者机器上，一个项目的 run 占用 5.05 GB，其中 4.06 GB 是这类副本。现在每份简报都会指定一个 scratch 文件夹，用来存放该 Agent 可以重新生成的内容，`archive` 会删除它；`workloop-audit` 会标记归档后仍超过 200 MB 的 run。

### 变更

- **修复：** reviewer 在自己的 worktree 中是只读的，因此要在 base 或上一版候选上运行检查时，只能把那个提交的代码树解包到别处，而简报只要求把 receipt 放在 worktree 之外。这些代码树连同依赖安装和缓存都进入了 run 的 `evidence/`，`archive` 又会保留整个运行目录。现在 `dispatch`、`review` 和 `final-review --prepare` 会在运行目录中创建 `evidence/<简报名>` 和 `scratch/<简报名>`，并在简报中写明两者：receipt 和报告引用的内容放 evidence，随 run 保留；其他提交的代码树（`git archive <sha> | tar -x -C <文件夹>`）、依赖安装、缓存和报告没有引用的测试产物放 scratch。`archive` 在清理 worktree 登记之前删除 `scratch/`，因此 Agent 在其中添加的 worktree 也会被注销，并报告运行目录的大小和释放的空间；删除未能完成时只提示，不阻塞归档。[验证参考](skills/paseo-workloop/reference/validation.md)和两份 README 也做了相同说明。
- **新增：** `workloop-audit` 测量每个运行目录（不跟随符号链接），并输出 `disk: <n> MB (scratch <n> MB)`。新的 `size` 检查标记会指出归档后仍超过 200 MB 的 run（附 `evidence/` 下最大的三项），或 `archive` 未删除的 `scratch/`。

### 升级说明

无需迁移。进行中的 run 继续运行：更新后写出的简报会写明两个文件夹，`archive` 只在存在 `scratch/` 时删除它。已归档的 run 不受影响；其 `evidence/` 中已有的代码树需要手动删除，`audit.mjs all` 会列出超过 200 MB 的 run。需要 Node.js 20+、npm 和 Git。

```sh
npx --yes github:suntianc/paseo-matt-workloop#v3.2.1 install
```

已有托管安装使用同一目标目录执行 `npx --yes github:suntianc/paseo-matt-workloop#v3.2.1 update`；`update` 拉取当前 `main`，固定安装器 tag 不会固定更新内容。项目安装在命令末尾添加 `--target <项目 skills 目录>`。

### 验证

- 全部 381 个本地测试通过（`npm test`），包括：一个 run 的执行者、reviewer 和终审 reviewer 简报所写的文件夹在 Agent 启动前已经存在，其 `archive` 删除了 1 MB 的 scratch 并保留了旁边的 receipt；以及审计的测试（测量 run 时排除 scratch、不跟随符号链接，200 MB 阈值，归档后残留的 scratch，以及没有测量数据的 run）。
- `npm run check:links` 在 66 个 Markdown 文件中解析了所有相对链接和 `skill://` 引用。
- v3.2.1 tarball（133 个文件）经 npx 安装到一个路径含空格、经 macOS `/tmp` 符号链接访问的临时目录，安装了 21 个技能；安装后的链接检查（67 个 Markdown 文件）通过，安装后的简报写明了两个文件夹，`workloop.mjs`、`validate.mjs`、`tidy-docs.mjs`、`req.mjs` 和 `audit.mjs` 均打印出用法。本地的 `Agent.md` 和 `AGENTS.md` 不在制品中。
- 安装后的 `audit.mjs all` 在两秒内读完维护者机器上的 17 次 run，并标记了一个：一个归档后仍保留 486 MB 的 run，主要是 Playwright trace。
- 发布提交在 Ubuntu 和 Windows、Node 20 和 22 上的 CI 全部通过；本次发布未在本地运行 Windows 和 Linux。

## [3.2.0] - 2026-11-01

### 摘要

跨多次 run 持续演进的项目现在可以维护需求台账：每条长期需求一份记录，新请求可以按原话找回它，并指向其背后的 run、规格、ADR 和交付记录，设计时从之前 run 已经得出的结论出发。审查循环在仍未收口的地方有了边界：终审后续轮次与 ticket 复审一样收窄，其返修周期与返修轮次共用上限；每次返修发给执行者的消息都附带与复审对应的返修方法。新增的只读 `workloop-audit` 技能对照工作流规则检查各次 run 的记录，可用于复盘，也可跨多次 run 使用。Reviewer 通过守卫执行命令：命令改动了被测候选版本时判为失败。

### 变更

- **新增：** `requirement-ledger` 技能及其命令行 `scripts/req.mjs`。每个项目的台账位于仓库之外的 `$WORKLOOP_ROOT/<project>/.requirements/`，每个 `REQ-<n>` 一份 Markdown 记录；编号永不复用，退役的需求保留文件。`lookup` 用请求中的拉丁词和中文二字组对标题、别名、摘要和引用打分，返回带 `strong`、`ambiguous` 或 `none` 判定的候选，只作为证据，不代为认定归属。`context` 按固定顺序列出需求的各项指针，并区分已完成、已归档、已归档但证据缺失三种交付状态。`link`、`sync`、`note` 是与 Workloop 的全部接口，只读取 run 的 `state.json`、从不写入；`sync` 会把被重新打开的 run 取代的交付保存在 `delivery_history` 中。`link --correct --reason` 是把 run 改挂到另一条需求的唯一方式；纠错中断时 run 会同时出现在两条记录中，`context`、`sync`、`link` 拒绝执行，`list`、`show`、`lookup`、`doctor` 会标注出来。`doctor [--repair-log]` 检查编号、重复、run、引用、仓库归属和审计日志。
- **新增：** `paseo-workloop/scripts/validate.mjs` 在干净的 worktree 上，按预期的 SHA 和分支执行命令。命令执行后若 HEAD、分支、index、已跟踪文件或未被忽略的文件发生变化，即使退出码为 0 也判为失败，并保留改动后的工作树供检查。每次执行在 worktree 之外的新目录中写入 `receipt.json` 和每条命令的完整输出；`--preflight` 检查先执行，相同命令的成功结果只有在指定 `--reuse-identical` 时才复用，`--repeat-check` 每次都执行；`--help` 打印用法。[Validation](skills/paseo-workloop/reference/validation.md) 还说明了如何校准 API 替身、如何诊断浏览器启动失败；新增的中断交接模板用于在平台拒绝某一步时记录已执行的内容。
- **新增：** 写完报告的终审轮次之后，下一轮与 ticket 复审一样收窄：简报写明该报告、它的集成提交和 `git diff <previousTip>..<tip>`，只确认上一轮边界内的阻塞性发现、核对验收映射、重跑检查和回归集、复评每条豁免，并检查上次提交以来改动中的底线问题。同一提交上的另一轮（`final-review --prepare --again`）复审同一提交；没有编号标准的 run 仍使用原来的简报。
- **新增：** 终审返修周期与返修轮次一样设上限：已写出报告的轮次之后，每个新的集成提交算一个返修周期；超过上限（默认两轮，可用 `config --max-rework-rounds <n>` 调整）时 `final-review --prepare` 拒绝启动，`--extra-round --reason "<用户的决定>"` 随该轮记录用户决定。`finish` 把它与超过上限的 ticket 轮次一起列出，`status` 会提示下一周期将超限，因此写返修 ticket 之前就会先问用户。
- **新增：** `workloop-audit` 技能及其 `scripts/audit.mjs`，对已往 run 做只读体检。`audit.mjs run <project>/<feature>` 统计 run 记录反映的事实——ticket、审查、返修轮次及超过上限的轮次、终审轮次、按类型统计的豁免、失败和冲突的集成、重试、接管，以及集成检查的耗时——用 workloop 自己的解析器读取报告，把每轮复审的阻塞性发现归入 `carried`、`in-change`、`late`、`outside-repo`、`unplaced` 或 `out`，并标出规则预期与记录相矛盾之处：`late` 的发现、没有 `## Findings` 的返修报告、已完成却没有复盘的 run、漏做 `sync` 的台账。`audit.mjs all [--project <p>] [--json] [--save]` 在多次 run 之间做同样的事，与上次保存的检查对比，并把下次对比的基准保存在 `$WORKLOOP_ROOT/.workloop-audit/` 下。它不写入任何 run、仓库或台账，workloop 也不依赖它；安装后 `retro` 以它开始。ticket 复审和终审复审的简报现在要求新发现接着上一轮的最高编号排，使一个 ID 在整个任务中只对应一条发现；只有当复审简报包含这一要求时，审计才把重复的 ID 视为同一条发现。
- **调整：** 迟到的发现——针对本轮未改动代码中某条已确认标准的缺陷——先由编排者判定：确认该缺陷后以返修轮次或返修 ticket 修掉，并计入上限；或写明为何不成立。只有编排者无法判定的问题（例如对标准含义的争议）才交给用户；其余建议和产品决定仍由用户决定。
- **调整：** Reviewer 和终审 reviewer 的简报写明候选版本所在分支，并要求通过 `validate.mjs` 执行命令，回执保存在 worktree 之外。
- **调整：** 在维护台账的项目中，`paseo-workloop` 在澄清需求前先执行检索，`WL init` 之后用 `req link` 记录归属，`WL finish` 之后固定执行 `req sync`。
- **调整：** 收紧了 `paseo-workloop` 与 `requirement-ledger` 面向编排者的参考文档，行为不变：同一规则的重复表述只保留一处，拒绝信息已写明修改办法的句子更短，带日期的 Paseo 兼容性观察记录移到 `paseo-workloop/reference/paseo-compat-history.md`，并修正了五处文档错误（第二条主需求、归档后应做的 `sync`、记录复核决定、检查阶段中的 `config`、远程 daemon 上的启动设置）。
- **调整：** 返修 `send`（`changes_requested` 审查之后，命令行和 `--prepare` 方式相同）会在发给执行者的消息中、页脚 `---` 线之后附上审查报告路径、被审候选版本的完整和短 SHA 及 `git diff <candidateSha>..HEAD`，并给出与复审一致的返修方法：先复现每条发现，再修其根因，最后按复审的方式检查本次改动。回放 17 次已往 run 发现，复审提出的阻塞性发现中有 71% 是修复不彻底，或改坏了自己这次改动中的其他部分。`--merge-tip` 的消息、`pass` 之后的消息，以及任务运行中的消息都不含这些内容。
- **调整：** 两份 README 和两张流程图都画出了有边界的循环：返修方法及其两轮上限、full run 终审的返修循环及其两个返修周期、run 旁边可选的需求台账，以及安装审计时 retro 从体检开始。流程图仍是可编辑的 Excalidraw 场景，导出时内嵌 Virgil 字体。

### 升级说明

无需迁移。台账和审计都是可选的：首次执行 `req new` 之前不会创建任何内容，审计只在安装了该技能时由 `retro` 运行。进行中的 run 继续运行；更新后发出的审查、终审轮次和返修消息使用新的简报和返修方法；在有编号标准的 run 中，超过返修周期上限的终审轮次需要 `final-review --prepare --extra-round --reason "<用户的决定>"`。需要 Node.js 20+、npm 和 Git。

```sh
npx --yes github:suntianc/paseo-matt-workloop#v3.2.0 install
```

已有托管安装使用同一目标目录执行 `npx --yes github:suntianc/paseo-matt-workloop#v3.2.0 update`；`update` 拉取当前 `main`，固定安装器 tag 不会固定更新内容。项目安装在命令末尾添加 `--target <项目 skills 目录>`。

### 验证

- 全部 377 个本地测试通过（`npm test`），包括台账的 E1–E11 验收场景；经符号链接目录调用 `validate.mjs`、在带 submodule 的仓库中运行它，以及它的 `--help`；终审后续轮次收窄、返修周期上限和 `--extra-round` 的测试；返修消息的测试（附加的返修方法、`--prepare` 消息的 prompt，以及不带该方法的消息）；以及审计的测试（发现落点、复审分类、标记、台账检查与只读行为）。
- `npm run check:links` 在 66 个 Markdown 文件中解析了所有相对链接和 `skill://` 引用。
- v3.2.0 tarball（133 个文件）经 npx 安装到一个路径含空格、经 macOS `/tmp` 符号链接访问的临时目录，安装了 21 个技能；安装后的链接检查（67 个 Markdown 文件）通过，`workloop.mjs`、`validate.mjs`、`tidy-docs.mjs`、`req.mjs` 和 `audit.mjs` 均打印出用法。本地的 `Agent.md`、`AGENTS.md` 以及台账的 ticket 草稿不在制品中。
- `audit.mjs all` 在维护者机器上约一秒读完 17 次 run 且未写入任何内容，它对 `browser-mcp-lab/task-isolation` 的分类与人工核对的回放一致。
- 发布提交在 Ubuntu 和 Windows、Node 20 和 22 上的 CI 全部通过。Windows 起初在 CI 中挂起：另一个进程读取记录时，Windows 拒绝了台账的写入，异常在测试能够让读取进程停止之前抛出。台账写入现在会像 Workloop 自己的写入一样，对这类拒绝重试约一秒。台账和 `validate.mjs` 现在按原生 realpath 比较路径，Windows 短文件名（`RUNNER~1`）与 Git 输出的长路径视为同一目录：此前 `new` 会拒绝自己的台账，`validate.mjs` 也识别不出位于 worktree 内的输出目录。测试中假定路径分隔符为 `/` 的匹配已修正，台账和审计测试启动的每个子进程都有两分钟上限。
- 两张 SVG 均由 Excalidraw 0.18 从更新后的场景导出，并在浏览器中渲染检查；所有节点、箭头和文字互不遮挡。
- 本次发布未在本地运行 Windows 和 Linux，由 CI 覆盖。

## [3.1.0] - 2026-10-28

### 摘要

属于项目踩坑的复盘发现，现在可以作为简短的踩坑条目保存在该项目的 `docs/pitfalls/` 中：复盘后提出，经用户同意才写入，ticket 碰到相同触发场景的执行者会读取它。Ticket 可以写明哪些既有行为必须保留、哪些新增明确不做；新 run 的集成 worktree 也不再使用会让 pytest 跳过仓库测试的目录名。两版 README 和工作流程图现在展示 3.0.0 的交付闸门。

### 变更

- **新增：** `paseo-workloop` 将写得出具体触发场景的复盘发现整理为 `docs/pitfalls/` 下的条目提案，使用 `templates/pitfall-entry.md`：触发场景、现象、确认陷阱仍然存在的检查、避开方法和来源。一条只对应一个触发场景和一种应对，run 的经过留在复盘中。"怎么确认"检查在坑修复后必须得到不同结果。关于 Agent 工作方式的建议仍作为复盘建议，Agent 越权行为写进简报规则。被引用的 `retro.md` 和少量被引用的摘录复制到 `docs/pitfalls/evidence/<run>/`，换台主机也能打开来源。用户同意前不写入任何内容，`retro` 本身不变。
- **新增：** 执行者读取 `docs/pitfalls/README.md` 中触发场景与本 ticket 匹配的条目；`tidy-docs` 新增 `pitfalls` 类型，用于登记 `docs/pitfalls/`。
- **新增：** Ticket 可以写明 `Keep as is`（需保留的既有行为）和 `Not in this change`（明确不做的新增），按用户原话填写。执行者保持所列行为、不添加被排除的内容；reviewer 将改变保留行为视为 `Regression`；编排者呈现 tickets 时指出哪些边界是自己决定的。
- **调整：** 新 run 的集成 worktree 改为 `<run dir>/tip`，不再使用 `<run dir>/integration`。pytest 会把测试路径上的每一级目录名都变成关键字，conftest 按 `"integration" in item.keywords` 跳过测试的仓库，在 `integrate` 和 `finish` 中会跳过全部测试，退出码却仍为 0。
- **调整：** 目标、范围和验收都清楚的请求可以跳过进一步讨论，但不能跳过 ticket 确认：Direct 和 Full 的 tickets 及其验收标准仍须在 run 启动前确认。
- **调整：** 执行者只结束自己启动的进程，通过记录的 PID 或工具自带的取消功能，不按名称或模式结束进程（如 `killall node`）。
- **调整：** 两版 README 简要说明 3.0.0 的闸门，细节交给 run 参考文档。两张流程图新增执行前的用户确认步骤（确认 tickets 及其编号验收标准），Full run 还新增合入与 `finish` 之间的独立终审。流程图仍是可编辑的 Excalidraw 场景，导出时内嵌 Virgil 字体。

### 升级说明

无需迁移。没有 `docs/pitfalls/` 的项目行为不变；已有的笔记目录可以登记为 `pitfalls`，由用户决定何时改写为条目。`Keep as is` 和 `Not in this change` 是可选的 ticket 字段。进行中的 run 仍按启动它的版本所描述的方式运行，继续使用 `state.json` 中记录的 `integration/` worktree；只有更新后启动的 run 使用 `tip/`。需要 Node.js 20+、npm 和 Git。

```sh
npx --yes github:suntianc/paseo-matt-workloop#v3.1.0 install
```

已有托管安装使用同一目标目录执行 `npx --yes github:suntianc/paseo-matt-workloop#v3.1.0 update`；`update` 拉取当前 `main`，固定安装器 tag 不会固定更新内容。项目安装在命令末尾添加 `--target <项目 skills 目录>`。

### 验证

- 本地 212 项测试全部通过（`npm test`），其中新增的 `tidy-docs` 清点测试将 `docs/pitfalls/` 目录及复制的证据登记为 `pitfalls`，`init` 测试要求集成 worktree 命名为 `tip`。
- `npm run check:links` 检查 54 个 markdown 文件的全部相对链接和 `skill://` 引用，均通过。
- v3.1.0 tarball（98 个文件）通过 npx 安装到含空格、且经 macOS `/tmp` 符号链接访问的临时路径，共 19 个技能；安装后的链接检查（55 个 markdown 文件）与两个 workloop 脚本的 help 均通过；本地 `Agent.md`、`AGENTS.md` 未进入制品。
- 踩坑规则在真实项目上试用：4 份复盘改写为 3 个条目，各条"怎么确认"检查均实际运行；在名为 `integration` 的目录下的检出中，按关键字判断的 conftest 跳过了 2968 个测试，改为按 marker 判断后这些测试正常运行。
- 两张 SVG 均由更新后的场景导出，并在浏览器中打开检查，所有节点和标签清晰可读。本次改动未在本机验证 Windows 和 Linux。

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

[3.1.0]: https://github.com/suntianc/paseo-matt-workloop/releases/tag/v3.1.0

[3.2.0]: https://github.com/suntianc/paseo-matt-workloop/releases/tag/v3.2.0

[3.2.1]: https://github.com/suntianc/paseo-matt-workloop/releases/tag/v3.2.1

[3.2.2]: https://github.com/suntianc/paseo-matt-workloop/releases/tag/v3.2.2

[4.0.0]: https://github.com/suntianc/paseo-matt-workloop/releases/tag/v4.0.0
