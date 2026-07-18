# Bugs And Risks

## Active blockers
- 修复后核心的新 Campaign 尚未执行，因此资格里程碑、连续 12 小时和累计 72 小时自然运行都尚未通过。
- Campaign `PC-A90AEC5B17EA925E5AF1` 已因旧核心时钟/订单簿未来时间误判 BLOCKED；其 12 小时失败 Session 不计时。新核心必须创建独立且带 supersedes 审计链接的 Campaign，不能沿用旧累计。
- 即使资格通过，仍需累计有效运行 72 小时、至少一个连续 12 小时 Session，并满足最终一致性与覆盖门槛。
- 自然 SELL、Partial Fill、Stop Loss、Settlement/Redeem 等稀有场景可能需要继续运行或使用明确标注的同版本隔离证据；不能伪装成自然行情。
- 当前环境历史 geoblock 曾返回受限，CLOB clock offset 曾不安全；Live 前必须在合法环境重新验证，禁止绕过。
- private key、真实 signer、认证交易 provider、隔离钱包和用户小额实盘授权均未接入/未完成。

## Active risks
- Data API 历史 offset 限制仍可能使完整历史 Replay 不可得；不得把不完整历史冒充完整回放。
- Data API offset 分页可能把同一行同时放在相邻页首尾；只允许用相邻页原始位置加另一独立公开接口的精确 multiplicity 共同核销。若另一接口缺失、同样位于边界或数量不匹配，仍必须 `AMBIGUOUS_DUPLICATE_EVENTS`。
- `node:sqlite` 在 Node 24 仍有 experimental warning，长期稳定性需要 72 小时 Campaign 证明。
- 公开钱包依赖增量轮询，Positions 与 Trades/Activity 可能短暂不同步；120 秒内保持 `MINOR_DIFF`，同一差异达到连续次数且持续满 120 秒后仍必须 `MAJOR_DESYNC` 并 fail closed。
- 2 秒 orderbook 新鲜度提高安全性但可能降低成交率；不得为提高通过率放宽。
- 公开 HTTP 响应没有服务器数字签名；当前证据能证明内容寻址、官方 URL、不可变本地 capture 与解析一致，但不是密码学级服务器签名。
- CLOB clock 启动前检查只能证明开始时安全；运行中若系统时钟再次越过阈值，执行层仍会 fail closed 并记录 `ORDERBOOK_CLOCK_UNSAFE`，但新核心仍需自然 12/72 小时验证稳定性。

