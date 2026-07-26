# Progress

## Current task
- 按用户授权完成跨 Core 累计验证：旧 Core 固定有效 `12 h`，新 Core 需再取得有效 `12 h`；最终报告标记 `OWNER_AUTHORIZED_MIXED_CORE_AGGREGATION`，不得改写同 Core Campaign 的内建计时。
- 全程保持 `PAPER + LIVE_DISABLED + liveAllowed=false`；异常时先判断安全性和数据完整性，再决定修复、重启或停止。

## Implemented
- 新增 `OWNER_AUTHORIZED_EXTERNAL_FINALIZATION_EXCEPTION` 验收策略：只在完整计划时长、完整健康段、Observe 最终同步且无 gap/major desync、数据库一致性通过、外部市场数据已恢复、PAPER 安全门完整，并且 blocker 精确限定为最终估值超时时计入独立业主汇总；不会改写系统原始失败报告。
- Paper Campaign preflight 和 supervisor 启动前读取 `IOREG AppleClamshellState`：合盖时以 `MACBOOK_LID_CLOSED` fail closed，开盖或无 clamshell 的桌面设备才允许继续。
- `src/paper-validation/campaign-child-result.ts` 区分正常 Paper 报告与 Paper 失败 JSON；失败结果不会再被当作正常 `paper.report` 使用。
- supervisor 收尾路径识别失败/无效 Paper 与 Observe 报告，进入失败收尾并把 Paper 原始失败信息写入报告 payload。
- supervisor catch 对 pointer 写入失败做 best effort，保留原始错误并记录 `PAPER_CAMPAIGN_RECOVERY_POINTER_WRITE_FAILED`。
- 启动顺序先回收或安全冻结旧 core 的遗留 `RUNNING` Session，再按 core hash 创建 replacement，避免重复点击和残留 `RUNNING`。
- 新增受限 `--recover-only` supervisor 模式，只做遗留 Session 回收/安全冻结并退出，不创建新 Session、不启动 Paper/Observe。
- 新源码与回归测试已纳入 Core compatibility manifest。
- 2026-07-25 首次启动时，隔离套件中的重型 Shell 打包参数化用例在全套并发下触发默认 `5 s` 超时；已仅将该两组集成用例的显式时限调整为 `15 s`，不改生产逻辑或安全 Gate。

## Verification
- 用户授权例外红测先以 `paperOwnerAuthorizedFinalizationRuntimePolicy is not a function` 失败；实现后策略测试 `8/8`、TypeScript、全套 `56 files / 773 tests` 通过。
- 用第 2 轮真实指标执行策略得到 `accepted=true`、`creditedRuntimeMs=14,400,002`、`reasons=[]`。
- 新回归先红：`evaluatePaperCampaignPowerSafety is not a function`；实现后 `paper-campaign-clock-safety` `5/5` 通过。
- TypeScript 通过；相关 `4 files / 24 tests` 通过；全套 `56 files / 771 tests` 通过。
- 当前实机检查返回 `PASSED + lidState=OPEN`；`git diff --check` 通过。
- 失败测试先红：缺失 child-result 模块。
- 当前通过：TypeScript；相关测试 `5 files / 53 tests`；此前全量 `56 files / 769 tests` 通过；恢复工件清理后追加 Shell 生命周期测试 `2 files / 16 tests` 通过，`git diff --check` 通过。
- `--recover-only` 与恢复工件清理修复均已提交。
- 超时修复后，Shell 打包文件 `12/12` 通过；TypeScript 与全套 `56 files / 769 tests` 通过。

## Runtime state
- 当前无 Observe/Paper/Supervisor/launcher 进程，operator lock、marker、FIFO 均已清理。
- 旧 Core 固定计入 `43,200,006 ms`；新 Core 第 1 轮正常计入 `14,400,002 ms`。
- 新 Core 第 2 轮 `PS-8B337FF558CBBFA6BAD7` 运行满 `4 h`，但收尾市场数据超时导致 `FINAL_DRAIN_INCOMPLETE`，`countsTowardCampaign=false`，Campaign `PC-1FA2F49244FE2B7BE43D` 已 `BLOCKED`。
- 第 2 轮 Observe 有 `8,200` 次成功轮询、`16` 次失败轮询、`6` 个事件、`2` 个 Signal、`0` 个 scheduling gap，最终对账 `SYNCED`；Paper 的 3 个持仓因最终估值不可用保守冻结。公共 API 随后已恢复。
- 第 2 轮按用户授权外部收尾例外计入独立汇总；当前用户口径累计 `72,000,010 ms`，还缺 `14,399,990 ms`。
- 数据库 Schema `2.30.0`、`quick_check=ok`、外键问题 `0`，Live 数据全为 `0`，安全 Gate 未变化。

## Next steps
1. 提交已验证的业主例外策略；保留第 2 轮原始失败证据。
2. 保持 MacBook 开盖，通过正式 Terminal 入口创建新 Core replacement 并运行最后一轮约 `4 h`。
3. 每小时检查一次，正常时静默；完成后生成跨 Core/业主例外累计报告和 ZIP。
