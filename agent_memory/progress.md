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
- 当前通过：TypeScript；相关测试 `5 files / 53 tests`；此前全量 `56 files / 769 tests` 通过。
- `--recover-only` 增量修复尚未提交；全量测试需在该增量后重跑。

## Runtime state
- 当前无 Observe/Paper/Supervisor/launcher 进程。
- `PC-2EB95BD31A8EB9693837 / PS-58AB7048A91D8264E009` 运行约 2 小时 52 分后异常结束：Observe 结果最终 `SYNCED`，Paper 失败为 `unable to open database file`；macOS System Policy/TCC 同时拒绝 WAL 与 operator pointer 访问。
- 正式 Session/Campaign 报告和 ZIP 未生成；数据库仍为 Schema `2.30.0`、`quick_check=ok`、外键问题 `0`，安全 Gate 未变化。

## Next steps
1. 完成增量全量测试、`git diff --check` 和静态审查，提交当前修复。
2. 先让启动程序获得 macOS `Documents` 访问权限，再安全回收本次遗留 Session；不把这次时长计入新 core 的 4 小时门槛。
3. 从干净新提交创建新 Campaign，重新累计自然 Paper。
