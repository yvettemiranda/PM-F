# Progress

## Current task
- 2026-07-22 已把后续测试目标切换为 `0x1f9e15f39bbd5d163b0eacf0fbef647ced9e4f1a`；用户将自行启动，Codex 本轮未创建新目标、未启动 Campaign、未写业务库。
- 修复目标切换时可能误续跑“全库最新 Campaign”的缺陷：预检、freeze、runner 和状态均按 wallet/target 筛选；不同目标可以保留各自 Campaign，旧目标不会被新目标的核心变化冻结或续跑。
- 隔离 Phase 0/Replay proof 现在显式绑定目标钱包；旧地址 proof 对新地址验证失败。全局 supplemental Replay evidence 也按目标 signal binding 过滤，不能跨钱包补足覆盖率。
- 新地址只读尽调：身份 `IDENTITY_CONFIRMED/HIGH`、类型 `PROXY_WALLET`、当前活跃；Trades/Activity 因上游 offset 限制均不完整，Positions 完整。最近 500 条 Activity 有 10 次 MERGE，且 0 次在最近 1000 条 Trades 中发现同交易哈希，现有系统不会复制 MERGE。
- 已为旧目标安全启动 `2.27.0` replacement Campaign `PC-C268FD8331F1F503DFF6`，随后按用户新指示通过安全暂停入口收尾。Session `PS-D50FE31F7FF33A1DCEA4` 最终 `SYNCED`，累计 `26061 ms`，0 Signal、0 Order、0 Fill、0 Position、0 active Reservation，Campaign 状态 `PAUSED`、可继续但仍绑定旧目标。
- 隔离验证在启动前重新执行：49 个测试文件、622 项全部通过；Phase 0/Replay 第一次尝试形成稳定 proof，artifact hash `29e0f71f436346fb53111f1083c61f901a67e08acb1005ca5fc731bffd93642c`。
- 本轮仍严格禁止 signer、认证 CLOB、真实订单、approve/redeem 和任何链上写入。

## Completed implementation
- 新增只读 Polygon `eth_getTransactionReceipt` 适配器和严格响应解析；仅允许 HTTPS RPC，交易哈希、回执状态、日志地址/topics/data 均做结构校验。
- 新增深模块 `negative-risk-conversion`：按目标钱包净额汇总全部 ERC-1155 `TransferBatch` 腿，并同时要求 Activity 金额、唯一且 stakeholder 精确等于目标钱包的 NegRiskAdapter 事件、目标 Positions 的 negative-risk/event identity 三方一致。
- 兼容真实 Data API 稀疏 Activity：`CONVERSION.eventSlug` 为空时，从全部目标 Positions 一致的非空 `eventSlug` 推导；Activity 有值时必须与 Positions 一致。
- Observe projection 现在按 tracked-first、historical-second 消耗源 bucket，并把两类 bucket 原样复制到每个目标资产；目标 conditionId 同步进入后续 REDEEM 投影映射。
- 纯 historical 转换不生成交易 Signal；存在 tracked bucket 时生成不可执行 `TARGET_CONVERSION` 审计义务。在线与 Gap 分别使用明确阻断原因，绝不把未跟随转换伪装成已完成。
- 回执 capture、转换腿、证据哈希与 source event/poll/observe run 事务绑定，数据库 append-only；重启从证据表恢复，不重复 RPC，也不会因缺失内存状态改变 checkpoint hash。
- 回执缺失、stakeholder 不符/证明重复、金额不符、源/目标净额不符、目标事件不一致、证据哈希冲突或 provider 缺失时 Poll 失败关闭，不提交半成品事件或 checkpoint。
- 转换涉及的源/目标资产必须与同 Poll 的完整 Position projection 做 micros 零容差核对；即使普通 reconciliation 容差会判 `SYNCED`，转换数量有 1 micros 差异也不会写入不可变 verified evidence。
- Paper funnel 新增 conversion 计数；短测 Gate 和最终 Campaign integrity 都将未执行 tracked conversion 作为硬 blocker。运行时在候选选择前及逐笔执行前重复闭锁检查，消除 Observe 并发提交窗口：Paper 原子置 `PAUSED` 并冻结仓位，Live 调用 emergency stop 强制退回 `PAPER + LIVE_DISABLED`。
- Paper/Live 执行入口显式拒绝 `TARGET_CONVERSION`，避免被错误当成 SELL；当前并未伪造 conversion 执行能力。
- 新增 migration `032_negative_risk_conversion.sql`；代码 Schema 升到 `2.27.0`，Signal 升到 `1.6.0`，Observe Signal 升到 `observe-v1.1.0`。旧 Campaign 时长不得进入新核心。

