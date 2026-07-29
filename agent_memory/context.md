# Context

## Project
- 唯一有效仓库：`/Users/d4clt/Documents/Codex/2026-07-07/ni-k`。
- ni-k 是独立 Polymarket 跟单系统，不复用旧 Bot 的代码、数据库或账本。
- 当前唯一测试目标：`0x1f9e15f39bbd5d163b0eacf0fbef647ced9e4f1a`；旧地址和旧核心 Campaign 只能作为历史证据，不能改绑或混算时长。

## Safety boundary
- 所有生产前置条件、官方 geoblock、Gate、Live 对账和钱包授权真正通过前，必须保持
  `execution_mode=PAPER`、`live_gate_state=LIVE_DISABLED`、`liveAllowed=false`。
- 用户已明确授权按已保存的 `10/1/3/1 pUSD` 小额限额完成一次 Live 全流程。仍禁止加载
  private key/seed 或伪造/绕过任何安全证据；OKX 的身份签名和链上授权仍必须在扩展中逐笔
  明确确认。钱包已连接只代表身份会话建立，只有一键流程完成 Gate、对账、钱包准备和最终
  启动后才进入 Live。
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
- 2026-07-29 的独立 Observe 验证已连续完成两轮，每轮 `29,400,xxx ms`
  （8 小时 10 分钟），均为 `DURATION_COMPLETE`、`SHORT_SOAK_PASSED`、
  `liveStabilityEligible=true`，scheduling gap/major desync/unrecovered connection gap
  均为 `0`，最终均为 `SYNCED`。第二轮报告为
  `data/observe/observe-8h.json`，并归档为
  `data/observe/archive/observe-8h-run-aead6def-fc4d-466a-87c6-d665255acde0-passed.json`；
  第一轮归档为
  `data/observe/archive/observe-8h-run-3a9f1686-ba4a-4dd1-9426-da20cd8b36b8-passed.json`。
- Observe 的临时 API 失败和 minor diff 均已恢复，两个最终报告只保留
  `RECOVERED_API_FAILURES_OBSERVED` 与 `TRANSIENT_MINOR_DIFF_OBSERVED` 警告，
  没有验收 blocker。整个过程未加载私钥、未包含订单逻辑、未创建订单。
- `launchctl submit` 推断出的 KeepAlive 在第二轮完成后曾启动第三轮；该轮仅运行约
  77 秒后按用户要求安全中止，证据归档为
  `data/observe/archive/observe-8h-run-4f36e7c7-d3ae-4648-8d65-343e0f7c3e0b-aborted.json`。
  对应 job 已 `remove` 且保持 disabled，当前无 Observe/Paper/Supervisor 进程。
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
- 官方结束时间缺失的 Live 策略仍会阻断；普通浏览器 EOA 的 signer、会话内认证
  CLOB、只读 provider、真实 CLOB adapter、allowance/redeem 和默认 production
  assembly 已完成，但真实钱包、真实凭据、真实资金证据和用户当次最终确认尚未发生。

## Operator workflow
- 桌面入口：`/Users/d4clt/Desktop/Polymarket验证_点这里`；目标文件：`data/operator/target-wallet.txt`。运行锁存在时禁止切换目标。
- `operator-control` 与 `operator-dashboard` 是 localhost UI 的统一控制面。UI 可操作
  Paper，并展示小额 Live 参数、EOA 钱包连接、allowance 设置、逐项 readiness、
  Gate、对账、恢复和紧急停用；执行模式不能作为普通配置字段绕过 Gate。
- `prototype/live-ui/server.mjs` 在 EIP-1193 session 证明通过后调用
  `assembleDefaultConnectedLiveRuntime`。同一 session 装配 browser signer、惰性
  CLOB L2 client、真实余额/allowance/仓位、CLOB submit/cancel、EOA approve/
  redeem、官方 geoblock、时钟、合规、账户、身份绑定、Gate 和 runtime。配置变化
  强制断开重连；启动前同步 recovery 必须 ready，启动失败回滚 Gate，后台循环异常
  emergency stop；宿主退出先停 Gate/runtime 并撤销 session。持久化配置读取时也
  执行小额硬上限；runtime database 和新备份强制 `0600`。UI 只开放完整闭环的
  EOA；Proxy/Safe/1271 等待官方 relayer。
- Live runtime 会捕获源码/验证工件在会话建立后发生的版本失配：在预检、arming 或恢复抛出
  `LIVE_PRODUCTION_*_INVALID` 时撤销旧钱包租约、取消待签名请求并回到
  `PAPER + LIVE_DISABLED`，返回 `LIVE_RUNTIME_STALE_RECONNECT_REQUIRED`；更新源码或
  验证工件后必须重启服务并重新连接。
- UI 快照仍每 `3 s` 轮询，但 `generatedAt`、readiness `checkedAt` 和钱包
  `lastSeenAt/expiresAt` 等纯时间字段不会再触发整页 DOM 替换；顶部“后台在线”时间原位更新。
  真正的数据变化才重绘，且输入编辑、弹窗、后台操作和钱包连接期间延后重绘。服务提供
  instance id/source version，服务重启后页面会自动刷新到新实例。Gate 前置条件同时展示
  当前源码上的 `effectiveStatus`，旧提交或 dirty 源码证据显示为 `STALE`。

