# Progress

## Current task
- 准备 Phase 0.5：完善 capture manifest、Golden Expectations、Position Baseline、资金估算及异常恢复验证；当前等待关键口径确认，尚未修改 Phase 0.5 代码。

## Completed
- 独立初始化 TypeScript/Node.js 项目；未读取、迁移或复用旧版 PolymarketBot 代码、数据库、模型、交易逻辑或页面。
- 实现公开 Profile、Trades、Activity、Positions、Polygon bytecode、Relayer deployed 与 CLOB server time 采集；请求具备 timeout、有限 retry、backoff 和 jitter。
- Wallet Identity 证据链确认目标为 `IDENTITY_CONFIRMED / PROXY_WALLET / HIGH`：Profile 地址匹配、45-byte EIP-1167 bytecode、实现地址 `0x44e999d5c2f66ef0861317f9a4805ac2e90aeb4f`。
- 修正 Relayer `/deployed` 语义：结果只作为部署证据，不单独用于 SAFE/Deposit Wallet 类型判断。
- 实现版本化 ruleset、三级幂等键、Signal/Replay/Monitor 状态机、18 位价格与 6 位份额定点数、API 契约报告、Replay Engine、SQLite WAL 初始化和关键路径同步事务。
- Signal 与 Replay 状态迁移已写入审计表；API 延迟与 CLOB clock offset 已写入 `latency_metrics`。
- 当前真实样本：4000 Trades、3500 Activity、141 Positions；44 assets、42 conditions；数据窗口约为 2026-06-30 至 2026-07-07。
- 当前回放：4000 unique events、562 buy signals、50 sell signals、3388 historical sells；612 Signals；Replay Hash `0b4a1d9203a446176f76e66f18f08a4e4c62d26c196181e3820ab1edc88dcf15`。
- 同一输入连续 3 次 Replay Hash 一致；SQLite 原始事件和 Signal 未重复增长。
- 已通过 TypeScript 类型检查、7 个测试文件共 24 项测试、SQLite `integrity_check` 和 `foreign_key_check`。

## Current gate
- Wallet Identity 已通过。
- API schema 无字段错误，但历史分页被生产 API 的 3000 offset 上限截断，因此 API Contract 为 `INCOMPLETE`。
- Replay 为 `INCOMPLETE`，尚未达到 Phase 0 `PASSED`；禁止进入 Paper Executor。
- 未接入私钥，未创建订单，未执行链上写操作。

## Next steps
- 先确认卖出归属、断线 Signal、资本置信度、Golden 审批、Crash Recovery 语义和 Git commit 处理方式。
- 确认后固化不可变 capture manifest 和 Golden Expectations，完成 baseline/capital/recovery 实现与验证。
- 全部 Phase 0.5 门禁通过后才评估是否具备进入 Paper 的条件；本阶段不开发 Paper。
