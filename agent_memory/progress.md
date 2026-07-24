# Progress

## Current task
- 修复本轮 macOS TCC 导致的 Paper 异常退出、失败原因被覆盖和 Campaign 遗留 `RUNNING` 状态。
- 审计当前 Session 数据，保持 `PAPER + LIVE_DISABLED + liveAllowed=false`，不启动新 Paper。

## Implemented
- `src/paper-validation/campaign-child-result.ts` 区分正常 Paper 报告与 Paper 失败 JSON；失败结果不会再被当作正常 `paper.report` 使用。
- supervisor 收尾路径识别失败/无效 Paper 与 Observe 报告，进入失败收尾并把 Paper 原始失败信息写入报告 payload。
- supervisor catch 对 pointer 写入失败做 best effort，保留原始错误并记录 `PAPER_CAMPAIGN_RECOVERY_POINTER_WRITE_FAILED`。
- 启动顺序先回收或安全冻结旧 core 的遗留 `RUNNING` Session，再按 core hash 创建 replacement，避免重复点击和残留 `RUNNING`。
- 新增受限 `--recover-only` supervisor 模式，只做遗留 Session 回收/安全冻结并退出，不创建新 Session、不启动 Paper/Observe。
- 新源码与回归测试已纳入 Core compatibility manifest。

## Verification
- 失败测试先红：缺失 child-result 模块。
- 当前通过：TypeScript；相关测试 `5 files / 53 tests`；此前全量 `56 files / 769 tests` 通过；恢复工件清理后追加 Shell 生命周期测试 `2 files / 16 tests` 通过，`git diff --check` 通过。
- `--recover-only` 与恢复工件清理修复均已提交；本次最终只变更项目记忆文件，不影响运行时代码。

## Runtime state
- 当前无 Observe/Paper/Supervisor/launcher 进程，operator lock、marker、FIFO 均已清理。
- `PC-2EB95BD31A8EB9693837 / PS-58AB7048A91D8264E009` 运行约 2 小时 52 分后异常结束：Observe 结果最终 `SYNCED`，Paper 失败为 `unable to open database file`；macOS System Policy/TCC 同时拒绝 WAL 与 operator pointer 访问。
- `--recover-only` 已安全将旧 Session 标记 `BLOCKED`、旧 Campaign 标记 `FROZEN`；正式 Session/Campaign 报告和 ZIP 不生成，数据库 Schema `2.30.0`、`quick_check=ok`、外键问题 `0`，安全 Gate 未变化。

## Next steps
1. 保持当前旧 Campaign 只作为冻结失败证据，不把这次时长计入新 core 的 4 小时门槛。
2. 先让启动程序获得 macOS `Documents` 访问权限，再从干净新提交创建新 Campaign。
3. 从干净新提交创建新 Campaign，重新累计自然 Paper。
