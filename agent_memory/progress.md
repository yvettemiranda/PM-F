# Progress

## Current task
- 第二次安全启动已在创建 Campaign 前被 Phase 0 proof 正确拦住：最新 Capture 的分页歧义已清零，但一笔历史 `MERGE` 因公开历史 offset 截断缺少旧 Yes 腿，被 Replay 误列为 unsupported；当前以 Replay `2.2.0` 的受限 historical-bucket reconciliation 修复，实时 Observe Gate 不放宽。
- 已按用户确认开始新一轮跟单优化：后续 BUY 改为按完整账户权益缩放、现金作支付上限；MEDIUM 兜底降为 `1 pUSD`；同资产退出/止损与新 BUY 串行协调；报告新增金额和成交覆盖率。
- 已完成用户要求的数据清理和防复发优化：`data/` 从约 `12 GB` 降到约 `21 MB`，系统盘可用空间从约 `298 GB` 增到约 `310 GB`。
- 当前主库为全新 Schema `2.29.0` 空白安全库；旧 Campaign 数据只保留在昨晚两份关键 ZIP 及精简后的报告/日志中。下一次测试会从新 Campaign、新 Paper 账户开始。
- Observe 保持 `1 s` Polygon 发现、`3 s` Data API、`15 s` Positions/pUSD；只把无变化 `ONLINE + SYNCED` 的重型不可变证据降为 `15 s` 采样。状态变化、新事件、新 Signal 和 gap 恢复立即落全量证据。
- 迁移备份默认只保留最新且已校验的 `1` 份；已修复原先按含 schema 版本文件名排序、可能留下错误旧副本的问题。

## Completed implementation
- Replay `2.2.0`：历史 Trades/Activity 明确截断、官方 CLOB 精确给出两个非空 token 且可见资产不冲突时，MERGE 可把证明上缺失的旧余额只补入 historical bucket 再投影；完整历史、官方集合不匹配、金额异常或 tracked leg 无价格仍 fail closed。
- Replay `2.1.0` 修复 Data API 相邻页多行重叠：以稳定 JSON 序列识别最长 suffix/prefix overlap，原始 Capture 不删除，只把精确边界重复作为 multiplicity evidence 抵消。
- Paper `1.12.0` / Risk `1.8.0`：HIGH BUY 在完整可退出估值时使用 `totalEquityMicros`，估值不完整才退回 available cash；新 `BUY_AMOUNT_POLICY_V2` 对最终金额应用可审计的 available-cash cap，不再整单因现金不足而拒绝。
- Ruleset `v1.8.0`：MEDIUM 资本置信度固定兜底从 `10 pUSD` 收紧为 `1 pUSD`。
- Paper cycle 先固化目标 Signal、再检查止损；同资产退出 pending 时后到 BUY 以 `SAME_ASSET_EXIT_PENDING` 等待，退出在 retry 顺序中完成后 BUY 自动继续。
- Paper Funnel 新增理论 BUY、申请 BUY、实际 BUY 支出、BUY request/fill coverage、SELL request/fill coverage，按同一 execution cohort 统计。
- Observe 成功轮询拆分为轻量每秒记录和有条件完整证据；仓位投影仍每轮更新，轮询/心跳/计数不丢失。
- 最终状态从 `MAJOR_DESYNC/MINOR_DIFF/GAP_RECOVERED` 恢复为正常时也立即保存完整 checkpoint；Final Validation 改为验证 checkpoint 所属成功 Poll，不再错误要求最后一个轻量 Poll 必须自带 checkpoint。
- Runtime migration backup 默认 retention 从 `3` 改为 `1`，新生成备份固定优先保留，其余按 mtime 排序。
- 新增只读 Polygon 适配器：`eth_blockNumber`、`eth_getBlockByNumber`、分别查询两个官方 Exchange 的 `eth_getLogs`，以及公开 CLOB `markets-by-token`；无 signer、无认证请求、无链上写入。
- 新增 `PolygonOrderFilledTradeFeed`：2 个确认区块、1 秒 poll、target-maker 精确过滤、block/log hash 校验、token/condition 官方绑定、价格按 Data API 10 位 round-half-up 归一、微单位 size 精确重建。
- Observe 同轮先消费 Polygon 事件并生成 Paper Signal，Data API 3 秒后只做同 identity 确认，不重复 Signal；Positions/pUSD 仍为 15 秒并在事件变化时提前刷新。
- Polygon 临时网络错误只记 degraded warning 并使用 Data API；确认区块重组、log/block 不一致、Polygon/Data API identity 不一致立即持久化 reconciliation issue、置 `MAJOR_DESYNC` 并失败停止。
- Signal 版本升至 `1.8.0`，Observe Signal 内部版本升至 `observe-v1.3.0`，运行文件和新测试纳入核心兼容性清单。
- Campaign runner 新增“stdout/stderr 完全 flush 后主动退出”机制，修复报告已写完但依赖 worker 仍让 supervisor 残留的问题。
- Paper cycle 改为先固化新 Signal、再统一重试 pending，保证已到达的目标退出先于旧 BUY 重试。
- `TARGET_SELL` 现在按 sell ratio 同时调整现有 Position 和 WAITING BUY：全退出取消 Reservation，部分退出同步缩减 Execution/Reservation/Cash/Audit 账本；若只抵消待买，记录 `TARGET_EXIT_APPLIED_TO_WAITING_BUY`，不伪造 SELL Order/Fill。
- Risk 在任何待买账本调整前完成完整 Signal/Context/Ruleset/Reconciliation 校验；Risk 拒绝时待买保持不变。部分缩减后的金额禁止被市场最低额 auto-lift 反向放大。Paper 版本升至 `1.9.0`。
- Paper `1.10.0` 新增有界 SELL 约束终止：小于市场最小量的 TARGET_SELL 未成交部分不放大、不超卖；部分成交后的精度尾差保留在 Position；止损路径仍 fail safe pending，并按 evidence hash 去重。
- Paper `1.11.0` / Risk `1.7.0` 新增 WAITING BUY 缩量 Risk 审计链：验证父决定 scope/ALLOW/amount，强制新金额严格小于父金额，Risk/Execution 当前金额精确一致，并在 Execution Audit 中同时保存父子 Risk Decision ID。

