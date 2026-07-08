# ni-k Polymarket Copy Trading System

这是一个全新、独立的 Polymarket Copy Trading System。它不复用旧版 PolymarketBot 的代码、数据库、仓位模型、交易逻辑或页面。

当前实现到 Phase 0.5：

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

`Paper Executor`、`Live Executor`、私钥接入、真实订单和链上写操作均不属于当前阶段。

## 本机验证

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm phase0:validate -- 0x目标地址
pnpm phase05:replay-capture -- capture_run_id
pnpm observe:run -- 0x目标地址 --duration-seconds=300 --poll-seconds=15
```

运行结果保存在本机 `data/phase0/`。确定性 Replay 要求 capture 和当前工作树使用同一 Git commit，且两者都不是 dirty 状态。

`observe:run` 不加载私钥，也没有下单路径。省略 `--duration-seconds` 时持续运行，收到 `SIGINT`/`SIGTERM` 后安全停止；每次报告写入 `data/observe/`。Paper Gate 默认要求至少连续运行 24 小时、源码工作树干净、无未恢复连接 gap、无 checkpoint hash 不一致、未出现 `MAJOR_DESYNC` 且最终为 `SYNCED`。已恢复的 API 失败和短暂 `MINOR_DIFF` 会保留为 warning，系统不会自动升级运行模式。

Phase 0.5 只验证监控层输出，不包含任何 Paper/Live 执行器。监控层 Signal 和未来执行层状态必须保持独立；`executionEligible=false` 的 Signal 不得被 Paper 或 Live 消费。服务端和页面后续仍只允许监听 `127.0.0.1`。
