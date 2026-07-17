# ni-k Polymarket Copy Trading System

这是一个全新、独立的 Polymarket Copy Trading System。它不复用旧版 PolymarketBot 的代码、数据库、仓位模型、交易逻辑或页面。

当前已完成 Phase 1A—5 的主体架构，并完成一轮 Production Readiness Hardening：

- Wallet Identity 验证
- 官方公开 API 数据契约采集
- 第一层领域模型和状态机
- SQLite 初始化
- Replay Engine
- 去重、仓位投影和崩溃恢复测试
- Capture Manifest 与源码版本绑定
- Position Baseline 与历史/跟踪仓位双桶账本
- 目标可见资金估算与 `HIGH / MEDIUM / LOW` 置信度
- Candidate Golden Cases（必须由用户确认后才能批准）
- Signal `executionEligible`；断线行为 Signal 永远禁止进入执行层
- Observe Only Runner：增量轮询、checkpoint 恢复、前向仓位投影和只报告不修正的 reconciliation
- 不可变 `signal_execution_context`：为 Paper 输出交易时间、市场结束时间、市场元数据和逐 BUY 资金决策
- Paper Executor：独立模拟账户、资金 reservation、完整深度 VWAP、模拟 FAK、独立 Position/Execution、止损、结算和审计账本
- Phase 1A 架构优化：统一 Executor Interface、Risk Manager、Risk Decision 全链路关联、Portfolio Projection Service、Ruleset Registry、Live 安全占位、Settlement Service、PnL Model、不可变 Audit Log、Position `FROZEN` 保护态和核心对象版本字段
- Phase 2/3：Live Gate Safety Layer、Live Executor 架构、Order/CLOB/Signer/Wallet/Redeem adapters、Live Order/Fill/Position/Ledger/Reconciliation/Crash Recovery/Emergency Stop。默认仍使用 disabled/fake adapter，不默认创建真实交易能力
- Phase 4：Final Validation Framework。统一验证入口会在 isolated snapshot database 上运行 Paper Replay、Consistency、Crash Recovery、Reconciliation、Live Gate fake path 和 Observe Only 检查，并生成可追溯 Validation Report
- Phase 5：Operational Validation Framework。新增 Operational Runner、单实例锁、心跳、健康快照、运行 checkpoint、shadow risk observation、一致性/崩溃恢复检查和 Operational Report，用于证明系统可以被长期验证，而不是打开真实交易
- Production hardening：公开 API 分页/运行时契约校验、Activity 时间游标增量采集、WAL-safe SQLite Online Backup、内容寻址压缩 capture、不可变证据表、历史 ruleset 执行、Live 信号序列游标与坏消息隔离、完整订单簿执行计划、真实/恢复共用 fill 校验、Live 账户资金口径绑定和外部现金/仓位对账
- Live 下单边界加固：不可变 Signal/Execution Context 逐字段校验、钱包与 authorized signer 绑定、signed order 的 maker/signer/数量/限价/fee 复核、完整 Order Intent 快照及恢复 hash、账户级串行化、取消 CAS、启动恢复门槛和紧急停止竞态保护

`Live Executor` 已有完整架构、官方 CLOB SDK adapter 和 fake/disabled 测试路径，但默认不会构造真实 signer，也没有用户可操作的 Live 启动入口。当前数据库状态固定为 `execution_mode=PAPER`、`live_gate_state=LIVE_DISABLED`。私钥接入、真实订单、approve、真实 redeem 和链上写操作均不属于当前默认运行状态。Phase 4/5 和自动化 hardening 只代表技术候选与验证框架可用，不代表最终验证通过，也不代表 Live 已获授权。

## 本机验证

不熟悉命令行时，只使用仓库里的 `操作入口/` 文件夹；旧的 `点这里运行/` 已移除，避免误点失效入口：

1. 双击 `1_开始或继续Paper累计验证.command`。第一次默认最多连续运行 12 小时；满 2 小时记录资格里程碑但不强制重启，继续到 12 小时可同时满足连续门槛。后续继续使用同一个 Campaign 和 1000 pUSD 模拟账户累计验证时间。
2. 想暂停或关机时，双击 `2_安全暂停并生成报告.command`。它会停止 Observe、让 Paper 安全收尾，并自动生成报告和诊断 ZIP。
3. 双击 `3_查看进度和打开最新结果.command`。Finder 会选中应发给 Codex 的最新 ZIP，无需手工寻找数据库或日志。

长期入口会使用 macOS `caffeinate` 防止系统睡眠（屏幕仍可关闭），并在 `data/operator/run/` 保存本次入口的精确进程记录。安全暂停只向这些已登记的本项目任务发送停止信号，不按进程名称扫描其他项目。每次启动都会通过 frozen lockfile 校验依赖；同一时间只允许一个长期入口运行。Observe/Paper 启动前还会检查数据库是否固定为 `PAPER + LIVE_DISABLED`；如需迁移，会先用 SQLite Online Backup 保存最多 3 个迁移前备份，再执行 migration、`integrity_check` 和 `foreign_key_check`。

