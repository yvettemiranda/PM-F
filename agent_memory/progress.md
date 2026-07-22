# Progress

## Current task
- 2026-07-22 修复新目标 Phase 0 被两组完全相同 Trades 阻断：新增官方 Polygon V2 Exchange `OrderFilled` multiplicity proof，只在全部 Trades/Activity 行属于当前目标钱包，且目标 maker、side、token、精确抵押金额、次数与不同 `orderHash` 全部一致时确认；任意错钱包行、未知合约、回执缺失/冲突、金额不符或重复 order hash 均继续 fail closed。
- Phase 0 只为 ambiguous 交易读取 `eth_getTransactionReceipt`；原始回执和派生 proof 进入同一不可变 Capture Manifest，`replay-capture` 从压缩 payload 重新解码并严格比对 proof。默认 Polygon RPC 更新为 Polygon 官方文档列出的 `https://polygon.drpc.org`，仍只允许 HTTPS 和只读回执方法。
- 使用失败 Capture `ee7228a4...` 只读复算：2 份回执生成 2 份 proof，confirmed duplicate 2、ambiguous 0，Replay unique events `11000`、BUY signals `5691`；只剩隔离 proof 明确允许的历史 offset/资本/Golden/baseline 限制。
- 2026-07-22 完成第一轮全仓控制面/跟单能力审计：目标地址从源码常量改为原子运行时选择，新增面向未来 localhost UI 的只读 `operator-control` 状态投影；运行锁存在时禁止切换，历史 Campaign/证据不改绑。
- 修正 Live Gate `OBSERVE_ONLY_24H_SOAK` 与既定“Paper 24 小时 + Observe 8 小时”口径冲突；migration `033` 保留原状态/evidence 地迁移为 `OBSERVE_ONLY_8H_SOAK`，代码 Schema 升至 `2.28.0`。
- `MERGE/SPLIT` 仍无安全复制语义，但从“记录后等待普通差异升级”改为当次 reconciliation 明确 `UNSUPPORTED_TARGET_ACTIVITY + MAJOR_DESYNC`，Paper/未来 Live 立即 fail closed；combo TRADE 不受误伤。
- 完成 runtime ruleset profile：复用现有 `RULESET` 深接口，让 Observe/Risk/Paper 及隔离 Live fake 路径在进程启动时读取同一份严格校验配置；profile hash 同时进入 ruleset registry 和 Paper core identity，参数变化强制新 Campaign，不能只改界面值或混算旧时长。
- 2026-07-22 已把后续测试目标切换为 `0x1f9e15f39bbd5d163b0eacf0fbef647ced9e4f1a`；用户将自行启动，Codex 本轮未创建新目标、未启动 Campaign、未写业务库。
- 修复目标切换时可能误续跑“全库最新 Campaign”的缺陷：预检、freeze、runner 和状态均按 wallet/target 筛选；不同目标可以保留各自 Campaign，旧目标不会被新目标的核心变化冻结或续跑。
- 隔离 Phase 0/Replay proof 现在显式绑定目标钱包；旧地址 proof 对新地址验证失败。全局 supplemental Replay evidence 也按目标 signal binding 过滤，不能跨钱包补足覆盖率。
- 新地址只读尽调：身份 `IDENTITY_CONFIRMED/HIGH`、类型 `PROXY_WALLET`、当前活跃；Trades/Activity 因上游 offset 限制均不完整，Positions 完整。最近 500 条 Activity 有 10 次 MERGE，且 0 次在最近 1000 条 Trades 中发现同交易哈希，现有系统不会复制 MERGE。
- 已为旧目标安全启动 `2.27.0` replacement Campaign `PC-C268FD8331F1F503DFF6`，随后按用户新指示通过安全暂停入口收尾。Session `PS-D50FE31F7FF33A1DCEA4` 最终 `SYNCED`，累计 `26061 ms`，0 Signal、0 Order、0 Fill、0 Position、0 active Reservation，Campaign 状态 `PAUSED`、可继续但仍绑定旧目标。
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
- 本轮 multiplicity 修复通过 `pnpm typecheck`，且 52 个测试文件、652 项全部通过；覆盖真实双 BUY、SELL 精确 taker 抵押金额、V2 normalized size、错目标 Trades/Activity、伪造合约、重复 order hash、金额/maker/side 不符、proof 重放不一致、API warning、Replay 与数据库多 occurrence 持久化。
- 自定义 profile 验证中，不导出 profile 环境时隔离证明按预期拒绝默认/自定义 core 混用；修正验证命令后全量通过。新增回归测试也已改为在独立无 profile 子进程计算真正默认 core，保证测试本身可在两种 profile 下运行。
- 新增覆盖原子地址选择/损坏配置/运行锁/桌面 shell、UI capabilities、profile 完整持久化/非法或 Live-only 参数拒绝/环境路径约束/运行锁/重置、参数变化必然改变 Paper ruleset 与 Campaign core、8 小时 prerequisite 保证 evidence 的迁移、MERGE/SPLIT 当次 fail-closed。
- 最终控制面/Observe/迁移聚焦回归：5 个测试文件、119 项通过。
- 真实数据库 backup-first 迁移及只读复核：Schema `2.28.0`、Gate `PAPER + LIVE_DISABLED`、Live Gate transition 0、`PRAGMA integrity_check=ok`、`foreign_key_check` 0 行；`OBSERVE_ONLY_8H_SOAK=PENDING`，新目标尚无 target/Campaign。迁移前 `2.27.0` backup 同样完整且安全。
- 新增覆盖：真实多段内部转移的净额解析、stakeholder/唯一证明、金额/事件不一致拒绝、micros 零容差 Positions、稀疏 Activity、historical/mixed bucket、tracked blocker、Paper/Live 竞态注入闭锁、证据持久化、缺 provider 失败关闭、重启不重复 RPC、migration/append-only、public RPC 方法白名单、Campaign Gate/integrity blocker。
- 使用失败 Session 的原始 Activity、转换后 Positions capture 和 Polygon 真实回执只读复算成功：精确识别 1 个源资产、4 个目标资产、`1667621700` micros、事件 `fed-decision-in-july-181`，证据哈希 `dd93f80f43e05e8f6736e1e5f7f6cbf4acedb526f635014913a158957c83a771`。
- `git diff --check` 通过。
- Standards/Spec 两路独立审查的全部发现均已修复；最终复核均为 0 actionable findings。

