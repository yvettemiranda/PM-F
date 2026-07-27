# Progress

## Current task
- Paper 跨 Core 累计 24 小时验证已经完成；当前只保留最终证据和进入小额 Live 前的独立阻断项。
- 最终报告标记 `OWNER_AUTHORIZED_MIXED_CORE_AGGREGATION` 与 `OWNER_AUTHORIZED_EXTERNAL_FINALIZATION_EXCEPTION`，且没有改写原始数据库或同 Core Campaign 的内建计时。
- 已完成 Paper/Live 运行时交接与最终估值恢复修复：同一 Paper 账户和 baseline 可在安全 replacement 中承接旧仓位；最终 drain/估值有界重试；估值未完成时新 BUY 延后且不消费；Live 仅保留禁用态交接与隔离恢复。

## Implemented
- Risk Manager 现在把 `POLYGON_TRADE_FEED_UNSAFE` 事故限定到事故所属 Observe Run：新 Run 的 Signal 不再被旧 Run 的事故误拒绝，同时旧事故记录保持 `OPEN`，同 Run、归属缺失/损坏及其他 `MAJOR_DESYNC` 继续硬阻断。
- Polygon confirmed-cursor 恢复现在先二次读取同一区块，过滤负载均衡节点的一次性链视图不一致；确认重组后，仅在上一锚点仍匹配且被重组批次没有目标成交时回退并重扫，同时把 reorg recovery 固化进 Polygon capture。存在已发布目标成交或更深重组时继续硬阻断。
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
- 事故范围红测先稳定复现：上一 Observe Run 的 `POLYGON_TRADE_FEED_UNSAFE` 使当前 Run BUY 进入 `REJECTED`；修复后当前 Run BUY `EXECUTED`，事故所属旧 Run 的 BUY 仍以原事故 ID 拒绝，旧事故记录未改写。Paper Executor `122/122`、TypeScript、全套 `56 files / 777 tests` 和 `git diff --check` 通过。
- Polygon 重组恢复红测先以 `POLYGON_TRADE_FEED_CONFIRMED_REORG:0x65` 失败；实现后定向 `2 files / 66 tests`、TypeScript、全套 `56 files / 776 tests` 通过。额外覆盖单次 RPC 哈希不一致可恢复，以及已发布目标成交后重组仍拒绝。
- 用户授权例外红测先以 `paperOwnerAuthorizedFinalizationRuntimePolicy is not a function` 失败；实现后策略测试 `8/8`、TypeScript、全套 `56 files / 773 tests` 通过。
- 用第 2 轮真实指标执行策略得到 `accepted=true`、`creditedRuntimeMs=14,400,002`、`reasons=[]`。
- 新回归先红：`evaluatePaperCampaignPowerSafety is not a function`；实现后 `paper-campaign-clock-safety` `5/5` 通过。
- TypeScript 通过；相关 `4 files / 24 tests` 通过；全套 `56 files / 771 tests` 通过。
- 当前实机检查返回 `PASSED + lidState=OPEN`；`git diff --check` 通过。
- 失败测试先红：缺失 child-result 模块。
- 当前通过：TypeScript；相关测试 `5 files / 53 tests`；此前全量 `56 files / 769 tests` 通过；恢复工件清理后追加 Shell 生命周期测试 `2 files / 16 tests` 通过，`git diff --check` 通过。
- `--recover-only` 与恢复工件清理修复均已提交。
- 超时修复后，Shell 打包文件 `12/12` 通过；TypeScript 与全套 `56 files / 769 tests` 通过。
- 本次运行时交接/估值恢复改动完成后，TypeScript 通过；定向 Campaign/Live 风险测试 `2 files / 40 tests` 通过；全套 `56 files / 784 tests` 通过；`git diff --check` 通过。

## Runtime state
- 当前无 Observe/Paper/Supervisor/launcher 进程，operator lock、marker、FIFO 均已清理。
- 最终 `PC-53F4B34D814FCDDFB663 / PS-04B30EBA4C1C49656AF7` 正常完成并计入 `14,400,002 ms`；独立业主累计为 `86,400,012 ms`，达到 24 小时。
- 最终轮 `25` 个事件、`13` 个 Signal、`11` 个可执行 BUY 全部 Risk ALLOW 并被 Paper 消费；因安全限价/截止时间，`1,239` 个订单均零成交，当前无 Paper 持仓、手续费或盈亏。
- Observe 最终 `SYNCED`，scheduling gap/major desync 为 `0`；数据库 Schema `2.30.0`、`quick_check=ok`、外键问题 `0`。
- `PAPER + LIVE_DISABLED + liveAllowed=false` 保持不变，Live execution/order/attempt/fill 全为 `0`。
- 最终报告：`data/operator/final-reports/ni-k-paper-mixed-core-24h-final-20260727-0300.md`。

## Next steps
1. 本次代码修复提交后，不再自动启动 Paper/Live；现有 24 小时历史证据不改写。
2. 在考虑小额 Live 前，单独完成合规/geoblock、隔离钱包、真实 signer、Live runtime 接线与 arming 审计，并取得用户再次明确授权；当前 Live 仍是 `LIVE_DISABLED`。
3. 若需要更强自然覆盖，应另开 Paper Campaign 等待自然 FILL/SELL/PnL 样本；不得因此放宽价格或风控。
