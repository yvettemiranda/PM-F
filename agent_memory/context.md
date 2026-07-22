# Context

## Project
- 唯一有效仓库：`/Users/d4clt/Documents/Codex/2026-07-07/ni-k`。
- ni-k 是独立 Polymarket Copy Trading System，不复用旧版 PolymarketBot 的代码、数据库、账本或交易逻辑。
- 当前唯一测试目标：`0x1f9e15f39bbd5d163b0eacf0fbef647ced9e4f1a`；旧地址及其 Campaign 只作为历史证据保留，不能改绑或混算时长。

## Safety boundary
- 固定：`execution_mode=PAPER`、`live_gate_state=LIVE_DISABLED`、`liveAllowed=false`。
- 禁止 private key/seed、真实 signer、认证 CLOB submit/cancel、approve、真实 redeem、真实订单或链上写入。
- 禁止绕过 geoblock、时钟、安全 Gate，禁止覆盖历史失败证据或跨核心混算验证时长。
- Gap、unsupported conversion/SPLIT、无法证明完整 outcome set 的 MERGE，以及数据/版本/恢复/账本不确定时继续 fail closed。

## Architecture and current core
- Observe：每 `1 s` 读取 Polygon 两个官方 CTF Exchange 的已确认 `OrderFilled`（当前确认深度 `2`），公开 Trades/Activity 每 `3 s` 交叉确认和兜底；Positions/pUSD 默认每 `15 s` 全量核对，发现新目标事件时立即强制核对。Gap/Cursor、Activity confirmation、Position projection、reconciliation 与 checkpoint 仍保留。
- Polygon 快速源只接受目标为 maker 的官方 `OrderFilled`，逐 token 用公开 CLOB `markets-by-token` 绑定 condition；按官方成交微单位重建与 Data API 一致的 price/size。启动时从当前已确认 head 建 cursor，不追补启动前交易。
- Polygon RPC 暂时失败时降级到 Data API，不伪造 gap；已确认 cursor block hash 改变、log/block hash 不符，或同一成交与 Data API 的经济 locator 相同但 source identity 不同，会立即 `MAJOR_DESYNC` 并停止新开仓。
- Paper：不可变 Signal/Execution Context、Risk、Reservation、完整 REST 盘口、VWAP/FAK、Execution/Position/Ledger、Fee/PnL、Settlement 与恢复。
- 待成交 BUY 使用公开无认证 CLOB Market WebSocket 作为盘口变化唤醒；执行前仍读取完整 REST 盘口，断线或无事件时每 `15 s` 兜底。STOP/SELL 安全退出仍按每个 Paper cycle 处理。
- 完全相同的待成交盘口和 fee 不重复写完整订单尝试；盘口变化后才产生新尝试。等待原因拆分为 `BUY_NO_ASK`、`BUY_BEST_ASK_ABOVE_LIMIT`、`BUY_ZERO_EXECUTABLE_LIQUIDITY` 等。
- Paper 每轮先消费并固化已到达的新 Signal，再重试旧执行；后续 `TARGET_SELL` 会按同一比例同时减少现有 Position 和同 asset/condition 的 WAITING BUY，完整退出取消待买，部分退出缩减 Reservation，且只有 Risk 通过后才改账。被缩减的待买禁止被首开最低额重新放大。
- 当前源码目标版本：Schema `2.29.0`、Signal `1.8.0`、Strategy `2.4.0`、Risk `1.6.0`、Replay `2.0.0`、Paper `1.9.0`、Live `1.8.0`、Validation `1.6.0`、Operational `1.5.0`、Ruleset `v1.7.0`、Config `v1.4.0`；Observe Signal 内部版本为 `observe-v1.3.0`。
- Signal Context 将官方市场结束时间分为 `VERIFIED` / `UNAVAILABLE`；Paper 对后者只使用不可变、有限时长的 `execution_deadline_at`，Live 继续拒绝该状态。
- Observe 先提交事件/projection/checkpoint，再逐个富化 Signal；单市场元数据失败只记 warning 并在后续轮询重试，不能再制造连接 gap 或污染其它市场 Signal。
- 标准二元完整集合 MERGE 必须先由官方 CLOB market token 列表精确证明两个 outcome asset，再按最近目标成交价归一到 `1.0`，生成两个独立、按 tracked 仓位比例的等价 `TARGET_SELL`；Phase 0/Replay 保存并复核同一官方证据。无法证明完整 outcome set、余额不足或缺少 tracked leg 定价时立即 fail closed。REDEEM 只投影归零，不伪造 SELL。
- 新的市场 WebSocket、Polygon `OrderFilled` 快速源、Campaign 安全退出 helper 和测试均纳入 `coreCompatibilityHash` / verification suite；本核心不能续用旧 Campaign 时间。

