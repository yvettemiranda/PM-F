# ni-k Polymarket Copy Trading System

这是一个全新、独立的 Polymarket Copy Trading System。它不复用旧版 PolymarketBot 的代码、数据库、仓位模型、交易逻辑或页面。

当前实现到 Phase 5 架构与验收框架阶段：

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

`Live Executor` 已有完整架构和 fake/disabled adapter 测试路径，但默认不包含真实交易能力。私钥接入、真实订单、认证交易客户端、approve、真实 redeem 和链上写操作均不属于当前默认运行状态。Phase 4/5 只代表验证框架存在，不代表最终验证通过，也不代表 Live 可用。

## 本机验证

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm phase0:validate -- 0x目标地址
pnpm phase05:replay-capture -- capture_run_id
pnpm observe:run -- 0x目标地址 --duration-seconds=300 --poll-seconds=15
pnpm paper:run -- --duration-seconds=300 --interval-seconds=1
pnpm validate:final -- --type=all
pnpm operational:validate -- --mode=health_monitor --duration-seconds=0
```

运行结果保存在本机 `data/phase0/`。确定性 Replay 要求 capture 和当前工作树使用同一 Git commit，且两者都不是 dirty 状态。

`observe:run` 不加载私钥，也没有下单路径。省略 `--duration-seconds` 时持续运行，收到 `SIGINT`/`SIGTERM` 后安全停止；每次报告写入 `data/observe/`。Live Gate 前必须完成至少连续运行 24 小时、源码工作树干净、无未恢复连接 gap、无 checkpoint hash 不一致、未出现 `MAJOR_DESYNC` 且最终为 `SYNCED` 的验收。已恢复的 API 失败和短暂 `MINOR_DIFF` 会保留为 warning，系统不会自动升级运行模式。

用户已将 24 小时 Observe soak 延期到 Live Gate 前，因此短时 `SHORT_SOAK_PASSED` 允许开发 Phase 1A，但不允许据此进入 Live。`paper:run` 默认创建一个从启动时间开始消费新 Signal 的 1000 pUSD 模拟账户；传入 `--account-id=<id>` 可从已有 checkpoint 恢复。Paper 只读取 `PUBLISHED && executionEligible=true` 的 Signal 和不可变 execution context，只调用公开无认证的 CLOB 市场数据 GET 接口。

监控层 Signal 和执行层状态必须保持独立；`executionEligible=false` 的 Signal 不得被 Paper 或 Live 消费。Paper 和未来 Live 使用同一份 Signal + Execution Context 输入，必须先经过 Risk Manager，再进入 Executor Interface。每条 Paper Execution 必须引用 `risk_decision_id`；系统触发的止损和结算也记录系统级 Risk Decision。账户状态统一由 Portfolio Projection 从 ledger/position/PnL 计算，Report/UI 不应自行计算余额或权益。服务端和页面后续仍只允许监听 `127.0.0.1`。

`validate:final` 默认复制 `data/phase0/phase0.sqlite` 到 `data/validation/<session-id>/` 后运行，避免污染业务数据。可选 `--type=paper_consistency|live_gate|paper_replay|crash_recovery|reconciliation|observe_only|all`。报告输出为 JSON 和 Markdown，最终状态最多到 `VALIDATION_FRAMEWORK_READY`；即使所有 fake/snapshot 检查通过，`liveAllowed` 仍固定为 `false`。真实资金前仍必须实际执行长周期 Paper Validation、24 小时 Observe Only soak、Crash Recovery 长测、状态一致性验证、geoblock/compliance、小额实盘前检查，并由用户再次明确授权。

`operational:validate` 默认同样复制源 SQLite 到 `data/operational/<run-id>/` 后运行，避免污染业务库。可选 `--mode=health_monitor|consistency_monitor|observe_only|paper_validation|crash_recovery`。其中：

- `health_monitor` 只记录心跳、数据库健康和 checkpoint。
- `observe_only` 只记录 shadow risk observation，不写正式 `risk_decisions`，不进入 Paper/Live。
- `paper_validation` 使用 dedicated Paper validation account 和 fake market data，只验证执行框架，不连接真实盘口或真实交易。
- `crash_recovery` 只在 snapshot DB 中做事务回滚和恢复检查。

Operational Report 的最高默认状态是 `OPERATIONAL_FRAMEWORK_READY`，并固定 `liveAllowed=false`。它证明“长期运行验证框架已经具备”，不等于 24 小时/7 天 soak 已经完成，也不等于 Live Gate 通过。
