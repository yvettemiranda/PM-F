# Context

## Project
- Workspace: `/Users/d4clt/Documents/Codex/2026-07-07/ni-k`
- Purpose: 独立设计和后续实现 Polymarket Copy Trading System。

## Constraints
- `ni-k` 与旧版 PolymarketBot 完全独立；不引用、不迁移、不复用旧项目代码、账本、风控、页面或交易逻辑。
- 当前处于 Phase 5 Operational Validation Framework 已实现后的状态；允许 Paper 模拟账户、模拟订单和模拟成交，允许 Live Gate 安全检查/状态机/审计占位，允许 Live Executor 使用 fake/disabled adapters 进行代码正确性测试，允许 Final/Operational Validation 在 isolated snapshot database 中运行 fake path、故障注入、心跳、健康检查、shadow risk observation 和 dedicated Paper validation account；继续禁止真实私钥、默认真实订单、默认认证交易接口、approve、真实 redeem 和链上写操作。
- 新项目按三层架构设计：钱包监控与信号生成层、模拟交易层、实盘交易层。
- 第一版只支持一个 Polymarket Profile / Proxy Wallet 地址。
- 第一阶段优先完成监控、信号、自然语言解释、标准化事件、模拟交易、日志和状态机；不优先开发实盘。
- 默认使用中文沟通，技术标识保持原文。
- 对未确认内容明确标注，不把推测当结论。

## Current target
- Public Profile / Proxy Wallet: `0x0c0e270cf879583d6a0142fc817e05b768d0434e`。
- 该地址仅用于读取公开数据，不代表任何私钥、资金或交易授权。

## Validation
- 最小验证集：TypeScript 类型检查、单元/事务测试、真实公开 API 契约采样、Replay Hash 确定性、SQLite `integrity_check` 与 `foreign_key_check`。
- Replay 只有在身份、数据契约、Golden 样本、资金/仓位基线、幂等、状态机、崩溃恢复和历史复现全部通过后才可标记 `PASSED`。
- 当前价格采用 18 位、份额采用 6 位定点整数；禁止静默截断外部小数。
- Signal 只描述目标钱包行为；`executionEligible` 是监控层给未来执行层的硬门禁，不是 Execution 状态。断线期间生成行为 Signal，但必须为 `false` 且原因是 `GAP_EVENT`。
- Position Baseline 使用历史/跟踪双桶；卖出优先减少启动后跟踪桶，不足部分再减少历史桶，SELL Ratio 只使用跟踪桶。
- Observe Only 使用 Trades 与 Activity 双源归一化交易；Activity 先到、Trades 后到时共享交易幂等键，后到数据只计重复。REDEEM 更新仓位投影但不生成交易 Signal。
- Observe checkpoint 保存事件游标、replay state、投影 hash 和资金快照；恢复窗口事件仍生成行为 Signal，但固定 `executionEligible=false/GAP_EVENT`。
- Observe Paper Gate 允许已恢复的 API 失败和最终已恢复的短暂 `MINOR_DIFF`，但会保留 warning；未恢复连接 gap、checkpoint 投影 hash 不一致、任何 `MAJOR_DESYNC` 或最终非 `SYNCED` 都是硬阻断。
- 用户已明确将 24 小时 Observe Only soak 从 Paper 硬门禁延期为 Live Gate 前置项；短时 Observe 状态记为 `SHORT_SOAK_PASSED`，延期不代表取消。
- Paper 只能消费 `PUBLISHED && executionEligible=true` 的 Signal 及其不可变 `signal_execution_context`，禁止读取 `raw_events`。Paper 与未来 Live 必须使用同一份 Signal + Execution Context 输入，并先经过 Risk Manager，再进入 Executor Interface。
- Live Executor 目前仅有安全占位实现，所有交易入口固定抛出 `LIVE_EXECUTOR_NOT_IMPLEMENTED`，不得放入私钥、认证客户端或真实订单逻辑。
- Position 支持 `FROZEN` 保护态；冻结期间禁止新增仓位、自动卖出和自动止损，只能在 reconciliation 成功后恢复到冻结前的可持仓状态。
- Settlement 已拆为 `SettlementService`；结果未确认时只进入/保持 `SETTLEMENT_PENDING`，不得提前计算最终盈亏或 redeem。
- Unrealized PnL 必须使用完整深度可退出 VWAP 减成本和退出费用，记录 price source、timestamp 与 fee；禁止使用 Last Price 或页面价格。
- 关键行为必须写入不可变 `audit_log`；Risk 决策必须写入 `risk_decisions`，每条 Paper Execution 必须引用 `risk_decision_id`。系统触发的止损和结算也生成系统级 Risk Decision，Execution/Position/Settlement 等核心对象记录 `ruleset_hash`、`source_code_commit`、`config_version`。
- 当前规则参数必须写入 `ruleset_registry`，并通过 `ruleset_hash` 关联 Signal Context、Execution、Position 和 Settlement；历史对象不得被当前配置覆盖解释。
- 账户状态统一通过 `PortfolioProjectionService` 从 ledger/position/PnL 计算并落库到 `portfolio_projection_runs`；Report/UI/其他模块不得绕过该投影层自行计算余额、敞口或权益。
- 资金估算同时保存 `capitalEstimateStatus=COMPLETE/INCOMPLETE/FAILED` 和 `capitalConfidence=HIGH/MEDIUM/LOW`；MEDIUM 使用 10 pUSD fallback，LOW 禁止进入执行阶段。
- Golden Expectations 必须先生成 `CANDIDATE`，只有用户人工确认后才能变更为 `APPROVED` 并参与 Golden Passed。