## Application entry
- 日常主入口为桌面 `/Users/d4clt/Desktop/Polymarket验证_点这里/Hecatonchires.command`，它指向仓库内 `scripts/launch-hecatonchires-ui.command`。
- 主入口检测 `GET /api/operator/snapshot`；已有 localhost UI 时只打开浏览器，未运行时补齐 Finder 启动时可能缺失的 Node PATH、启动 `pnpm operator:ui`，等待就绪后打开浏览器。终止终端会先停止本次 UI 服务。
- Chrome 已有同 URL 标签页时，主入口通过 AppleScript 聚焦并复用该标签页，不再创建
  重复控制台。UI 的钱包连接和 session wallet worker 使用 Web Locks 跨标签页互斥；
  钱包已授权本站时先复用 `eth_accounts`，不会伪装成仍需连接确认。
- 活跃控制台的 `3 s` 心跳会续期短期钱包会话；页面关闭且没有心跳时仍会在 30 分钟后
  自动失效。模式切换已收敛为“一次确认”：必要时先恢复钱包会话，再由后台依次执行
  Gate、Live 对账、钱包授权准备、最终 Gate 和 runtime 启动，任何步骤失败自动回滚 Paper。
- 桌面入口现在还会在 Finder 精简 PATH 中探测用户级/Homebrew/Codex bundled `pnpm`，再补齐同目录 Node；这修复了双击时找不到 pnpm 导致入口立即退出的问题。
- 主入口故意不放进 `操作入口/`，避免把纯 UI 启动脚本纳入 Paper core compatibility manifest；`操作入口/` 的三个 `.command` 继续作为 Paper 验证/安全暂停/结果查看工具。

## Runtime handoff and valuation recovery
- Paper 账户现在是跨 Campaign 的持久化组合容器。新 Core replacement 在旧 Campaign 已终止、没有等待中的 BUY/活动 reservation 且现金账本一致时复用同一 `paper_account_id` 和同一 `baseline_run_id`；旧仓位、旧 execution 和旧 ruleset 快照保持不可变，新账户运行时元数据更新到当前 Core，并在 Campaign transition evidence 中记录单向交接。
- SQLite 迁移 `036_execution_runtime_handoff.sql` 移除 Campaign 对 `paper_account_id` 的列级唯一限制，改为可审计的 `(paper_account_id, created_at)` 索引，允许同一持久化 Paper 账户跨顺序 replacement Campaign 使用。
- Paper final drain 与 Paper/Live 只读估值均使用有上限的重试和退避；最终估值短暂不完整会保留原始 blocker 和恢复证据，并允许同一 Core 后续恢复，而不是把仓位当成已结算或强行完成。
- Paper BUY 在已有持仓且市场数据仍处于不可恢复冻结时不消费/不下新 BUY；Live BUY 在估值不完整时保留 Signal 待重试，不 quarantine、不消费。
- Live 已具备禁用态 `handoffRuntime`、final valuation recovery、启动恢复、外部订单/
  成交/仓位对账、合规/geoblock/时钟、浏览器 EOA signer、会话内认证 CLOB、真实
  adapter、arming/kill switch 和默认 production assembly；全局
  `PAPER + LIVE_DISABLED + liveAllowed=false`、无真实钱包/真实订单的事实不变。
- Live `handoffRuntime` 现在还要求账户处于禁用态、没有未终态外部订单或活动 reservation、现金/保留账本非负且没有非零冻结仓位；Live Gate 全局 reconciliation 同时检查 Live 账本与孤儿/负仓位。`LiveRuntime` 仅组合 Gate 启动恢复、LiveExecutor 和 LiveRunner，不自行 arming 或发现凭据。
- `LiveIdentityBinding` 在启动恢复、arming 申请/确认和轮询入口都核对注册账户、钱包状态、运行时钱包地址、authorized signer 地址、组件环境类型与源码版本；漂移时紧急禁用 Gate。`assembleLiveRuntime` 要求调用方显式注入全部 provider/adapter，不读取私钥或自动构造认证客户端。

## 2026-07-28 workspace cleanup
- 保留审计文档、最终 24 小时报告及压缩包、最终五个审计引用 Campaign、最终隔离验证、当前 Live 生产验证凭证和最新交接指针。
- 已将过期的 pre-2.30 迁移备份、旧中间 evidence/log、未被最终报告引用的 `PC-2EB95BD31A8EB9693837` 与 `PC-305046D47E89A5529CDA` 文件、历史交接 ZIP、旧清理说明和 `.DS_Store` 移出仓库；临时可恢复目录由本轮工具输出给出。
- 未删除 `data/phase0/phase0.sqlite`、历史 Capture、源码迁移、测试 fixture 或最终审计证据；这些仍是运行恢复、Replay 或外部审计所需资料。
- 同轮复核删除了只被旧测试使用的 `LiveExecutorPlaceholder` 及其过时断言；正式 `LiveExecutor`、默认生产装配和安全 Gate 保持不变。

## Owner-selected delivery order
- 用户明确要求按“3 → 2 → 1”推进：先完成全部 Live/后端接线、账户交接、外部订单恢复、合规与安全闸门等开发（但不得启用真实订单）；再开发可操作的 UI；最后统一做 Paper、隔离 Live 和安全门验证。
- UI 完成后才进入最终验证；最终验证通过且用户再次明确授权前，仍保持 `PAPER + LIVE_DISABLED + liveAllowed=false`。这里的“先做 3”表示先把能力开发完整，不表示提前接通或启用实盘。
