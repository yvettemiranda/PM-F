# Bugs And Risks

## Active blockers
- Paper 跨 Core 累计 24 小时已完成，没有剩余 Paper 运行 blocker。
- 自然运行没有产生 FILL、POSITION_UPDATE、FEE 或 PnL 样本；若将来需要这些自然覆盖，必须继续 Paper 等待市场自然触发，不能为强行覆盖而放宽安全限价或风控。
- 无法证明完整 outcome set、余额或退出价格的 MERGE 继续硬阻断。
- 历史 Replay 没有本系统提交的 SPLIT/CONVERSION 完整证明时保持 `INCOMPLETE`；不能只凭 Activity 或市场元数据猜测。
- 官方市场结束时间不可得时仅允许 bounded Paper，Live 继续拒绝。
- 阶段 3 后端接口与隔离接线已完成；真实 signer、认证 CLOB 凭据、真实钱包资金证据、真实 Live UI、最终统一验收和用户再次明确授权仍不存在，任何一项都不能被 fake/isolated 测试替代。

## Active risks
- `reconciliation_issues` 是目标级长期证据；新修复只对 `POLYGON_TRADE_FEED_UNSAFE` 使用明确的 Observe Run 归属缩小阻断范围。归属缺失、JSON 损坏、同 Run 或其他类型 `MAJOR_DESYNC` 全部继续 fail closed；后续若新增可恢复事故类型，必须单独定义恢复证明，不能泛化跳过。
- Polygon 的两块确认深度仍可能遇到浅层重组或负载均衡节点链视图不一致。新恢复只覆盖“上一锚点不变 + 被重组批次未发布目标成交”；否则继续 fail closed，避免撤销或漏记已发布 Signal。
- 当前最终估值硬时限为 `30 s`。本次公共 API 故障持续数分钟，仅增加短重试无法挽救该轮；无限延长收尾又会破坏轮换时限。当前采用保留失败证据、严格限定后计入独立业主汇总并由新 Core replacement 续跑的方式。
- `caffeinate` 无法阻止 MacBook 合盖睡眠；运行期间必须保持屏幕盖打开，可以锁屏或自动黑屏。启动前合盖检查只能避免在已合盖时误启动，不能阻止启动后再次合盖。
- 深度清理已删除用户级应用缓存和日志；相关应用下次启动可能需要重新生成缓存或重新建立索引，未删除 Codex runtime 以避免破坏当前工具环境。
- SPLIT/CONVERSION 当前不是链上复制：SPLIT 新腿隔离为 historical，CONVERSION 只退出 tracked source。它能避免全账户被普通特殊操作打断，但组合收益可能偏离目标，必须独立统计发生次数、受影响金额和退出结果。
- 完整 SPLIT 证明依赖官方市场、同轮 Positions 和最终 `SYNCED` 对账；任何一个来源临时缺失都会延迟该轮提交。该取舍优先保证不凭空创建仓位。
- Live 总权益 sizing 需要对所有开放仓位完成退出深度估值；估值不完整会退回可用现金，因此实际金额可能保守偏小。
- 阶段 3 已完成运行时交接、估值恢复、合规 provider、外部订单恢复、身份绑定和 arming 审计接口；但它们只证明后端 seam 和隔离 fake 路径。`LiveRuntime`/`assembleLiveRuntime` 不创建凭据、不自动切换模式，当前仍没有真实 signer、认证 CLOB client、真实资金运行证据或获授权的生产启动入口。
- `ConfiguredComplianceProvider` 是显式配置的只读策略适配器，不是法律意见或远端权威合规服务；生产接入时仍需由用户确认适用政策来源、地域和账户资格，并保留新鲜证据。
- 同一 `orderHash` 跨 Polygon transaction 的后续 fill 按用户确认视为独立经济成交，可能比目标原始订单数更多；UI 必须标明“经济成交次数”。
- 每笔 `<1%` BUY 可能放大到 `1—5 pUSD`，虽有 9 次小额追单上限，仍需自然测试累计敞口、收益偏差和费用。
- Polygon WebSocket 只是 wake hint；`1 s` 确认块扫描、Data API `3 s` 和 Positions REST 是完整性兜底。确认深度、API offset 和短暂不同步仍可能触发 gap/reconciliation。
- 不可变 Capture、盘口与特殊操作证据会持续增加磁盘占用；仍需 Campaign 归档和磁盘增长告警。
- Observe 与 Replay 对特殊操作保留两套面向不同输出的投影编排；当前有一致性回归覆盖，但后续再改 SPLIT/CONVERSION 时应优先抽取共享纯 reducer，避免语义漂移。
- `node:sqlite` 在 Node 24 仍有 experimental warning。
- 当前 Live 仅在隔离 fake signer/order adapter 回归，不能把单元测试视为实盘就绪。

## Resolved in current implementation
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
- 未再次明确授权前，禁止 private key/seed、真实 signer、认证 CLOB client、submit/cancel、approve、真实 redeem、真实订单、真实资金和链上写入。
- 禁止覆盖历史失败证据、把用户授权的跨 Core 汇总伪称为同 Core Campaign 时长、降低数据/时钟/恢复/账本安全门或绕过 geoblock。
