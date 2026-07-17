# Context

## Project
- 工作区：`/Users/d4clt/Documents/Codex/2026-07-07/ni-k`。
- ni-k 是独立 Polymarket Copy Trading System，不复用旧版 PolymarketBot 的代码、数据库、页面、账本或交易逻辑。
- 当前唯一目标钱包：`0x0c0e270cf879583d6a0142fc817e05b768d0434e`，仅访问公开数据。

## Architecture
- 第一层：Wallet Identity、公开数据 Capture、Replay、Observe、Position Baseline/Projection、Capital Estimate、Signal 与不可变 Execution Context。
- 第二层：Paper Account、Risk Manager、Paper Executor、完整深度 VWAP/FAK、Reservation、Position、Ledger、Fee/PnL、Settlement/Redeem、Portfolio Projection。
- 第三层：Live Gate 与 Live Executor 架构仅作安全占位和 Fake 验证；没有默认真实 signer、认证交易客户端或资金操作。
- 当前新增 Paper Validation Campaign：固定账户、2 小时资格 Session、累计 72 小时、至少一次连续 12 小时、60 秒 checkpoint、暂停/恢复、不可变报告和三个双击入口。

## Current safety state
- 固定：`execution_mode=PAPER`、`live_gate_state=LIVE_DISABLED`、`liveAllowed=false`。
- 禁止 private key/seed、真实 signer、认证 CLOB submit/cancel、approve、真实 redeem 或任何链上写入。
- Signal 与执行层严格分离；Paper/Live 只消费 `PUBLISHED && executionEligible=true` 的 Signal + immutable Execution Context。
- Gap Signal 固定 `executionEligible=false`，不得补执行。

## Current correctness baseline
- Schema `2.21.0`：2.20.0 为精确金额和市场约束，2.21.0 为 Paper Campaign。
- HIGH 比例金额使用 BigInt 精确分数，只在最终 pUSD micro 向下取整一次；旧 ppm 字段仅兼容历史。
- `min_order_size` 按 shares 解释，tick/SDK 精度后再判断；低于限制不创建 Order/Fill/Position，不放大金额。
- 官方 orderbook/fee 原始响应保存为内容寻址、append-only capture，并由快照 FK 绑定；`REAL_EXECUTION_REPLAY v2` 会重建官方响应、校验 URL/时间/内容和下单时点新鲜度，Fake/缺失 capture 不能成为真实执行证据。
- Fee 优先使用官方公开 `/fee-rate`：显式 `base_fee=0` 才按零费率处理；非零费率必须由单份完整 market-info capture 独立解释，禁止拼接不可复现证据。
- Orderbook 执行新鲜度按 `收到时间 + 本次公开请求延迟` 保守计算；源端 `timestamp` 作为内容更新时间与不可变审计证据保留，不再把安静但刚获取的盘口误判为过期。
- Campaign 报告包含跨 Session 累计 Observe 指标、完整 Paper funnel、原因分布、完整性与 checkpoint 汇总。
- Crash Recovery 由 CLI 与测试共用同一生产编排：验证进程、checkpoint 链、Observe/Paper cursor、Projection 与数据库完整性；先事务化释放等待 BUY、刷新 Portfolio、终止准确遗留 Observe，再决定恢复或保守阻断。清理前的结构性异常不可被清理后状态覆盖。

## Operator workflow
- 用户只使用桌面 `/Users/d4clt/Desktop/Polymarket验证_点这里` 三个入口：开始/继续、安全暂停、查看结果。
- 当前旧 Campaign `PC-6D45BA731F325AA7370D` 已因市场数据核心缺陷保守 BLOCKED；旧报告只读保留。修复核心 clean commit 后，入口只允许对这一组明确 blocker 创建带不可变 supersedes 链接的新 Campaign 和新账户，再运行约 2 小时资格短测。
- 资格通过后同一 Campaign/账户每次默认最多 12 小时，累计目标 72 小时；每次安全停止自动生成 Session 报告、Campaign 报告和脱敏 ZIP。
- 首次资格短测若提前安全暂停，已验证健康时长计入 72 小时，但 `qualified` 仍为 false，下一次仍须完成独立完整的 2 小时资格 Session。

## Remaining gates
- 2026-07-17 的 12 小时 Session 实际运行 `43,200,002ms`，但因旧核心错误被判 FAILED 且不计入累计；旧 Campaign 仍仅保留此前 `9,407,075ms` 有效时间。修复后不能跨核心混算，新的 2 小时资格 Session 尚未开始。
- 资格通过后仍需累计 72 小时、至少一个连续 12 小时 Session，并补足关键场景覆盖。
- Live 前仍需长期稳定性、Crash/重启验证、最终 reconciliation、合规地区 geoblock/clock 检查、隔离钱包与用户再次明确授权。
