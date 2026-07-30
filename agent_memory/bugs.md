# Bugs And Risks

## Active blockers
- 本轮没有未解决的产品 blocker。已完成 `77 files / 910 tests`、TypeScript、语法、差异
  检查和 `live-production-validation-v2` 工件验证；临时端口启动、时间推进、安全退出、
  端口关闭和重启也已通过。
- 当前数据库已通过正式账户装配流程完成安全交接：空旧账户已审计停用，当前 Safe 账户为
  `ACTIVE`；没有未终态订单、reservation、执行或非零 Live 仓位。全局仍为
  `PAPER + LIVE_DISABLED`，Live executions/orders/attempts/fills 为 `0`。
- 仍有一个交付边界：尚未用真实资金取得自然 FILL、真实 PnL 或真实链上写入证据。若要
  进入真实 Live，必须在当次钱包会话中重新明确授权，并继续让地域、合规、余额、allowance、
  价格、市场和对账安全门逐项通过；测试通过本身不授予交易权限。
- 强制杀进程、宿主崩溃和网络长时不可用仍会导致 fail-closed；正常退出应使用 UI“退出”或
  桌面入口的安全停止路径，不要使用 `kill -9`。
- Paper 跨 Core 累计 24 小时已完成，没有剩余 Paper 运行 blocker。
- 自然运行没有产生 FILL、POSITION_UPDATE、FEE 或 PnL 样本；若将来需要这些自然覆盖，必须继续 Paper 等待市场自然触发，不能为强行覆盖而放宽安全限价或风控。
- 无法证明完整 outcome set、余额或退出价格的 MERGE 继续硬阻断。
- 历史 Replay 没有本系统提交的 SPLIT/CONVERSION 完整证明时保持 `INCOMPLETE`；不能只凭 Activity 或市场元数据猜测。
- 官方市场结束时间不可得时仅允许 bounded Paper，Live 继续拒绝。
- 普通浏览器 EOA signer 与其经链上验证的 Polymarket Gnosis Safe 资金地址已接到默认
  localhost host；真实 CLOB 凭据、生产 provider、Safe 仓位和官方地域结果仍须在重启后
  验收。钱包余额可以为零，不再是 Gate blocker；隔离测试仍不能替代外部事实。
- 当前运行服务仍基于上一干净提交，旧钱包 session 已连接但本轮修复尚未加载。提交、生成
  新验证 artifact 和重启后旧 session 会按版本绑定规则撤销；已保存限额、合规确认和启动
  基线仍有效，只需重新做一次钱包身份证明，不应要求用户重复保存参数。
- 前次用户授权请求曾被 `GEOBLOCK_BLOCKED:US:CA` 阻断；本轮官方端点实测又返回
  `blocked=false / KR`，说明出口地域会随实际网络路径变化。不得缓存允许结果、绕过、伪造或
  手工覆盖 provider；每次 arming/执行仍必须取得新鲜官方结果。
- 重复 Hecatonchires 标签页曾同时轮询钱包会话并可能争抢同一签名请求；现已由桌面入口
  标签页复用和 UI Web Locks 互斥解决。OKX 扩展确认不能被后台静默跳过；每个签名或交易
  仍必须在扩展弹窗中明确确认。
- UI 现在只提供日志/报告索引和结构化失败原因，不返回 `live_order_attempts.request_json/response_json` 或原始日志尾部；Live 执行、取消、重试、对账和恢复入口按后台 capability 禁用，避免把确定失败的点击呈现成可用操作。
- “Live 对账”当前不可点击是预期的安全阻断：只有验证过的钱包会话、Signer、只读余额、认证 CLOB 和已装配 LiveRuntime 全部就绪后才开放；未连接钱包时接口必须返回 `LIVE_RECONCILIATION_RUNTIME_NOT_CONFIGURED`。

