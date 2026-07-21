# Progress

## Current task
- 2026-07-21 用户授权实施 BUY 策略：首开最低金额、市场最低额有限自动抬升、高价 BUY 上限，默认值均进入版本化 ruleset。
- Paper 核心实现和回归验证已完成；旧核心 Campaign `PC-94D81ECAD5EF89852D2A` 的约 44.12 小时只能保留为历史证据，新核心必须从 0 创建 replacement Campaign。
- 本轮未启用 Live、未接入 private key/signer、未提交或取消真实订单，也未执行任何链上写操作。

## Completed implementation
- 默认首开最低金额 `1,000,000` micros（1 pUSD），市场最低额自动抬升上限 `5,000,000` micros（5 pUSD），BUY 最高价 `0.95`；全部进入 immutable ruleset snapshot 和 Paper core identity。
- 比例金额足够时保持原值；不足时只允许无现有仓位且无另一待处理首开 BUY 的首单抬升。完全平仓后恢复首开资格，已有仓位不补足、不累计、不追单。
- 市场最低额在 5 pUSD 内时精确抬至 SDK/tick/share 可通过的最小金额；最终金额重新通过 Risk，并同步 Execution、Reservation、Cash ledger 和审计。超过 5 pUSD 时明确拒绝。
- 目标价高于 `0.95` 在 Risk 阶段拒绝；执行上限为 `min(target * 1.02, 0.95)`；当前最佳 ask 高于 `0.95` 时不创建订单。
- `BUY_ORDER_CONSTRAINT_INPUT_INVALID` 已进入 Paper 验证 blocker；验收漏斗只统计 Execution 最终绑定的 Risk Decision。
- Executor Interface 的预审批 BUY Risk Decision 现在必须与首开/市场规则处理后的最终金额一致，否则事务回滚且不创建 Execution/Reservation。
- SELL、Stop Loss、Settlement 未改变；旧 ruleset 仍可按历史语义读取，避免旧 Position 的退出/结算被新 BUY 字段阻断。
- 重复的 BUY 上限计算已收敛为共享实现，Paper 与 Live 的 0.95 价格边界一致。

## Verification completed
- 全量：48 个测试文件、588 项全部通过。
- `pnpm typecheck` 通过；`git diff --check` 通过。
- 覆盖：首开 1 pUSD、正比例落为 0 micro、市场最低额 5 pUSD 内抬升/超过上限拒绝、已有仓位/待处理首单防重复、完全平仓重置、最终 Risk/Reservation/验收计数、预审批金额不一致回滚、目标价/实际 ask 0.95 上限、内部 invalid blocker。
- Standards 审查发现的重复上限算法和交接记录冲突已修正；Spec 审查确认 Paper 规则完整。

## Current identity
- Schema `2.25.0`；Strategy `2.2.0`；Risk `1.6.0`；Paper `1.6.0`；Live `1.5.0`；Ruleset `v1.5.0`；Config `v1.3.0`。
- Ruleset：`df8972bec64fff074eeb2c5d67ed500dcd2dfac32f3da2a21cbe546dc4edabad`。
- Paper ruleset：`2eea639f551be44fa8abfe32c11d6b01973c0167bbe505595643b1d77825e93f`。
- Core compatibility：`cc538a1db25932877754acc2ee04defbe5559306c0cbb556164065701d04645b`。
- Validation policy：`b798450c845d7a7429ee1239b3e8feb1d5f146e3ab028d20eefbe6cab5587aac`。
- Operator build：`0b5e3e2fa74e1f5291bc3fed357635f2135058d335898271ee904b5990d87ff8`。
- Verification suite：`1613c8196f8578d7602f39553c445b4dae1931d5edb0cc13087511abb12f4128`。
- Artifact provenance：`9c434a6a5a06d32a1d3c8eb3e2b79c66449b40e60941aeb15c454599d0e6cf77`。

## Runtime state before handoff
- 真实业务库 Schema `2.25.0`，最新旧核心 Campaign `PC-94D81ECAD5EF89852D2A` 为 `PAUSED`，active Reservation 为 0。
- 运行模式保持 `PAPER + LIVE_DISABLED + liveAllowed=false`；本轮实现期间没有启动累计验证进程。

## Next steps
1. 用户下一次双击“1_开始或继续Paper累计验证.command”；入口应因核心变化创建 replacement Campaign，并从 0 开始累计。
2. 新核心先完成至少一次连续 12 小时，再累计 72 小时、补齐关键场景覆盖，最后完成同版本 24 小时 Observe。
3. 在任何 Live 授权讨论前，必须先补齐 Live 市场最低额动态抬升的最终 Risk/Gate/钱包检查/预留一致性，并完成隔离回归；当前不得启用 Live。
