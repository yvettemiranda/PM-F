# Context

## Project
- 工作区：`/Users/d4clt/Documents/Codex/2026-07-07/ni-k`。
- ni-k 是独立 Polymarket Copy Trading System，不复用旧版 PolymarketBot 的代码、数据库、页面、账本或交易逻辑。
- 当前唯一目标钱包：`0x0c0e270cf879583d6a0142fc817e05b768d0434e`，仅访问公开数据。

## Architecture
- 第一层：Wallet Identity、公开数据 Capture、Replay、Observe、Position Baseline/Projection、Capital Estimate、Signal 与不可变 Execution Context。
- 第二层：Paper Account、Risk Manager、Paper Executor、完整深度 VWAP/FAK、Reservation、Position、Ledger、Fee/PnL、Settlement/Redeem、Portfolio Projection。
- 第三层：Live Gate 与 Live Executor 架构仅作安全占位和 Fake 验证；没有默认真实 signer、认证交易客户端或资金操作。
- 当前 Paper Validation Campaign：固定账户、累计 72 小时、至少一次连续 12 小时、60 秒 checkpoint、暂停/恢复、不可变报告和三个双击入口。首次 Session 默认最多运行 12 小时，满 2 小时记录资格里程碑但不人为重启。

## Current safety state
- 固定：`execution_mode=PAPER`、`live_gate_state=LIVE_DISABLED`、`liveAllowed=false`。
- 禁止 private key/seed、真实 signer、认证 CLOB submit/cancel、approve、真实 redeem 或任何链上写入。
- Signal 与执行层严格分离；Paper/Live 只消费 `PUBLISHED && executionEligible=true` 的 Signal + immutable Execution Context。
- Gap Signal 固定 `executionEligible=false`，不得补执行。

## Current correctness baseline
- Schema `2.24.0`：2.20.0 为精确金额和市场约束，2.21.0 为 Paper Campaign，2.22.0 固化 Signal/Context target，2.23.0 固化 Observe Projection Snapshot，2.24.0 固化 Observe 与 Campaign/Session 的精确绑定。
- HIGH 比例金额使用 BigInt 精确分数，只在最终 pUSD micro 向下取整一次；旧 ppm 字段仅兼容历史。
- `min_order_size` 按 shares 解释，tick/SDK 精度后再判断；低于限制不创建 Order/Fill/Position，不放大金额。
- 官方 orderbook/fee 原始响应保存为内容寻址、append-only capture，并由快照 FK 绑定；`REAL_EXECUTION_REPLAY v2` 会重建官方响应、校验 URL/时间/内容和下单时点新鲜度，Fake/缺失 capture 不能成为真实执行证据。
- Fee 优先使用官方公开 `/fee-rate`：显式 `base_fee=0` 才按零费率处理；非零费率必须由单份完整 market-info capture 独立解释，禁止拼接不可复现证据。
- Orderbook 执行新鲜度按 `收到时间 + 本次公开请求延迟` 保守计算；源端 `timestamp` 作为内容更新时间与不可变审计证据保留，不再把安静但刚获取的盘口误判为过期。
- Campaign 报告包含跨 Session 累计 Observe 指标、完整 Paper funnel、原因分布、完整性与 checkpoint 汇总。
- Crash Recovery 由 CLI 与测试共用同一生产编排：验证进程、checkpoint 链、Observe/Paper cursor、Projection 与数据库完整性；先事务化释放等待 BUY、刷新 Portfolio、终止准确遗留 Observe，再决定恢复或保守阻断。清理前的结构性异常不可被清理后状态覆盖。
- Observe、Signal、Execution Context、Risk、Execution、Position、Transition 与 Audit 的最终验收全部按当前 Campaign/Session/Account/Target/Core 精确限定；同目标的独立 Observe 不会被误清理，会保守阻断恢复。
- `coreCompatibilityHash` 只覆盖会改变 Paper 行为、计时、恢复、安全或账本语义的代码/规则/Schema；纯报告、说明和打包展示不再机械重置累计时间。
- Observe 对账按具体差异独立跟踪：连续次数达到 3 且同一差异持续至少 `reconciliationGraceMs=120000` 才升级为 `MAJOR_DESYNC`；宽限期内事件补齐恢复为 `SYNCED`，checkpoint hash 损坏等结构错误仍立即 fail closed。
- Phase 0 对相邻 offset 页的首尾完全相同行只记录为分页重叠候选；只有另一独立公开接口确认较低且精确相等的事件 multiplicity 时才核销该候选。原始行和重复计数仍保留，单源重复、双源边界重复、非边界重复或非法证据继续 `AMBIGUOUS_DUPLICATE_EVENTS`。

