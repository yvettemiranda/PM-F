# Progress

## Current task
- 用户要求先修复全程序审计确认的四项问题，并在新一轮自然 Paper 前先处理特殊操作：
  1. Live 比例 BUY 错用可用现金而不是完整总权益；
  2. Live 同轮旧等待 BUY 可能早于新目标 SELL 重试；
  3. Campaign crash recovery 不能还原 Polygon `OrderFilled`；
  4. Core compatibility hash 漏掉共享 SELL policy。
- 特殊操作必须坚持无 signer、无真实资金、无认证订单、无链上写入；证据不足 fail closed。

## Implemented
- Live BUY sizing 改为读取统一账户估值：`COMPLETE` 时以 `totalEquityMicros` 计算比例，`availableBalanceMicros` 只作为支付上限；估值不完整时回退可用现金。
- Live cycle 改为“队首目标退出 → 止损 → pending exit → 晚到队首退出 → 按原序消费新 Signal → 旧 waiting BUY”；新 Signal 消费抛错时旧 BUY 不会继续重试。
- `ObserveStore` 提供共享持久化事件 decoder，正常恢复和 Campaign crash recovery 都能识别并校验 Data API trade/activity、Polygon `OrderFilled`、conversion 和 SPLIT 证据。
- Core compatibility 的执行和验证清单纳入 `src/execution/target-sell-policy.ts`，Schema 清单纳入迁移 035。
- 新增 Schema `2.30.0` 的不可变 `split_projection_evidence`：保存 Activity 关联、官方市场、同轮 Positions 原文/时间/哈希和来源版本。缺少完整证据时 Observe 整轮不提交、游标不前移。
- SPLIT 的目标 outcome 腿只投影到 historical bucket，不生成 BUY；negative-risk CONVERSION 的 destination 腿进入 historical bucket，tracked source 生成 `TARGET_SELL` 等价退出。
- Replay 只接受按 `source_event_key` 传入且哈希/Activity/市场/Positions 一致的特殊操作证明；无证明保持 `INCOMPLETE`。CONVERSION Replay 已与 Observe 对齐 source exit 和 destination isolation。
- README、版本、迁移注册、运行时 Schema 合同和 core compatibility 清单已同步。

## Verification
- TDD/回归覆盖：Live 总权益资金比例、可用现金支付上限、新 SELL 优先取消旧等待 BUY、同轮 BUY→SELL 原序、Signal 消费失败不重试旧 BUY、Polygon crash recovery、共享 SELL policy 纳入 core hash。
- 特殊操作覆盖：SPLIT 缺证据失败关闭、完整证据投影/持久化/恢复、Replay 弱证据拒绝、Replay 完整 SPLIT、CONVERSION source SELL 与 destination historical projection。
- 最终验证：TypeScript 通过；全量 `55/55` 测试文件、`767/767` 测试通过；`git diff --check` 通过。
- Schema 035 额外覆盖缺索引、缺不可变触发器时拒绝且不登记版本，以及完整既存对象的幂等补登记。

## Runtime state
- 当前无 Observe/Paper/Supervisor/launcher 进程；未启动 Campaign，未迁移运行数据库。
- 安全状态保持 `PAPER + LIVE_DISABLED + liveAllowed=false`；本轮没有 signer、认证 CLOB、真实订单、真实资金或链上写入。
- 运行数据库仍为 `2.29.0`，源码目标 `2.30.0`；下次新核心启动必须走既有备份优先迁移入口。

## Next steps
1. 提交当前实现；不自动启动 Paper。
2. 用户确认后从最终干净提交和新 core hash 创建新 Campaign，先备份迁移到 Schema `2.30.0`，再重新累计自然验证时长。
