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
- Observe：每 `1 s` 读取 Polygon 两个官方 CTF Exchange 的已确认 `OrderFilled`（当前确认深度 `2`），并用公开 Polygon WebSocket 的 target-maker log 作为提前唤醒；WebSocket 不直接生成 Signal，断线/乱序/丢消息时继续由 `1 s` poll 兜底。公开 Trades/Activity 每 `3 s` 交叉确认；Positions/pUSD 默认每 `15 s` 全量核对，发现新目标事件时立即强制核对。每次成功轮询保留轻量心跳；无变化且 `ONLINE + SYNCED` 时完整 Capture/Capital/Reconciliation/Checkpoint 每 `15 s` 采样一次，事件、Signal、gap 恢复或状态变化立即保存完整证据。
- Polygon 快速源只接受目标为 maker 的官方 `OrderFilled`，逐 token 用公开 CLOB `markets-by-token` 绑定 condition；按官方成交微单位重建与 Data API 一致的 price/size。启动时从当前已确认 head 建 cursor，不追补启动前交易。
- Polygon RPC 暂时失败时降级到 Data API，不伪造 gap；已确认 cursor block hash 改变、log/block hash 不符，或同一成交与 Data API 的经济 locator 相同但 source identity 不同，会立即 `MAJOR_DESYNC` 并停止新开仓。
- Paper：不可变 Signal/Execution Context、Risk、Reservation、完整 REST 盘口、VWAP/FAK、Execution/Position/Ledger、Fee/PnL、Settlement 与恢复。
- 待成交 BUY 使用公开无认证 CLOB Market WebSocket 作为盘口变化唤醒；执行前仍读取完整 REST 盘口，断线或无事件时每 `15 s` 兜底。STOP/SELL 安全退出仍按每个 Paper cycle 处理。
- 完全相同的待成交盘口和 fee 不重复写完整订单尝试；盘口变化后才产生新尝试。等待原因拆分为 `BUY_NO_ASK`、`BUY_BEST_ASK_ABOVE_LIMIT`、`BUY_ZERO_EXECUTABLE_LIQUIDITY` 等。
- Paper 每轮先消费并固化已到达的新 Signal，再检查止损和重试旧执行；目标退出先于止损，止损只作用于剩余仓位。后续 `TARGET_SELL` 会按同一比例同时减少现有 Position 和同 asset/condition 的 WAITING BUY，完整退出取消待买，部分退出缩减 Reservation，且只有 Risk 通过后才改账。被缩减的待买禁止被首开最低额重新放大。
- 同 asset 的 `EXIT_PENDING` / `STOP_EXIT_PENDING` 存在时，新 BUY 保留为 `WAITING_EXECUTION + SAME_ASSET_EXIT_PENDING`，退出完成后自动继续，禁止同一仓位方向相反的任务同时成交。
- WAITING BUY 每次被目标退出向下缩减时，都会以原 Risk Decision 为父证据生成新的严格向下金额决定，并把 Execution 重新绑定到当前金额；持平、向上、跨账户或非 ALLOW 父决定全部失败关闭。
- `TARGET_SELL` 小于市场最小下单量，或合法成交后只剩不足 `0.01` 股的执行器尾差时，Paper 不允许放大卖单超卖：保存约束证据、保留真实成交/Position，把不可提交部分从该 Execution 分配中移除并终止为 `CANCELLED`。`STOP_LOSS` 继续保持 pending，但相同约束只记录一次。
- 当前源码目标版本：Schema `2.29.0`、Signal `1.8.0`、Strategy `2.6.0`、Risk `1.9.0`、Replay `2.2.0`、Paper `1.13.0`、Live `1.10.0`、Validation `1.7.0`、Operational `1.7.0`、Ruleset `v1.8.0`、Config `v1.5.0`；Observe Signal 内部版本为 `observe-v1.3.0`。
- Signal Context 将官方市场结束时间分为 `VERIFIED` / `UNAVAILABLE`；Paper 对后者只使用不可变、有限时长的 `execution_deadline_at`，Live 继续拒绝该状态。
- Observe 先提交事件/projection/checkpoint，再逐个富化 Signal；单市场元数据失败只记 warning 并在后续轮询重试，不能再制造连接 gap 或污染其它市场 Signal。
- 标准二元完整集合 MERGE 必须先由官方 CLOB market token 列表精确证明两个 outcome asset，再按最近目标成交价归一到 `1.0`，生成独立、按 tracked 仓位比例的等价 `TARGET_SELL`；Phase 0/Replay 保存并复核同一官方证据。仅历史 Replay 明确遭官方 offset 截断时，可按已验证二元 token set 把缺失旧腿补入 historical bucket 后投影，不生成虚假 BUY；Observe 实时路径仍以完整启动 baseline/启动后成交为准。无法证明完整 outcome set、实时余额不足或缺少 tracked leg 定价时立即 fail closed。REDEEM 只投影归零，不伪造 SELL。
- 新的市场 WebSocket、Polygon `OrderFilled` 快速源、Campaign 安全退出 helper 和测试均纳入 `coreCompatibilityHash` / verification suite；本核心不能续用旧 Campaign 时间。

