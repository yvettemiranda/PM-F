# Bugs And Risks

## Active blockers
- 原 24 小时运行仍缺 Paper JSON，无法证明当时 PaperRunner 错误为零；且没有任何 `executionEligible=true` 的 SELL，347 个模拟仓位全部 `OPEN`，正常卖出、止损、已实现 PnL、Settlement/Redeem 未被长测覆盖。
- Crash Recovery 长测、长期 Ledger/Position/External State 一致性尚未执行；短时和零时长 smoke 不能替代 soak。
- Data API 历史 offset 上限导致完整钱包历史不可得，历史 Replay 仍为 `INCOMPLETE`；缺历史 orderbook snapshot，不能声称历史 Paper execution/PnL 已验证。
- 真实 geoblock/compliance、隔离钱包、安全凭据存储、真实只读余额/订单/成交/仓位 provider、人工授权和小额实盘前检查尚未完成。
- 2026-07-13 最终只读复测官方 geoblock 返回 `BLOCKED (US/CA)`，CLOB clock offset 约 `1733ms` 且为 `UNSAFE`；当前环境明确不能用于 Live，必须在合法部署环境重新验证，禁止绕过。

## Active risks
- Paper 公开行情请求现支持外部 Abort；最终估值有 30 秒总预算并可由后续 TERM 立即升级为快速停止。其他未接入该 signal 的非 Paper 公共采集仍依赖各自 timeout/有限重试，操作入口继续保留 45 秒强制清理上限。
- 旧 24 小时轮询收到约 536 万条 Trade 记录，其中识别 2,368,476 个重复事件，仅 704 个新事件。当前正常 Trade 头页已降为 100 条且不覆盖 committed watermark 时自动回退 1000 条；仍需用 7 天长跑确认真实 API 负载改善幅度。
- `@polymarket/clob-client-v2@1.0.8` 间接依赖 `elliptic@6.6.1`，`pnpm audit --prod` 报 1 个 LOW；公告所列修复版 6.6.2 尚未在 npm 发布，当前无法安全覆盖。官方 SDK 已是最新版，需持续关注上游更新。
- Node 内置 `node:sqlite` 在 Node 24.14.0 仍输出 experimental warning；已锁定 Node 版本并有 Online Backup、事务、恢复和完整性测试，但长时间运行稳定性仍需 soak 证明。
- 公开钱包成交依赖 Data API 增量轮询而非钱包 WebSocket；Activity/Trades/Positions 可短暂先后不一致。系统会保留 gap、MINOR_DIFF/MAJOR_DESYNC 和 reconciliation evidence，不得自动改仓掩盖差异。
- CLOB orderbook 超过 2 秒会严格拒绝成交；这提高安全性但可能降低 Paper/未来 Live 成交率，必须用长期报告评估，不能为了成交率私自放宽。
- 外部余额、订单、成交和仓位 provider 的生产实现仍需在真实部署环境接线与验收；当前 fake/disabled 测试只证明接口和状态机，不证明真实网络可用性。
- 业务源库仍可能停留在 schema 2.18.0；首次短测会先做 SQLite Online Backup，再迁移到 2.19.0 并执行 integrity/FK/`PAPER + LIVE_DISABLED` 检查。

