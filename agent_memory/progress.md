# Progress

## Current task
- 2026-07-21 用户进一步明确：所有测试最终服务于 Live，Paper 与未来 Live 对同一 BUY 策略必须端到端一致，不能把 Live 市场最低额抬升留作以后处理；该端到端补齐已完成。
- 已在严格 Fake/Disabled 隔离环境中补齐 Live 的市场最低额自动抬升、最终 Risk、钱包/授权重验、Reservation、Live Gate、签名预算、消费记录和恢复重试一致性。
- Paper 核心实现和回归验证已完成；旧核心 Campaign `PC-94D81ECAD5EF89852D2A` 的约 44.12 小时只能保留为历史证据，新核心仍必须从 0 创建 replacement Campaign。
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
- Live 动态市场最低额抬升现在复用同一 BUY amount policy；最终金额会重新过 Risk、外部余额/授权、并发预留/敞口和 Live Gate，最终 Risk/金额持久化到 Execution、Consumption、Order 和签名预算。
- Live 首开资格由 sizing 与执行时重验共用同一定义；当前仓位、另一待处理首开 BUY、完全平仓后的重置行为与 Paper 一致。
- Live 重启重试现在恢复完整 Signal/Context/精确资本比例与 Capital Decision；抬升后的 Risk 和 Reservation 跨重启保持不变，不会重复加预留或重复 Risk。
- Live Consumer 在 Execution 已提交但 Consumption 尚未落库时，会直接恢复 Execution 绑定的最终 Risk/金额；最终 Risk/金额重绑、拒绝状态和 Reservation 释放在同一事务中完成，不留下半完成等待状态。

## Verification completed
- 全量：48 个测试文件、601 项全部通过。
- `pnpm typecheck` 通过；`git diff --check` 通过。
- 覆盖：首开 1 pUSD、正比例落为 0 micro、市场最低额 5 pUSD 内抬升/超过上限拒绝、已有仓位/待处理首单防重复、完全平仓重置、最终 Risk/Reservation/验收计数、预审批金额不一致回滚、目标价/实际 ask 0.95 上限、内部 invalid blocker。
- Standards 审查发现的重复上限算法和交接记录冲突已修正；Spec 审查确认 Paper 规则完整。
- 新增隔离 Live 覆盖：首开 1 pUSD、市场最低额抬升/超过 5 pUSD 拒绝、最终 Risk/钱包/授权/预留/Gate/签名一致性、已有仓位/待处理首开防重复、完全平仓重置、足额比例不受 5 pUSD 上限误伤、重启幂等恢复。

## Current identity
- Schema `2.25.0`；Strategy `2.2.0`；Risk `1.6.0`；Paper `1.6.0`；Live `1.6.0`；Ruleset `v1.5.0`；Config `v1.3.0`。
- Ruleset：`df8972bec64fff074eeb2c5d67ed500dcd2dfac32f3da2a21cbe546dc4edabad`。
- Paper ruleset：`2eea639f551be44fa8abfe32c11d6b01973c0167bbe505595643b1d77825e93f`。
- Core compatibility：`cc538a1db25932877754acc2ee04defbe5559306c0cbb556164065701d04645b`。
- Validation policy：`b798450c845d7a7429ee1239b3e8feb1d5f146e3ab028d20eefbe6cab5587aac`。
- Operator build：`0b5e3e2fa74e1f5291bc3fed357635f2135058d335898271ee904b5990d87ff8`。
- Verification suite：`b9086fc12bcb83fa4694c593959ba69c515f00187a419fb3d5b4610067c532a7`。
- Artifact provenance：`cc17ccf847f1c4ac19eadea3f4d33b89cb23987171a8f0040012da30d870ecd0`。

## Runtime state before handoff
- 真实业务库 Schema `2.25.0`，最新旧核心 Campaign `PC-94D81ECAD5EF89852D2A` 为 `PAUSED`，active Reservation 为 0。
- 运行模式保持 `PAPER + LIVE_DISABLED + liveAllowed=false`；本轮实现期间没有启动累计验证进程。

## Next steps
1. 用户下一次双击“1_开始或继续Paper累计验证.command”；入口应因核心变化创建 replacement Campaign，并从 0 开始累计。
2. 新核心先完成至少一次连续 12 小时，再累计 72 小时、补齐关键场景覆盖，最后完成同版本 24 小时 Observe。
3. 完成上述自然验证、真实 Live 合规/geoblock/隔离钱包/signer 设计和用户再次明确授权前，继续保持 `LIVE_DISABLED`。