## Confirmed BUY policy
- 当前默认继续保持首开最低 `1 pUSD`、市场最低额自动抬升上限 `5 pUSD`、BUY 绝对最高价 `0.95`。
- HIGH 置信度 BUY 按完整可退出估值的账户总权益计算目标比例，可用现金仅作为最终支付上限；估值不完整时退回可用现金。MEDIUM 置信度固定兜底为 `1 pUSD`，不再因证据变差放大到 `10 pUSD`。
- BUY 接受低于目标成交价的更优价格；追高上限为 `min(0.95, target + max(target * 2%, 2 * tick))`。
- 比例金额足够时按原值执行。无仓位首开不足时抬到 `1 pUSD`；若市场最小单更高，可精确抬升但不得超过 `5 pUSD`。只有这笔首开被实际放大且已经成交形成持仓，同 asset 后续 BUY 才继承同一 `1—5 pUSD` 规则；首笔等待、拒绝或原本未放大均不激活，完全清仓后 lineage 清零。
- 市场最低额按当前可成交深度和 fee 精确计算，不按最坏追价上限放大。例如目标价 `0.50`、当前可成交价 `0.50`、市场最小 `5` 份时为 `2.50 pUSD`；若更优盘口已让 `1 pUSD` 满足最低份额，则保持 `1 pUSD`，不自动放大。
- SELL、止损和结算不受 BUY 上限影响。历史 ruleset 缺少新字段时继续按原对称价格窗口解释，不能用新规则重解释旧仓位或旧执行。
- Paper 与隔离 Live fake 路径共享同一价格结果；Live 若因市场最低额改变最终金额，仍须在签名/提交前重新完成 Risk、钱包余额/授权、Reservation 和 Gate 绑定。
- `BUY_AMOUNT_POLICY_V3` 用 `FIRST_ENTRY / AMPLIFIED_POSITION / NONE` 记录资格，旧 V2 完整哈希证据可继续证明已有放大 lineage；损坏、缺失或被篡改的 Risk 证据一律不授予继承。