## Active risks
- 桌面主入口依赖本机已有 `pnpm` 和 Node.js 20+；脚本会尝试从 pnpm 同级运行时补齐 Node PATH，若用户的系统没有 Node.js 仍会明确提示，尚未打包成自带运行时的正式 `.app`。
- 本轮旧运行产物已移出仓库至临时可恢复目录；若外部审计需要被清理的原始日志、旧 Campaign ZIP 或 pre-2.30 备份，应从该目录恢复，不能从当前项目目录推断其仍然存在。
- `reconciliation_issues` 是目标级长期证据；新修复只对 `POLYGON_TRADE_FEED_UNSAFE` 使用明确的 Observe Run 归属缩小阻断范围。归属缺失、JSON 损坏、同 Run 或其他类型 `MAJOR_DESYNC` 全部继续 fail closed；后续若新增可恢复事故类型，必须单独定义恢复证明，不能泛化跳过。
- Polygon 的两块确认深度仍可能遇到浅层重组或负载均衡节点链视图不一致。新恢复只覆盖“上一锚点不变 + 被重组批次未发布目标成交”；否则继续 fail closed，避免撤销或漏记已发布 Signal。
- 当前最终估值硬时限为 `30 s`。本次公共 API 故障持续数分钟，仅增加短重试无法挽救该轮；无限延长收尾又会破坏轮换时限。当前采用保留失败证据、严格限定后计入独立业主汇总并由新 Core replacement 续跑的方式。
- `caffeinate` 无法阻止 MacBook 合盖睡眠；运行期间必须保持屏幕盖打开，可以锁屏或自动黑屏。启动前合盖检查只能避免在已合盖时误启动，不能阻止启动后再次合盖。
- 深度清理已删除用户级应用缓存和日志；相关应用下次启动可能需要重新生成缓存或重新建立索引，未删除 Codex runtime 以避免破坏当前工具环境。
- SPLIT/CONVERSION 当前不是链上复制：SPLIT 新腿隔离为 historical，CONVERSION 只退出 tracked source。它能避免全账户被普通特殊操作打断，但组合收益可能偏离目标，必须独立统计发生次数、受影响金额和退出结果。
- 完整 SPLIT 证明依赖官方市场、同轮 Positions 和最终 `SYNCED` 对账；任何一个来源临时缺失都会延迟该轮提交。该取舍优先保证不凭空创建仓位。
- Live 总权益 sizing 需要对所有开放仓位完成退出深度估值；估值不完整会退回可用现金，因此实际金额可能保守偏小。
- 默认 production assembly 现在会在验证过的 EOA session 后创建 browser signer、惰性
  authenticated CLOB、真实 provider/adapter、production account、Gate 和 runtime；
  `LiveRuntime` 仍不自行 arming，当前没有真实资金运行证据或已发生的最终授权。
- `ConfiguredComplianceProvider` 是显式配置的只读策略适配器，不是法律意见或远端权威合规服务；生产接入时仍需由用户确认适用政策来源、地域和账户资格，并保留新鲜证据。
- Live readiness 的“可就绪”状态依赖宿主显式提供每项 provider capability override；仅保存公开钱包地址不会伪称钱包已连接，也不会让 Gate 自动通过。生产接入时必须把这些 override 与真实只读 provider、Signer 和认证 CLOB 的新鲜证据绑定，不能由浏览器或配置文件自行勾选。
- 同一 `orderHash` 跨 Polygon transaction 的后续 fill 按用户确认视为独立经济成交，可能比目标原始订单数更多；UI 必须标明“经济成交次数”。
- 每笔 `<1%` BUY 可能放大到 `1—5 pUSD`，虽有 9 次小额追单上限，仍需自然测试累计敞口、收益偏差和费用。
- Polygon WebSocket 只是 wake hint；`1 s` 确认块扫描、Data API `3 s` 和 Positions REST 是完整性兜底。确认深度、API offset 和短暂不同步仍可能触发 gap/reconciliation。
- 不可变 Capture、盘口与特殊操作证据会持续增加磁盘占用；仍需 Campaign 归档和磁盘增长告警。
- Observe 与 Replay 对特殊操作保留两套面向不同输出的投影编排；当前有一致性回归覆盖，但后续再改 SPLIT/CONVERSION 时应优先抽取共享纯 reducer，避免语义漂移。
- `node:sqlite` 在 Node 24 仍有 experimental warning。
- browser signer、authenticated CLOB、readonly provider、真实 CLOB adapter 和 EOA
  链上交易构造均只做了隔离测试；不能把单元测试视为真实钱包/真实资金验收。
