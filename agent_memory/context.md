# Context

## Project
- 唯一有效仓库：`/Users/d4clt/Documents/Codex/2026-07-07/ni-k`。
- ni-k 是独立 Polymarket 跟单系统，不复用旧 Bot 的代码、数据库或账本。
- 当前唯一测试目标：`0x1f9e15f39bbd5d163b0eacf0fbef647ced9e4f1a`；旧地址和旧核心 Campaign 只能作为历史证据，不能改绑或混算时长。

## Safety boundary
- 必须保持 `execution_mode=PAPER`、`live_gate_state=LIVE_DISABLED`、`liveAllowed=false`。
- 未再次明确授权前，禁止 private key/seed、真实 signer、认证 CLOB submit/cancel、approve、真实 redeem、真实订单、真实资金和链上写入。
- 禁止绕过 geoblock、时钟、安全 Gate、数据完整性 Gate，禁止覆盖历史失败证据。用户已明确授权把旧 Core 的有效 `12 h` 与新 Core 的有效 `12 h` 作为独立证据跨 Core 汇总，但不得篡改数据库或伪称同 Core Campaign 完成。
- Gap、无法证明的跨源去重、证据不完整的 SPLIT/CONVERSION、无法证明完整 outcome set 的 MERGE 继续 fail closed。

## Runtime architecture
- Observe 默认每 `1 s` 扫描 Polygon 已确认 `OrderFilled`，公开 WebSocket 只负责立即唤醒；Trades/Activity 每 `3 s` 交叉确认，Positions/pUSD 每 `15 s` 全量核对，新事件立即提前核对。
- 无变化且 `ONLINE + SYNCED` 时每 `15 s` 保存完整 Capture/Capital/Reconciliation/Checkpoint；新事件、Signal、gap 恢复和状态变化立即保存不可变证据。
- Paper/隔离 Live 共享 Signal/Context、Risk、REST 盘口、含手续费 VWAP、FAK、Reservation、Position/Ledger 和恢复语义；Paper 与 Live 账户和账本保持隔离。
- Paper 每轮先消费新 Signal，再检查止损并统一重试。Live 每轮先处理队首 TARGET_SELL、检查止损、重试退出，再按目标原始顺序消费新 BUY/SELL，最后才重试旧等待 BUY；Signal 消费失败时该轮旧 BUY 也不重试。
- Live 比例 BUY 在完整估值时用账户总权益作为资金比例基数，可用现金只作为支付上限；估值不完整时保守回退可用现金。

## Current execution rules
- 每笔目标 BUY 独立判断、独立 FAK，不累计、不合并未成交金额。
- 目标成交额占当时可见总资金 `<1%`：每笔最低 `1 pUSD`，按市场最低可执行额抬升，硬上限 `5 pUSD`；市场最低额超过 `5` 直接跳过。占比 `>=1%` 时只按双方资金比例。
- 首次实际开仓不计追单；之后 `<1%` 的实际成交最多 `smallFollowBuyMaxCount=9`。零成交、取消和过期不计，`>=1%` BUY 不受次数限制。
- 同一 `transactionHash + orderHash` 的 Polygon 多 fill 合并并计算 VWAP；跨 transaction 或不同 orderHash 保持独立。Data API 只有与唯一 Polygon 经济成交精确一致时才去重。
- BUY 含手续费实际 VWAP 必须处于目标价 `90%—105%`（含边界）且不高于 `0.95`；低于 `90%` 或高于 `0.95` 放弃，高于 `105%` 且不高于 `0.95` 等待。
- BUY 截止为市场剩余时间 `50%` 与 `30 min` 较短者；盘口 WebSocket 唤醒，`15 s` REST 兜底。目标 SELL 先取消或同比例缩减等待 BUY，再按本轮识别仓位比例卖自身真实持仓。
- 普通 `STANDARD_TRADE` SELL 达到或超过 `95%` 时按本轮全部退出；MERGE/CONVERSION 等 `COMBO_ACTIVITY` 不应用该阈值。低于最低卖量的真实尾仓持续 `EXIT_PENDING`，不为凑最低量而放大。
- 止损实际退出后锁定该标的重新 BUY，直到目标本轮完全结束且自身持仓、等待/在途和结算义务归零。

