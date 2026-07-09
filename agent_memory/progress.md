# Progress

## Current task
- Phase 2 Live Gate Safety Layer 已完成实现和自动化验证；当前尚未进入 Phase 3，也未进入 Live Executor。Phase 1B 长期 Paper Validation、24 小时 Observe soak、Crash Recovery 长测、长期一致性和用户再次授权仍未执行。

## Completed
- 本地 Git 已初始化；Phase 0 基线 commit：`36ed3dc64e9cbe3657e7d6968b86f6fa51b1fd6a`。
- SQLite 已从 1.2 原地迁移至 1.3/1.4；新增 capture manifest、baseline、双桶 ledger、capital estimate、Golden、Replay job 与按 Replay 版本化事件分类。
- Capture Manifest 保存 wallet、接口/分页、时间范围、数量、payload SHA-256、规则版本、commit 与 dirty 状态；dirty capture 禁止确定性验收。
- Position Baseline 保存 condition/asset/slug/title/outcome/size/avgPrice/snapshot cutoff；真实目标当前 141 条 baseline。
- 资金模块读取官方 Polygon pUSD ERC-20 balance 和 Positions `currentValue`；当前快照为 `COMPLETE/HIGH`。历史 BUY 因快照超出 ±5 分钟保存为 `INCOMPLETE/MEDIUM`，ratio 为 null，fallback 为 10 pUSD。
- Replay 使用历史/跟踪双桶，tracked-first sell；断线 BUY 进入历史桶，断线 SELL 更新双桶，同时生成 `executionEligible=false/GAP_EVENT` 行为 Signal。
- 非 TRADE Activity 分类：SPLIT/MERGE/CONVERSION 为 `COMBO_ACTIVITY`，官方其他非交易活动为 `NON_TRADE_ACTIVITY`，未识别类型为 `UNRECOGNIZED`；均不生成跟单 Signal。
- 已从目标钱包真实数据自动筛出 5 类 Golden candidates：NORMAL_BUY、NORMAL_SELL、HISTORICAL_SELL、COMBO(MERGE)、UNRECOGNIZED(YIELD)。因此暂未使用第二公开钱包。
- Golden 1-5 已按用户明确指令从 `CANDIDATE` 更新为 `APPROVED`；五项自动比对均为 `MATCH`，`golden_evaluation_status=PASSED`，并保存 5 条审批状态迁移。
- 已实现 stale Replay Job → `INTERRUPTED` → 新 Job 重跑；关键事务失败完整回滚。
- 当前 TypeScript 类型检查通过，11 个测试文件共 37 项测试通过；覆盖 baseline、capital、manifest、Golden、断线、乱序、重复、幂等、事务回滚和 Crash Recovery。
- commit `376ba80fbfcfe4bceecdac6ddbfcb924a1ad5c2f` 的 clean capture `964354247f7403cfbdf5b7542a19f39b98d3c10652917a3e03bdb0225d8c2dc4` 已从 manifest 重放；stored/new Replay Hash 均为 `af6cdf9c7f81f6311113daf4ce36e3892bf40913f580716d79fbd6ec2e53dfe8`，`stable=true`。
- 已新增 Observe Only Runner、1.5.0 SQLite migration、checkpoint、position projection、capital snapshot 关联、reconciliation report、单实例和 stale-run 恢复。
- 已覆盖正常连续轮询、API 临时失败、断线 gap、重启 checkpoint、重复、3-1-2 乱序、REDEEM 投影、Activity/Trades 先后到达去重和恢复窗口截断保护；当前 12 个测试文件共 44 项测试通过。
- 真实地址短时运行发现并修正 Activity 比 Trades 更早可见的成交，以及 REDEEM 导致的仓位归零；修正后 25.467 秒运行 3 次成功轮询、0 次失败、3 个 gap 事件、3 个非执行 Signal、3 次对账，最终 `SYNCED` 且未发现漂移。
- Phase 1A 新增不可变 `signal_execution_context`，逐 BUY 保存时间一致的 capital decision、目标交易时间、市场结束时间和市场元数据；Paper 不读取 `raw_events`。
- Paper Executor 已实现 1000 pUSD 独立账户、signal cutoff、消费 checkpoint、三级资金决策、reservation、完整深度 VWAP、模拟 FAK、独立 Position/Execution、10% 普通卖出、15% 止损、止损优先、到期 settlement/redeem 和组合账本。
- 已接入公开无认证 `GET /book`、`GET /clob-markets/{condition}` 与 `GET /markets/{condition}`；真实采样确认订单簿、费率曲线和未结算状态可读，全程未调用认证/交易端点。
- Phase 1A 初版曾达到 13 个测试文件共 67 项测试通过；覆盖比例/兜底/拒绝资金、Gap、历史卖出、零成交重试、部分成交、价格范围、stale、超时释放、多仓位、两类 pending、止损优先、结算、非零费用、重复幂等、并发 reservation、Crash 回滚、restart、Paper runner checkpoint，以及 context 构建失败禁止发布可执行 Signal。
- Phase 1A 架构优化已新增 SQLite `2.1.0` 迁移、统一 `ExecutorInterface`、`LiveExecutorPlaceholder`、`RiskManager`、`SettlementService`、`PnL Model`、不可变 `audit_log`、`risk_decisions`、`paper_unrealized_pnl_snapshots` 和 Position `FROZEN` 状态。
- `signal_execution_context` 已扩展 `sourceCodeCommit/sourceCodeDirty/configVersion`；Paper Execution/Position/Settlement/PnL/State Transition 等核心对象保存 `ruleset_hash/source_code_commit/config_version`。
- Paper 当前通过 Risk Manager 决定 `ALLOW/REJECT`，拒绝原因写入 `riskRejectReason`；Live 占位只实现接口并固定拒绝交易逻辑。
- 本轮主体架构补齐已新增 SQLite `2.2.0` 迁移、`ruleset_registry`、`portfolio_projection_runs` 和 `PortfolioProjectionService`；账户状态统一从 ledger/position/PnL 投影生成。
- 每条新增 Paper Execution 均引用 `risk_decision_id`；止损和结算这类系统触发执行也写入系统级 Risk Decision；标准 `executeBuy/executeSell` 接口会校验并复用传入的已批准 Risk Decision。
- 当前验证结果：TypeScript 类型检查通过；13 个测试文件共 84 项测试通过；当前本地 `data/phase0/phase0.sqlite` 已迁移至 schema `2.2.0`，`PRAGMA integrity_check=ok`，`foreign_key_check=[]`。
- Phase 2 已新增 SQLite `2.3.0` 迁移、`LiveGateService`、`LiveGateStore`、`LiveGateReconciliation`、`BalanceProvider`、`MockBalanceProvider`、`PaperBalanceProvider` 和 Live Gate 类型定义；默认状态为 `PAPER + LIVE_DISABLED`。
- Live Gate 启动流程为：request live → preflight → `LIVE_ARMING` → 人工确认 → `LIVE_ACTIVE`；若重启时发现持久化 `LIVE_ACTIVE`，会自动降级为 `PAPER + LIVE_ARMING` 并要求重新检查和确认。
- Live Gate preflight 覆盖 mode、钱包元数据、仅 mock/paper balance provider、配置、风险参数、数据库完整性、reconciliation 和 Live 前置验收项；前置项默认 `PENDING`。
- `checkExecution()` 只读取 Signal、Execution Context 和既有 `risk_decision_id`，要求 Signal 已发布且可执行、Risk Decision 为 `ALLOW`、ruleset 已注册且匹配、市场未结束、无 FROZEN/MAJOR_DESYNC。
- 新增 `risk_snapshots` 与 `live_gate_runs` 审计链路；`live_wallets` 仅保存元数据，不包含私钥、seed、signer 或交易能力字段。
- 当前验证结果：TypeScript 类型检查通过；14 个测试文件共 96 项测试通过；当前本地 `data/phase0/phase0.sqlite` 已迁移至 schema `2.3.0`，`PRAGMA integrity_check=ok`，`foreign_key_check=[]`。