## Confirmed BUY policy
- 当前默认继续保持首开最低 `1 pUSD`、市场最低额首开自动抬升上限 `5 pUSD`、BUY 绝对最高价 `0.95`。
- BUY 接受低于目标成交价的更优价格；追高上限为 `min(0.95, target + max(target * 2%, 2 * tick))`。
- 比例金额足够时按原值执行；不足时只允许当前资产无仓位的首开抬到 `1 pUSD`。若市场最小单更高，可精确抬升但不得超过 `5 pUSD`；完全平仓后下一次 BUY 可重新视为首开。
- 市场最低额按当前可成交深度和 fee 精确计算，不按最坏追价上限放大。例如目标价 `0.50`、当前可成交价 `0.50`、市场最小 `5` 份时为 `2.50 pUSD`；若更优盘口已让 `1 pUSD` 满足最低份额，则保持 `1 pUSD`，不自动放大。
- SELL、止损和结算不受 BUY 上限影响。历史 ruleset 缺少新字段时继续按原对称价格窗口解释，不能用新规则重解释旧仓位或旧执行。
- Paper 与隔离 Live fake 路径共享同一价格结果；Live 若因市场最低额改变最终金额，仍须在签名/提交前重新完成 Risk、钱包余额/授权、Reservation 和 Gate 绑定。

## Current runtime and Campaign
- 真实业务库已 backup-first 升到 Schema `2.29.0`；迁移前备份为 `data/operator/backups/phase0-before-2.29.0-2026-07-22T10-11-59-892Z.sqlite`。迁移前后关键业务表逐项同数，`integrity_check=ok`、外键失败 `0`，旧备份与历史记录均保留。
- 最近一轮 Campaign `PC-FDE74DCF0572D08802EE`、Session `PS-E4B568E00791EA9C2F83` 已于 2026-07-22 20:42 安全暂停：累计 `1.39 h`，Observe 成功 `4273`、失败 `0`、新事件 `18`、Signal `6`、Paper Order `96`、Fill `2`、Active Reservation `0`，Gate 始终为 `PAPER + LIVE_DISABLED`。
- 本轮取得首个自然完整生命周期：目标 BUY 被约 3 秒发现，Paper 以 `4.10 pUSD` 买入 `5` 份；目标随后 SELL，Paper 卖出 `5` 份并实现 `-0.10 pUSD`。这证明 Polygon 快速发现、Signal、Risk、BUY/SELL FAK、Position/PnL 全链可运行。
- 同轮第二个目标 BUY 因 ask 超过上限等待；目标随后以标准二元 MERGE 完整退出，但旧 Paper 核心只生成 `SELL_SIZE_UNAVAILABLE`，没有立即取消 WAITING BUY。安全暂停释放了该 Reservation；Paper `1.9.0` 已新增退出优先、待买取消/缩量和账本回归测试。
- 当前无 Observe/Paper/Campaign supervisor；10 分钟维护自动化临时 `PAUSED`，防止未提交核心被自动启动。最终干净提交和安全预检通过后创建 replacement Campaign，并持续到 2026-07-23 08:00（Asia/Shanghai）。

## Known blockers before small Live
- 新目标最近抽样中频繁出现标准二元 `MERGE`；Paper 已有等价双腿退出语义，但仍须用新核心短测取得自然 MERGE/成交证据。无法证明完整集合的 MERGE 继续硬阻断。
- 官方结束时间缺失的市场只允许 bounded Paper；Live 继续失败关闭，后续须决定是否接受独立的 Live deadline 风险策略。
- tracked negative-risk conversion 仍只形成不可执行义务并硬阻断；没有受控 Paper 语义和未来明确授权的链上适配器。
- 仍需从新干净核心重新累计 40 分钟资格、连续 4 小时、累计 24 小时、自然 BUY/SELL/Fill/PnL 覆盖及最终 8 小时 Observe；旧核心或旧 Campaign 时长不能混算。
- geoblock/compliance、隔离钱包、真实 signer 和小额 Live 的再次明确授权均未完成。

## Operator workflow
- 用户使用桌面 `/Users/d4clt/Desktop/Polymarket验证_点这里` 的开始/继续、安全暂停、查看结果入口。
- 目标选择来自 `data/operator/target-wallet.txt`；运行锁存在时禁止切换。所有入口按 wallet/target 隔离 Campaign、账户、基线和 proof。
- `operator-control` 是未来 localhost UI 的统一控制面；Live 控件保持 `LIVE_RUNTIME_NOT_WIRED`，执行模式不能做成普通 UI 配置。