`操作入口/` 中没有 Live 入口，不会读取私钥，不会创建真实订单。

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm phase0:validate -- 0x目标地址
pnpm phase05:replay-capture -- capture_run_id
pnpm observe:run -- 0x目标地址 --duration-seconds=300 --poll-seconds=15
pnpm paper:run -- --duration-seconds=300 --interval-seconds=1
pnpm validate:final -- --type=all --campaign-id=PC-... --session-id=PS-...
pnpm operational:validate -- --mode=health_monitor --duration-seconds=0
```

运行结果保存在本机 `data/phase0/`。确定性 Replay 要求 capture 和当前工作树使用同一 Git commit，且两者都不是 dirty 状态。

`observe:run` 不加载私钥，也没有下单路径。省略 `--duration-seconds` 时持续运行，收到 `SIGINT`/`SIGTERM` 后安全停止；每次报告写入 `data/observe/`。Activity 使用官方 `start` 时间游标分页，Trades 的满页结果必须覆盖上次已提交 cursor（且跨过同秒边界），否则 fail closed 并进入 gap recovery。Live Gate 前必须完成至少连续运行 24 小时、源码工作树干净、无未恢复连接 gap、无 checkpoint hash 不一致、未出现 `MAJOR_DESYNC` 且最终为 `SYNCED` 的验收。已恢复的 API 失败和短暂 `MINOR_DIFF` 会保留为 warning，系统不会自动升级运行模式。

用户已将 24 小时 Observe soak 延期到 Live Gate 前，因此短时 `SHORT_SOAK_PASSED` 允许开发 Phase 1A，但不允许据此进入 Live。`paper:run` 默认在主数据库使用 `data/operator/paper-account-id.txt` 持久化 1000 pUSD 模拟账户 ID，重启时恢复账户、待处理 execution 和 consumer checkpoint；每次 session 还会在 Observe 启动前事务化前移消费 cutoff，因此不会补停机期间的历史 Signal。自定义数据库使用数据库旁的独立 account-id 文件。传入 `--account-id=<id>` 可明确选择现有账户，只有显式传入 `--new-account` 才会新建并替换持久账户。Paper 只读取 `PUBLISHED && executionEligible=true` 的 Signal 和不可变 execution context，只调用公开无认证的 CLOB 市场数据 GET 接口。

监控层 Signal 和执行层状态必须保持独立；`executionEligible=false` 的 Signal 不得被 Paper 或 Live 消费。Paper 和未来 Live 使用同一份 Signal + Execution Context 输入，必须先经过 Risk Manager，再进入 Executor Interface。每条 Paper Execution 必须引用 `risk_decision_id`；系统触发的止损和结算也记录系统级 Risk Decision。账户状态统一由 Portfolio Projection 从 ledger/position/PnL 计算，Report/UI 不应自行计算余额或权益。服务端和页面后续仍只允许监听 `127.0.0.1`。

`validate:final` 必须显式指定同一个 `campaign-id` 和 `session-id`，并通过 SQLite Online Backup 把 `data/phase0/phase0.sqlite` 的一致性快照写入 `data/validation/<validation-session-id>/` 后运行；它不会把旧 Campaign、其他账户或其他目标钱包的数据混进本次结论。源库即使处于 WAL 模式也不会漏掉已提交数据，验证过程不会污染业务库。可选 `--type=paper_consistency|live_gate|paper_replay|crash_recovery|reconciliation|observe_only|all`。报告输出为 JSON 和 Markdown，最终状态最多到 `VALIDATION_FRAMEWORK_READY`；存在未运行项、警告或历史数据不足时，顶层结果明确为 `INCOMPLETE`，不会用 framework session 的 `PASSED` 冒充最终验收通过。无论结果如何，`liveAllowed` 均固定为 `false`。真实资金前仍必须实际执行长周期 Paper Validation、24 小时 Observe Only soak、Crash Recovery 长测、状态一致性验证、geoblock/compliance、小额实盘前检查，并由用户再次明确授权。

`operational:validate` 默认同样使用 SQLite Online Backup 在 `data/operational/<run-id>/` 建立一致性快照，避免污染业务库。可选 `--mode=health_monitor|consistency_monitor|observe_only|paper_validation|crash_recovery`。`consistency_monitor` 和 `crash_recovery` 只有在同时提供 `--campaign-id=PC-... --session-id=PS-...` 时才会运行账户、账本和恢复检查；缺少明确作用域时只记录 `EXPLICIT_CAMPAIGN_SCOPE_REQUIRED`，不会拿全库旧数据冒充本次结论。其中：

- `health_monitor` 只记录心跳、数据库健康和 checkpoint。
- `observe_only` 只记录 shadow risk observation，不写正式 `risk_decisions`，不进入 Paper/Live。
- `paper_validation` 使用 dedicated Paper validation account 和 fake market data，只验证执行框架，不连接真实盘口或真实交易。
- `crash_recovery` 只在 snapshot DB 中做事务回滚和恢复检查。

Operational Report 的最高默认状态是 `OPERATIONAL_FRAMEWORK_READY`，并固定 `liveAllowed=false`。它证明“长期运行验证框架已经具备”，不等于 24 小时/7 天 soak 已经完成，也不等于 Live Gate 通过。

## Live 前不可跳过的人工门禁

- 使用干净、已记录 commit 的构建，并在隔离环境重新执行全量测试和迁移演练。
- 完成 24 小时 Observe、长周期 Paper、Crash Recovery 长测与长期账本/仓位一致性验证。
- 配置专用隔离钱包和系统安全存储中的 signer/凭据；不得把私钥或 seed 写入仓库、环境示例或日志。
- 使用官方只读 geoblock、时钟、余额、订单、成交、仓位证据；Live 账户本金必须与 Gate 配置一致，风险预算不得超过配置敞口，外部现金必须与 Live ledger 在容差内一致。
- 由用户再次明确授权，再完成 `LIVE_ARMING` 和精确确认短语；程序不会自动从 Paper 升级到 Live，重启后也不会自动恢复 `LIVE_ACTIVE`。
