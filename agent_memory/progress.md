# Progress

## Current task
- Phase 0.5 Observe Only Runner 已实现并完成短时真实地址验证；24 小时连续运行门禁尚未满足，因此仍禁止进入 Paper。

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

## Current gate
- Wallet Identity 已通过。
- 当前 baseline 和实时资金快照已建立。
- Golden 1-5 已通过。
- Data API 历史仍被 offset 3000 上限截断，历史 Replay 保持 `INCOMPLETE`。
- Observe 短时功能验收已通过，但默认 24 小时 soak 尚未完成；Paper Gate 保持关闭。
- 未进入 Paper/Live，未接入私钥，未创建订单，未执行交易。

## Next steps
- 以 clean commit 启动至少 24 小时 Observe Only soak；要求无失败轮询、无状态漂移、最终 `SYNCED`。
- 24 小时报告通过后再重新判定 Paper Gate；系统不得自动升级模式。
