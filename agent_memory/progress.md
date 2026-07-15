# Progress

## Current task
- commit `ff1f77651919a167461e2338ae51f41b51521892` 上的 24 小时 Observe 已通过：`activeRuntimeMs=86400004`、5,300 次成功轮询、42 次失败均恢复、0 `MAJOR_DESYNC`、最终 `SYNCED`、`liveStabilityEligible=true`。
- 联合验证仍未整体通过：原 24 小时 Paper 缺最终 JSON，且没有有效 SELL/止损/结算覆盖；但孤儿 PID 1300/1316 已安全停止，进程跟踪和收尾路径已修复。

## Completed
- 修复 SQLite WAL 直接复制风险，Validation/Operational 改为 Online Backup；新增 snapshot retention，验证不会污染业务库或无限占用磁盘。
- 公开 API 增加分页完整性、运行时 schema、超时/有限重试/jitter；capture payload 使用内容寻址压缩存储并校验 hash。
- Observe 增强 Activity/Trades 双源确认、组合/非交易隔离、checkpoint/reconciliation、乱序/重复/gap/restart 恢复。
- Paper 增强保守金额舍入、Reservation、stale orderbook、历史 ruleset 的等待/价格/止损/滑点/版本审计。
- Live 增加独立 Live Account 风险域、资产 reservation、完整市场数据执行计划、正式状态机、外部 timeout、订单/成交/仓位/现金恢复与对账。
- 官方 CLOB adapter 按当前 SDK 对接 post/cancel/status/open orders/trades/fee exponent；真实提交结果与 Crash Recovery 共用严格 fill 校验，校验 CLOB finality、经济字段、风险预算、限价、fee evidence 和重复 fill。
- 修复历史 ruleset 被当前止损/滑点覆盖；Paper/Live 的历史 Position、Risk Decision、Execution、PnL、Settlement 和 Audit 保留原版本。
- 修复 Live 激活时 Signal cutoff 时间空窗：改为同事务单调 `signal_sequence` 边界；坏 Signal 可不可变 quarantine，缺 context 走明确 Risk REJECT，不再阻塞后续队列。
- Live Gate 增强 production provider 类型、clean commit、geoblock、clock、prerequisite evidence、原子 CAS、精确人工确认、账户/钱包绑定、配置/账本/外部现金一致性、单笔/敞口/日亏/连续亏损检查。
- Live Runner 执行顺序收敛为止损检查、待退出、待买入、再消费新 Signal；止损行情失败、过期、深度不足或历史规则异常时，本周期 fail closed 阻断所有新增 BUY 并保留账户级 Audit。长期报告的错误与结算明细已改为有界去重，同时保留累计计数。
- 数据库增加 2.7.0—2.18.0 migrations、关键证据 append-only triggers、ruleset/registry/Live Gate transition immutability、Live signal cursor/quarantine、authorized signer、完整 Live Order Intent evidence 和 append-only Live Settlement Events。
- Executor 入口新增 Signal/Execution Context/capital decision 逐字段不可变校验；Paper/Live 不能用相同 ID 搭配内存篡改的价格、资产、比例或元数据重用 ALLOW Risk Decision。
- Live signer 输出不再被信任：重新绑定注册钱包和 authorized signer，限制 signed 数量/价格/预算，校验 maker/signer/fee rate/exponent/model，启动恢复未完成或紧急停止竞态时禁止 submit。
- BUY 费用预算改为执行器与官方 CLOB adapter 双重独立推导：按完整签名数量、限价、费率和指数计算，并覆盖价格改善可能经过的 `p=0.5` 费用峰值；signer 自报的 `maxTotalCostMicros` 不能再低报或突破 Risk Decision 预算。
- 多进程紧急停止与 submit 竞态增加同事务持久化 `SUBMIT/STARTED` claim 和 Gate transition generation 检查；紧急停止遇到在途 submit 会保持 Gate disabled、冻结执行并明确报告 incomplete，后到成交只入账为可对账的 FROZEN 状态。
- Cancel/Reconcile/Recovery/Redeem 纳入账户级串行化，取消 intent 使用 SQLite CAS；紧急停止先同步设置内存 halt 并持久化 Gate disabled，再清理订单。
- Observe Activity 适配官方非交易空字段，增量路径使用官方 `start` 游标完整分页；Trades 满页必须跨过上次 cursor，防止同秒高频截断。
- Activity 游标由持久事件独立推导：存在未确认 Trade 时回看到最老事件前 1 秒，否则对最新确认 Activity 保守重叠 5 分钟；recovery/Trades 水位不会推进 Activity。
- Observe/Paper CLI 新增 backup-first runtime database preparation：迁移前 Online Backup、按数据库前缀最多保留 3 份、迁移后 integrity/FK/Live Gate 表与 `PAPER + LIVE_DISABLED` 强校验。
- Final/Operational 所有模式强制隔离 snapshot；`--no-snapshot` 在任何数据库迁移或证据写入前直接拒绝，防止验证污染业务源库。
- Live Execution row/transition/audit 使用可嵌套 SAVEPOINT 原子提交；Settlement current projection 的每次变化与 append-only event、transition、audit 同事务，故障注入验证会完整回滚。
- 批量冻结仓位也自持事务；任一仓位 transition 失败会全部回滚。Redeem 失败后的 projection/event/transition 统一回到 `RESOLVED`，失败原因只作为不可变 evidence 保存。
- 依赖锁定 `@polymarket/clob-client-v2@1.0.8`、`viem@2.55.0`，并覆盖 `ws@8.21.0`；官方 CLOB SDK 当前已是 npm 最新版。
- 双击 Observe/Paper/停止/报告入口已加单实例、精确 PID、frozen install、caffeinate、有界停止和自动报告；用户日常只需桌面三按钮，没有 Live 入口。
- 最新验证：TypeScript 通过；28 个测试文件、323 项测试全部通过；`git diff --check` 与全部 `.command/.sh` zsh 语法通过。
- 业务库 Online Backup 隔离验证保持源文件 SHA-256 `008a7a76...f8fbb55` 不变；2.18.0 迁移快照 `integrity_check=ok`、`foreign_key_check=[]`，仍为 `PAPER + LIVE_DISABLED`。
- `validate:final --type=all` framework session 通过，但顶层正确报告 `INCOMPLETE`、`VALIDATION_FRAMEWORK_READY`、`liveAllowed=false`；未把 Replay/历史 orderbook 数据不足冒充 PASS。
- clean commit 上的 Final Validation 记录 `sourceDirty=false`，2.18.0 snapshot 完整性和外键检查通过；业务源库 hash 在验证前后保持不变。
- 2.18.0 下五种 `operational:validate` 零时长 smoke 全部无 blocking failure、`liveAllowed=false`，并因 long soak/实时覆盖/新 Paper 消费未执行而正确报告 `INCOMPLETE`；所有运行均使用 Online Backup，源库 hash 未变。
- 真实公开接口采样成功：Profile、4000 Trades、3500 Activity、127 Positions、CLOB Time/Market/Orderbook 均通过 runtime parser；全程只读、无认证、无订单。
- `source_event_key` 升级为兼容旧 key 的 v1.2 多重集身份：occurrence 0 保持不变，后续相同 occurrence 使用确定性 sibling key；只有 Trades/Activity 双源确认后才进入投影和 Signal。
- 双源数量不一致会写入 `SOURCE_EVENT_MULTIPLICITY_AMBIGUOUS` reconciliation evidence，并至少进入 `MINOR_DIFF`；持续不一致升级 `MAJOR_DESYNC`，无法误通过 Observe Gate。
- 延迟到断线或重启后才确认的 occurrence 会单调升级为 Gap，持久化为 `GAP_TRADE`，生成的 Signal 固定 `executionEligible=false`，不会补执行。
- 新 Position Baseline 后没有事件时，Activity 增量游标固定锚定在 baseline 前 1 秒；不再反复请求受 offset 限制的全部历史，也不使用 Trades/recovery 水位推进 Activity 游标。
- 失败 24 小时任务中的真实三行成交 capture 已回放为 3 个独立事件，`confirmedRepeated=1`、`ambiguousRepeated=0`、Replay `PASSED`，报告 hash 为 `6b7909875f4cfef732330e1cf1d22e78cf823ef614577b17f97e7c4b51705d84`。
- clean commit `9e22cafd3127390fb871dce66881d91ba18fb9e3` 上的 90 秒 Observe：6/6 轮询成功、0 API failure、0 Gap、0 drift、6 次 reconciliation 全部一致，最终 `SYNCED`，状态 `SHORT_SOAK_PASSED`；报告为 `data/observe/observe-eb12fa48-0f08-4b5c-bc0d-7f11cc9540aa.json`。
- 最新验证：TypeScript 通过；28 个测试文件、335 项测试全部通过；`git diff --check` 通过。
- 已仅删除隔离 Validation/Operational 任务的可再生 SQLite 快照、`.DS_Store` 和失效 FIFO，回收 3,153,285,120 bytes；主库、迁移备份、原 24 小时失败证据、90 秒通过证据及最新 Validation/Operational 报告均保留。
- 操作入口语法、中文/空格路径、日志尾部刷盘、有界子进程停止、最新 ZIP/fallback 选择及严格 4 文件压缩包已通过独立 smoke 测试。
- 2026-07-14 15:37:14 至 2026-07-15 15:37:14 的真实 Observe 长测已达到 24 小时 Gate：704 个新事件、566 个 Signal、56 个 Gap Signal 全部不可执行；5,188 次 `SYNCED`、112 次可恢复 `MINOR_DIFF`、0 `MAJOR_DESYNC`，无未恢复连接缺口或 checkpoint hash 不一致。
- 本轮 Paper 数据库证据显示 566 个 Signal 全部且仅消费一次；345 个完全成交、2 个部分成交、108 个超时、47 个费率模型不可用，Reservation 归零、现金账本一致、无重复/孤立记录。但因 Paper 最终报告缺失，只能作为临时证据，不能通过 Paper Stability。
- `operator_tsx` 现由后台 subshell 直接 `exec node --import tsx`；启动器记录 PID 与实际 worker PID 一致，并禁止前台误用。进程生命周期回归验证 TERM 可由 worker 接收、正常退出且无孤儿。
- PaperRunner 已支持 Abort 中断间隔等待，并在各阶段间停止；Abort 后最终报告只做账本快照，不再发起盘口请求。真实双击入口短测在约 11 秒内完成 Paper/Observe 收尾，生成严格 4 文件 ZIP，无强杀、无残留进程、锁或 FIFO，数据库 `integrity_check=ok`。
- Paper CLI 区分 `FAST_ABORT` 与 `FINAL_VALUATION`：人工 TERM 快速收尾并固定不能通过 Gate；Observe 满 24 小时后入口发送 USR1，Paper 停止循环后执行聚合最终估值。CLI 与联合入口都会拒绝 `INCOMPLETE`/未估值报告，避免把缺失 PnL 冒充完成。
- Portfolio Projection 改为同一 asset+condition 聚合全部独立 Position 后只消费一次完整盘口深度，再按确定性比例分摊退出价值/费用；FROZEN 非零仓位不再漏算，部分/不可估值来源明确为 `PARTIAL_ORDERBOOK_EXIT_VWAP`/`UNAVAILABLE`。
- Stop Loss 单轮按 asset+condition 复用盘口；Settlement 单轮按 condition+asset 复用结果，避免相反 outcome 串用。Paper 长跑错误详情限制为最近 100 条，同时保留 `errorCount/droppedErrorCount`。
- 最新验证：Node `24.14.0`、pnpm `11.7.0` frozen install 通过；TypeScript 通过；30 个测试文件、351 项测试全部通过；全部操作入口 zsh 语法和 `git diff --check` 通过。
- 隔离临时数据库上的真实 Paper CLI USR1 测试已通过：`shutdownMode=FINAL_VALUATION`、`status=COMPLETED`、`valuationStatus=COMPLETE`、exit 0；测试生成物已清理，`交给Codex/` 仅保留用户原 24 小时 ZIP。
- 最终估值增加 30 秒全局预算；公开 CLOB orderbook/fee/resolution 请求支持外部 Abort，重试和 backoff 也可取消。USR1 后再发 TERM 的隔离实测会升级为 `FAST_ABORT/STOPPED_EARLY`、exit 1，不会等 45 秒强杀或误过 Gate。
- 计划收尾取消在途 Paper 行情请求时，仅与该 AbortSignal reason 对应的取消会被视为正常停止；同时发生的普通业务错误仍计入 `errorCount`，避免健康任务因正常收尾时机假失败，也不会吞掉真实错误。
- 最终并行规格/证据复审覆盖 PID、信号升级、30 秒估值预算、45 秒清理上界、报告与双重 Gate、盘口聚合及安全边界；已关闭全部发现项，未发现剩余 P0/P1/P2。

## Current gate
- 系统达到“Production Ready Candidate 的技术候选”所需主体能力，但尚未完成长周期验收，也未获 Live 授权。
- 自动验证不允许把 `liveAllowed` 改为 true；当前无 private key、真实 signer、真实订单或真实资金行为。

## Next steps
- 针对短测中持续返回 `No orderbook exists` 的 Paper asset，明确不可交易市场的冻结/恢复或退避策略；当前会诚实生成 `COMPLETED_WITH_ERRORS`，不得把它冒充 Paper Stability PASS。
- 无需重跑 Observe 24 小时；下一轮只需在修复上述 Paper 行情健康问题后执行 Paper 长周期验证，并检查错误总数、估值完整性与最终报告。
- 后续单独补验有效 SELL、止损、Settlement/Redeem、Crash Recovery 和最终一致性；本轮 12 个 SELL 全为 Gap，未覆盖卖出生命周期。
- 全部长周期、合规和人工 Gate 通过后，才讨论真实 signer、认证 provider 和小额实盘授权。
