# ni-k Polymarket Copy Trading System

这是一个全新、独立的 Polymarket Copy Trading System。它不复用旧版 PolymarketBot 的代码、数据库、仓位模型、交易逻辑或页面。

当前已完成 Phase 1A—5 的主体架构，并完成一轮 Production Readiness Hardening：

- Wallet Identity 验证
- 官方公开 API 数据契约采集
- 第一层领域模型和状态机
- SQLite 初始化
- Replay Engine
- 去重、仓位投影和崩溃恢复测试
- Capture Manifest 与源码版本绑定
- Position Baseline 与历史/跟踪仓位双桶账本
- 目标可见资金估算与 `HIGH / MEDIUM / LOW` 置信度
- Candidate Golden Cases（必须由用户确认后才能批准）
- Signal `executionEligible`；断线行为 Signal 永远禁止进入执行层
- Observe Only Runner：增量轮询、checkpoint 恢复、前向仓位投影和只报告不修正的 reconciliation
- 不可变 `signal_execution_context`：为 Paper 输出交易时间、市场结束时间状态、执行截止时间、市场元数据和逐 BUY 资金决策
- Paper Executor：独立模拟账户、资金 reservation、完整深度 VWAP、模拟 FAK、独立 Position/Execution、止损、结算和审计账本
- Phase 1A 架构优化：统一 Executor Interface、Risk Manager、Risk Decision 全链路关联、Portfolio Projection Service、Ruleset Registry、Live 安全占位、Settlement Service、PnL Model、不可变 Audit Log、Position `FROZEN` 保护态和核心对象版本字段
- Phase 2/3：Live Gate Safety Layer、Live Executor 架构、Order/CLOB/Signer/Wallet/Redeem adapters、Live Order/Fill/Position/Ledger/Reconciliation/Crash Recovery/Emergency Stop。默认仍使用 disabled/fake adapter，不默认创建真实交易能力
- Phase 4：Final Validation Framework。统一验证入口会在 isolated snapshot database 上运行 Paper Replay、Consistency、Crash Recovery、Reconciliation、Live Gate fake path 和 Observe Only 检查，并生成可追溯 Validation Report
- Phase 5：Operational Validation Framework。新增 Operational Runner、单实例锁、心跳、健康快照、运行 checkpoint、shadow risk observation、一致性/崩溃恢复检查和 Operational Report，用于证明系统可以被长期验证，而不是打开真实交易
- Production hardening：公开 API 分页/运行时契约校验、Activity 时间游标增量采集、WAL-safe SQLite Online Backup、内容寻址压缩 capture、不可变证据表、历史 ruleset 执行、Live 信号序列游标与坏消息隔离、完整订单簿执行计划、真实/恢复共用 fill 校验、Live 账户资金口径绑定和外部现金/仓位对账
- 完全相同成交的链上次数证明：只对官方 Polygon V2 Exchange 的成功回执解码 `OrderFilled`，并要求目标 maker、side、token、抵押金额、成交次数和不同 `orderHash` 全部精确一致；原始回执与派生 proof 随 Capture Manifest 内容寻址、不可变保存，任何缺失或不一致继续阻断 Replay
- Live 下单边界加固：不可变 Signal/Execution Context 逐字段校验、钱包与 authorized signer 绑定、signed order 的 maker/signer/数量/限价/fee 复核、完整 Order Intent 快照及恢复 hash、账户级串行化、取消 CAS、启动恢复门槛和紧急停止竞态保护

`Live Executor` 已有完整架构、官方 CLOB SDK adapter、合规/geoblock/时钟安全 provider、钱包与 signer 身份绑定、启动恢复、外部订单/成交/仓位对账、arming/kill switch 和完整依赖装配入口。装配入口只接受显式注入的 adapter，不会发现或加载私钥；当前也没有用户可操作的 Live UI。数据库状态固定为 `execution_mode=PAPER`、`live_gate_state=LIVE_DISABLED`。私钥接入、真实订单、approve、真实 redeem 和链上写操作均不属于当前默认运行状态。Phase 4/5 和自动化 hardening 只代表技术候选与验证框架可用，不代表最终验证通过，也不代表 Live 已获授权。