## Confirmed defaults
- 断线交易只记录、不补跟，但用于修正后续目标地址净持仓；同步分为 `SYNCED / MINOR_DIFF / MAJOR_DESYNC`。
- `BUY_EXECUTION_MODE` 第一版为 `FAK`，设计上预留 `FOK`、`LIMIT_WAIT`，不得写死执行模式。
- 买入等待时间为 `min(市场剩余时间 × WAIT_RATIO, MAX_WAIT_TIME)`；默认 `WAIT_RATIO=0.5`、`MAX_WAIT_TIME=30分钟`。
- 买入价格标准模式为目标价 `0.98` 到 `1.02`；范围外标记 `SIGNAL_EXPIRED`。
- 普通跟卖默认最大滑点 10%，超出进入 `EXIT_PENDING`；止损默认最大滑点 15%，超出进入 `STOP_EXIT_PENDING`；两者持续尝试但禁止无限滑点。
- 止损判断使用整笔待卖份额按当前订单簿深度计算的实际可成交 VWAP，不使用 Last Price、页面价格或最近成交价。
- 实盘风险上限：单市场 20%、总敞口 50%、单日最大亏损 5%、连续亏损 5 次暂停；全部参数化，模拟模式不被这些新增实盘上限阻断。
- 目标可见资金为公开持仓市值加 Proxy Wallet 链上 pUSD 可用余额；失败时固定跟买 10 pUSD。
- 模拟账户初始资金为 1000 pUSD。
- 实盘使用隔离钱包和系统安全存储，不保存明文私钥；小额实盘测试必须再次获得明确授权。
- 仅监听 `127.0.0.1`、单实例、不开放公网或局域网；实盘前执行官方 geoblock 检查。
- 模拟交易开发前必须先完成 Phase 0：API 契约验证、第一层数据模型验证、Replay Engine、第一层 SQLite 初始化设计和 Replay Report；Replay 未通过不得进入第二层。
- Phase 0 增加 Wallet Identity Report；钱包类型无法以充分证据确认时进入 `IDENTITY_UNKNOWN`，不得生成可执行信号。
- 核心对象必须记录 `schema_version`、`signal_version`、`strategy_version`、`risk_version`、`replay_version`，并保存不可变规则快照，保证历史复现。
- 同步等级调整为 `SYNCED / MINOR_DIFF / MAJOR_DESYNC`，使用可配置容差和持续次数判断；份额绝对容差当前为 0.1 share，用于覆盖 Positions 不返回的尘埃仓位。
- 目标资金快照与目标交易时间差不得超过默认 5 分钟；超时标记 `INCOMPLETE` 并使用 10 pUSD 兜底。
- 实时运行模式为 `OBSERVE_ONLY / PAPER / LIVE`；Replay 是独立验证任务，不属于运行模式。
- 采用保守同步策略：`MINOR_DIFF` 下 Paper 正常、Live 禁止新增开仓但允许退出和对账；`MAJOR_DESYNC` 停止所有新增交易并继续监控、对账和风险处理。
- Signal 只描述目标钱包行为；Paper/Live 分别维护独立 Execution 状态，Paper 结果不得影响 Live。
- 所有关键事件、信号和执行动作必须有稳定幂等键；重启、重叠拉取和重复消息不得产生重复信号或动作。
- 架构采用实时盘口 WebSocket、目标钱包 Data API 增量轮询和持久化事件队列；REST 不得直接触发交易动作。
- 所有外部请求必须具备 timeout、有限重试、指数退避、jitter 和限流；关键时间使用 UTC 并记录服务器时钟偏移、数据新鲜度和端到端延迟。
- 优化优先级固定为正确性高于安全性、高于稳定性、高于延迟；不得为了低延迟绕过确认、幂等、状态机或风控。
- Phase 0、Replay、Observe Only、Paper 仅本机 `127.0.0.1` 运行；Live 部署位置以后单独评估。
- Paper 盘口只读公开无认证 CLOB market data，必须使用完整深度 VWAP 和 2 秒新鲜度门禁；不得调用认证 user channel 或任何下单端点。
- Live Gate 默认状态必须保持 `execution_mode=PAPER` 且 `live_gate_state=LIVE_DISABLED`；`LIVE_ACTIVE` 重启后必须降级为 `LIVE_ARMING` 并重新 preflight + 人工确认。
- Live Gate 只接受已有 `RiskDecision=ALLOW`，不得重新计算或替代 Risk Manager 决策；`RiskManager` 仍只输出 `ALLOW/REJECT`。
- `live_wallets` 只保存钱包元数据，不保存 private key、seed phrase、signer 或真实交易能力字段。
- Phase 3 引入官方 `@polymarket/clob-client-v2` 与 `viem` 依赖；`PolymarketClobAdapter` 只是显式 adapter seam，不得默认实例化真实 signer 或真实 CLOB client。
- Live Executor 默认依赖 `DisabledSigner`、`DisabledOrderAdapter`、`DisabledWalletProvider`、`DisabledRedeemAdapter`；测试可以使用 fake gate/fake signer/fake wallet/fake order/fake redeem。
- Live Executor 必须调用 `LiveGateService.checkExecution()` 或等价 gate seam，且只接受 `RiskDecision=ALLOW`；不得自行重算 Risk Decision。
- Live allowance 当前只读；allowance 不足记录 `ALLOWANCE_INSUFFICIENT` 并阻断，禁止自动 approve 或 increaseAllowance。
- Phase 4 Validation Framework 默认复制源 SQLite 到 `data/validation/<session-id>/` 后运行；Validation 只允许写 validation 表或 snapshot DB，不能污染业务数据。`validate:final` 的最高状态是 `VALIDATION_FRAMEWORK_READY` 且 `liveAllowed=false`，不等同于 Live Gate 通过。
- Phase 5 Operational Validation Framework 默认复制源 SQLite 到 `data/operational/<run-id>/` 后运行；Operational Runner 支持 `health_monitor`、`consistency_monitor`、`observe_only`、`paper_validation`、`crash_recovery`，写入心跳、健康快照、checkpoint、异常、一致性结果、shadow risk observation 和报告。Observe operational 不写正式 `risk_decisions`；Paper operational 使用 dedicated Paper validation account 和 fake market data；mutating mode 禁止 `--no-snapshot`。最高默认状态是 `OPERATIONAL_FRAMEWORK_READY` 且 `liveAllowed=false`，不等同于长周期 soak 或 Live Gate 通过。
