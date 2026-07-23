# Bugs And Risks

## Active blockers
- tracked negative-risk conversion 没有复制能力；当前形成不可执行义务并安全阻断。
- SPLIT 没有安全的 position projection/copy 语义，会触发 `UNSUPPORTED_TARGET_ACTIVITY + MAJOR_DESYNC`。
- 无法证明完整 outcome set、余额或定价的 MERGE 继续硬阻断；不会猜测资产集合或价格。
- 官方市场结束时间不可得时仅允许 bounded Paper，Live 继续拒绝。
- 新 Ruleset `v1.9.0` 尚无自然 Campaign 时长；旧核心 `4.84 h` 只能作诊断证据。自然 SELL/REALIZED_PNL 与最终 Observe 时长仍未完成。
- geoblock/compliance、隔离钱包、真实 signer、Live arming 和用户再次明确授权均未完成。

## Active risks
- 同一 `orderHash` 可跨多笔 Polygon 交易长期部分成交；昨晚 16 个目标 orderHash 中有 8 个跨交易，最长间隔约 2 小时 43 分。用户已确认按 `transactionHash + orderHash` 定义一次经济成交：同交易多 fill 合并，跨交易后续 fill 独立继续跟，以免等待订单终结导致数小时延迟或漏单。UI/报告必须明确这是经济成交次数，不是原始订单数。
- 小额追单次数、持仓周期和止损锁由现有不可变证据推导而不扩表。完整 SELL/等价 MERGE/REDEEM 只有在自身旧义务全部归零后才成为重置边界；无法证明时保守不重置。需要自然短测验证复杂交错顺序。
- Data API 不提供 `orderHash`。多 fill 归并以 Polygon 官方日志为准；跨源只在 transaction/asset/side/timestamp、总 size 和加权价格精确一致且只有一个 Polygon 订单候选时去重。API 时间或精度若不一致会 fail closed，可能牺牲跟单覆盖率但不会猜测合并。
- 每笔 `<1%` BUY 都可能放大到至少 `1 pUSD`，虽然单笔硬封顶 `5`、小额追单最多 `9`，仍需自然测试累计敞口、目标偏差和实际收益，不能用单元测试证明策略盈利。
- Polygon WebSocket 只是 wake hint，可能断线/乱序/漏消息；`1 s` 确认块扫描、Data API `3 s` 和 REST/Activity 仍是完整性兜底。2 个确认区块的速度/重组取舍仍需长测。
- target-maker canonical `OrderFilled` 路径已通过历史抽样，但特殊撮合路径仍需持续交叉确认。
- WAITING BUY 仍会每 `15 s` REST 兜底；完整证据采样和不可变审计库会持续增长。当前降低了重复写入并只保留 1 份迁移备份，但长期仍需 Campaign 归档和磁盘增长告警。
- `node:sqlite` 在 Node 24 仍有 experimental warning；需通过新核心长测观察。
- Data API offset、分页边界、短暂 Positions/Trades/Activity 不同步仍可能触发 gap recovery/reconciliation，不能为提高成交率降低完整性 Gate。
- 当前 Live 仅在隔离 fake 路径回归，真实 runtime 未接线；不能把单元测试等同实盘就绪。

## Resolved in current implementation
- 旧风控会因目标参考价高于 `0.95` 提前拒绝，即使自身实际成交价合法；当前新 Ruleset 只对自身含手续费实际 VWAP执行 `0.95` 上限，旧 Ruleset 行为保留。
- 小额金额曾可能被 available-cash cap 压到 `1 pUSD` 以下并成交；当前小额保持 1U 下限，现金不足整笔拒绝。
- MEDIUM 资本证据无 ratio 时曾无法分类并报 `BUY_FOLLOW_RATIO_EVIDENCE_UNAVAILABLE`；当前 fixed fallback 明确归为小额 BUY并保持1U。
- 市场最低量预检曾使用未按 tick 取整的105%上限，而实际撮合使用向下取整价，可能错误允许不足最低量的部分成交；当前预检和撮合共用同一可执行上限。
- 新 V4 曾可能重解释缺少 `smallFollowBuyMaxCount` 的 v1.7/v1.8 Ruleset；当前历史 V3/V2 金额证据、lineage、价格和 TARGET_SELL 语义均按旧 Ruleset执行，并有回归覆盖。
- TARGET_SELL 在新规则下曾因低于市场最小量被终止为 `CANCELLED`；当前 Ruleset 改为持续 `EXIT_PENDING`、保留真实尾仓且对相同约束证据去重。
- Polygon 同一 orderHash 的多个 fill 曾各自触发 Signal；当前在快速源先按 transaction+orderHash 聚合，并在唯一经济证据匹配时消除 Data API 重复。
- BUY 原先允许所有低价改善且使用 `2%/2 tick` 上限；当前新 Ruleset 严格执行目标价 90%—105%及实际价0.95上限，历史价格规则不变。

## Safety boundary
- 必须保持 `PAPER + LIVE_DISABLED + liveAllowed=false`。
- 未再次明确授权前，禁止 private key/seed、真实 signer、认证 CLOB client、submit/cancel、approve、真实 redeem、真实订单、真实资金和链上写入。
- 禁止覆盖历史失败证据、跨核心混算时长、降低数据/时钟/恢复/账本安全门或绕过 geoblock。
