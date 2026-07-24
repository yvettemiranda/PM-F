# Context

## Project
- 唯一有效仓库：`/Users/d4clt/Documents/Codex/2026-07-07/ni-k`。
- ni-k 是独立 Polymarket 跟单系统，不复用旧 Bot 的代码、数据库或账本。
- 当前唯一测试目标：`0x1f9e15f39bbd5d163b0eacf0fbef647ced9e4f1a`；旧地址和旧核心 Campaign 只能作为历史证据，不能改绑或混算时长。

## Safety boundary
- 必须保持 `execution_mode=PAPER`、`live_gate_state=LIVE_DISABLED`、`liveAllowed=false`。
- 未再次明确授权前，禁止 private key/seed、真实 signer、认证 CLOB submit/cancel、approve、真实 redeem、真实订单、真实资金和链上写入。
- 禁止绕过 geoblock、时钟、安全 Gate、数据完整性 Gate，禁止覆盖历史失败证据或跨核心混算验证时长。
- Gap、无法证明的跨源去重、unsupported conversion/SPLIT、无法证明完整 outcome set 的 MERGE 继续 fail closed。

## Runtime architecture
- Observe 默认 Polygon 已确认 `OrderFilled` 每 `1 s` 扫描，并用公开 WebSocket target-maker log 立即唤醒；通知不直接生成 Signal。Trades/Activity 每 `3 s` 交叉确认，Positions/pUSD 每 `15 s` 全量核对，新事件立即提前核对。
- 无变化且 `ONLINE + SYNCED` 时每 `15 s` 保存一次完整 Capture/Capital/Reconciliation/Checkpoint；事件、Signal、gap 恢复和状态变化立即保存完整证据。
- Paper/隔离 Live 共享不可变 Signal/Context、Risk、完整 REST 盘口、含手续费 VWAP、FAK、Reservation、Position/Ledger 和恢复语义。待买由盘口 WebSocket 唤醒，无消息时每 `15 s` REST 兜底。
- 每个 cycle 先固化新 Signal，再处理目标退出、止损和 pending retry。目标 SELL 先取消或同比例缩减等待 BUY，再按目标减仓比例处理自身真实持仓；不超卖、不为最低量放大。
- SELL 比例只以启动后实际跟随的本轮目标仓位为分母，不追补启动前历史仓位；普通 `STANDARD_TRADE` SELL 低于 `95%` 时按比例退出，达到或超过 `95%` 时把本轮跟单仓位判定为完整退出。目标仍持有的比例尾部转回 historical bucket，不再形成后续跟单义务。`COMBO_ACTIVITY`/MERGE 不应用该阈值，继续使用原有比例语义。
- 当前 Ruleset 下，低于最低卖出量的真实尾仓保持 `EXIT_PENDING`，不因时间过期取消；旧 Ruleset 继续保留其原有 terminal-cancel 行为，历史执行不被新规则重解释。

## Current execution rules
- 每笔目标 BUY 独立判断、独立 FAK，不累计、不合并未成交金额。
- 目标成交额占当时可见总资金 `<1%`：每笔金额最低 `1 pUSD`，按实际市场最低执行额抬升，硬上限 `5 pUSD`；比例结果超过 `5` 仍截到 `5`，市场最低额超过 `5` 直接跳过。资金不足 `1` 时整笔拒绝，不成交到 `1` 以下。
- 占比 `>=1%`：只按双方资金比例，不采用 `1—5 pUSD` 抬升；低于市场最低执行额时直接跳过。
- 首次实际开仓不计追单；之后 `<1%` 的实际成交最多 `smallFollowBuyMaxCount=9`。部分成交只计一次，零成交、取消、拒绝、过期不计；`>=1%` BUY 不受次数限制。
- 只有目标完整退出，且自身持仓、等待 BUY、退出任务和 Live 在途订单均归零，才开始新周期并重置次数。
- 同一 `transactionHash + orderHash` 的 Polygon 多 fill 合并金额并计算 VWAP；不同 orderHash 保持独立。Data API 只有与唯一 Polygon 订单的总数量和加权价格精确一致时才跨源去重，无法证明时不猜测。
- 参考价使用目标同一经济成交 VWAP。最新完整 REST 盘口的含手续费实际成交均价必须在目标价 `90%—105%`（含边界）且不高于 `0.95`：低于 `90%` 或高于 `0.95` 直接放弃，高于 `105%` 且不高于 `0.95` 继续等待。
- 市场最低量预检和最终撮合使用同一个 tick 向下取整后的 BUY 上限。允许满足市场最低量的 FAK 部分成交，余量立即取消且不转入下一笔。
- BUY 截止时间仍为市场剩余时间 `50%` 与 `30 min` 较短者；结束时间不可得时 Paper 使用信号固化的有限截止，Live 拒绝。
- 止损一触发即锁定该标的重新 BUY；目标本轮持仓结束且自身全部义务归零后解锁。SELL/REDEEM/MERGE/结算仍继续处理。
- MEDIUM 资本证据缺少比例时保留既有 `1 pUSD` fixed fallback，并归为小额 BUY；HIGH 使用精确比例，完整估值时按账户总权益计算。

