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
- 当前源码目标版本：Schema `2.29.0`、Signal `1.9.0`、Strategy `2.7.0`、Risk `1.10.0`、Replay `2.3.0`、Paper `1.14.0`、Live `1.11.0`、Validation `1.7.0`、Operational `1.7.0`、Ruleset `v1.9.0`、Config `v1.6.0`。
- `BUY_AMOUNT_POLICY_V4` 只用于包含 `smallFollowBuyMaxCount` 的新 Ruleset。v1.8/V3 与 v1.7/V2 历史证据继续按不可变旧语义验证，不能套用新金额、价格或 SELL 规则。
- 本次没有数据库结构变更，也没有修改扫描频率、账本边界或安全 Gate。任何新 Campaign 必须使用最终干净提交生成的新 core compatibility hash。

## Current runtime and evidence
- 历史 Campaign `PC-105EC3F76A2AC49D59E6` 为 `PAUSED`；旧核心累计 `4.84 h`，只作诊断证据，不能计入当前新核心验收。
- 历史结果：`15605` 次成功轮询、`11` 次已恢复 timeout、`30` 个目标事件、`9 BUY / 21 SELL`、gap `0`、最终 `SYNCED`；9 个 BUY 为 `1 FAK_FILLED / 5 BELOW_MARKET_MIN_ORDER_SIZE / 3 WAIT_TIMEOUT`。
- 当前无 Observe/Paper/Supervisor/launcher 进程；目标仍正确，数据库 Schema `2.29.0`，此前检查 `integrity_check=ok`、外键失败 `0`，Live Execution/Order/Fill 均为 `0`。
- `data/` 最近约 `598 MB`、主库约 `577 MB`；旧多代迁移备份已按用户授权清理，迁移备份默认只保留最新校验通过的 `1` 份。

## Remaining blockers before small Live
- 新核心尚无自然短测/长测；历史 `4.84 h` 不计入。需要先做新 core 短时 Paper，再开始干净最终 Campaign。
- SPLIT 和 tracked negative-risk conversion 仍无可执行复制语义；无法证明完整集合的 MERGE 仍硬阻断。
- 官方结束时间缺失的 Live 策略、自然 SELL/REALIZED_PNL、最终 Observe 时长、合规/geoblock、隔离钱包、signer 和 Live arming 尚未完成。

## Operator workflow
- 桌面入口：`/Users/d4clt/Desktop/Polymarket验证_点这里`；目标文件：`data/operator/target-wallet.txt`。运行锁存在时禁止切换目标。
- `operator-control` 是未来 localhost UI 的统一控制面；Live 控件继续固定为 `LIVE_RUNTIME_NOT_WIRED`，执行模式不能做成普通 UI 配置。
