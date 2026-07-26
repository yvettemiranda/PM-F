# Progress

## Current task
- 修复 MacBook 合盖状态下仍可启动 Paper Campaign 的问题，从修复后新 Core 重新累计满 24 小时；每轮最多 4 小时，每小时检查一次，正常时静默，轮换和修复时间不计入有效时长。
- 全程保持 `PAPER + LIVE_DISABLED + liveAllowed=false`；异常时先判断安全性和数据完整性，再决定修复、重启或停止。

## Implemented
- Paper Campaign preflight 和 supervisor 启动前读取 `IOREG AppleClamshellState`：合盖时以 `MACBOOK_LID_CLOSED` fail closed，开盖或无 clamshell 的桌面设备才允许继续。
- `src/paper-validation/campaign-child-result.ts` 区分正常 Paper 报告与 Paper 失败 JSON；失败结果不会再被当作正常 `paper.report` 使用。
- supervisor 收尾路径识别失败/无效 Paper 与 Observe 报告，进入失败收尾并把 Paper 原始失败信息写入报告 payload。
- supervisor catch 对 pointer 写入失败做 best effort，保留原始错误并记录 `PAPER_CAMPAIGN_RECOVERY_POINTER_WRITE_FAILED`。
- 启动顺序先回收或安全冻结旧 core 的遗留 `RUNNING` Session，再按 core hash 创建 replacement，避免重复点击和残留 `RUNNING`。
- 新增受限 `--recover-only` supervisor 模式，只做遗留 Session 回收/安全冻结并退出，不创建新 Session、不启动 Paper/Observe。
- 新源码与回归测试已纳入 Core compatibility manifest。
- 2026-07-25 首次启动时，隔离套件中的重型 Shell 打包参数化用例在全套并发下触发默认 `5 s` 超时；已仅将该两组集成用例的显式时限调整为 `15 s`，不改生产逻辑或安全 Gate。

## Verification
- 新回归先红：`evaluatePaperCampaignPowerSafety is not a function`；实现后 `paper-campaign-clock-safety` `5/5` 通过。
- TypeScript 通过；相关 `4 files / 24 tests` 通过；全套 `56 files / 771 tests` 通过。
- 当前实机检查返回 `PASSED + lidState=OPEN`；`git diff --check` 通过。
- 失败测试先红：缺失 child-result 模块。
- 当前通过：TypeScript；相关测试 `5 files / 53 tests`；此前全量 `56 files / 769 tests` 通过；恢复工件清理后追加 Shell 生命周期测试 `2 files / 16 tests` 通过，`git diff --check` 通过。
- `--recover-only` 与恢复工件清理修复均已提交。
- 超时修复后，Shell 打包文件 `12/12` 通过；TypeScript 与全套 `56 files / 769 tests` 通过。

## Runtime state
- 当前无 Observe/Paper/Supervisor/launcher 进程，operator lock、marker、FIFO 均已清理。
- `PC-A1C63D1657110D955029` 前三轮累计有效 `12 h`；第四轮因 2026-07-26 03:08—09:13 合盖 Deep Idle 失败，`0 h` 计入并将旧 Campaign 标记 `BLOCKED`。
- 失败轮 Observe 仅 `133` 次成功轮询、`3` 次 API 超时、`13` 个 scheduling gap，最终对账 `SYNCED`；Paper 为 `FINAL_DRAIN_INCOMPLETE`，9 个持仓因市场数据不可用保守冻结。
- 数据库 Schema `2.30.0`、`quick_check=ok`、外键问题 `0`，Live 数据全为 `0`，安全 Gate 未变化。

## Next steps
1. 完成合盖保护回归、全量验证并提交，保留旧 Campaign 的失败证据，不跨 Core 混算旧 12 小时。
2. 保持 MacBook 开盖，从干净提交通过独立 Terminal 正式入口创建 replacement Campaign。
3. 每小时检查一次；每个 4 小时 Session 正常结束后立即续开，直到新 Core 有效累计满 24 小时。