## Operator workflow
- 用户只使用桌面 `/Users/d4clt/Desktop/Polymarket验证_点这里` 三个入口：开始/继续、安全暂停、查看结果。
- 历史失败 Campaign 均只读保留且不计入新核心；最新失败 Campaign 为 `PC-A90AEC5B17EA925E5AF1`，Session `PS-F76E83CEABE73C181068` 实际运行 `43,200,002ms` 后因本机时钟约慢 2 秒触发订单簿未来时间误判，状态为 `BLOCKED`、累计为 0。
- 修复后入口仅允许旧核心且 blocker 精确等于本次五项时钟/最终估值失败集合时，以 `CORE_REPAIR_CLOCK_SAFETY` 创建带不可变 supersedes 链接的新 Campaign 和新账户；缺项、增项、同核心或其他失败原因均拒绝替换。
- 2026-07-18 修复提交后的真实 preflight 测得 CLOB clock offset `+1407ms` 并在创建 Campaign 前正确阻断；Apple/Cloudflare/Google NTP 随后均确认本机再次慢约 `2.05s`。macOS `timed` 日志显示其收到正确 NTP 后拒绝约 2 秒校正，并用旧合成时钟把系统重新拨慢；系统层问题未持久修复前禁止启动。
- 2026-07-17 20:42 的启动前检查未创建 Campaign：同一历史交易在 Trades offset 0/1000 相邻页首尾重复，而 Activity 仅出现一次，三次新抓取均因此得到 `ambiguousEvents=1`。修复只识别双源确认的相邻页重叠，不放宽普通歧义。
- 新 Campaign 第一次默认最多运行 12 小时：满 2 小时记录资格里程碑并继续运行，健康跑满 12 小时可同时满足资格和连续运行门槛；每次安全停止自动生成 Session 报告、Campaign 报告和脱敏 ZIP。
- 首次 Session 若不足 2 小时就安全暂停，已验证健康时长仍计入 72 小时，但 `qualified` 保持 false；下次仍是资格 Session。

## Remaining gates
- 2026-07-18 Campaign `PC-A90AEC5B17EA925E5AF1` 的 12 小时 Session `PS-F76E83CEABE73C181068` 因 `FINAL_VALUATION_INCOMPLETE`、`PAPER_EXIT_CODE:1`、`PAPER_FINAL_VALUATION_INCOMPLETE`、`PAPER_STATUS:COMPLETED_WITH_SAFETY_BLOCKERS`、`UNRECOVERED_MARKET_DATA_BLOCKER` 失败，`countsTowardCampaign=false`、累计时间为 0。
- 修复后不能跨核心混算；时钟安全修复后的 `coreCompatibilityHash=637191cd09eff0ddcdb8309b71226be62fdb6c08dbd13087208e6ca04cc17d08`，新 Campaign 尚未创建。
- 当前系统时钟仍不安全，真实 preflight 已 fail closed；必须先通过 macOS“日期与时间”重置自动校时并再次交叉核对，不能绕过或放宽 1000ms 阈值。
- 新 Campaign 仍需累计 72 小时、至少一个连续 12 小时 Session，并补足关键场景覆盖；代码 RC 通过不等于 Paper 长期验收通过。
- Live 前仍需长期稳定性、Crash/重启验证、最终 reconciliation、合规地区 geoblock/clock 检查、隔离钱包与用户再次明确授权。
