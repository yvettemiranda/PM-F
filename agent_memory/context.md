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
- 当前源码目标版本：Schema `2.30.0`、Signal `1.11.0`、Strategy `2.9.0`、Risk `1.10.0`、Replay `2.5.0`、Paper `1.17.0`、Live `1.14.0`、Validation `1.8.0`、Operational `1.9.0`、Ruleset `v1.11.0`、Config `v1.7.0`。
- 当前运行数据库是 Schema `2.30.0`；本轮已完成迁移但异常 Session 未生成正式报告。后续启动仍必须沿用备份优先和既有入口。
- `BUY_AMOUNT_POLICY_V4` 与 `followSellFullExitThresholdPpm=950000` 只由包含相应字段的新 Ruleset 解释；旧 Ruleset 固定按旧语义恢复，不得重解释历史执行。
- Core compatibility 已纳入共享 SELL policy 和迁移 `035_special_activity_projection.sql`。新核心必须创建新 Campaign；跨 Core 时长只允许按用户授权在独立最终报告中汇总，不得写回 Campaign 内建计时。

## Current runtime and evidence
- 旧 Core `PC-A1C63D1657110D955029` 固定有效基线为 `43,200,006 ms`；合盖失败轮 `PS-BFDD2F7E81AA8ADE1EAB` 为 `0 ms`，不计入。
- 新 Core `a8fbf2...` / Campaign `PC-1FA2F49244FE2B7BE43D` 第 1 轮 `PS-82029D62FCBC90727F35` 正常完成并计入 `14,400,002 ms`。
- 新 Core 第 2 轮 `PS-8B337FF558CBBFA6BAD7` 在满 `4 h` 的最终估值窗口遇到公共市场数据持续超时，Paper 返回 `FINAL_DRAIN_INCOMPLETE`；该轮 `countsTowardCampaign=false`，Campaign 因同 Core 终态策略进入 `BLOCKED`。
- 第 2 轮 Observe 最终对账为 `SYNCED`，但收尾前 API 超时窗口未在 Session 结束前恢复；稍后只读复测公共 API 已恢复。数据库 `quick_check=ok`、外键问题 `0`，全程仍为 `PAPER + LIVE_DISABLED + liveAllowed=false`，Live Execution/Order/Attempt/Fill 全为 `0`。
- 用户已明确授权：若 Session 已完整运行、Observe 无调度/数据 gap 且最终 `SYNCED`、数据库和安全门正常、公共市场数据随后恢复，并且唯一失败是最终估值的 `FINAL_DRAIN_INCOMPLETE`，则可在独立业主汇总中计入该轮，但不得改写原始 Session/Campaign 报告。
- 第 2 轮据此以 `OWNER_AUTHORIZED_EXTERNAL_FINALIZATION_EXCEPTION` 计入 `14,400,002 ms`；用户口径当前累计为旧 Core `43,200,006 ms` + 新 Core 第 1 轮 `14,400,002 ms` + 第 2 轮例外 `14,400,002 ms`，合计 `72,000,010 ms`，还缺 `14,399,990 ms`。
- 新 Core `cea650dd...` / Campaign `PC-323157F9C8C2FBE4EA27` 于 `2026-07-26T12:08:36Z` 启动，但 Observe 在运行 `3,840,425 ms` 后检测到确认游标 `0x56b313f` 的区块哈希变化并抛出 `POLYGON_TRADE_FEED_CONFIRMED_REORG`。Supervisor 安全停止 Paper；失败轮不计入，Campaign `BLOCKED`。
- 事故前最后一个 Polygon 批次 `0x56b313f-0x56b313f` 没有目标日志；Paper 最终估值完整、账本一致、真实订单和链上写入均为 `0`。实现缺陷是对“上一锚点未变且被重组批次没有目标成交”的可安全浅层重扫也直接终止。
- 当前已增加受限恢复：先重复核验游标哈希；若只是单次 RPC 链视图不一致则继续，若两次确认发生变化，则只在上一锚点哈希未变且被重组批次目标成交数为 `0` 时回退到上一锚点并重扫。曾发布目标成交或上一锚点也变化时仍 fail closed。
- 当前无 Observe/Paper/Supervisor/launcher 进程，运行锁、marker、FIFO 已清理。修复会产生新 Core；提交后须通过正式入口创建 replacement，重新完成最后约 `4 h`。

## Remaining blockers before small Live
- 合盖保护修复后的新核心尚无自然运行时长；累计 `24 h`、连续 `4 h`、`API_RECOVERY` 和新特殊操作自然样本仍未满足。
- SPLIT/CONVERSION 采用“退出或隔离”而非真实链上复制，可能与目标组合的经济结果不同；必须在 Paper 报告中单独统计。
- 历史 Phase 0 若只有特殊 Activity、没有本系统提交的完整证明，Replay 会保持 `INCOMPLETE`，不得人工降级通过。
- 官方结束时间缺失的 Live 策略、合规/geoblock、隔离钱包、真实 signer、真实 Live runtime 接线和 Live arming 尚未完成。

## Operator workflow
- 桌面入口：`/Users/d4clt/Desktop/Polymarket验证_点这里`；目标文件：`data/operator/target-wallet.txt`。运行锁存在时禁止切换目标。
- `operator-control` 是未来 localhost UI 的统一控制面；Live 控件继续固定为 `LIVE_RUNTIME_NOT_WIRED`，执行模式不能做成普通 UI 配置。
