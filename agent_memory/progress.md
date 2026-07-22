# Progress

## Current task
- 2026-07-22 已定位 Session `PS-6FA97901118724B49713` 的 `MAJOR_DESYNC`：目标钱包在负风险事件中发生 `CONVERSION`，旧 Observe 只记录 Activity、不变更 Position projection，导致源资产残留并缺少 4 个目标资产。
- 真实事件为 tx `0x31374b6803b62320cac0730a80292846a4e4e64e0aa5fb4a7e4b4eb0020217dd`，金额 `1667.6217`；源资产减少并净增加 4 个同事件目标资产。该事件只消耗 baseline historical bucket，未涉及本 Campaign 的 tracked 仓位。
- 用户要求按未来 Live 的安全标准全方位修复；本轮仍严格禁止 signer、认证 CLOB、真实订单、approve/redeem 和任何链上写入。

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
- 全量：49 个测试文件、622 项全部通过。
- 新增覆盖：真实多段内部转移的净额解析、stakeholder/唯一证明、金额/事件不一致拒绝、micros 零容差 Positions、稀疏 Activity、historical/mixed bucket、tracked blocker、Paper/Live 竞态注入闭锁、证据持久化、缺 provider 失败关闭、重启不重复 RPC、migration/append-only、public RPC 方法白名单、Campaign Gate/integrity blocker。
- 使用失败 Session 的原始 Activity、转换后 Positions capture 和 Polygon 真实回执只读复算成功：精确识别 1 个源资产、4 个目标资产、`1667621700` micros、事件 `fed-decision-in-july-181`，证据哈希 `dd93f80f43e05e8f6736e1e5f7f6cbf4acedb526f635014913a158957c83a771`。
- `git diff --check` 通过。
- Standards/Spec 两路独立审查的全部发现均已修复；最终复核均为 0 actionable findings。

## Current identity
- 代码 Schema `2.27.0`；Signal `1.6.0`；Strategy `2.2.0`；Risk `1.6.0`；Paper `1.6.0`；Live `1.6.0`；Validation `1.3.0`；Operational `1.3.0`；Ruleset `v1.5.0`；Config `v1.3.0`。
- Ruleset：`e8b3eede381b889562d51ed39d692d9f106a37b7d220ad28c412a72cdd8daa75`。
- Paper ruleset：`6c8547d4e526878a1d3d696ad60dd77dd7a32c08937013729018fad0cb9492b7`。
- Core compatibility：`3fcda9398e3e9967de441d75fa8bc55de865c7dfbc5d4817515c48086cf86a1d`。
- Validation policy：`9e959cfd98d56a7542317a7cb065ef244beaad0ca0914ae40422ca2f51224523`。
- Verification suite：`b979fefc84fef2a1c96d3cabfd875af49eda57db2d5a55f443b47833053c666c`。
- Operator build：`0ace5772d3c25fe0af39701121a2d16951b6e1af8ce25124b112ee78110f07a2`。
- Artifact provenance：`10e91d2def41ba61aee0fa5b63026de66db968b9536bd60311ddb4169f4e5c80`。

## Runtime state before handoff
- 真实业务库仍为 Schema `2.26.0`，尚未应用本轮 migration；必须在代码提交且无运行进程后使用既有 backup-first 入口迁移。
- Campaign `PC-0969675B1A77CA978A5B` 已 `BLOCKED`；失败 Session `PS-6FA97901118724B49713` 为 `FAILED/RUNTIME_CONSISTENCY_UNSAFE`、不计时，历史证据不得修改。
- 上一完成 Session `PS-D7B6D9BD9AA1C3EBA971` 和安全暂停 Session `PS-75B12304DFFD12CBE912` 均保留原计时证据，但因本轮核心变化不得计入 replacement Campaign。
- `PAPER + LIVE_DISABLED`，active Reservation 为 0；当前无 Paper、Observe 或 Campaign supervisor 进程。

## Next steps
1. 提交已通过双轴审查与全量验证的收口修复。
2. 确认无进程后通过既有 backup-first 入口把真实数据库从 `2.26.0` 升到 `2.27.0`，复核 backup、migration history、foreign key、Gate 和历史证据。
3. 用户下一次启动时创建新核心 replacement Campaign，从 0 进行压缩后的 40 分钟资格、连续 4 小时、累计 24 小时和最终 8 小时 Observe；旧核心运行时间不混算。
4. `TARGET_CONVERSION` 的真实 Paper/Live 执行仍未授权实现；若未来自然出现 tracked conversion，系统会立即闭锁。进入 Live 前必须另行完成受控 Paper/Fake 转换执行器、真实合规/钱包/signer 设计和再次明确授权。