## Resolved in current implementation
- 2026-07-18 的 12 小时运行发现：本机时钟约慢 2 秒，而旧订单簿逻辑对任何大于 0ms 的未来源时间直接返回 `NaN`，造成已有持仓最终估值失败。现统一使用 `clockUnsafeThresholdMs=1000`：阈值内允许正常微差，超限明确记录 `ORDERBOOK_CLOCK_UNSAFE`；Campaign 创建前使用 CLOB 公共 `/time` 只读检查并 fail closed，本次五项 blocker 仅可由不同核心按精确白名单创建累计为 0 的替代 Campaign。
- 2026-07-17 20:42 的三次 Phase 0 均稳定出现同一 `ambiguousEvents=1`：一笔此前 7 份捕获中始终单次出现的历史 BUY，移动到 Trades offset 0/1000 边界后被相邻两页各返回一次，Activity 仍只有一行。现保留两份原始行和重复计数，仅在相邻页首尾完全相同且另一独立接口精确确认较低 multiplicity 时记录 `reconciledPaginationOverlapRows`；真实双重成交、单源证据、双源边界或非法证据继续阻断。
- 2026-07-17 的 3 小时资格运行发现：`reconciliationGraceMs=120000` 虽已配置但 Observe 未使用，连续三次约 31 秒就升级 `MAJOR_DESYNC`，且不同差异会共享连续计数。现已按具体差异持久化首次时间与连续次数，只有“同一差异连续至少 3 次且持续至少 120 秒”才升级；真实迟到事件回归、持续失步回归及替代 Campaign 审计路径均已覆盖。
- 2026-07-17 首次稳定化核心启动的三次 Phase 0 均为稳定 Replay、`ambiguousEvents=0`，但交易历史由客户端在已知官方 offset 边界主动停止时记录 `CLIENT_OFFSET_LIMIT`，proof 校验器只接受 `SOURCE_OFFSET_LIMIT`，造成 `PHASE0_VALIDATION_PROOF_INVALID`。校验器现接受这两种精确已知上限类别，未知 stop category、Schema 错误、分页错配和 Replay 不一致仍全部拒绝。
- `coreCompatibilityHash` 已只覆盖实际 Paper 行为、运行编排、恢复、安全和 Schema 合同；Live-only/纯报告/说明/打包变化不再误伤 Campaign，canonical serializer、runtime policy 与 checkpoint 等真实语义变化不会漏掉。
- Validation/Operational/Paper 最终检查已统一到当前 Campaign/Session/Account/Target/Core；Signal/Execution Context 固化 target，Paper/Risk 不再靠 raw event 推导执行身份。
- Execution→Risk、当前状态→Transition、关键动作→Audit、资金/仓位/幂等/orphan 已有确定性 scoped invariant；旧数据不能替当前 Session 制造通过。
- Observe 与 Campaign/Session 精确绑定且 provenance 不可改；Crash Recovery 只终止当前绑定 Observe，同目标 standalone Observe 保持 RUNNING 并触发保守阻断。
- 操作面已收敛为桌面三个按钮，旧 `点这里运行/` 入口删除，README 和桌面说明统一为首次最多 12 小时、2 小时只记里程碑。
- 2026-07-17 的 12 小时运行发现：官方显式零费率未被接受、慢 fee 请求会让先取回的盘口变旧、源端内容 timestamp 在盘口不变化时可能长期不更新、无暴露市场冻结会误伤整场。上述四项已修复并补真实公开接口只读验证。
- Orderbook freshness 现使用收到时间、收到后的等待时间及公开请求 latency 的保守总和；raw 源时间仅作不可变审计和未来时间异常检查。
- 无暴露市场异常降为 quarantine；存在 Position、WAITING/EXIT/STOP pending 或 active Reservation 时仍保守 blocker。
- 最终停止和 Crash Recovery 明确阻断任何 active Reservation；不能用账本“彼此一致”掩盖资金尚未释放。
- 终态 Campaign 替换白名单已收紧：必须是不同核心、包含 `UNRECOVERED_MARKET_DATA_BLOCKER`、退出码只能是 1，且新旧关系写入 append-only transition；crash/kill/未知 blocker 不能借机重开。
- 首次资格启动发现仓库冻结 pnpm `11.7.0`、当前 Codex 运行时为 `11.9.0`；入口在 Campaign 创建前安全拒绝，现已将冻结版本对齐为 `11.9.0`，未混入任何运行时长或模拟数据。
- 旧 Phase 0 校验把三个必然缺失的历史输入和 Data API offset 限制一律视为不可启动；现仅允许精确、可核验的已知不完整原因，并在全部报告中明确保留 `phase0ReplayStatus`，未知原因仍 fail closed。
- Phase 0/Replay 数据库准备改为先备份、再迁移、后校验；current schema 会核对连续 marker、关键表列、唯一索引和全部 109 个安全触发器。
- 启动器会在 Node/pnpm/依赖检查和任何数据库访问前收割指针绑定的遗留进程，避免环境失败时旧进程继续写库。
- 2026-07-16 的旧启动在 backup-first 修复前把实际库从 2.19 增量迁移至 2.21；不存在迁移前备份，不能声称可恢复。已保存事后快照 `data/operator/backups/phase0-post-migration-incident-20260716T065024Z.sqlite` 和 manifest，迁移内容经核验为新增对象、当前库完整性正常。
- 小于 1 ppm 的有效比例不再因整数 ppm 提前截断为 0。
- `min_order_size`/tick 已进入共享快照、执行前判断和不可变证据；不会自动放大金额。
- 报告不再用“BUY 未观察到”掩盖已收到但不可执行/被拒绝的 BUY。
- 外部 ZIP 不再泄露内部 Observe UUID、账户 ID 或本机绝对路径。
- Observe 首次轮询只把真正位于启动/恢复 cutoff 之前的事件标记 Gap。
- Supplemental Evidence 不能覆盖 sizing/hash/integrity 等真实错误。
- `coreCompatibilityHash` 不再因纯报告或操作说明变化机械重置累计时间。
- Market constraint evidence 冲突和快照 capture 冲突均 fail closed。
- Fake/测试域名、缺失官方原始 capture、内容/时间不匹配或下单时已过期的盘口不能成为 `REAL_EXECUTION_REPLAY`。
- Campaign 累计报告不会只显示最后一次 Session；被动一致性检查也不再虚报自然 Crash Recovery。
- Crash 清理后会重建并核对 Portfolio Projection；清理前的多个 Observe/绑定冲突等结构异常始终保留为 blocker，不能被清理动作抹掉。
- 首次资格短测安全暂停的健康时间会累计，但不会让 Campaign 提前获得 `qualified`。
- 桌面按钮不依赖 Finder 当前目录；诊断 ZIP 失败时不会误打开上一次旧包。
- Campaign 启动在新隔离 proof 写入前失败时，不再把旧 source commit/coreCompatibilityHash 的 `paper-isolated-verification.json` 放进标准 proof 清单；失败包改为保留本次 Vitest、Phase 0、Replay 和日志证据。
- 新增导出的 Vitest、Phase 0、Replay 证据中的系统临时目录和 `file://` 本地路径现会被稳定别名替换；manifest 会拒绝任何仍含已识别本机绝对路径的包，避免诊断 ZIP 泄露运行机器路径。
- Manifest 不再只写 commit 而遗漏 dirty/core；无报告时记录当前真实 dirty/core，有报告时冲突或缺失字段保守写 `null`，不会把未知来源伪装成 clean。
- 诊断包中的隔离 proof 现在必须同时匹配报告 source commit、报告 coreCompatibilityHash 与当前核心；同 commit 但报告 core 冲突/缺失时也会被排除。
- Manifest 扫描失败不再继续生成无 manifest 的 ZIP 或未压缩目录；HTTPS query/fragment 不再因整条 URL 被保护而绕过本机路径泄漏检查。
- Phase 0 分页边界偶发 ambiguous event 时不再尝试去重、归并或解释性放行；启动器最多执行 3 次全新公开抓取，只有 `ambiguousEvents=0`、Replay 稳定且 proof 校验成功才继续，否则保持 `PAPER + LIVE_DISABLED` 并在创建 Campaign 前停止。

## Safety boundary
- 必须保持 `PAPER + LIVE_DISABLED + liveAllowed=false`。
- 未再次明确授权前，禁止 private key/seed、真实 signer、认证 CLOB client、submit/cancel、approve、真实 redeem 和链上写入。
- 数据不一致、版本不一致、恢复状态不确定、Gap、Risk Reject、stale orderbook 或冻结状态一律保守阻断，不得手工改判。
