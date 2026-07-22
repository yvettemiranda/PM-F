# Progress

## Current task
- 2026-07-22 用户要求停止当前测试，全面排查“目标开单但始终跟不上”并修复；必须保持 `PAPER + LIVE_DISABLED`，修复完成后不自动重启。
- Campaign `PC-D6C6BDF51D42647D8EA6` 已正式安全暂停并生成报告；最终确认 4 BUY + 2 SELL 全部为 `GAP_EVENT`，无 Order/Fill、无 Reservation、无 Live 写入。
- 已复现首个确定根因：CLOB 市场 `end_date_iso=null` 时，Signal Context 构造抛出 `MARKET_END_TIME_UNAVAILABLE`；Observe 将元数据处理失败误当成数据源断档并扩大 gap cutoff，下一轮把已实时看到的交易永久降级为不可执行 Gap。
- 直接根因、同轮其它市场被连带丢弃、多腿 MERGE emission/ledger/classification 冲突、非交易 Activity 重复执行和 Replay/Observe 不一致均已修复并提交；业务库 backup-first 迁移完成，准备生成新核心 Phase 0 并启动测试。

## Completed implementation
- 新增 migration 034：记录 Signal 富化 warning、显式市场结束时间状态和执行 deadline，并允许同一个 MERGE source event 保存多条 Signal emission。
- Observe 事件/projection/checkpoint 与 Signal 富化解耦；每条 Signal 独立富化、失败可持久重试，同一轮其它市场不受影响；只有真实 API/调度/恢复缺口才打开 gap。
- 缺少官方结束时间的市场不再丢 Signal；Paper 使用目标时间起有限 deadline，Live Gate 明确拒绝 `MARKET_END_TIME_UNAVAILABLE`。
- 标准二元 MERGE 必须由官方 CLOB token set 精确证明后，才在 Observe 与 Replay 中生成两个唯一的等价退出 Signal；两腿 emission、Replay classification 和 position ledger 均分别持久化。零/单腿、官方集合不符、余额不足或不可定价 MERGE 立即 `MAJOR_DESYNC`。SPLIT/CONVERSION 仍失败关闭。
- Replay 按时间交织 Trades 与非交易 Activity，REDEEM 会清零同 condition projection，Golden expectations 与多腿事件结果保持一致。
- README 和版本/核心兼容性契约已同步到 Schema `2.29.0` / Ruleset `v1.7.0`。

## Verification completed
- TDD 已覆盖：结束时间为空仍发布并 Paper 成交、瞬时富化失败后重试、同轮单市场失败隔离、多腿 MERGE 双 emission/ledger/classification、官方三 outcome 拒绝、零/单腿 MERGE fail closed、非交易 Activity 去重、Paper 双腿退出、Replay MERGE/REDEEM、Live unknown-end 拒绝及 migration/核心契约。
- 当前最终全量结果：`53` 个测试文件、`685/685` 项通过；`tsc --noEmit` 与 `git diff --check` 通过。
- Standards/Spec 两轴审查先后发现多腿 emission、ledger/classification 唯一约束、零/单腿 MERGE、官方 outcome set、非交易 Activity 去重、Replay/Observe 投影一致及版本绑定问题；均已修复并有持久化回归覆盖。

## Runtime state before final verification
- 旧 Campaign `PC-D6C6BDF51D42647D8EA6` 仍为 `PAUSED`，Session 已 `COMPLETED`，无 Observe/Paper/Supervisor 子进程；本批未创建真实订单、未使用 signer、未链上写入。
- 业务库已从 `2.28.0` backup-first 迁移到 `2.29.0`；迁移前后 Campaign `9`、Session `18`、checkpoint `5543`、raw event `23129`、Signal `20559`、Paper execution `608`、Paper order `1499` 等关键表逐项同数，Live execution/order/fill 仍全为 `0`，Active Reservation 为 `0`。
- 下次启动必须使用本批最终干净 commit 重新生成 Phase 0/Replay/core 绑定，不得续算旧核心 Campaign 时长。

## Current identity
- 当前工作树尚未提交，旧 hash 不得继续作为新核心身份；提交并迁移后从 Operator 输出重新记录。

## Next steps
1. 提交迁移后记忆更新，使用最终干净 HEAD 重新生成 Phase 0/Replay/core 绑定。
2. 按用户最新明确要求，以新核心自动启动全新的 Paper Campaign；不得续用旧时长。
3. 每 30 分钟核对信号漏斗、warning/gap/desync、进程和 Gate；必要时安全暂停、修复、重新从新核心测试，持续到 2026-07-23 08:00（Asia/Shanghai）。