## Special activities
- MERGE 只有在官方完整二元 outcome set、余额和定价证据都充分时，才生成各腿 `TARGET_SELL` 等价退出；证据不足继续硬阻断。
- SPLIT 不执行链上铸造。Activity 金额、官方二元市场、同轮 Positions 与最终投影必须一致；不可变证据固化市场/Positions 原文、时间与哈希。目标新增腿进入 historical bucket，不生成 BUY。
- Polygon 回执和 Positions 双重验证的 negative-risk CONVERSION 不执行链上转换；destination 腿进入 historical bucket。若 source 含启动后 tracked 仓位，则按本轮转换比例生成可执行 `TARGET_SELL` 等价退出。
- Replay 只有收到相同的完整持久化证明才投影 SPLIT/CONVERSION；仅有历史 Activity 或市场元数据时保持 `INCOMPLETE`。

## Version and compatibility
- 当前源码目标版本：Schema `2.31.0`、Signal `1.11.0`、Strategy `2.9.0`、Risk `1.10.0`、Replay `2.5.0`、Paper `1.18.0`、Live `1.16.0`、Validation `1.9.0`、Operational `1.9.0`、Ruleset `v1.11.0`、Config `v1.7.0`。
- 当前运行数据库是 Schema `2.30.0`；本轮已完成迁移但异常 Session 未生成正式报告。后续启动仍必须沿用备份优先和既有入口。
- `BUY_AMOUNT_POLICY_V4` 与 `followSellFullExitThresholdPpm=950000` 只由包含相应字段的新 Ruleset 解释；旧 Ruleset 固定按旧语义恢复，不得重解释历史执行。
- Core compatibility 已纳入共享 SELL policy 和迁移 `035_special_activity_projection.sql`。新核心必须创建新 Campaign；跨 Core 时长只允许按用户授权在独立最终报告中汇总，不得写回 Campaign 内建计时。

## Current runtime and evidence
- Paper 跨 Core 累计验证已于 `2026-07-27 02:41:48 +08:00` 完成。最终独立报告为 `data/operator/final-reports/ni-k-paper-mixed-core-24h-final-20260727-0300.md`，验收标记为 `OWNER_AUTHORIZED_MIXED_CORE_AGGREGATION`。
- 固定计入：旧 Core 三轮 `43,200,006 ms`；Core `a8fbf2...` 正常轮 `14,400,002 ms`；同 Core 最终估值超时轮按 `OWNER_AUTHORIZED_EXTERNAL_FINALIZATION_EXCEPTION` 仅在独立业主汇总计入 `14,400,002 ms`；最终修复验证轮 `14,400,002 ms`。合计 `86,400,012 ms`。
- 原始数据库和 Session/Campaign 报告均未改写；跨 Core 结果没有伪称为单一 Campaign 的内建 24 小时完成。
- 最终 Core `e284de7...` / Campaign `PC-53F4B34D814FCDDFB663` / Session `PS-04B30EBA4C1C49656AF7` 为 `COMPLETED`、`countsTowardCampaign=true`、blocker 空，连续有效 `14,400,002 ms`。
- 最终轮处理 `25` 个事件、发布 `13` 个 Signal；`11` 个可执行 BUY 全被 Paper 消费且 Risk `ALLOW`，全部因安全价格条件或截止时间正常过期；`2` 个 SELL 为 `GAP_EVENT` 且无 Paper 仓位，不补单。其余 SELL 为历史/无本轮 tracked 仓位，正常不跟。
- 最终轮 Paper execution `11`、order `1,239`、fill `0`、position `0`，现金/权益均为 `1,000,000,000 micros`，手续费和盈亏均为 `0`，估值完整。
- Observe 成功轮询 `10,241` 次，scheduling gap 和 major desync 均为 `0`，最终 `SYNCED`；数据库 `quick_check=ok`、外键问题 `0`。
- 最终仍为 `PAPER + LIVE_DISABLED + liveAllowed=false`，Live execution/order/attempt/fill 全为 `0`，真实订单和链上写入为 `0`。
- Observe/Paper/Supervisor/launcher 均已退出，operator lock、marker、FIFO 已清理。