## Resolved in current hardening
- Paper 不可用行情此前只形成重复运行错误；现 `No orderbook`、stale book 和 fee unavailable 都会持久化单市场冻结、有界退避和恢复证据，不伪造价格、不产生模拟成交，未恢复 blocker 无法通过 Gate。
- Paper 最终 drain 超时、Settlement 请求/赎回异常、零费用但缺 Fee Ledger、target 漂移、Cash/Reservation 中间余额错误现在都会 fail closed；到期仓位会先事务化取消对应未成交退出 allocation。
- Crash Recovery 不再只依赖 SQLite `RAISE(ABORT)`：新增真实子进程 SIGKILL 覆盖 Reservation、BUY Fill、Settlement，重启后完整性、外键、幂等和账户一致性均通过。
- 联合入口原先记录后台 zsh/tsx 包装层 PID，TERM 后实际 Paper worker 会成为孤儿且缺报告；现改为后台 subshell 直接 exec Node worker，并用真实操作入口验证 Paper/Observe 均生成报告、四文件 ZIP 完整、无进程/锁/FIFO 残留。
- Paper 快速停止后的 `INCOMPLETE` 账本快照曾可能仍标为 `COMPLETED`；现 CLI 使用独立完成状态，联合 Gate 再校验 `errorCount=0`、完整估值、零未估值仓位、VWAP 来源和 `FINAL_VALUATION` 关闭协议，人工快速停止不能误过 Gate。
- Paper 停止原先可能卡在不可中断 interval、逐仓位重复盘口请求或最终全仓位网络估值；现已支持 Abort、按市场复用单轮快照、停止后账本-only 收尾，347 个仓位/4 个 asset 不再产生数百次重复请求。
- Paper 计划收尾时取消在途请求曾会被计为运行错误，使完整最终估值也变成 `COMPLETED_WITH_ERRORS`；现只忽略可证明属于当前停机信号的取消，竞态中的普通业务错误仍保留，并有正反回归测试。
- Portfolio Projection 原先对同一 asset 的每个独立 Position 重复使用完整盘口深度并漏掉 FROZEN，可能高估可退出价值；现按 asset+condition 汇总 size 匹配一次深度并确定性分摊，同时纳入 FROZEN。
- 原联合入口的 Paper 会早于 Observe 结束、正常完成仍标记“提前停止”、信号崩溃可被吞成成功、`wait` 可无限阻塞、日志未刷盘就打包、Finder 可选错旧 ZIP 等操作缺陷已修复。现只有 Observe 报告明确 `liveStabilityEligible=true` 且 `activeRuntimeMs>=86400000`、Paper 安全报告通过时才显示正常结束。
- 结果 ZIP 改为唯一名、临时写入、完整性校验和严格 4 项白名单；已排除 macOS AppleDouble/`__MACOSX`、SQLite、`.env`、账户 ID 和凭据。
- 同一交易中两笔字段完全相同的真实成交曾被 v1.1 字段哈希折叠；现已使用兼容旧 key 的 occurrence 多重集身份修复。双源确认、数量歧义阻断、跨重启延迟确认 Gap 化、数据库保存和 Replay 均有回归测试，真实失败 capture 可稳定还原 3 个事件。
- fresh baseline 后没有 post-baseline event 时，Activity 游标曾为 `undefined`，导致高频钱包每隔一轮重扫不完整历史并触发 `OBSERVE_INCREMENTAL_PAGE_SATURATED`；现已固定回看 baseline 前 1 秒，并有无事件连续轮询回归测试。
- 游标修复后的 90 秒真实 Observe 已连续 6 次成功轮询并保持 `SYNCED`，没有 API failure、Gap、状态漂移或 checkpoint 异常；长周期结论仍等待重新执行 24 小时任务。
- WAL snapshot 漏数据、capture payload 不可复现、BUY 向下舍入、Observe 组合误识别、Live/Paper 历史规则串用、Live 信号激活空窗、坏 Signal 阻塞队列、Live fill/recovery 校验不一致、外部仓位/现金漂移缺失、Live 账户资金口径未绑定均已修复并有回归测试。
- Live Runner 原先先消费新 Signal、后检查止损且长期报告数组无限增长；现已改为风险退出优先，止损健康异常时本周期阻断新增 BUY，并对错误/结算明细实施有界去重和累计计数。
- Activity 的 MAKER_REBATE/YIELD 等空字符串占位曾导致真实采集失败，且高频钱包每轮首屏都会饱和；现已按非交易语义归一化，并使用时间游标分页/Trades overlap 检查防漏。
- Live Executor 曾可接收内存篡改的 Signal、信任 signer 改写经济参数、缺完整 Order Intent 恢复证据，以及与 emergency/cancel 发生并发竞态；现已逐项 fail closed 并有回归测试。
- Live BUY 曾只信任 signer 自报费用上限，且另一进程可在 submit 调用窗口触发 emergency；现已用独立最坏费用计算、持久化 submit claim、Gate generation 和成交后冻结/对账路径修复，相关类型检查及 104 项聚焦测试通过。
- Validation/Operational 曾允许部分 `--no-snapshot` 路径迁移并写业务库，Live Gate transition 可被改删，Execution 状态与审计存在非原子窗口，Settlement 表名与证据语义混淆；现已统一强制 snapshot、保护 Gate transition、原子化 Execution，并用 2.18.0 append-only Settlement Events 分离投影与证据。
- 批量仓位冻结曾可能在中途故障时只冻结一部分，Redeem `FAILED` 的 event 曾与 projection/transition 状态分叉；现已用嵌套事务全部回滚，并统一 lifecycle 为 `REDEEM_PENDING -> RESOLVED`，失败详情保留在 reason/evidence。
- 高危/中危 `ws` 间接依赖已通过 workspace override 固定到 8.21.0；剩余 audit 只有上述 LOW `elliptic`。

## Safety boundary
- 当前状态必须保持 `PAPER + LIVE_DISABLED`；不存在自动升级或用户双击 Live 的路径。
- 未再次明确授权前禁止接入 private key/seed、真实 signer、认证 CLOB client、submit/cancel、approve、真实 redeem 和链上写操作。
- `executionEligible=false`、Risk REJECT、Gate failure、stale orderbook、未知 fill、reconciliation drift 或冻结状态都必须 fail closed；不得手工改数据库绕过。
- 只有完成所有长周期/合规/人工 Gate 后，才能把技术候选评估为可进行小额真实资金试运行。
