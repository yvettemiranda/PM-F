# Progress

## Current task
- 2026-07-22 用户要求保持后台测试、不漏跟单并持续检查到 2026-07-23 08:00；必须保持 `PAPER + LIVE_DISABLED`，发现问题可安全停止、修复、验证后自动重启。
- 最近 Campaign `PC-80F7ECAFC26347B92117` 已安全停止并完成证据：626 次成功轮询、0 失败、3 个 SELL 事件、0 Signal/Order/Fill、0 Reservation。3 个 SELL 都来自 Paper baseline 未持有的启动前历史仓位，不是未跟上的目标开仓。
- 已确认实际延迟问题：第三个 SELL 的 Positions 先变化，约 30 秒后 Data API Trades/Activity 才发布；原 3 秒轮询无法消除上游发布延迟。
- 当前正在完成 Polygon 官方 `OrderFilled` 快速源、跨源一致性熔断和 Campaign 最终退出的全量验证；维护自动化已临时暂停，尚未启动新核心。

## Completed implementation
- 新增只读 Polygon 适配器：`eth_blockNumber`、`eth_getBlockByNumber`、分别查询两个官方 Exchange 的 `eth_getLogs`，以及公开 CLOB `markets-by-token`；无 signer、无认证请求、无链上写入。
- 新增 `PolygonOrderFilledTradeFeed`：2 个确认区块、1 秒 poll、target-maker 精确过滤、block/log hash 校验、token/condition 官方绑定、价格按 Data API 10 位 round-half-up 归一、微单位 size 精确重建。
- Observe 同轮先消费 Polygon 事件并生成 Paper Signal，Data API 3 秒后只做同 identity 确认，不重复 Signal；Positions/pUSD 仍为 15 秒并在事件变化时提前刷新。
- Polygon 临时网络错误只记 degraded warning 并使用 Data API；确认区块重组、log/block 不一致、Polygon/Data API identity 不一致立即持久化 reconciliation issue、置 `MAJOR_DESYNC` 并失败停止。
- Signal 版本升至 `1.8.0`，Observe Signal 内部版本升至 `observe-v1.3.0`，运行文件和新测试纳入核心兼容性清单。
- Campaign runner 新增“stdout/stderr 完全 flush 后主动退出”机制，修复报告已写完但依赖 worker 仍让 supervisor 残留的问题。

## Verification completed
- TDD 红绿覆盖：链上 BUY 早于 Data API 发布且后续不重复；确认区块重组 fail closed；跨源 identity 不一致 fail closed；1 秒 Campaign 参数；Data API 3 秒缓存；读接口白名单；supervisor 输出 flush 后在残留 handle 存在时仍按状态码退出。
- 真实只读短探针已通过：Polygon 状态从 `INITIALIZING` 转为连续 `AVAILABLE`，新区块 cursor 正常推进；Data API Trades/Activity、Positions 和 pUSD 公共读取成功，没有 signer/订单/链写入。
- 最终全量结果：`54/54` 个测试文件、`692/692` 项通过；`tsc --noEmit`、`git diff --check` 通过。
- 首轮全量的 3 个失败均是旧测试仍期待 Data API 每循环请求；已改为显式推进 3 秒后断言，并由最终全量覆盖。

## Runtime state before final verification
- Campaign `PC-80F7ECAFC26347B92117` 已停止，Session `PS-94D8F66D8CC9042A3B44` 已完成；无 Observe/Paper/Supervisor 子进程，无 Active Reservation。
- 业务库仍为 Schema `2.29.0`，本批不需要新 migration；Live execution/order/fill 保持全为 `0`，未使用 signer、未创建真实订单、未链上写入。
- 下次启动必须使用本批最终干净 commit 重新生成 Phase 0/Replay/core 绑定并创建 replacement Campaign，不得续算旧核心时长。

## Current identity
- 当前工作树尚未提交，旧 hash 不得继续作为新核心身份；提交并迁移后从 Operator 输出重新记录。

## Next steps
1. 提交最终干净核心，以该 commit 生成隔离 Phase 0/Replay/core 证据。
2. 核对数据库 `2.29.0` 与 Gate 后创建 replacement Campaign。
3. 恢复维护自动化并验证进程参数为 `--poll-seconds=1 --reconciliation-seconds=15`、Polygon feed `AVAILABLE`、Live 数据表保持 0。
4. 每 30 分钟核对漏斗、延迟、degraded/gap/desync、数据库增长和进程；必要时安全暂停修复，持续到 2026-07-23 08:00。
