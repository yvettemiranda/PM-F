# ni-k Polymarket Copy Trading System

这是一个全新、独立的 Polymarket Copy Trading System。它不复用旧版 PolymarketBot 的代码、数据库、仓位模型、交易逻辑或页面。

当前只实现 Phase 0：

- Wallet Identity 验证
- 官方公开 API 数据契约采集
- 第一层领域模型和状态机
- SQLite 初始化
- Replay Engine
- 去重、仓位投影和崩溃恢复测试

`Paper Executor`、`Live Executor`、私钥接入、真实订单和链上写操作均不属于当前阶段。

## 本机验证

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm phase0:validate -- 0x目标地址
```

运行结果保存在本机 `data/phase0/`。服务端和页面后续仍只允许监听 `127.0.0.1`。
