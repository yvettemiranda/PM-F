# Progress

## Current task
- 2026-07-22 用户要求保持后台测试、不漏跟单并持续检查到 2026-07-23 08:00；必须保持 `PAPER + LIVE_DISABLED`，发现问题可安全停止、修复、验证后自动重启。
- Campaign `PC-FDE74DCF0572D08802EE` 已安全暂停：4273 次成功轮询、0 失败、18 个事件、6 个 Signal、96 个 Paper Order、2 个 Fill、0 Active Reservation。
- 已取得首个自然 BUY→Paper Fill→目标 SELL→Paper Fill→PnL 完整证据；发现速度约 3 秒，Signal 到 Paper Fill 约 4–5 秒，已实现 PnL `-0.10 pUSD`。
- 同轮发现目标 MERGE 完整退出时，旧核心没有取消仍在等价外的 WAITING BUY，存在之后买入陈旧仓位的风险；已停止 Campaign、暂停 10 分钟自动巡检并进入 TDD 修复。

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

## Verification completed
- TDD 红绿覆盖：链上 BUY 早于 Data API 发布且后续不重复；确认区块重组 fail closed；跨源 identity 不一致 fail closed；1 秒 Campaign 参数；Data API 3 秒缓存；读接口白名单；supervisor 输出 flush 后在残留 handle 存在时仍按状态码退出。
- 真实只读短探针已通过：Polygon 状态从 `INITIALIZING` 转为连续 `AVAILABLE`，新区块 cursor 正常推进；Data API Trades/Activity、Positions 和 pUSD 公共读取成功，没有 signer/订单/链写入。
- 当前最终全量结果：`54/54` 个测试文件、`696/696` 项通过；新增回归覆盖全退出抢跑、部分退出缩量、Position+WAITING BUY 同时处理、Risk 拒绝不改账；`tsc --noEmit`、`git diff --check` 通过。
- 首轮全量的 3 个失败均是旧测试仍期待 Data API 每循环请求；已改为显式推进 3 秒后断言，并由最终全量覆盖。

## Runtime state before final verification
- Campaign `PC-FDE74DCF0572D08802EE` 已暂停，Session `PS-E4B568E00791EA9C2F83` 已完成；无 Observe/Paper/Supervisor 子进程，无 Active Reservation。
- 业务库仍为 Schema `2.29.0`，本批不需要新 migration；Live execution/order/fill 保持全为 `0`，未使用 signer、未创建真实订单、未链上写入。
- 下次启动必须使用本批最终干净 commit 重新生成 Phase 0/Replay/core 绑定并创建 replacement Campaign，不得续算旧核心时长。

## Current identity
- Paper `1.9.0` 修复已提交；启动只允许使用当前干净 Git HEAD，精确 commit/core hash 以 replacement Campaign 的 Operator 输出为准。

## Next steps
1. 核对数据库 `2.29.0` 与 Gate 后创建 replacement Campaign。
2. 恢复维护自动化并验证进程参数为 `--poll-seconds=1 --reconciliation-seconds=15`、Polygon feed `AVAILABLE`、Live 数据表保持 0。
3. 每 30 分钟核对漏斗、延迟、degraded/gap/desync、数据库增长和进程；必要时安全暂停修复，持续到 2026-07-23 08:00。
