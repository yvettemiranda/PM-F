# Progress

## Current task
- 全仓库 Production Readiness Hardening 已完成：代码、独立复核、提交、clean-commit 全量回归、真实只读 API 契约采样、业务库隔离迁移和五类 Operational smoke 均已有证据。

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
- 双击 Observe/Paper/停止/报告入口已加单实例、精确 PID、frozen install、caffeinate、安全停止和自动报告；没有 Live 入口。
- 最新验证：TypeScript 通过；28 个测试文件、323 项测试全部通过；`git diff --check` 与全部 `.command/.sh` zsh 语法通过。
- 业务库 Online Backup 隔离验证保持源文件 SHA-256 `008a7a76...f8fbb55` 不变；2.18.0 迁移快照 `integrity_check=ok`、`foreign_key_check=[]`，仍为 `PAPER + LIVE_DISABLED`。
- `validate:final --type=all` framework session 通过，但顶层正确报告 `INCOMPLETE`、`VALIDATION_FRAMEWORK_READY`、`liveAllowed=false`；未把 Replay/历史 orderbook 数据不足冒充 PASS。
- clean commit 上的 Final Validation 记录 `sourceDirty=false`，2.18.0 snapshot 完整性和外键检查通过；业务源库 hash 在验证前后保持不变。
- 2.18.0 下五种 `operational:validate` 零时长 smoke 全部无 blocking failure、`liveAllowed=false`，并因 long soak/实时覆盖/新 Paper 消费未执行而正确报告 `INCOMPLETE`；所有运行均使用 Online Backup，源库 hash 未变。
- 真实公开接口采样成功：Profile、4000 Trades、3500 Activity、127 Positions、CLOB Time/Market/Orderbook 均通过 runtime parser；全程只读、无认证、无订单。

## Current gate
- 系统达到“Production Ready Candidate 的技术候选”所需主体能力，但尚未完成长周期验收，也未获 Live 授权。
- 自动验证不允许把 `liveAllowed` 改为 true；当前无 private key、真实 signer、真实订单或真实资金行为。

## Next steps
- 由用户通过双击入口完成 24 小时 Observe，把报告交给 Codex 分析后再执行长周期 Paper。
- 全部长周期、合规和人工 Gate 通过后，才讨论真实 signer、认证 provider 和小额实盘授权。