## Current runtime and Campaign
- 2026-07-23 已按用户授权清理旧数据：`data/` 曾从约 `12 GB` 降到约 `21 MB`。约 `7.2 GB` 多代整库迁移备份、旧主库、旧 validation/operational 数据库副本和昨晚前无关输出已永久删除，不可恢复；本次 4.84 小时高频验证后 `data/` 约 `598 MB`，主库约 `577 MB`。
- 当前 Campaign `PC-105EC3F76A2AC49D59E6` 已于 17:15 安全暂停，状态 `PAUSED`、`qualified=true`、blocker `0`；两次 Session 共计 `4.84 h` 有效时长，最长连续 `4.00 h`，完成 Session `2`，唯一未覆盖场景为自然 `REALIZED_PNL`。
- 首个 Session `PS-48F7A4771AF8B9DAA487` 自然运行 4 小时并 `PASSED_NATURAL`；第二个 `PS-13BA80A15A935D5E738B` 从 16:25 恢复 checkpoint 后运行约 50 分钟，17:15 通过安全入口完成 final drain、估值和报告。
- 累计 Observe：成功 `15605`、失败 `11`（同一短暂 timeout 窗口，已自然恢复）、事件 `30`、Signal `9`、gap `0`、最终 `SYNCED`；`51` 次 transient `MINOR_DIFF` 均自动恢复，API recovery 和 restart/checkpoint recovery 已取得自然证据。
- 目标事件为 `9 BUY / 21 SELL`；9 个 BUY 全部被发现并生成 Signal，Risk 全部 ALLOW。Paper 结果：`1` 笔完整成交、`5` 笔 `BELOW_MARKET_MIN_ORDER_SIZE`、`3` 笔 `WAIT_TIMEOUT`。21 个 SELL 均只减少启动前 historical bucket，未命中 tracked 仓位，因此没有自然 SELL Signal。
- 唯一持仓仍为 15.8 份 Yes、成本 `1 pUSD`、状态 `OPEN`；最终估值 `0.91236 pUSD`，未实现 PnL `-0.08764 pUSD`，已实现 PnL `0`。账户现金 `999 pUSD`、Reservation `0`，无未消费 eligible Signal 或等待 Execution。
- 当前无 Observe/Paper/Supervisor/launcher 进程；Schema `2.29.0`，`integrity_check=ok`、外键失败 `0`、异常 `0`、reconciliation issue `0`，Live Execution/Order/Fill 均为 `0`。目标配置仍是 `0x1f9e15f39bbd5d163b0eacf0fbef647ced9e4f1a`。
- 本次两份关键 ZIP：`Paper累计验证_PC-105EC3F76A2AC49D59E6_PS-48F7A4771AF8B9DAA487_20260723-162247-46728.zip`（SHA-256 `2f70d7ff...72f08`）和 `Paper累计验证_PC-105EC3F76A2AC49D59E6_PS-13BA80A15A935D5E738B_20260723-171522-66566.zip`（SHA-256 `4dc0cd95...0c49c`）。
- 默认迁移备份保留数从 `3` 收紧为 `1`，并保证刚生成且校验通过的备份优先保留，避免 schema 版本文件名排序留下错误旧副本。
- 截至 17:15 的半小时巡检自动化 `ni-k-paper-17-15` 已删除，不会再自动重启。

## Known blockers before small Live
- 新目标最近抽样中频繁出现标准二元 `MERGE`；Paper 已有等价双腿退出语义，但仍须用新核心短测取得自然 MERGE/成交证据。无法证明完整集合的 MERGE 继续硬阻断。
- 官方结束时间缺失的市场只允许 bounded Paper；Live 继续失败关闭，后续须决定是否接受独立的 Live deadline 风险策略。
- tracked negative-risk conversion 仍只形成不可执行义务并硬阻断；没有受控 Paper 语义和未来明确授权的链上适配器。
- Paper `1.13.0` / Risk `1.9.0` / Strategy `2.6.0` 改变了跟单放大继承和目标发现链路；此前核心累计的 `4.84 h` 只保留为诊断证据，不能计入本核心最终 `24 h`。新核心尚未开始干净 Campaign，最终 8 小时 Observe、自然 SELL/REALIZED_PNL 也仍未完成。
- geoblock/compliance、隔离钱包、真实 signer 和小额 Live 的再次明确授权均未完成。

## Operator workflow
- 用户使用桌面 `/Users/d4clt/Desktop/Polymarket验证_点这里` 的开始/继续、安全暂停、查看结果入口。
- 目标选择来自 `data/operator/target-wallet.txt`；运行锁存在时禁止切换。所有入口按 wallet/target 隔离 Campaign、账户、基线和 proof。
- `operator-control` 是未来 localhost UI 的统一控制面；Live 控件保持 `LIVE_RUNTIME_NOT_WIRED`，执行模式不能做成普通 UI 配置。