- Live crash recovery 会在 SQLite 的 `live_orders.signed_payload_json` 持久化精确
  signed order intent；该字段不进入 UI、快照、普通日志或审计包。runtime database
  和新备份已强制 `0600`，Operator UI 使用 `umask 077`，但生产仍必须使用全盘
  加密、受控系统账户和备份保留/访问控制。
- 已有 Polymarket Gnosis Safe 由 EOA owner 通过 `POLY_GNOSIS_SAFE` 签名类型使用；
  UI 不再把资金地址误写回 EOA。Safe allowance 不足会延后到具体订单，不阻断 Live
  准备；需要链上授权的订单仍必须由浏览器钱包明确确认。
- 钱包会话已经作为短期运行时租约绑定到 Live action：断开、过期或替换会话会撤销 action 并触发 emergency stop；这能防止 UI 地址与已装配 runtime 漂移，但生产宿主仍必须把真实 provider、signer、CLOB 和 Gate 授权绑定到同一会话，不能只依赖浏览器端地址。
- 旧钱包会话与新源码/验证工件版本不一致时，预检可能抛出 `LIVE_PRODUCTION_VALIDATION_ARTIFACT_INVALID`；现在该版本失配会自动安全断开会话、取消待签名请求并返回 `LIVE_RUNTIME_STALE_RECONNECT_REQUIRED`，要求重新连接，不再暴露 500 内部错误。源码或验证工件更新后必须重启 localhost 服务并重新签名。
- 连接后的宿主 factory 只能通过服务端会话绑定 wrapper 暴露 action；钱包 provider 还必须自报并被装配入口核对 Polygon chainId。会话到期由后台定时器主动失效；紧急停用失败会重试一次并让断开接口返回 503，但若外部停机服务持续不可用，必须继续保持 Gate 禁用并人工处理。
- Animal Island UI 参考仓库为 CC BY-NC 4.0 且限制商业使用；当前原型只做独立 CSS 视觉借鉴，没有复制其代码/资源。若未来把该方向落到商业产品，必须重新设计或完成明确许可审查。

## Resolved in current implementation
- 2026-07-29：桌面入口不再后台启动 pnpm 包装进程后只保存其 PID。它现在直接启动并持有
  Node UI 服务，关闭终端时发送 `SIGTERM` 并等待 `shutdownSafety()` 最多 `10 s`，确保
  Gate 和 runtime 安全停止；真实退出测试中发现的残留 `LIVE_ACTIVE` 已通过正式紧急停用
  接口恢复，未创建订单。
- 2026-07-29：Operator `liveAllowed` 不再是历史常量 `false`；它现在严格投影数据库 Gate，
  仅 `execution_mode=LIVE` 且 `live_gate_state=LIVE_ACTIVE` 时为 `true`，避免 UI 在真实
  激活后仍显示互相矛盾的状态。
- 2026-07-29：生产钱包不再被要求空仓。只有全新 Live 账户可首次捕获外部 outcome token
  为不可变基线；基线不写入 `live_positions`，不会被本系统卖出或计入风险敞口。对账继续
  精确比较外部实际值与“基线 + 本系统仓位”，外部手工漂移仍 fail closed。
- 2026-07-29：余额为零的钱包准备不再调用缺少 `token_id` 的 CONDITIONAL allowance
  API。它会直接返回 `LIVE_WALLET_SETUP_DEFERRED_NO_COLLATERAL`，不发送授权交易并允许
  一键流程继续；未来具体订单仍执行余额和 token-specific allowance 检查。
- 2026-07-29：一键 Live 不再先确认 Gate 后运行 startup recovery。恢复和 runner 在
  `LIVE_ARMING` 下完成，runner 复用已经通过的 execution recovery，避免二次恢复把 Gate
  降级；最后确认才进入 `LIVE_ACTIVE`。确认失败会先停止空闲 runner，再 emergency-disable。
- 2026-07-29：官方 CLOB time 实测五次全部 HTTP 200，但当前网络响应耗时
  `2.3–8.2 s`；旧默认 `2 s` RTT 门槛导致 `CLOCK_RTT_UNSAFE`。默认 RTT 预算现与
  `10 s` 请求超时一致，仍保留最多两次请求、超时/HTTP/payload 失败关闭，以及调用方显式
  更严格 RTT 上限的能力。