## Current identity
- 代码 Schema `2.28.0`；Signal `1.6.0`；Strategy `2.2.0`；Risk `1.6.0`；Replay `1.9.0`；Paper `1.6.0`；Live `1.6.0`；Validation `1.4.0`；Operational `1.3.0`；Ruleset `v1.5.0`；Config `v1.3.0`（本修复不改变策略配置身份）。
- Ruleset：`e8b3eede381b889562d51ed39d692d9f106a37b7d220ad28c412a72cdd8daa75`。
- Paper ruleset：`6c8547d4e526878a1d3d696ad60dd77dd7a32c08937013729018fad0cb9492b7`。
- Core compatibility：`961e92694cff204c05bd743e477a61d503ce28d6727bb43f53b48728b55e5ba8`。
- Validation policy：`cede0f6a6717f32b0d71c7b313b36659fd1e6fbf6c9e0a0dc1f094bb4483d21f`。
- Verification suite：`3fce09b0c99c4c55c96830e5c1e4c350b49ab3040f500ce9f74896543ca1a970`。
- Operator build：`0cf3976bf7a9040f3e215d005ca1622fa9d52bdd13a38c7d5635168bb15e5389`。
- Artifact provenance：`431378868dc418f575b4649ed2b3b54c6ab287a525edbba7b8b93e0e68109e47`。

## Runtime state before handoff
- 新地址选择来源为 `data/operator/target-wallet.txt`，当前 `campaignId=null`、无 operator lock；失败启动只完成 Phase 0 Capture/baseline/replay，没有创建 Campaign、Paper account 或运行时订单。ruleset 为 `PROJECT_DEFAULT`。
- 真实业务库已由 backup-first 入口迁移到 `2.28.0`；本轮备份为 `data/operator/backups/phase0-before-2.28.0-2026-07-22T02-38-41-085Z.sqlite`，备份/新库均完成 integrity、foreign key、migration history、Schema contract 和安全 Gate 核验。
- Campaign `PC-0969675B1A77CA978A5B` 已 `BLOCKED`；失败 Session `PS-6FA97901118724B49713` 为 `FAILED/RUNTIME_CONSISTENCY_UNSAFE`、不计时，历史证据不得修改。
- 上一完成 Session `PS-D7B6D9BD9AA1C3EBA971` 和安全暂停 Session `PS-75B12304DFFD12CBE912` 均保留原计时证据，但因本轮核心变化不得计入 replacement Campaign。
- `PAPER + LIVE_DISABLED`，active Reservation 为 0；当前无 Paper、Observe 或 Campaign supervisor 进程。
- 旧目标的 `2.27.0` replacement Campaign `PC-C268FD8331F1F503DFF6` 为 `PAUSED`；最新 Session `PS-D50FE31F7FF33A1DCEA4` 已安全完成，最终对账 `SYNCED`，未取得 40 分钟资格。
- `OBSERVE_ONLY_24H_SOAK=PENDING` 已原状态迁移为 `OBSERVE_ONLY_8H_SOAK=PENDING`；新表 `negative_risk_conversion_evidence` 当前为 0 行，历史 Campaign/Session 终态未被迁移改变。

## Next steps
1. multiplicity 修复形成干净提交后，用户可重新启动新目标短测；入口会刷新绑定新 commit 的 Phase 0/Replay proof，并在 proof 通过后创建独立 account/Campaign。
2. 新目标出现 MERGE/SPLIT 时将立即 `MAJOR_DESYNC`；用户应安全暂停并交回 ZIP。该结果证明“钱包包含当前不可跟操作”，不是程序误漏单。
3. UI 可在 Paper 长测并行开发，直接调用 `operator-control` 的 target/status/ruleset 接口；执行模式不得做成普通配置，Live 按钮保持不可用。
4. `MERGE/SPLIT` projection/copy 和 `TARGET_CONVERSION` 的真实执行仍未完成；小额 Live 前还必须完成自然 BUY/SELL/订单/成交/PnL 覆盖、合规、隔离钱包、signer、安全 Gate 和用户再次明确授权。