## Current gate
- Wallet Identity 已通过。
- 当前 baseline 和实时资金快照已建立。
- Golden 1-5 已通过。
- Data API 历史仍被 offset 3000 上限截断，历史 Replay 保持 `INCOMPLETE`。
- Observe 短时功能验收已通过；用户明确把 24 小时 soak 从 Paper Gate 移至 Live Gate 前，因此允许 Phase 1A 开发。
- 已进入 Paper 开发但未标记 Paper Passed；未进入 Live，未接入私钥，未创建真实订单，未执行真实交易或链上写入。
- Phase 1A 已完成实现、架构优化、主体架构补齐和自动化验证，尚未执行 Phase 1B 的持续 Paper 模拟验收；不得标记 Paper Passed。
- Live Gate Safety Layer 代码已通过自动化验证，但 Live Gate 明确未通过：Phase 1B Paper Validation、24 小时 Observe、Paper 稳定性、Crash Recovery 长测、长期一致性、geoblock/compliance 和用户再次授权均未完成。

## Next steps
- 下一步建议进入 Phase 1B：使用新产生且带 execution context 的实时 Signal 执行持续 Paper 模拟验收。
- Live Gate 前再统一执行 24 小时 Observe、Paper 稳定性、Crash Recovery、长时间一致性、geoblock/compliance 和用户再次授权。
