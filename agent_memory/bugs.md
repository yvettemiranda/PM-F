# Bugs And Risks

## Active blockers
- Data API Trades/Activity 在 offset 超过 3000 时返回上限错误；当前历史样本不是完整钱包历史，不能用当前 Positions 倒推历史起点。
- 141 条 Position Baseline 是当前启动快照，只适用于快照之后的增量监控；不能冒充历史 Replay 窗口开始时的仓位。
- 历史 BUY 缺少交易时点 pUSD/Positions 快照，只能保存 `INCOMPLETE/MEDIUM` 和 10 pUSD fallback，不能生成历史比例资金结果。
- Golden 1-5 已 `APPROVED/MATCH/PASSED`；该门禁已解除，但不消除历史数据不完整和前向 baseline 验证不足。

## Active risks
- 事件分类依赖 Replay gap/baseline 上下文，已从 raw event 单值字段迁移为 `replay_event_classifications` 版本化投影；raw event 上的旧分类列不应作为权威读取来源。
- 生产 Trades 偶发完全相同重复行；仅 Activity 第二来源唯一对应时确认去重，否则 `AMBIGUOUS_DUPLICATE_EVENTS`。
- 同一 transaction hash 可包含多条真实 fill；交易 source key 包含 wallet、tx、condition、asset、side、price、size、timestamp 和 identity version。
- 非 TRADE Activity 的数值字段可能出现 JSON number 浮点展开；其身份键保存原始字符串，normalized price/size 不参与交易仓位计算，完整 payload 保存在 capture/raw JSON。
- 当前使用 Node.js 内置 `node:sqlite`，仍有 experimental warning；进入长期运行前需锁定 Node 版本或切换成熟驱动。
- 公开钱包交易仍依赖 Data API 增量轮询，Market WebSocket 只用于盘口；不得描述为钱包成交推送。

## Safety boundary
- 当前只实现监控层与验证工具，不存在 Paper/Live Executor。
- `executionEligible=false` 是未来 Paper/Live 必须同步检查的硬门禁；断线、组合、未识别事件不得进入执行层。
- 当前地址和可选第二地址仅授权读取公开数据；不读取私钥、不创建订单、不做链上写操作。
- Phase 0.5 未通过前禁止 Paper；Paper 未通过且用户未再次明确授权前禁止 Live。
