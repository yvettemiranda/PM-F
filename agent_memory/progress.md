# Progress

## Current task
- 截止 2026-07-23 08:00 的夜间 Paper 监测已结束，30 分钟维护自动化已删除；系统不再自动重启。
- Paper `1.10.0` Campaign `PC-0F5C35EEA77131BFFD70` 完整跑满 `4 h`，Observe `11675/4`、36 个事件、21 个 Signal（18 BUY/3 SELL）、20 个可执行 Signal 全部消费，5 次 Paper Fill（4 full/1 partial），最终 `SYNCED`，无运行错误、无 Major Desync。
- 最终 scoped integrity 发现 2 个 `RISK_REQUESTED_AMOUNT_MISMATCH`：WAITING BUY 被目标退出安全缩量后，Execution 当前金额与原 Risk Decision 金额不再相等。因此 Session 被正确标记 `FAILED`、不计入 Campaign 时长，原报告与数据库未改写。
- 已按 TDD 完成 Paper `1.11.0` / Risk `1.7.0` 修复：每次目标退出缩减待买都生成并绑定新的严格向下 Risk Decision，完整取消绑定金额 `0`，非向下调整拒绝。

## Completed implementation
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
- TDD 红绿覆盖：链上 BUY 早于 Data API 发布且后续不重复；确认区块重组 fail closed；跨源 identity 不一致 fail closed；1 秒 Campaign 参数；Data API 3 秒缓存；读接口白名单；supervisor 输出 flush 后在残留 handle 存在时仍按状态码退出。
- 真实只读短探针已通过：Polygon 状态从 `INITIALIZING` 转为连续 `AVAILABLE`，新区块 cursor 正常推进；Data API Trades/Activity、Positions 和 pUSD 公共读取成功，没有 signer/订单/链写入。
- Paper `1.11.0` 先取得失败回归，再验证部分缩量、完整取消和禁止非向下调整；最终全量 `54/54` 文件、`699/699` 测试通过，`tsc --noEmit` 与 `git diff --check` 通过。
- 真实数据库 Schema `2.29.0`、`integrity_check=ok`、外键失败 `0`，Gate 为 `PAPER + LIVE_DISABLED`，Live Execution/Order/Fill/Redeem/Settlement Ledger 均为 `0`；最终报告确认未加载 private key、无认证交易客户端、真实订单 `0`、链上写入 `0`。
- 首轮全量的 3 个失败均是旧测试仍期待 Data API 每循环请求；已改为显式推进 3 秒后断言，并由最终全量覆盖。

## Runtime state before final verification
- Campaign `PC-0F5C35EEA77131BFFD70` 已结束且最终阻断；无 Observe/Paper/Supervisor 子进程、无 Active Reservation。两个旧 launcher zsh 只停留在终端确认提示且无子进程。
- 业务库仍为 Schema `2.29.0`，本批不需要 migration；数据目录约 `12 GB`，其中迁移备份约 `7.2 GB`，暂不删除审计证据。
- 下次启动必须使用包含 Paper `1.11.0` / Risk `1.7.0` 的最终干净 commit，重新生成 Phase 0/Replay/core 绑定并创建 replacement Campaign，不得续算旧核心时长。

## Current identity
- Paper `1.11.0` / Risk `1.7.0` 修复已完成隔离验证；精确 commit/core hash 以最终提交和下一次 replacement Campaign 的 Operator 输出为准。

## Next steps
1. 形成 Paper `1.11.0` / Risk `1.7.0` 干净 HEAD。
2. 用户确认下一轮测试窗口后，从新核心创建 replacement Campaign；先完成隔离验证、Phase 0/Replay，再重新累计资格和 4 小时自然验证。
3. 小额 Live 前继续处理 SPLIT/negative-risk conversion、结束时间缺失策略、Live 小额 SELL 约束终止、合规/geoblock、隔离钱包与 signer 授权；当前不得开启 Live。