## 本机验证

不熟悉命令行时，只使用仓库里的 `操作入口/` 文件夹；旧的 `点这里运行/` 已移除，避免误点失效入口：

1. 双击 `1_开始或继续Paper累计验证.command`。第一次默认最多连续运行 4 小时；满 40 分钟记录资格里程碑但不强制重启，继续到 4 小时可同时满足连续门槛。后续继续使用同一个 Campaign 和 1000 pUSD 模拟账户累计到 24 小时。
2. 想暂停或关机时，双击 `2_安全暂停并生成报告.command`。它会停止 Observe、让 Paper 安全收尾，并自动生成报告和诊断 ZIP。
3. 双击 `3_查看进度和打开最新结果.command`。Finder 会选中应发给 Codex 的最新 ZIP，无需手工寻找数据库或日志。

长期入口会使用 macOS `caffeinate` 防止系统睡眠（屏幕仍可关闭），并在 `data/operator/run/` 保存本次入口的精确进程记录。安全暂停只向这些已登记的本项目任务发送停止信号，不按进程名称扫描其他项目。每次启动都会通过 frozen lockfile 校验依赖；同一时间只允许一个长期入口运行。Observe/Paper 启动前还会检查数据库是否固定为 `PAPER + LIVE_DISABLED`；如需迁移，会先用 SQLite Online Backup 保存迁移前备份，成功后只保留最新 1 份，再执行 migration、`integrity_check` 和 `foreign_key_check`。

`操作入口/` 中没有 Live 入口，不会读取私钥，不会创建真实订单。