- 2026-07-29 一键 Live 稳定性修复：活跃 localhost 心跳会滑动续期钱包租约；PAPER→LIVE
  后台按 Gate→Live 对账→钱包 readiness→新鲜 Gate→arming 启动恢复和空闲 runtime→最终
  确认执行，任何阶段失败自动回滚 `PAPER + LIVE_DISABLED`。UI 只需一次模式二次确认，
  不再重复输入确认词或手动依次点击 Gate/对账；手动操作保留在高级诊断。
- 2026-07-29 第二轮稳定性修复：3 秒轮询不再因纯时间变化整体替换 DOM；钱包流程、
  输入、弹窗和操作期间延后重绘；顶部改用最新后台快照时间并能显示连接异常。服务实例
  变化自动 reload，真实 Chrome 的时间推进、稳定 node 和重启换页均通过。
- 钱包发现不再在先看到 MetaMask 等非 OKX provider 时过早返回；现在持久接收 EIP-6963、
  优先 OKX/OKEX，并兼容 `window.okxwallet(.ethereum)`。连接后监听 accounts/chain/
  disconnect，漂移时安全撤销后台会话。
- Gate prerequisite 的数据库原始状态继续保留，但 UI 依据当前服务源码生成
  `effectiveStatus`；证据 commit 不匹配或服务源码 dirty 时显示 `STALE`。生产能力 badge
  明确显示“就绪/待完成”，不再只靠颜色或把历史 `PASSED` 当成当前通过。
- 三轮 Phase0/Replay 证据打包测试在全套并发下稳定略超默认 `5 s`，但独立执行可通过，属于测试时限而非产物错误；该重型用例现在使用与相邻打包测试一致的 `15 s` 显式时限，生产逻辑未变。
- 2026-07-29：钱包连接只使用 `window.ethereum` 时，OKX 延迟注入或多扩展并存会出现“扩展弹窗完成但页面未连接”。新增 EIP-6963 discovery，优先 OKX/OKEX，兼容 `ethereum.providers` 和传统注入；服务重启后的 disconnected 状态也改成明确的“需重新签名”提示。新增 3 个回归用例，未改变 `PAPER + LIVE_DISABLED + liveAllowed=false`。
- OKX personal-sign 已验证后，默认 LiveRuntime 因源码未清洁抛出
  `LIVE_PRODUCTION_SOURCE_DIRTY`，旧路由会把刚建立的钱包会话一并回滚，造成“弹窗成功但
  页面仍未连接”。现在仅对这个明确的装配前置条件失败保留 `CONNECTED` 会话并返回待装配
  状态；身份、网络或签名失败仍 fail closed。用户需在服务重启后重新连接一次。
- UI 早期仅通过 `refresh-render` 禁止动画重播，但仍每 3 秒替换整页 DOM，按钮和钱包
  异步流程仍会失效；现已升级为 snapshot render key，纯时间刷新只原位更新顶部状态，
  不再替换节点。
- Finder 双击 `.command` 时没有加载用户 PATH，旧入口在 `command -v pnpm` 处直接退出，
  表现为终端一闪而过且浏览器不打开。`launch-hecatonchires-ui.command` 现在会探测
  用户级 pnpm、Homebrew pnpm 和 Codex bundled pnpm，再沿用同一 Node PATH 推导；在
  精简 PATH 下的实际 wrapper 回归已通过。
- 8 小时 Observe 临时托管使用 `launchctl submit` 时被系统推断为 KeepAlive，导致第一、
  第二轮自然完成后自动重启。第二轮完成后已按用户要求保留两轮通过报告，移除并禁用
  精确 job；短暂第三轮以 `ABORTED` 保留原始数据库证据，未删除或改写历史运行记录。
  后续一次性 Observe 不得再依赖该隐式 KeepAlive 方式。
