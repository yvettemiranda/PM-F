# Bugs And Risks

## Active blockers
- Data API Trades 和 Activity 在 offset 超过 3000 时返回 `max historical activity offset of 3000 exceeded`；当前 4000/3500 行都不是完整历史，不能据此声称重建了钱包全部仓位。
- 缺少交易时点历史资金快照，562 个买入信号的 capital 状态必须保持 `INCOMPLETE`，不能用当前余额冒充历史余额。
- 缺少启动时 Position Baseline；当前 3388 个无可识别本地前置仓位的卖出只能计为 `historicalSells`，不能生成跟卖信号。
- 缺少人工 Golden Expectations，尚未证明所有真实边界样本的买卖识别、卖出比例和断线处理正确。
- 当前 `source_code_commit=UNCOMMITTED`，不满足历史结果按源码提交复现的最终门禁。
- Phase 0.5 待确认：目标卖出同时存在历史 baseline 和启动后新增仓位时，采用 historical-first、tracked-first 还是比例分摊；该选择会直接改变 SELL Signal。
- Phase 0.5 待确认：断线期间交易是完全不生成 Signal，还是生成仅描述目标行为但不可被 Execution 消费的 Signal；当前需求中的“执行信号”与既有 Signal/Execution 分离规则存在歧义。
- Phase 0.5 待确认：capital `HIGH/MEDIUM/LOW` 的数据完整性门槛、缺失两个资金来源时的等级，以及 `targetTradeCapitalRatio` 的时间点和适用交易方向。
- Phase 0.5 待确认：Golden Expectations 必须有独立人工批准，不能由同一套实现逻辑自行生成并自行判定通过。
- Phase 0.5 待确认：Crash Recovery 是将中断运行标记终止后重跑，还是恢复同一个 Replay Run。

## Active risks
- 生产 Trades 偶发完全相同的重复行；只有 Activity 第二来源恰好存在唯一对应行时才允许确认去重，否则必须标记 `AMBIGUOUS_DUPLICATE_EVENTS`。
- 同一 transaction hash 可包含多条不同 size 的真实 fill，`source_event_key` 不能只使用 transaction hash；当前键包含 wallet、tx、condition、asset、side、price、size、timestamp 和 identity version。
- 真实价格曾出现 16 位小数；当前采用 18 位价格定点整数并拒绝超精度数据，后续 API 再超出时必须升级版本，禁止截断。
- 当前使用 Node.js 内置 `node:sqlite`，运行时会给出 experimental warning；进入长期运行前需决定锁定 Node 版本或切换成熟 SQLite 驱动。
- 公开 Market WebSocket 只提供盘口数据，任意目标钱包交易仍依赖 Data API 增量轮询；不得把盘口 WebSocket 描述成钱包成交推送。
- Replay Engine 必须持续与正式第一层共用同一领域逻辑；若后续另写一套线上识别算法，现有 Replay 结论失效。

## Safety boundary
- Phase 0 未通过前禁止 Paper；Paper 未通过且用户未再次明确授权前禁止 Live。
- 当前地址只授权公开数据读取；不读取私钥、不创建真实订单、不做链上写操作。
- Phase 0/Replay/Observe Only/Paper 仅本机运行并只允许 `127.0.0.1`；实盘部署与 geoblock 后续单独评估。
