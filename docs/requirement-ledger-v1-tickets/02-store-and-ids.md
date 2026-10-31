# 02 台账存储、编号分配、锁与审计

**Blocked by:** 01
**Scope:** skills/requirement-ledger/scripts/,skills/requirement-ledger/reference/storage.md
**Maps to:** E1（建档部分）、E7（医生部分）、R2

**Goal：** 实现 `.requirements/` 文件台账底座：编号分配、原子写、项目锁、审计日志、`new/list/show/retire` 与 `doctor` 基础检查。

## Acceptance criteria
- [ ] AC1: `req new` 在 `$WORKLOOP_ROOT/<project>/.requirements/` 创建 `REQ-<n>-<slug>.md`（Markdown+YAML），并生成/更新 `_meta.json`；`- [ ]` 编号从 `REQ-001` 起、最小 3 位补零。— check: `node --test skills/requirement-ledger/scripts/test/store.test.mjs`
- [ ] AC2: 分配顺序为**先持久化 `lastIssued`、再建文件**；模拟“仅 `_meta` 成功、文件失败”后重跑，编号出现空缺但**不回退、不复用**。
- [ ] AC3: 写盘为同目录 temp+`rename`；模拟并发/中断，读者永不见半截文件；关键元数据写入含 `fsync(tmp)` 与 `fsync(dir)`（R2）。
- [ ] AC4: 项目锁 `.requirements/.lock` 独占创建（`wx`+pid）；陈旧锁按 pid 存活判定；**无法确认失效则拒绝接管**。
- [ ] AC5: `_log.jsonl` 仅审计；主文件成功而日志 append 失败时，`doctor` 报“审计缺口”，`req doctor --repair-log` 可补记且不改正文。
- [ ] AC6: `req list` / `req show` / `req retire` 正确；retire 保留文件与编号，`list` 默认可显示状态。
- [ ] AC7: `doctor` 基础检查：重复 `id`、无效 frontmatter、`lastIssued` 与现存文件不一致（只向保守方向修复，永不调低/复用）。

**Keep as is:** 其它 skill 的脚本互不影响。
**Not in this change:** 不实现 lookup/context/link/sync（T3–T5）；不建 SQLite。