## Remaining blockers before small Live
- 用户授权的 Paper 累计 `24 h` 和最终连续 `4 h` 已完成；但自然 FILL、POSITION_UPDATE、FEE、PnL 仍未发生，不能把隔离测试伪称为自然成交。
- SPLIT/CONVERSION 采用“退出或隔离”而非真实链上复制，可能与目标组合的经济结果不同；必须在 Paper 报告中单独统计。
- 历史 Phase 0 若只有特殊 Activity、没有本系统提交的完整证明，Replay 会保持 `INCOMPLETE`，不得人工降级通过。
- 官方结束时间缺失的 Live 策略仍会阻断；真实 signer、认证凭据、真实资金证据和用户再次明确授权均不存在，因此不能启用真实 Live。阶段 3 只完成了显式依赖注入的后端能力和 fake/isolated 验证。

## Operator workflow
- 桌面入口：`/Users/d4clt/Desktop/Polymarket验证_点这里`；目标文件：`data/operator/target-wallet.txt`。运行锁存在时禁止切换目标。
- `operator-control` 是未来 localhost UI 的统一控制面；Live 后端已接线，但 Live 控件继续固定为 `LIVE_UI_NOT_IMPLEMENTED`，执行模式不能做成普通 UI 配置。

## Runtime handoff and valuation recovery
- Paper 账户现在是跨 Campaign 的持久化组合容器。新 Core replacement 在旧 Campaign 已终止、没有等待中的 BUY/活动 reservation 且现金账本一致时复用同一 `paper_account_id` 和同一 `baseline_run_id`；旧仓位、旧 execution 和旧 ruleset 快照保持不可变，新账户运行时元数据更新到当前 Core，并在 Campaign transition evidence 中记录单向交接。
- SQLite 迁移 `036_execution_runtime_handoff.sql` 移除 Campaign 对 `paper_account_id` 的列级唯一限制，改为可审计的 `(paper_account_id, created_at)` 索引，允许同一持久化 Paper 账户跨顺序 replacement Campaign 使用。
- Paper final drain 与 Paper/Live 只读估值均使用有上限的重试和退避；最终估值短暂不完整会保留原始 blocker 和恢复证据，并允许同一 Core 后续恢复，而不是把仓位当成已结算或强行完成。
- Paper BUY 在已有持仓且市场数据仍处于不可恢复冻结时不消费/不下新 BUY；Live BUY 在估值不完整时保留 Signal 待重试，不 quarantine、不消费。
- Live 已具备禁用态 `handoffRuntime`、final valuation recovery、启动恢复、外部订单/成交/仓位对账、合规/geoblock/时钟 provider、钱包/signer 公共身份绑定、arming/kill switch 和显式依赖装配；全局 `PAPER + LIVE_DISABLED + liveAllowed=false`、无真实 signer/真实订单的安全边界不变。
- Live `handoffRuntime` 现在还要求账户处于禁用态、没有未终态外部订单或活动 reservation、现金/保留账本非负且没有非零冻结仓位；Live Gate 全局 reconciliation 同时检查 Live 账本与孤儿/负仓位。`LiveRuntime` 仅组合 Gate 启动恢复、LiveExecutor 和 LiveRunner，不自行 arming 或发现凭据。
- `LiveIdentityBinding` 在启动恢复、arming 申请/确认和轮询入口都核对注册账户、钱包状态、运行时钱包地址、authorized signer 地址、组件环境类型与源码版本；漂移时紧急禁用 Gate。`assembleLiveRuntime` 要求调用方显式注入全部 provider/adapter，不读取私钥或自动构造认证客户端。

## Owner-selected delivery order
- 用户明确要求按“3 → 2 → 1”推进：先完成全部 Live/后端接线、账户交接、外部订单恢复、合规与安全闸门等开发（但不得启用真实订单）；再开发可操作的 UI；最后统一做 Paper、隔离 Live 和安全门验证。
- UI 完成后才进入最终验证；最终验证通过且用户再次明确授权前，仍保持 `PAPER + LIVE_DISABLED + liveAllowed=false`。这里的“先做 3”表示先把能力开发完整，不表示提前接通或启用实盘。
