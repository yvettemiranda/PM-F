# Bugs And Risks

## Active blockers
- tracked negative-risk conversion 没有真实复制能力；当前生成不可执行义务并暂停 Paper/未来 Live。
- SPLIT 仍没有安全的 position projection/copy 语义，会立即 `UNSUPPORTED_TARGET_ACTIVITY + MAJOR_DESYNC`。
- 无法证明恰好两个完整 outcome、余额不足或缺少 tracked leg 价格的 MERGE 会立即硬阻断；不会猜测资产集合或价格。
- 官方市场结束时间缺失时只允许 bounded Paper；Live Gate 继续拒绝，尚未形成可接受的真实资金 deadline 策略。
- 新核心仍需从 0 完成 40 分钟资格、连续 4 小时、累计 24 小时、自然 BUY/SELL/Fill/PnL 和最终 8 小时 Observe。
- geoblock/compliance、隔离钱包、真实 signer、Live arming 和用户再次明确授权均未完成。

## Active risks
- 3 秒 Trades/Activity 提高公开 API 请求频率；Positions/pUSD 已限制为 15 秒并在新事件时提前刷新，仍需短测观察限流、gap 和 scheduling gap。
- Market WebSocket 只提供 wake hint，可能断线、丢消息或收到乱序增量；执行始终 REST 复核并每 15 秒兜底，不能把 WebSocket 消息直接当成交证据。
- 待成交 BUY 不再为完全相同盘口重复写完整 attempt，但仍会在 wake/fallback 时发 REST 请求；需要短测确认 API 和数据库增长率。
- `node:sqlite` 在 Node 24 仍有 experimental warning；长期稳定性需新核心 Campaign 验证。
- CLOB `/time` 偏移在 Session 内固定；系统时钟继续漂移时订单簿检查必须失败关闭。
- Data API offset、分页边界和短暂 Positions/Trades/Activity 不同步仍可能触发 gap recovery 或 reconciliation；不得以“尽量成交”为由降低这些数据完整性 Gate。
- 数据目录和迁移备份较大。业务 Campaign/Session/capture 有审计价值，不直接删除；若整理空间，先哈希校验、恢复验证并只归档明确冗余的旧迁移备份。

## Resolved in current implementation
- Signal 富化失败曾被误记为 Data API gap，导致已实时看到的 4 BUY + 2 SELL 永久不可执行；当前事件先持久化，每条 Signal 独立重试，富化 warning 不再扩大 gap。
- 官方结束时间为空曾抛出 `MARKET_END_TIME_UNAVAILABLE`；当前 Signal Context 显式记录 `UNAVAILABLE` 和不可变 bounded deadline，Paper 可继续，Live 仍失败关闭。
- 标准二元 MERGE 曾无条件触发 `MAJOR_DESYNC`；当前 Observe/Replay 只有在官方 CLOB token set 精确匹配时才生成两个唯一的等价 `TARGET_SELL` 并清理 projection，目标历史抽样的 72 次 MERGE 均有两条 prior asset，正式验证仍以逐 condition 官方 capture 为准。
- 同一个 MERGE source event 的第二条 Signal、Replay classification 和 position ledger 曾分别会被旧唯一约束静默吞掉；migration 034 重建三张证据表并按 signal/asset 唯一，旧行原样迁移、不可变触发器重建。
- Replay 曾记录 MERGE 却不生成在线等价退出，且非交易 Activity 页边界重复会执行两次；当前按时间交织并去重 Activity，与 Observe 使用同一归一价格和官方 outcome-set 规则。
- BUY 原对称 `98%—102%` 下限会拒绝更低的改善价格；当前只设追高上限，低价改善允许成交。
- 低价市场原 `2%` 上限可能小于两个 tick，导致自然 BUY 长期无法落入合法价格；当前取 `2%` 与 `2 tick` 较宽者并受 `0.95` 封顶。
- Observe 原 15 秒统一轮询导致目标事件发现慢；当前事件 3 秒、状态 15 秒，新事件立即强制状态核对。
- 单个 WAITING BUY 曾在未变化盘口下高频生成重复 attempt，造成 API、数据库和报告噪声；当前 WebSocket/15 秒控制重试，且相同盘口+fee 不重复写完整 attempt。
- Paper 等待原因曾合并为 `PRICE_OUT_OF_RANGE_OR_ZERO_LIQUIDITY`；当前按无卖盘、超限、零可执行流动性拆分。
- 新增 WebSocket/test 文件若未进入 verification 清单会触发 `PAPER_VERIFICATION_TEST_FILE_SET_MISMATCH`；已把运行文件纳入 core hash、测试纳入 verification suite，旧 Campaign 不会误续。
- Live 内部计划的合法微单位取整曾被误判越价；现只对未改变的内部计划允许该取整，signer 变更导致的真实越价继续拒绝。
- Market WebSocket helper 抛错时曾使 Runner 退回每个 cycle 全量重试 BUY；当前异常路径也受 15 秒 REST fallback 限制，退出任务仍每个 cycle 处理。
- 市场最低额曾按 BUY 最高追价计算，可能把实际已足够的 1 pUSD 放大；当前按允许价格内的真实多档 ask 深度和 fee 精确计算。空盘口先保持原 Reservation，恢复后按精确金额重新 Risk，不凭假定价格提前放大。

## Safety boundary
- 必须保持 `PAPER + LIVE_DISABLED + liveAllowed=false`。
- 未再次明确授权前，禁止 private key/seed、真实 signer、认证 CLOB client、submit/cancel、approve、真实 redeem、真实订单和链上写入。
- 禁止覆盖历史失败证据、跨核心混算时长、降低数据/时钟/恢复/账本安全门或绕过 geoblock。