## Verification completed
- `pnpm typecheck` 通过。
- 全量：49 个测试文件、623 项全部通过。
- 聚焦回归：6 个测试文件、69 项通过；覆盖目标 scoped preflight、旧目标 proof 拒绝、目标 evidence binding、operator 参数传递和 Replay evidence。
- 真实数据库 immutable 只读复核：Schema `2.27.0`、Gate `PAPER + LIVE_DISABLED`、Live Gate transition 0、`PRAGMA integrity_check=ok`、`foreign_key_check` 0 行；新目标尚无 target/Campaign，旧目标最新 Campaign 仍为 `PAUSED`。
- 新增覆盖：真实多段内部转移的净额解析、stakeholder/唯一证明、金额/事件不一致拒绝、micros 零容差 Positions、稀疏 Activity、historical/mixed bucket、tracked blocker、Paper/Live 竞态注入闭锁、证据持久化、缺 provider 失败关闭、重启不重复 RPC、migration/append-only、public RPC 方法白名单、Campaign Gate/integrity blocker。
- 使用失败 Session 的原始 Activity、转换后 Positions capture 和 Polygon 真实回执只读复算成功：精确识别 1 个源资产、4 个目标资产、`1667621700` micros、事件 `fed-decision-in-july-181`，证据哈希 `dd93f80f43e05e8f6736e1e5f7f6cbf4acedb526f635014913a158957c83a771`。
- `git diff --check` 通过。
- Standards/Spec 两路独立审查的全部发现均已修复；最终复核均为 0 actionable findings。

## Current identity
- 代码 Schema `2.27.0`；Signal `1.6.0`；Strategy `2.2.0`；Risk `1.6.0`；Paper `1.6.0`；Live `1.6.0`；Validation `1.3.0`；Operational `1.3.0`；Ruleset `v1.5.0`；Config `v1.3.0`。
- Ruleset：`e8b3eede381b889562d51ed39d692d9f106a37b7d220ad28c412a72cdd8daa75`。
- Paper ruleset：`6c8547d4e526878a1d3d696ad60dd77dd7a32c08937013729018fad0cb9492b7`。
- Core compatibility：`b4239c719f028e59d6ab64b9c6c97ae20bba7412e32cf0eccf9df2fd770e8b92`。
- Validation policy：`d42e37a537f15f9ef4cece7f91cb3bcaffcfcc3b4b8898e2f5d5940ec9fbc9b7`。
- Verification suite：`7b26227cd99596eace91ad7076b0b194b3c05bf5346037705edaf3d20b6ee567`。
- Operator build：`33f3ed2abd5be301defaa3d05e45b0a39893d9b5d7c5cbc92e891e6b2b516878`。
- Artifact provenance：`10e91d2def41ba61aee0fa5b63026de66db968b9536bd60311ddb4169f4e5c80`。

## Runtime state before handoff
- 目标隔离修复已形成干净提交；新地址只读 preflight 为 `PASSED`，`campaignId=null`、`mismatchFrozen=false`、时钟校准通过。业务数据库文件 mtime 仍为 `2026-07-22T09:52:02+0800`，本轮未写库。
- 真实业务库已由既有 backup-first 入口从 `2.26.0` 迁移到 `2.27.0`；备份为 `data/operator/backups/phase0-before-2.27.0-2026-07-22T01-24-19-628Z.sqlite`，入口已完成备份/新库 integrity、foreign key、migration history、Schema contract 和安全 Gate 核验。
- Campaign `PC-0969675B1A77CA978A5B` 已 `BLOCKED`；失败 Session `PS-6FA97901118724B49713` 为 `FAILED/RUNTIME_CONSISTENCY_UNSAFE`、不计时，历史证据不得修改。
- 上一完成 Session `PS-D7B6D9BD9AA1C3EBA971` 和安全暂停 Session `PS-75B12304DFFD12CBE912` 均保留原计时证据，但因本轮核心变化不得计入 replacement Campaign。
- `PAPER + LIVE_DISABLED`，active Reservation 为 0；当前无 Paper、Observe 或 Campaign supervisor 进程。
- 旧目标的 `2.27.0` replacement Campaign `PC-C268FD8331F1F503DFF6` 为 `PAUSED`；最新 Session `PS-D50FE31F7FF33A1DCEA4` 已安全完成，最终对账 `SYNCED`，未取得 40 分钟资格。
- 新表 `negative_risk_conversion_evidence` 当前为 0 行；历史 Campaign/Session 终态未被迁移改变。

## Next steps
1. 用户随后双击“1_开始或继续Paper累计验证”；首次运行会重建新目标 Phase 0/Replay proof 并创建独立 Campaign。Codex 本轮不代用户启动。
2. 首次新目标 Paper 应先短时观察 MERGE/负风险活动是否触发持续 Position diff；若出现 `MINOR_DIFF/MAJOR_DESYNC`，立即安全暂停并把 ZIP 交给 Codex，不能把该时长当作 Live-ready 证明。
3. `MERGE/SPLIT` projection/copy 和 `TARGET_CONVERSION` 的真实 Paper/Live 执行仍未完成；小额 Live 前必须解决这些 blocker，并另行完成合规、隔离钱包、signer、安全 Gate 和用户再次明确授权。
