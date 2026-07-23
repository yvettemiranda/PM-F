# Progress

## Current task
- 用户已确认用逐笔新规则替换“首笔放大后继承”：`<1%` 每笔硬性 `1—5 pUSD`，`>=1%` 只按比例；首次实际开仓不计，小额后续最多 `9` 次；止损触发后锁定重新 BUY。
- BUY 使用目标 VWAP和最新 REST 盘口的含手续费实际 VWAP，价格区间为 `90%—105%` 且不超过 `0.95`。
- 用户已明确确认经济成交口径：同一 `transactionHash + orderHash` 的多个 fill 合并；同一订单跨交易的后续 fill 作为新的实际经济成交继续跟。
- 范围保持：不改数据库结构、扫描频率、账本、安全 Gate 和 Paper/Live 边界。

## Implemented
- Ruleset 升至 `v1.9.0`，新增可配置 `smallFollowBuyMaxCount=9`；Signal/Strategy/Risk/Replay/Paper/Live/Config 同步升版。
- `BUY_AMOUNT_POLICY_V4` 精确区分 `<1%` 与 `>=1%`：小额每笔最低 `1`、市场最低额抬升、硬上限 `5`；比例 BUY 不抬升。小额可用现金不足 `1` 时由 Risk 拒绝，不降到 `1` 以下成交。
- 新增无 schema 的 `buy-follow-policy`：从不可变 Signal/Execution/Fill/Position/Order 证据推导持仓周期、首次实际开仓、9 次小额成交和止损锁；只有目标完整退出且自身义务归零才重置。
- MEDIUM 无比例证据继续使用既有 `1 pUSD` fixed fallback；部分成交计一次，零成交/取消/过期不计，`>=1%` BUY 不受 9 次限制。
- Polygon `OrderFilled` 按 `transactionHash + orderHash` 聚合多个 fill，求和并计算加权均价；Observe 只在唯一 Polygon 订单与单个 Data API endpoint 的聚合经济值精确一致时建立跨源 alias。
- Paper 和隔离 Live 改为在匹配后检查含手续费实际 VWAP；实现 90%、105%、0.95 边界与低价直接放弃/高价等待规则。目标参考价本身高于 0.95 不再被提前拒绝，只限制自身实际成交价。
- 市场最低量预检改为使用 tick 向下取整后的可执行 BUY 上限，避免预检看到 10 份、实际 FAK 只能成交 4 份却错误放行。
- 当前 Ruleset 下，低于市场最低量的 TARGET_SELL 保持 `EXIT_PENDING`，不因 BUY deadline 或等待时间取消；旧 Ruleset 继续保留旧金额、价格、lineage 和 SELL 终止语义。
- 新文件和执行依赖已纳入 core compatibility；README 已更新当前规则。

## Verification
- TDD/回归覆盖：小额最低1/最高5、比例结果超过5仍封顶、市场最低额超过5、精确1%边界、9次与第10次、`>=1%` 不限、部分成交计一次、零成交/取消/过期不计、未清义务不重置、完整新周期重置。
- 覆盖同 orderHash 多 fill VWAP、不同订单不合并、Polygon/Data API 聚合去重、无法证明时失败关闭。
- 覆盖 90%、105%、0.95 边界、目标参考价高于0.95但实际价合法、FAK 部分成交、tick-rounded 市场最低量、等待/过期/释放资金、SELL 调整等待 BUY、SELL 持续退出、止损锁和新周期解锁。
- 覆盖真实缺少 `smallFollowBuyMaxCount` 的历史 Ruleset，确认不会被 V4 重解释；MEDIUM 无 ratio 的 1U fallback 已覆盖。
- 最终全量：`54/54` 测试文件、`737/737` 测试通过；包含 Live 手续费价格边界与小额第 9/10 次集成路径。

## Runtime state
- 没有启动新测试或任何 Live 进程。历史 Campaign `PC-105EC3F76A2AC49D59E6` 保持 `PAUSED`，旧核心 `4.84 h` 不得混入新核心。
- 安全状态保持 `PAPER + LIVE_DISABLED + liveAllowed=false`；收尾前仍需再次只读核对进程、Git、数据库、Gate、Campaign、磁盘和 Live 零记录。

## Next steps
1. 完成安全复核并提交当前实现。
2. 用最终干净提交开启全新 Paper，重点观察自然 BUY/SELL、聚合去重、9 次计数、止损锁、延迟、RPC degraded 和数据库增长。
