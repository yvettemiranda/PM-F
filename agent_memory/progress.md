# Progress

## Current task
- 2026-07-22 用户确认本批目标：目标地址事件 `3 s` 扫描、公开 Market WebSocket 盘口唤醒、BUY 非对称 tick 规则、保持首开 `1 pUSD` 模式；不启动后台 Campaign，不改变 `PAPER + LIVE_DISABLED`。
- BUY 上限已实现为原 `2%` 与至少 `2 tick` 取较宽者，并继续受 `0.95` 绝对上限约束；低于目标价的改善价格全部接受。
- Observe 已拆分节奏：Trades/Activity 每 `3 s`；Positions/pUSD 每 `15 s`，但发现新事件立即刷新。
- Paper 已接入公开无认证 CLOB Market WebSocket，只把消息作为待成交 BUY 的 wake hint；每次判断仍重新拉取 REST orderbook，且每 `15 s` 强制兜底。
- 未改变 1 pUSD 首开和最高 5 pUSD 市场最低额自动抬升策略；市场最低额改为按当前可成交多档深度和 fee 精确计算，低价改善已足够满足市场最低份额时保持 1 pUSD。无可用深度时不预先放大 Reservation，待盘口恢复后按精确金额重新 Risk 一次。

## Completed implementation
- 新增 `src/execution/market-change-feed.ts`：官方 Market Channel 订阅、动态 subscribe/unsubscribe、10 秒 PING、断线指数重连、按 asset 去重唤醒；无认证、无 signer、无订单能力。
- `PaperRunner` 只对盘口变化 asset 或 15 秒兜底重试待成交 BUY；STOP/SELL 退出每个 cycle 都处理，BUY 到期即使没有 wake 也会释放 Reservation。
- `PaperExecutor` 暴露待成交 BUY 市场列表和可限定重试范围；同一 execution 的 orderbook payload 与 fee 未变化时不再写重复完整尝试。
- Paper/Live 使用同一非对称 BUY 规则；历史 ruleset 缺少新字段时保留旧对称语义。
- 修正共享 VWAP 计算，避免先把 notional 舍入到 micros 再反推价格造成的虚假越价；Live 对内部计划允许自身最小单位取整，但 signer 只要改变数量并实际越过限价仍失败关闭。
- 等待原因由合并字符串改为可诊断的无卖盘、最优卖价超限、零可执行流动性等。
- 版本已升级为 Strategy `2.3.0`、Paper/Live `1.7.0`、Validation `1.5.0`、Operational `1.4.0`、Ruleset `v1.6.0`、Config `v1.4.0`；Schema 保持 `2.28.0`。
- README 已同步 3/15 秒节奏、WebSocket 仅唤醒+REST 复核，以及新 BUY 公式。

## Verification completed
- TDD 聚焦覆盖：两 tick BUY、低价改善、超上限等待、历史规则兼容、1 pUSD/市场最低额、重复盘口不重复尝试、到期释放、WebSocket 订阅、Runner wake/fallback、Observe 3/15 秒缓存和新事件强刷。
- Paper Executor `93/93` 通过；Live Executor `100/100` 通过；TypeScript `tsc --noEmit` 通过。
- 公共 WebSocket 实网只读烟测成功：目标最近 asset 完成握手并收到 `book` 消息；未认证、未写数据库、未签名、未下单。
- 首轮全量测试 `655/664` 通过，9 项仅因新增测试未登记 verification suite 而按设计失败；将 `market-change-feed.ts/test.ts` 纳入核心与验证清单后，受影响 `49/49` 回归通过。
- 首次 Standards/Spec 两轴审查共发现 4 项：WebSocket 异常时可能退化为每 cycle 全量 BUY 重试、进度文档过期、Paper/Live 无成交原因重复、市场最低额按追价上限而非真实深度放大；均已修复并增加回归用例，两轴最终复核均为 0 个 actionable finding。
- 最终全量验证：`53` 个测试文件、`668/668` 项通过；`tsc --noEmit` 与 `git diff --check` 通过。

## Runtime state before final verification
- Codex 本批未启动 Paper、Observe 或 Campaign supervisor，未写业务数据库，未创建真实订单或链上交易。
- 下次启动必须使用本批最终干净 commit 重新生成 Phase 0/Replay/core 绑定，不得续算旧核心 Campaign 时长。

## Current identity
- Ruleset：`33d4b9334cf947e578c6807e447c9c0684e36a4cc888ab4f07df4e9082499ec6`。
- Paper ruleset：`736f827e2c91035d864d26de07c4fd70c54a4260ee56ef950a6d2c55a0aa443e`。
- Core compatibility：`9a905cff10982f9181b24b6999c4799cacfdc7cb7a490a3b7caffec8073f7ec5`。
- Validation policy：`703b65ca66e1f0cc7e366f61f9ae82be1b7afd2939a6207848c47077487f66a8`。
- Verification suite：`c4f98d5fcb2e86bb632035172f6f27ddfff2fc929c1bc11e6de39ec5ab5a819a`。
- Operator build：`11df3f64bdd1d47198b3f0448e7a6c2e156205329748ac6ddbab3e2ea3c7b9b8`。
- Artifact provenance：`46cda8aa74eb6dacba23ec1befe80c4d45730c6fea959f1228440f507953af67`。

## Next steps
1. 本批核心已提交并保持后台停止；等待用户确认后启动新核心短测。
2. 短测确认自然 BUY 能在新窗口内成交、无变化重试显著下降、延迟链和数据库增长正常。
3. 后续另批处理 MERGE/SPLIT 语义和只读 UI；最终从稳定新核心重新累计 24 小时。