## Version and compatibility
- 当前源码目标版本：Schema `2.29.0`、Signal `1.10.0`、Strategy `2.8.0`、Risk `1.10.0`、Replay `2.4.0`、Paper `1.16.0`、Live `1.13.0`、Validation `1.7.0`、Operational `1.9.0`、Ruleset `v1.10.0`、Config `v1.7.0`。
- `BUY_AMOUNT_POLICY_V4` 只用于包含 `smallFollowBuyMaxCount` 的新 Ruleset。v1.8/V3 与 v1.7/V2 历史证据继续按不可变旧语义验证，不能套用新金额、价格或 SELL 规则。
- `followSellFullExitThresholdPpm=950000` 只由新 Ruleset 解释；缺少该字段的历史 Ruleset 固定回退为 `1000000`，不会把旧的比例 SELL 重解释为完整退出。
- 本次没有数据库结构变更，也没有修改扫描频率、账本边界或安全 Gate。任何新 Campaign 必须使用最终干净提交生成的新 core compatibility hash。
- 普通 `TARGET_SELL` 的 `EXIT_PENDING` 与后续真实到达的 BUY 是两笔独立义务：旧退出继续保留和重试，但不得阻塞后续 BUY。`STOP_EXIT_PENDING` 仍由止损重开锁拒绝本轮后续 BUY。

## Current runtime and evidence
- 用户已授权只保留当前规则版本。2026-07-23 23:45 已永久删除更早的混合旧规则数据库、旧 Campaign/Capture/Replay/日志、`work/`、`outputs/` 和旧 ZIP。
- 新版 Campaign `PC-9CE4EA3EBBE605DF9E54` 自然暴露 `SAME_ASSET_EXIT_PENDING` 阻塞独立 BUY：一个 `0.096538` 股尾仓退出使后续 1 pUSD BUY 等到过期。2026-07-24 05:51 已安全暂停，累计约 `5.99 h`、11 个 BUY Signal、3 个 BUY Fill、3 个持仓、0 个 Live 记录。
- 诊断报告 `Paper累计验证_PC-9CE4EA3EBBE605DF9E54_PS-DD61330BCD0C886521F7_20260724-055146-58952.zip` 的 SHA-256 为 `ea14fbc1df00114aa350b910e517553dbdbc43b175ce24d8bd199235315fa88f`。该旧 Paper `1.14.0` Campaign 只作问题证据，不与修复后的 Paper `1.15.0` 累计时长。
- 旧 Paper `1.14.0` 运行库和冗余报告已移至系统废纸篓 `/Users/d4clt/.Trash/ni-k-old-core-20260724-0557/`，可恢复；仓库清理后一度降至约 `232 MB`。只保留上述问题诊断 ZIP 和当前新版报告。
- 修复代码提交 `7a640a71a384e8ad02cb9c36046496daaf4538a8` 从空白 Schema `2.29.0` 创建 Campaign `PC-305046D47E89A5529CDA`。用户将截止时间提前到 2026-07-24 07:30，07:36 已安全暂停并完成 final drain：有效运行 `1.63 h`，Observe 成功 `5556`、失败 `0`、Gap `0`，3 个 BUY Signal、1 个 SELL Signal、2 个 Fill、1 个 Realized PnL、无活动 Reservation。
- 新版自然成交为小额 BUY 申请 `4.14 pUSD`、实际买入 `5.003743` 股，随后 TARGET_SELL 成交 `5` 股并保留 `0.003743` 股真实精度尾仓 `EXIT_PENDING`；两笔高价等待 BUY 正常过期并释放 `2 pUSD`。
- 当前报告 `Paper累计验证_PC-305046D47E89A5529CDA_PS-2CD692D49B8A067668BE_20260724-073627-69773.zip` 的 SHA-256 为 `f4dd4c4dd578896416b614cfaecec605fbf8f1748adb2888e38eac2e4dde3eea`；ZIP 校验通过。最终状态 `PAUSED + PAPER + LIVE_DISABLED + liveAllowed=false`，Live Execution/Order/Fill/Attempt 均为 `0`，数据库 integrity/foreign key 正常。
- 上述 `1.63 h` Campaign 属于旧 Paper `1.15.0`/Ruleset `v1.9.0` 核心，只保留为自然成交证据；95%全退的新核心尚未启动 Campaign，不能继承旧核心累计时长。

## Remaining blockers before small Live
- 95%全退新核心尚无自然运行时长；旧 Paper `1.15.0` Campaign 的 `1.63 h` 只作诊断证据，不能进入新核心 Gate。累计 `24 h`、连续 `4 h` 和 `API_RECOVERY` 仍未满足。
- SPLIT 和 tracked negative-risk conversion 仍无可执行复制语义；无法证明完整集合的 MERGE 仍硬阻断。
- 官方结束时间缺失的 Live 策略、合规/geoblock、隔离钱包、signer、真实 Live runtime 接线和 Live arming 尚未完成；自然 BUY/SELL/Fill/Fee/Realized PnL 已在 Paper 覆盖，但不能替代 Live 验证。

## Operator workflow
- 桌面入口：`/Users/d4clt/Desktop/Polymarket验证_点这里`；目标文件：`data/operator/target-wallet.txt`。运行锁存在时禁止切换目标。
- `operator-control` 是未来 localhost UI 的统一控制面；Live 控件继续固定为 `LIVE_RUNTIME_NOT_WIRED`，执行模式不能做成普通 UI 配置。