目标钱包不再写死在启动脚本里。项目默认值在 `config/default-target-wallet.txt`，操作员选择写入被 Git 忽略的 `data/operator/target-wallet.txt`；因此换地址不会改变源码版本，也不会把旧地址的 Campaign、账户、基线或证明重新绑定。运行任务或残留安全锁存在时拒绝换地址。

 localhost `Hecatonchires` UI 复用 `operator-control` 控制面和 `operator-dashboard` 只读投影：它统一展示目标钱包、数据库安全状态、Campaign、Observe、Signal、Market、Risk、Paper/Live 账户、资金、执行、持仓、订单、成交、盈亏、账本、日志索引、对账、恢复、隔离异常、审计和目标/我的对照事件。Live 订单取消、执行重试和运行时恢复入口会根据后台 capability 开启；未配置时以明确原因禁用。原始订单请求/响应与日志正文不进入 localhost 快照。Paper 策略/风险参数以完整、严格校验的不可变 profile 写入被 Git 忽略的 `data/operator/ruleset-profile.json`，进程启动时冻结；参数变化会改变 Paper ruleset/core identity，只能用于下一次 Campaign，不能把不同参数的验证时长混在一起。运行锁存在，或现有数据库不精确处于 `PAPER + LIVE_DISABLED` 时，目标和参数修改都会失败关闭；这两条独立门禁不能互相替代。基础设施容差、安全 Gate、执行模式和 Live-only 参数不开放编辑；模式切换、Live Gate、Paper 生命周期和恢复都由后台接口执行。Live Gate 可以从 UI 发起真实后台预检和审计，但当前 Live execution/order runtime 仍因无 signer、认证 CLOB、外部余额/合规/地理和时钟 provider 而保持 fail closed。

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm operator:control -- status
pnpm operator:control -- set-target --target-wallet=0x目标地址
pnpm operator:control -- get-ruleset
pnpm operator:control -- set-ruleset --file=/绝对路径/profile-overrides.json
pnpm operator:control -- reset-ruleset
pnpm phase0:validate -- 0x目标地址
pnpm phase05:replay-capture -- capture_run_id
pnpm observe:run -- 0x目标地址 --duration-seconds=300 --poll-seconds=1 --reconciliation-seconds=15
pnpm paper:run -- --duration-seconds=300 --interval-seconds=1
pnpm validate:final -- --type=all --campaign-id=PC-... --session-id=PS-...
pnpm operational:validate -- --mode=health_monitor --duration-seconds=0
```

`profile-overrides.json` 只提交名称和需要改变的 Paper 参数；`status` 返回当前值、hash 和允许编辑的 key，非法类型、越界关系、未知 key、Live-only key 或无实际变化都会失败关闭。例如：

```json
{
  "name": "Lower buy ceiling",
  "overrides": {
    "buyMaximumPricePpm": 940000,
    "stopTriggerRatioPpm": 450000
  }
}
```

运行结果保存在本机 `data/phase0/`。确定性 Replay 要求 capture 和当前工作树使用同一 Git commit，且两者都不是 dirty 状态。

Data API 不提供逐 fill ID。Polygon 快速源按同一 `transactionHash + orderHash` 归并多个 fill，金额求和并计算加权平均成交价；同一交易中的不同 `orderHash` 始终保留为独立成交，同一 `orderHash` 后续出现在另一笔链上 transaction 时也视为新的经济成交并独立跟单。Data API 后续若以多行报告同一经济成交，只有总数量和加权价格与唯一的 Polygon 订单证据精确一致时才去重；存在多个候选订单或经济值不一致时不猜测合并，并立即失败关闭。Data API 自身出现完全相同的多行成交时，仍须由 Trades/Activity 或官方回执证明 occurrence 数量。

`observe:run` 不加载私钥，也没有下单路径。省略 `--duration-seconds` 时持续运行，收到 `SIGINT`/`SIGTERM` 后安全停止；每次报告写入 `data/observe/`。Observe 默认每 1 秒读取 Polygon 上两个官方 Exchange 已确认 2 个区块的 `OrderFilled`，并把目标地址作为 maker 的成交还原成与 Data API 相同身份的交易；同时订阅公开 Polygon WebSocket 的同一 maker 日志，只把通知当作“立即再扫描一次”的唤醒信号。WebSocket 消息本身绝不生成 Signal，仍须通过已确认区块扫描、重组检查、REST/Activity 交叉确认和幂等链路；断线、乱序或丢消息时原有 1 秒轮询继续兜底。公开 Trades/Activity 仍限制为每 3 秒读取一次，Positions 与 pUSD 默认每 15 秒全量核对一次，发现新的目标事件时会立即提前核对。每个成功轮询仍写入轻量心跳和计数；当仓位与状态没有变化且保持 `SYNCED` 时，完整 Capture、资金快照、对账报告和恢复 checkpoint 最多每 15 秒保存一次。新事件、新 Signal、gap 恢复、非 `ONLINE` 或非 `SYNCED` 状态仍会立即保存完整不可变证据，因此降写入量不会降低发现频率或安全门禁。链上快速源只读、无需认证，临时不可用时降级到原 Data API 路径；确认区块重组或两条公开源身份冲突时立即 `MAJOR_DESYNC`，不能重复跟单。Activity 使用官方 `start` 时间游标分页，Trades 的满页结果必须覆盖上次已提交 cursor（且跨过同秒边界），否则 fail closed 并进入 gap recovery。相邻 offset 页出现 1 行或多行重复时，系统只记录可精确证明的最长 suffix/prefix overlap 并在 multiplicity 解析中抵消，原始 Capture 不删除；非边界重复仍须 Trades/Activity 或官方链上回执证明。普通 BUY/SELL 或 MERGE Signal 的单市场元数据获取失败只记录 `signal_enrichment_failures` warning 并在后续轮询重试，不伪造连接 gap；SPLIT 的 outcome set 会直接改变仓位投影，缺少该证据时整次轮询不提交、游标不前移，下一轮重新验证。Live Gate 前必须完成至少连续运行 8 小时、源码工作树干净、无未恢复连接 gap、无 checkpoint hash 不一致、未出现 `MAJOR_DESYNC` 且最终为 `SYNCED` 的验收。已恢复的 API 失败、链上快速源降级和短暂 `MINOR_DIFF` 会保留为 warning，系统不会自动升级运行模式。

普通目标 BUY/SELL 可进入跟单链路；REDEEM 由跟单账户按自身持仓结算。标准市场 `MERGE` 只有在官方 CLOB market token 列表精确证明完整二元 outcome set 后，才会从目标投影中扣除完整套，并按各 outcome 的目标持仓比例生成独立 `TARGET_SELL` 等价退出；Phase 0 会把该 market 证据收入 Capture Manifest，Observe 的瞬时获取失败只延后信号并重试。Phase 0 的历史 Trades/Activity 若已被官方 offset 截断，但 MERGE 的条件、金额和官方二元 token set 均完整，Replay `2.5.0` 只把缺失的旧腿补入 historical bucket 后再投影，不把它伪造成新 BUY；实时 Observe 仍必须由启动基线或启动后的成交证明两腿。各腿沿用 SELL 的盘口、滑点、Risk 和幂等规则，不需要 signer 或链上写入。若 MERGE 金额、官方 outcome set、实时已知仓位或 tracked leg 退出定价证据不足，仍写入 `UNSUPPORTED_TARGET_ACTIVITY` 并 fail closed。

特殊操作采用“受影响仓位退出或隔离，其他市场继续”的策略，不伪造目标没有给出的成交价格，也不引入 signer 或链上写入。SPLIT 只有在 Activity 金额、官方二元 outcome set 和同轮 Positions 数量完全一致时才提交；不可变 `split_projection_evidence` 同时固化市场与 Positions 原文、来源时间和各自哈希，新 outcome 腿只进入 historical bucket，不生成普通 BUY，也不消耗小额追单次数。证据缺失时本轮失败关闭且游标不前移。由 Polygon 回执和 Positions 双重验证的 negative-risk `CONVERSION` 会把转换得到的目标 destination 腿转入 historical bucket；若转换涉及启动后跟随的 source 仓位，则按目标转换前本轮 source 仓位比例生成 `TARGET_SELL` 等价退出，先调整等待 BUY，再持续退出自身真实 source 持仓。Replay 只接受上述已提交且哈希匹配的特殊操作证明；仅有历史 Activity 或市场元数据时仍标记 `INCOMPLETE`，不会用弱证据重建。系统不会因此暂停整个账户，但也不会声称已经复制 SPLIT/CONVERSION 的链上铸造或转换动作。

官方市场结束时间为空时，Paper 使用 Signal 生成时固化的有界截止时间（当前最多 30 分钟）继续尝试，避免把正常交易误判为 gap；该状态在 context 中明确记为 `UNAVAILABLE`。Live Gate 对这类 context 仍固定拒绝 `MARKET_END_TIME_UNAVAILABLE`，不会把 Paper 的容错自动扩大到真实资金。

用户已将 8 小时 Observe soak 延期到 Live Gate 前，因此短时 `SHORT_SOAK_PASSED` 允许开发 Phase 1A，但不允许据此进入 Live。`paper:run` 默认在主数据库使用 `data/operator/paper-account-id.txt` 持久化 1000 pUSD 模拟账户 ID，重启时恢复账户、待处理 execution 和 consumer checkpoint；每次 session 还会在 Observe 启动前事务化前移消费 cutoff，因此不会补停机期间的历史 Signal。自定义数据库使用数据库旁的独立 account-id 文件。传入 `--account-id=<id>` 可明确选择现有账户，只有显式传入 `--new-account` 才会新建并替换持久账户。Paper 只读取 `PUBLISHED && executionEligible=true` 的 Signal 和不可变 execution context；待成交 BUY 使用公开、无认证的 CLOB Market WebSocket 作为盘口变化唤醒信号，但每次执行判断仍重新读取完整 REST 盘口，并保留 15 秒兜底检查。WebSocket 不参与签名、下单或链上写入。

每个 Paper cycle 会先消费已到达的新 Signal，再检查止损并统一重试旧任务，避免目标已经退出时旧 BUY 抢先成交，也避免同一批仓位同时生成目标退出和止损。隔离 Live 每轮先处理确实排在任何新 BUY 之前的队首退出，再检查止损；随后按目标原始序列处理本轮完整 BUY/SELL，最后才重试更早的等待 BUY。因此新 SELL 可以先取消旧等待 BUY，同时同轮 `BUY → SELL` 不会被错误颠倒。Paper 与隔离 Live 的目标 `TARGET_SELL` 都会同时作用于现有 Position 和同一 asset/condition 的待成交 BUY：SELL 比例仍以启动后实际跟随的本轮目标仓位为分母，不追补启动前旧仓；普通 `STANDARD_TRADE` SELL 比例低于 `95%` 时按比例退出，达到或超过 `95%` 时按本轮全部退出处理，直接取消待买并释放全部 Reservation。该 `95%` 阈值不用于 `COMBO_ACTIVITY`、MERGE 或 conversion 等价退出，特殊退出继续沿用原有比例语义。部分退出按同一比例缩减待买金额，缩减后的金额不会再被 `1—5 pUSD` 最低额规则反向放大。只有完整 Signal/Risk/Gate 校验通过后才允许改变 Live 待买，所有调整都写入 Reservation、Cash 和 Audit 账本；若目标退出记录失败，调整与账本会原子回滚并安全关闭 Live Gate。若退出只抵消了尚未成交的 BUY，不会伪造 SELL 订单或成交，而是记录为已处理的 `TARGET_EXIT_APPLIED_TO_WAITING_BUY`。普通 `TARGET_SELL` 因最低量或流动性留下的 `EXIT_PENDING` 会继续保留并独立重试，但不再阻塞之后真实到达的独立 BUY；止损产生的 `STOP_EXIT_PENDING` 仍由止损重开锁拒绝本轮后续 BUY，直到目标完整退出且自身义务归零。

每笔目标 BUY 独立判断、独立 FAK，不累计、不把未成交部分带到下一笔。目标本次成交额占可见总资金低于 `1%` 时，每笔都执行 `1—5 pUSD`：比例结果不足 `1` 时抬到 `1`，市场最低可执行金额更高时精确抬升，但硬上限为 `5`；比例结果本身超过 `5` 也截到 `5`，市场最低额超过 `5` 则直接放弃。占比大于或等于 `1%` 时只按双方资金比例，不采用最低额抬升。首次实际开仓不计追单；此后低于 `1%` 的实际成交最多 `9` 次，零成交、取消和过期不计数，大于或等于 `1%` 的 BUY 不受该次数限制。目标完整退出且自身持仓、待买和在途义务归零后开始新周期并重置次数。

BUY 参考价是同一经济成交的加权平均价。最新完整 REST 盘口计算的含手续费实际成交均价必须落在目标价 `90%—105%`（含边界）且不超过 `0.95`：低于 `90%` 或高于 `0.95` 直接放弃，高于 `105%` 但不超过 `0.95` 继续等待。允许 FAK 部分成交，但当前可成交部分必须达到市场最低执行要求，剩余部分立即取消且不累计。HIGH 置信度下仍以账户总权益计算比例、可用现金只作支付上限；估值不完整时退回可用现金口径。止损一旦触发，该标的在目标本轮持仓结束前禁止重新跟 BUY；目标完整退出且自身全部义务归零后才解除。Paper 报告继续区分理论金额、申请金额和实际成交支出。

`TARGET_SELL` 若小于 CLOB 最小下单量，或成交后只剩不足执行器 `0.01` 股精度的真实尾仓，不能通过放大卖单来“凑单”，也不能因等待时间过长而取消退出义务。Paper 保存市场约束证据并保持 `EXIT_PENDING`，直到后续可成交、市场结算、REDEEM 或其他安全结算完成；相同约束状态只记录一次，避免重复写库。`STOP_LOSS` 同样保持 `STOP_EXIT_PENDING`。

监控层 Signal 和执行层状态必须保持独立；`executionEligible=false` 的 Signal 不得被 Paper 或 Live 消费。Paper 和未来 Live 使用同一份 Signal + Execution Context 输入，必须先经过 Risk Manager，再进入 Executor Interface。每条 Paper Execution 必须引用 `risk_decision_id`；系统触发的止损和结算也记录系统级 Risk Decision。账户状态统一由 Portfolio Projection 从 ledger/position/PnL 计算，Report/UI 不应自行计算余额或权益。服务端和页面后续仍只允许监听 `127.0.0.1`。

`validate:final` 必须显式指定同一个 `campaign-id` 和 `session-id`，并通过 SQLite Online Backup 把 `data/phase0/phase0.sqlite` 的一致性快照写入 `data/validation/<validation-session-id>/` 后运行；它不会把旧 Campaign、其他账户或其他目标钱包的数据混进本次结论。源库即使处于 WAL 模式也不会漏掉已提交数据，验证过程不会污染业务库。可选 `--type=paper_consistency|live_gate|paper_replay|crash_recovery|reconciliation|observe_only|all`。报告输出为 JSON 和 Markdown，最终状态最多到 `VALIDATION_FRAMEWORK_READY`；存在未运行项、警告或历史数据不足时，顶层结果明确为 `INCOMPLETE`，不会用 framework session 的 `PASSED` 冒充最终验收通过。无论结果如何，`liveAllowed` 均固定为 `false`。真实资金前仍必须实际执行累计 24 小时 Paper Validation、8 小时 Observe Only soak、Crash Recovery 长测、状态一致性验证、geoblock/compliance、小额实盘前检查，并由用户再次明确授权。

`operational:validate` 默认同样使用 SQLite Online Backup 在 `data/operational/<run-id>/` 建立一致性快照，避免污染业务库。可选 `--mode=health_monitor|consistency_monitor|observe_only|paper_validation|crash_recovery`。`consistency_monitor` 和 `crash_recovery` 只有在同时提供 `--campaign-id=PC-... --session-id=PS-...` 时才会运行账户、账本和恢复检查；缺少明确作用域时只记录 `EXPLICIT_CAMPAIGN_SCOPE_REQUIRED`，不会拿全库旧数据冒充本次结论。其中：

- `health_monitor` 只记录心跳、数据库健康和 checkpoint。
- `observe_only` 只记录 shadow risk observation，不写正式 `risk_decisions`，不进入 Paper/Live。
- `paper_validation` 使用 dedicated Paper validation account 和 fake market data，只验证执行框架，不连接真实盘口或真实交易。
- `crash_recovery` 只在 snapshot DB 中做事务回滚和恢复检查。

Operational Report 的最高默认状态是 `OPERATIONAL_FRAMEWORK_READY`，并固定 `liveAllowed=false`。它证明“长期运行验证框架已经具备”，不等于 8 小时 soak 已经完成，也不等于 Live Gate 通过。

## Live 前不可跳过的人工门禁

- 使用干净、已记录 commit 的构建，并在隔离环境重新执行全量测试和迁移演练。
- 完成 8 小时 Observe、累计 24 小时 Paper、Crash Recovery 长测与长期账本/仓位一致性验证。
- 配置专用隔离钱包和系统安全存储中的 signer/凭据；不得把私钥或 seed 写入仓库、环境示例或日志。
- 使用官方只读 geoblock、时钟、余额、订单、成交、仓位证据；Live 账户本金必须与 Gate 配置一致，风险预算不得超过配置敞口，外部现金必须与 Live ledger 在容差内一致。
- 由用户再次明确授权，再完成 `LIVE_ARMING` 和精确确认短语；程序不会自动从 Paper 升级到 Live，重启后也不会自动恢复 `LIVE_ACTIVE`。