## Verification completed
- 真实失败 Capture 已定位到条件 `0x253a...735ba` 的 532.0828 份 MERGE：官方 CLOB 是精确 Yes/No 二元集合；Replay 可见 No 腿 1199.13 份、Yes 腿只有旧 SELL 而无可见 BUY，符合历史截断。新增回归先红后绿；完整历史缺腿和截断历史下官方 token mismatch 的失败关闭测试仍通过。干净提交后的同 Capture 确定性重放待执行。
- Replay `2.2.0` 修改后全量 `54/54` 文件、`708/708` 测试通过，`tsc --noEmit` 与 `git diff --check` 通过；本地 Standards/Spec 双轴复核未发现需要阻断提交的问题。
- 2026-07-23 首次启动的三份真实 Phase 0 Capture 稳定复现 2 个 ambiguous event；最小回归确认是相邻 Trades 页重复 2 行。修复后原 Capture 重放得到 `tradeBoundaryOverlapRows=2`、`reconciledPaginationOverlapRows=2`、`onChainProofs=2`、`ambiguousEvents=0`。
- 分页修复最终全量 `54/54` 文件、`707/707` 测试通过，`tsc --noEmit` 与 `git diff --check` 通过。
- 新优化先取得 4 条失败回归，再完成红绿：权益缩放、现金封顶、目标退出优先、同资产 BUY 延后恢复。最终全量 `54/54` 文件、`706/706` 测试通过，`tsc --noEmit` 与 `git diff --check` 通过。
- 清理后主库确认 Schema `2.29.0`、`integrity_check=ok`、外键失败 `0`、Gate `PAPER + LIVE_DISABLED`；Target/Campaign/Live Execution/Order/Fill 均为 `0`。
- 两份昨晚关键 ZIP 均通过 `unzip -t`；目标配置仍为 `0x1f9e15f39bbd5d163b0eacf0fbef647ced9e4f1a`。
- 新存储/备份/验证规则相关 `95/95` 测试通过。首次全量运行暴露 1 条过时 Final Validation checkpoint 假设，修复后最终全量 `54/54` 文件、`703/703` 测试通过，`tsc --noEmit` 与 `git diff --check` 通过。
- TDD 红绿覆盖：链上 BUY 早于 Data API 发布且后续不重复；确认区块重组 fail closed；跨源 identity 不一致 fail closed；1 秒 Campaign 参数；Data API 3 秒缓存；读接口白名单；supervisor 输出 flush 后在残留 handle 存在时仍按状态码退出。
- 真实只读短探针已通过：Polygon 状态从 `INITIALIZING` 转为连续 `AVAILABLE`，新区块 cursor 正常推进；Data API Trades/Activity、Positions 和 pUSD 公共读取成功，没有 signer/订单/链写入。
- Paper `1.11.0` 先取得失败回归，再验证部分缩量、完整取消和禁止非向下调整；最终全量 `54/54` 文件、`699/699` 测试通过，`tsc --noEmit` 与 `git diff --check` 通过。
- 真实数据库 Schema `2.29.0`、`integrity_check=ok`、外键失败 `0`，Gate 为 `PAPER + LIVE_DISABLED`，Live Execution/Order/Fill/Redeem/Settlement Ledger 均为 `0`；最终报告确认未加载 private key、无认证交易客户端、真实订单 `0`、链上写入 `0`。
- 首轮全量的 3 个失败均是旧测试仍期待 Data API 每循环请求；已改为显式推进 3 秒后断言，并由最终全量覆盖。

## Runtime state before final verification
- 无 Observe/Paper/Supervisor 子进程、无 Campaign；本次两轮启动都在创建 Campaign 前由 Phase 0/isolated proof 安全终止，失败 Capture/ZIP 已保留。
- 数据目录约 `21 MB`；当前空白业务库 Schema `2.29.0`、Gate 安全。旧 account/campaign pointer 与昨晚前无关日志已删除。
- 下次启动必须使用最终干净 commit，重新生成 Phase 0/Replay/core 绑定并创建新 Campaign，不得续算旧核心时长。

## Current identity
- Replay `2.2.0` / Paper `1.12.0` / Risk `1.8.0` / Operational `1.7.0` 已进入最终验证；精确 commit/core hash 以最终提交和下一次新 Campaign 的 Operator 输出为准。

## Next steps
1. 完成最终全量测试、双轴代码复核并提交，形成干净 HEAD。
2. 从空白安全库创建新 Campaign；先完成隔离验证、Phase 0/Replay，再持续运行到 2026-07-23 17:15，并每 30 分钟巡检。
3. 小额 Live 前继续处理 SPLIT/negative-risk conversion、结束时间缺失策略、Live 小额 SELL 约束终止、合规/geoblock、隔离钱包与 signer 授权；当前不得开启 Live。
