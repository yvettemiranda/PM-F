# Context

## Project
- Workspace: `/Users/d4clt/Documents/Codex/2026-07-07/ni-k`
- Purpose: 独立设计和后续实现 Polymarket Copy Trading System。

## Constraints
- `ni-k` 与旧版 PolymarketBot 完全独立；不引用、不迁移、不复用旧项目代码、账本、风控、页面或交易逻辑。
- 当前实现 Phase 0.5 钱包监控与信号生成层验证；禁止 Paper/Live、私钥接入、模拟/真实订单和链上写操作。
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
