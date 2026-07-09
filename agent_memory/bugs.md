# Bugs And Risks

## Active blockers
- Data API Trades/Activity 在 offset 超过 3000 时返回上限错误；当前历史样本不是完整钱包历史，不能用当前 Positions 倒推历史起点。
- 141 条 Position Baseline 是当前启动快照，只适用于快照之后的增量监控；不能冒充历史 Replay 窗口开始时的仓位。
- 历史 BUY 缺少交易时点 pUSD/Positions 快照，只能保存 `INCOMPLETE/MEDIUM` 和 10 pUSD fallback，不能生成历史比例资金结果。
- Golden 1-5 已 `APPROVED/MATCH/PASSED`；该门禁已解除，但不消除历史数据不完整和前向 baseline 验证不足。
- Observe Only 只完成短时真实运行，24 小时验证已由用户延期到 Live Gate 前；当前不能证明长期稳定，也绝不能据此打开 Live Gate。
- Phase 1A 自动化验证和架构优化不等于 Phase 1B Paper 稳定性验收；在持续新 Signal 模拟运行前不得标记 Paper Passed。
- Phase 2 Live Gate Safety Layer 只实现安全门和审计链路，不代表 Live Gate 已通过；所有 `live_gate_prerequisites` 默认 `PENDING`，不得手动绕过长期验收和用户再次授权。

## Active risks
- 事件分类依赖 Replay gap/baseline 上下文，已从 raw event 单值字段迁移为 `replay_event_classifications` 版本化投影；raw event 上的旧分类列不应作为权威读取来源。
- 生产 Trades 偶发完全相同重复行；仅 Activity 第二来源唯一对应时确认去重，否则 `AMBIGUOUS_DUPLICATE_EVENTS`。
- 同一 transaction hash 可包含多条真实 fill；交易 source key 包含 wallet、tx、condition、asset、side、price、size、timestamp 和 identity version。
- 非 TRADE Activity 的数值字段可能出现 JSON number 浮点展开；其身份键保存原始字符串，normalized price/size 不参与交易仓位计算，完整 payload 保存在 capture/raw JSON。
- 当前使用 Node.js 内置 `node:sqlite`，仍有 experimental warning；进入长期运行前需锁定 Node 版本或切换成熟驱动。
- 公开钱包交易仍依赖 Data API 增量轮询，Market WebSocket 只用于盘口；不得描述为钱包成交推送。
- Activity 的 TRADE 可能早于 Trades 可见；Observe 已用同一交易幂等键融合两源。若两源字段不完整或不一致，必须保留 reconciliation 异常，不得自动改仓。
- Positions 也可能短暂领先 Trades/Activity；短暂差异先标记 `MINOR_DIFF`，连续 3 次才升级 `MAJOR_DESYNC`。只有最终恢复为 `SYNCED` 时才视为已恢复，不能用自动改仓掩盖。
- Node.js `node:sqlite` experimental warning 仍存在；24 小时 soak 需同时观察驱动稳定性和 WAL/锁行为。
- 公开 REST orderbook 的源时间可能因盘口未变化而超过 2 秒；当前严格按需求标记 `ORDERBOOK_STALE` 并拒绝成交，Phase 1B 需观察该门禁对成交率的影响，不能偷偷放宽。
- CLOB 费率采用公开 `clob-markets/{condition}` 返回的 `fd.r/fd.e` 曲线快照；未知 exponent 或数据缺失时固定 `FEE_MODEL_UNAVAILABLE`，不得默认为零费率。
- Live Executor 目前只有安全占位；后续不得复制 Paper 成交实现直接接入真实下单，必须复用统一输入、Risk Manager、Executor Interface、Audit Log 和版本快照。
- `FROZEN` Position 会阻断新增仓位、自动卖出和自动止损；Phase 1B 需要验证 reconciliation 成功恢复路径不会误解冻仍存在异常的数据。
- Portfolio Projection 目前已从 ledger/position/PnL 统一计算账户状态；后续 Report/UI 必须读投影服务或投影表，不能重新实现余额、敞口或权益计算。
- Ruleset Registry 已保存当前规则参数；后续修改买入范围、等待时间、止损或费率模型时必须新增/保留可解释的规则版本，不能覆盖历史 `ruleset_hash`。
- `schemaVersion` 从 `2.2.0` 升到 `2.3.0`，`RULESET_HASH` 会随版本快照变化；历史对象必须继续按其原始 `ruleset_hash` 解释，不能用当前 hash 覆盖历史行为。
- Live Gate 当前只允许 `MOCK` 或 `PAPER` balance provider；后续真实余额接入必须单独设计为只读能力，并继续禁止在同一阶段引入签名或下单能力。

## Safety boundary
- 当前已存在 Paper Executor，但只允许模拟账户、模拟订单和模拟成交；Live Executor 仍未实现交易逻辑。
- `executionEligible=false` 是 Paper/Live 必须同步检查的硬门禁；断线、组合、未识别事件不得进入执行层。
- 当前地址和可选第二地址仅授权读取公开数据；不读取私钥、不创建真实订单、不做链上写操作。
- Phase 1B Paper 长期验证未通过且用户未再次明确授权前禁止 Live。
- `LIVE_ACTIVE` 即使曾被持久化，程序重启后也必须降级回 `LIVE_ARMING`，不得自动恢复真实执行状态。
