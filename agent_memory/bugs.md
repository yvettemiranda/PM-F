# Bugs And Risks

## Active blockers
- 原 24 小时 Observe 失败证据继续保留；身份折叠与 Activity 游标缺陷已修复，真实 capture replay 和新基准短时对账已通过，但修复后的 24 小时 Observe 尚未完成，因此 Observe 稳定性 Gate 仍未通过。
- 修复后的 24 小时 Observe、长周期 Paper、Crash Recovery 长测、长期 Ledger/Position/External State 一致性尚未执行；短时和零时长 smoke 不能替代 soak。
- Data API 历史 offset 上限导致完整钱包历史不可得，历史 Replay 仍为 `INCOMPLETE`；缺历史 orderbook snapshot，不能声称历史 Paper execution/PnL 已验证。
- 真实 geoblock/compliance、隔离钱包、安全凭据存储、真实只读余额/订单/成交/仓位 provider、人工授权和小额实盘前检查尚未完成。
- 2026-07-13 最终只读复测官方 geoblock 返回 `BLOCKED (US/CA)`，CLOB clock offset 约 `1733ms` 且为 `UNSAFE`；当前环境明确不能用于 Live，必须在合法部署环境重新验证，禁止绕过。

## Active risks
- `@polymarket/clob-client-v2@1.0.8` 间接依赖 `elliptic@6.6.1`，`pnpm audit --prod` 报 1 个 LOW；公告所列修复版 6.6.2 尚未在 npm 发布，当前无法安全覆盖。官方 SDK 已是最新版，需持续关注上游更新。
- Node 内置 `node:sqlite` 在 Node 24.14.0 仍输出 experimental warning；已锁定 Node 版本并有 Online Backup、事务、恢复和完整性测试，但长时间运行稳定性仍需 soak 证明。
- 公开钱包成交依赖 Data API 增量轮询而非钱包 WebSocket；Activity/Trades/Positions 可短暂先后不一致。系统会保留 gap、MINOR_DIFF/MAJOR_DESYNC 和 reconciliation evidence，不得自动改仓掩盖差异。
- CLOB orderbook 超过 2 秒会严格拒绝成交；这提高安全性但可能降低 Paper/未来 Live 成交率，必须用长期报告评估，不能为了成交率私自放宽。
- 外部余额、订单、成交和仓位 provider 的生产实现仍需在真实部署环境接线与验收；当前 fake/disabled 测试只证明接口和状态机，不证明真实网络可用性。
- 业务源库当前仍为 schema 2.4.0，未在本轮审计中原地修改。运行时准备会自动 backup-first，再迁移至 2.18.0，并做 integrity/FK/Live Gate 安全状态检查；第一次正式启动仍应观察迁移日志并保留自动备份。

## Resolved in current hardening
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
