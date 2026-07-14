# Context

## Project
- Workspace: `/Users/d4clt/Documents/Codex/2026-07-07/ni-k`。
- Purpose: 全新独立的 Polymarket Copy Trading System；不复用旧版 PolymarketBot 的代码、数据库、页面、账本或交易逻辑。
- Target wallet: `0x0c0e270cf879583d6a0142fc817e05b768d0434e`，仅授权读取公开数据。

## Architecture
- 第一层：Wallet Identity、公开 Data/Gamma/CLOB/RPC 采集、Capture、Replay、Observe、Position Baseline/Projection、Capital Estimate、Signal 与不可变 Execution Context。
- 第二层：Paper Account、Risk Manager、Paper Executor、完整深度 VWAP/FAK、Reservation、Position、Ledger、PnL、Settlement/Redeem、Portfolio Projection。
- 第三层：Live Gate、Live Account/Wallet metadata、Live Signal Consumer、Live Executor、官方 CLOB adapter seam、Order/Fill/Position/Ledger、Settlement/Redeem、Reconciliation、Crash Recovery、Emergency Stop。
- 横切能力：Ruleset Registry、不可变 Audit/State Transition/Settlement Event、SQLite migrations、Final Validation、Operational Validation、双击操作入口。
- 日常验证仅使用桌面 `Polymarket验证_点这里`的开始、提前停止、打开结果三个按钮；联合入口并行运行 Paper + Observe，Observe 真正达到 24 小时门槛后自动停止并生成严格白名单 ZIP。

## Current safety state
- 默认且当前固定：`execution_mode=PAPER`、`live_gate_state=LIVE_DISABLED`。
- 没有用户可操作的 Live 启动入口；默认使用 Disabled/Fake signer、wallet、order、redeem adapters。
- 禁止默认读取 private key/seed、真实 submit/cancel、approve、真实 redeem 或任何链上写操作。
- Live 必须同时经过已登记 `Risk Decision=ALLOW`、不可变 Signal/Execution Context 校验、活动 Live Account/Wallet/authorized signer 绑定、完整 Live Gate、外部余额/仓位/订单证据、Audit、Ledger、Reconciliation 和幂等检查。
- 程序不会自动升级模式；重启发现 `LIVE_ACTIVE` 时降级到 `PAPER + LIVE_ARMING` 并要求重新验证和人工确认。

## Core correctness rules
- Signal 只描述目标钱包行为；Paper/Live 只消费 `PUBLISHED && executionEligible=true` 的 Signal + immutable Execution Context，禁止读取 raw event 重新决策。
- Gap 行为可生成 Signal，但固定 `executionEligible=false/GAP_EVENT`；组合、无法识别、身份不确定事件不得进入执行层。
- 价格/份额/资金使用定点整数；BUY 预算保守向上取整，SELL 分配使用确定性舍入，禁止浮点资金误差和超卖。
- BUY 使用目标价 0.98—1.02、市场剩余时间等待公式、一次 FAK；SELL/止损使用完整深度可退出 VWAP，普通退出 10%、止损 15% 滑点保护。
- 所有历史 Execution/Position/Settlement/PnL/State Transition 必须按自身 `ruleset_hash/config_version/source_code_commit` 解释；不得用当前配置覆盖历史规则。
- 所有资金变化进入 Ledger，所有状态变化进入不可变 transition/audit，所有执行都有 idempotency key 和 `risk_decision_id`；`live_settlement_ledger` 仅是当前状态投影，`live_settlement_events` 才是不可变结算证据源。
- Live signed order 必须重新校验 maker、signer、资产、方向、数量、限价、fee rate/exponent/model 和风险预算；完整 Order Intent 在外部提交前持久化并以 hash/trigger 固定，恢复时缺证据或 hash 不符直接冻结。
- Live 启用前活动账户本金必须等于 Gate bankroll 配置，risk budget 不得超过配置总敞口，外部 pUSD 余额必须与 Live cash ledger 在容差内一致；每笔 BUY 重新检查单笔配置上限。

## Validation baseline
- Node `24.14.0`，pnpm `11.7.0`，schema `2.18.0`。
- 最小证据：`pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm test`、公开 API 实时契约采样、SQLite Online Backup 迁移演练、`integrity_check`、`foreign_key_check`、Final/Operational reports。
- Validation/Operational 强制通过 SQLite Online Backup 在隔离 snapshot DB 运行；所有 validation type / operational mode 都拒绝 `--no-snapshot`，不得迁移或写入业务源库。
- Final/Operational 最高自动状态分别是 `VALIDATION_FRAMEWORK_READY` / `OPERATIONAL_FRAMEWORK_READY`，且 `liveAllowed=false`；这些状态不等于 Live 已授权。
- 当前业务源库保留旧 schema 供安全对照；最新 migration 已通过旧 schema fixture 和业务库 Online Backup 隔离演练。Observe/Paper 运行前会强制 `PAPER + LIVE_DISABLED`，需要迁移时先 Online Backup，再做完整性/外键检查。
- 联合 24 小时结果自动写入被 Git 忽略的 `交给Codex/`；每轮 ZIP 只包含当轮 Observe JSON、Paper JSON、联合日志和中文摘要，不包含 SQLite、`.env`、账户 ID 或凭据。

## Remaining human gates
- 完成 24 小时 Observe、长周期 Paper、Crash Recovery 长测与长期状态一致性验证。
- 补足可复现的历史 orderbook/Paper Replay 数据；当前历史 API offset 限制使 Replay 仍为 `INCOMPLETE`。
- 在合规地区完成官方 geoblock/compliance 检查，准备隔离钱包、安全凭据存储和只读外部状态 provider。
- 用户再次明确授权后，才可单独接入真实 signer/认证 CLOB client，并先做小额实盘前检查。
