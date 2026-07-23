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
- 补齐隔离 Live 的目标 SELL/等待 BUY 对齐：完整退出取消等待 BUY，部分退出同比例缩减，先调整等待 BUY 再卖真实持仓；释放 Reservation/Cash、向下 Risk 决策、Transition 和 Audit 全部可追溯。
- 只抵消等待 BUY 且没有真实持仓时，Live 记录 `TARGET_EXIT_APPLIED_TO_WAITING_BUY` 而不伪造 SELL 订单；调整与该目标退出执行原子提交，记录失败会整笔回滚并关闭 Gate。
- Live 中被目标 SELL 缩减的等待 BUY 不会在后续重试时被市场最低额规则反向抬升；Gate 拒绝时等待 BUY 不发生改变。
- 修复安全启动编排死角：同 Paper core 的 `PAUSED` Campaign 在验证策略/测试套件变化时允许重建隔离测试与 Phase 0/Replay proof 后继续；`RUNNING`、崩溃恢复中、BLOCKED 或 core 不同仍拒绝刷新，避免移动未完成 Session 的证据。
- 修复 launcher 终端/PTY 被关闭后的收尾卡死：诊断包 Node 子命令统一脱离 stdin/stderr TTY，错误写入独立 postprocess log；安全暂停会重新判定运行身份，并清理暂停过程中才失效的安全锁。
- 自然 Paper 暴露普通尾仓 `EXIT_PENDING` 阻塞后续独立 BUY，而隔离 Live 已允许继续 BUY。已移除 Paper 的旧阻塞分支；普通退出义务继续独立保留，后续 BUY 正常逐笔判断，止损重开锁不变；Paper 版本升至 `1.15.0`。

## Verification
- TDD/回归覆盖：小额最低1/最高5、比例结果超过5仍封顶、市场最低额超过5、精确1%边界、9次与第10次、`>=1%` 不限、部分成交计一次、零成交/取消/过期不计、未清义务不重置、完整新周期重置。
- 覆盖同 orderHash 多 fill VWAP、不同订单不合并、Polygon/Data API 聚合去重、无法证明时失败关闭。
- 覆盖 90%、105%、0.95 边界、目标参考价高于0.95但实际价合法、FAK 部分成交、tick-rounded 市场最低量、等待/过期/释放资金、SELL 调整等待 BUY、SELL 持续退出、止损锁和新周期解锁。
- 覆盖真实缺少 `smallFollowBuyMaxCount` 的历史 Ruleset，确认不会被 V4 重解释；MEDIUM 无 ratio 的 1U fallback 已覆盖。
- 当前全量为 `54/54` 测试文件、`747/747` 测试通过；新增普通尾仓退出待处理时后续独立 BUY 的 Paper/Live 对齐回归。既有 Live SELL/等待 BUY、经济成交、启动恢复和收尾竞态覆盖继续通过；TypeScript 与 `git diff --check` 通过。

## Runtime state
- Paper `1.15.0` 修复已提交为 `7a640a71a384e8ad02cb9c36046496daaf4538a8`；旧运行库和冗余报告已移至系统废纸篓，只保留问题诊断 ZIP。
- 从空白数据库创建的 Campaign `PC-305046D47E89A5529CDA` 已按用户提前后的 07:30 截止安全暂停并完成 final drain。Session `PS-2CD692D49B8A067668BE` 有效运行 `1.63 h`，Observe `5556/0`、Gap `0`、最终 `SYNCED`，3 BUY Signal、1 SELL Signal、2 Fill、1 Realized PnL。
- 两笔等待 BUY 均正常过期并释放资金；自然 SELL 成交后保留 `0.003743` 股精度尾仓 `EXIT_PENDING`。当前无活动 Reservation、无 Observe/Paper/Supervisor、安全锁已清理。
- 最终报告 ZIP 与哈希已校验；数据库 integrity/foreign key 正常，Live Execution/Order/Fill/Attempt 全为 `0`，安全状态保持 `PAPER + LIVE_DISABLED + liveAllowed=false`。

## Next steps
1. 当前自动测试与巡检任务已经结束；除非用户明确要求，不自动重启。
2. 后续若继续实盘前验证，先从当前报告复核尾仓、等待过期和实际盈亏，再累计 Paper `24 h`/连续 `4 h` 并覆盖 `API_RECOVERY`。
3. Live runtime、合规、隔离钱包和 signer 未完成且未获授权，继续固定 `LIVE_DISABLED`。