- 用户授权的独立跨 Core Paper 汇总已达到 `86,400,012 ms`；最终连续 4 小时运行完整、安全，原始数据库与各 Campaign 的内建计时未改写。
- 上一 Observe Run 的全局 `POLYGON_TRADE_FEED_UNSAFE` 曾永久阻断后续新 Run 的所有标的，造成两个正常 BUY Signal 在 Paper 中被误拒；现在事故只阻断其所属 Run，历史记录不删除，同 Run 和不可证明归属仍拒绝。
- Polygon confirmed cursor 哈希变化曾无条件终止 Observe，即使该批次没有目标成交、上一锚点未变且可安全重扫；现在会二次核验并仅在可证明无经济事件冲突时回退重扫。
- 新 Core 第 2 轮收尾失败没有造成风险边界突破：失败 Session 未计时，3 个 Paper 持仓保守冻结，数据库一致性正常，Live 执行与链上写入均为 `0`；公共只读 API 随后恢复。
- Paper Campaign 曾能在 MacBook 已合盖的 DarkWake 中启动，造成调度空窗、Gap 和最终阻断；当前启动前读取 `AppleClamshellState`，合盖时以 `MACBOOK_LID_CLOSED` fail closed。
- 首次新核心隔离套件曾因两个真实打包集成用例共用默认 `5 s` 时限、在全套并发和冷缓存下出现单例超时；现在仅对这两个重型用例声明 `15 s`，生产打包与安全判断不变，全套 `769/769` 通过。
- Paper child 失败 JSON 曾被 supervisor 当成正常报告，导致原始错误被二次异常和 pointer `EPERM` 覆盖；现在显式分流失败 payload、保留失败原因并在 core 变更前先处理遗留 Session。
- Live 比例 BUY 曾以 available cash 作为资金比例基数，持仓后会系统性低估后续跟单；现在完整估值用 total equity，available cash 只作支付 cap。
- Live runner 曾先重试旧 waiting BUY，再消费新目标 SELL；现在新退出先处理，完整新 Signal 序列成功后才允许旧 BUY 重试，异常时跳过该轮 BUY。
- Campaign crash recovery 曾把持久化 Polygon `OrderFilled` 当 Activity 解码；现在正常恢复与 crash recovery 共用 source-aware decoder。
- Core hash 曾漏掉共享 `target-sell-policy.ts`，修改 SELL 规则可能不重置验证时长；当前执行/验证清单均包含该文件。
- SPLIT 曾直接触发 unsupported/major desync；当前完整证据可稳定投影到 historical bucket，弱证据仍失败关闭。
- tracked negative-risk CONVERSION 曾形成不可执行 `TARGET_CONVERSION` 并暂停账户；当前完整证据生成 source `TARGET_SELL` 等价退出，destination 隔离为 historical。旧不可执行 Signal 仍由兼容安全检查阻断。
- Replay 曾用弱于 Observe 的 SPLIT 证据并固定拒绝所有 CONVERSION；当前只有完整持久化证明才允许同语义回放。
- 普通 `TARGET_SELL` 尾仓 `EXIT_PENDING` 曾阻塞后续独立 BUY；当前普通退出与后续 BUY 独立，止损重开锁不变。
- 普通 `STANDARD_TRADE` SELL 达到 `95%` 后曾留下跟单义务；当前按本轮完整退出，MERGE/CONVERSION 不套用该阈值。
- 跨 Core 交接曾受 `paper_validation_campaigns.paper_account_id UNIQUE` 限制且新 Core 会丢失旧 Paper 持仓；现在迁移 `036` 移除该限制，复用同一账户/baseline，校验无 pending BUY/active reservation/账本不一致，并更新当前账户元数据而不改写历史仓位 ruleset。
- 公共 API 短暂故障曾让 final drain/估值一次超时即终止；现在 Paper/Live 只读估值和 Paper final drain 有界重试，无法恢复时保留不完整状态和原始证据，后续可恢复而不伪称结算完成。
- Paper/Live 估值不完整时的新 BUY 现在分别延后且不消费，避免在旧仓位冻结或估值缺失时错误放大风险。

## Safety boundary
- 必须保持 `PAPER + LIVE_DISABLED + liveAllowed=false`。
- 允许在 localhost UI 连接浏览器钱包并执行仅用于公开地址控制权证明的
  `personal_sign`；禁止加载 private key/seed，禁止未经用户逐步确认的 CLOB credential、
  submit/cancel、approve、redeem、真实订单、真实资金和链上写入。
- 禁止覆盖历史失败证据、把用户授权的跨 Core 汇总伪称为同 Core Campaign 时长、降低数据/时钟/恢复/账本安全门或绕过 geoblock。
