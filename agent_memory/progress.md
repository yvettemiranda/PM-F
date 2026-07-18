# Progress

## Current task
- 2026-07-18 Campaign `PC-A90AEC5B17EA925E5AF1` 的 Session `PS-F76E83CEABE73C181068` 实际运行 `43,200,002ms`，Observe 与 Paper 主流程健康，但最终 1 个持仓因 `ORDERBOOK_STALE / Orderbook age NaNms` 无法估值，Session FAILED 且累计为 0。
- 根因已由 ZIP、系统时间和 CLOB 公开时间共同确认：本机时钟约慢 2 秒，旧逻辑对任何大于 0ms 的源端未来时间立即返回 `NaN`，与既有 `clockUnsafeThresholdMs=1000` 安全规则不一致。
- 系统时间曾通过 macOS 管理员确认的 Apple NTP 临时校正至约 ±40ms，但 `timed` 后续把时间重新拨慢；修复提交后的 Apple/Cloudflare/Google NTP 均再次测得约 `+2.05s`，CLOB preflight 测得 `+1407ms` 并正确阻断。
- 修复已按 TDD 完成：订单簿允许阈值内微小偏差，超限明确记录 `ORDERBOOK_CLOCK_UNSAFE`；每次 Campaign 启动前必须用无认证 CLOB `/time` 做只读、fail-closed 检查。
- 替代策略仅接受本次精确五项 blocker 且新旧核心不同；新 Campaign 固定从累计 0 开始并记录 `CORE_REPAIR_CLOCK_SAFETY` supersedes 证据。
- 全程固定 `PAPER + LIVE_DISABLED`；未启动新 Campaign，未修改任何历史失败证据。

## Completed implementation
- 新增 Paper/未来 Live 共用的 BigInt 精确金额模块；约 `0.974709 ppm` 案例得到 `974 micros`，不会提前归零或放大。
- Execution Context、Risk Decision 保存精确比例、商、余数、舍入和不可变 sizing hash。
- 接入公开 `min_order_size`、tick 与 SDK 兼容归一化；买入低于限制事务化释放 Reservation，卖出保持对应 Pending 状态。
- 无盘口、缺失/非法约束与费用不可用继续走冻结、退避、恢复和明确日志，不伪造价格/成交。
- 报告拆分 Signal、Eligible/Gap、Capital、Risk、Order、Fill、Position、Reservation、Fee、PnL、Stop Loss、Settlement 与完整性。
- 对外诊断 ZIP 使用公开 Campaign/Session/Report ID、稳定脱敏别名、manifest 与 SHA-256；不导出内部 Observe/账户 UUID 或绝对路径。
- 新增可累计 Campaign、Session、Checkpoint、Transition、Report 和 `coreCompatibilityHash`；同一账户/基线/cursor，离线交易保持 Gap。
- 三个双击入口已部署到仓库和桌面目录。
- `REAL_SIGNAL_REPLAY` 与 `REAL_EXECUTION_REPLAY v2` 支持数据库重建校验；真实执行证据必须绑定官方公开 orderbook/fee 不可变 capture 和下单时点新鲜度。
- Campaign 报告已增加跨 Session 累计运行指标与完整 Paper funnel；被动 Crash 检查不再记为自然恢复成功。
- 新增生产共用 Crash Recovery 编排：真实进程 SIGKILL 检测、精确 cursor 绑定、checkpoint hash/sequence、WAITING BUY/Reservation 清理、Portfolio 刷新、abandoned Observe 中断、pending exit 保留及二次崩溃冻结证据复用。
- 资格短测提前安全暂停的健康时间按最终规则累计，但不能拼成资格通过；三个入口支持任意 Finder cwd，ZIP 失败会显式指向本次可见未压缩结果而非旧包。
- 官方 `/fee-rate` 显式零费率已进入 Paper/Portfolio/Replay；非零费率只接受单份完整 market-info capture，避免不可复现的混合证据。
- 盘口新鲜度改为 `receivedAt + latencyMs` 保守口径，同时保留 raw market timestamp；解决安静市场内容时间不更新导致永久冻结，也拒绝耗时超过 2 秒的慢请求。
- Market data 异常按暴露分级：无 Position/待退出/等待执行/有效 Reservation 的市场隔离为 quarantine，不再杀死整个 Session；有暴露仍是 blocker。
- 最终验收新增 `ACTIVE_RESERVATION_REMAINS`；任何未释放 Reservation 都不能通过停止/Crash 验收。
- 旧终态 Campaign 仅在核心不同且 blocker 精确属于本次市场数据缺陷时允许替换；新 Campaign 创建 transition 永久记录 supersedes、旧状态、旧 core hash 与修复原因，禁止历史混算。
- Paper Campaign 在创建 Campaign 前失败时，诊断 ZIP 会按本次 source commit 与 coreCompatibilityHash 验证隔离 proof；旧版本 proof 被排除，本次带 STAMP 的 Vitest、Phase 0、Replay 证据与日志会单独脱敏导出，UNKNOWN Campaign/Session/Report ID 不会被旧指针替代。
- 诊断脱敏覆盖 Vitest/Node 常见的 `/private/var/folders`、`/tmp`、`file:///Users` 及其他 macOS/POSIX 本地绝对路径（含 JSON 对象 key），同时保留 HTTPS URL；bundle manifest 在哈希前扫描全部文件，发现残留本机路径会 fail closed。
- 诊断 manifest 升级到 `1.1.0`，明确记录 nullable `sourceCommit`、`sourceCodeDirty` 和 `coreCompatibilityHash`；Campaign 有报告时只采用 session/campaign/run-result 的一致证据，无报告与 legacy 包才读取当前 Git/sourceVersion 和当前 core，不再用 `UNKNOWN` 或默认 false 冒充有效 provenance。
- 隔离 proof 打包校验同时绑定报告的 source commit、报告的 coreCompatibilityHash 与当前核心；任一缺失、冲突或不匹配均排除 proof，不生成互相矛盾的 manifest/证据组合。
- 两条诊断打包路径在 manifest 安全扫描失败时都会删除临时副本并返回失败，不发布 ZIP、也不保留可能含泄漏的 fallback；HTTPS URL 仅保护 origin/path，query/fragment 内明文或百分号编码的本机路径仍会被扫描和脱敏。
- 首次隔离 proof 的公开 Phase 0 改为最多 3 次独立新抓取；任一原始结果存在 ambiguous event、Replay 不稳定或 proof 校验失败都不会合并、接受或放宽，只保留逐次证据并重试，三次失败即在 Campaign 创建前阻断。
- 新增 2.22-2.24 三个 fail-closed migration：Signal/Execution Context 固化 target，Observe projection 采用内容寻址快照，Campaign Observe 精确绑定且 provenance/checkpoint append-only；历史回填不一致会在迁移前拒绝。
- Paper 消费在推进 cutoff 前验证当前实际 core、clean source、固定 Account/Target/Baseline 和 Campaign/Session RUNNING；只消费当前 Session 对应 Observe 产生的 Signal。
- 最终完整性检查按 Campaign/Session/Account/Target/Core 限定 Risk、Execution、Position、Ledger、Transition、Audit 和 orphan；旧 Campaign 或独立 Observe 不会污染当前验收。
- `coreCompatibilityHash` 拆分为实际 Paper 行为合同：纳入 canonical JSON、Paper rules、运行编排、checkpoint、crash recovery、final integrity、安全子进程和 Paper Schema contract；排除 Live-only migration 与纯展示/打包改动。
- 第一次资格运行改为最多 12 小时，2 小时只记录里程碑、不自动停止，避免“修一次、重跑一次”的人工循环。
- Observe 对账报告现持久化每个具体差异的 `firstObservedAt` 与 `consecutiveCount`；不同资产、差值或多重事件歧义不会共用连续计数。
- `reconciliationGraceMs` 已进入 Paper ruleset identity；对账实现与替换策略均进入 `coreCompatibilityHash`，旧 Campaign 不会与修复后时长混算。
- Campaign 替换白名单新增唯一的对账宽限期修复路径：仅接受旧核心、`BLOCKED` 且 blocker 精确为 `MAJOR_DESYNC:1` 与 `OBSERVE_STATUS:SHORT_SOAK_FAILED`；任何附加错误继续拒绝。
- 公开分页捕获保存 `boundaryOverlapRows` 而不删除原始行；Phase 0 与 capture Replay 使用同一重建规则，并在报告中单独输出 `reconciledPaginationOverlapRows`。
- Orderbook 源端时间不再以 1ms 的绝对未来判断误伤正常网络/时钟微差；阈值内沿用收到时间与请求延迟计算 freshness，阈值外明确冻结为 `ORDERBOOK_CLOCK_UNSAFE`。
- Paper Campaign preflight 新增 CLOB `/time` 公共只读安全门；非 `LIVE_READONLY`、请求不可用、来源错误、证据非法或绝对偏差超过 1000ms 均在 Campaign 创建前停止。
- `clockUnsafeThresholdMs`、时钟 preflight 及其公开 provider 已纳入 Paper ruleset/core identity；修复后时间不得与旧核心混算。
- 本次精确五 blocker 的终态 Campaign 可由不同核心创建审计化替代；少/多任一 blocker 均继续拒绝。

## Verification completed
- Node `24.14.0`、pnpm `11.9.0`。
- `pnpm typecheck` 通过。
- 本轮最新全量验证：47 个测试文件、539 项全部通过；`pnpm typecheck`、`git diff --check` 和全部 `.command/.sh` zsh 语法检查通过。
- `CLIENT_OFFSET_LIMIT` 回归先稳定复现 `PHASE0_VALIDATION_PROOF_INVALID`，修复后目标测试通过；直接重放用户本次第 1 次原始 Vitest/Phase 0/Replay 证据得到 `INCOMPLETE_KNOWN_LIMITATIONS`，24 个隔离测试文件、374 项测试绑定保持完整。
- 修复后 `pnpm typecheck`、47 个测试文件/539 项测试与 `git diff --check` 全部通过；`coreCompatibilityHash` 保持 `235fc5f6e57d90db6676c1f30756c8b498d41fe560d10c4844541f55b7b325c6`，未改变 Paper 行为合同。
- 对账宽限期回归先稳定复现第三次快速差异被错误判为 `MAJOR_DESYNC`；修复后宽限期内三次差异均为 `MINOR_DIFF` 并在事件补齐后 `SYNCED`，历史 major 为 0。
- 持续 120 秒的同一差异仍产生历史 `MAJOR_DESYNC`，最终即使恢复 `SYNCED` 也由验收框架永久阻断。
- 最新全量验证：47 个测试文件、541 项全部通过；`pnpm typecheck`、`git diff --check` 与全部 `.command/.sh` zsh 语法检查通过。
- Schema 保持 `2.24.0`；新 `coreCompatibilityHash=426ea848872ba228335402571e195ac7965fdbb863713ceb7fda3b13a252954e`，Paper ruleset hash 为 `4a37638adb49785e962280ed6130a26f8726d1ccd760318e8213222e3165b922`。
- 分页重叠回归先稳定复现 `INCOMPLETE + ambiguousEvents=1`；修复后目标测试、API contract、分页与隔离 proof 共 33 项通过。
- 用户本次第 1 次不可变捕获只读重放：`inputRows=16500`、`duplicateRows=3`、`confirmedDuplicateRows=1`、`reconciledPaginationOverlapRows=1`、`ambiguousEvents=0`，BUY/SELL Signal 仍为 `2011/233`。
- 最新全量验证：47 个测试文件、545 项全部通过；`pnpm typecheck`、`git diff --check` 与全部 `.command/.sh` zsh 语法检查通过。
- Schema 与 Paper ruleset hash 保持 `2.24.0` / `4a37638adb49785e962280ed6130a26f8726d1ccd760318e8213222e3165b922`；分页重叠修复后的 `coreCompatibilityHash=2c9bcf2cdcf45703fa15f71ff290a2ac07c0a904f0cea7aaeebccc87d79d6b42`。
- 干净修复提交上的真实公开 Phase 0 得到 `apiSchemaErrorCount=0`、`ambiguousEvents=0`，只剩历史 offset 与三项设计期证据限制；capture Replay 哈希与数据库保存值稳定一致。
- 锁定隔离集 24 个测试文件、379 项全部通过；正式 proof 校验器接受为 `INCOMPLETE_KNOWN_LIMITATIONS`，未把历史截断冒充完整回放。
- 当前运行库准备固定为 backup-first、连续 migration 前缀验证，并核对完整安全触发器注册表；未知未来版本、缺失历史 marker/触发器/关键表列均 fail closed。
- Phase 0 资格证据只接受完整 `PASSED`，或精确列举且相互匹配的 `INCOMPLETE_KNOWN_LIMITATIONS`；不会把 Data API 历史限制冒充完整 Replay。
- 独立启动流、运行时 Schema、报告/Replay 三路复审已关闭启动顺序、遗留进程、历史回放诚实性和 current schema 防护问题；最终无剩余 P0/P1。
- 第一次实际启动在创建 Campaign 前因 pnpm 版本不一致安全拒绝；第二次在创建 Campaign 前因旧 Phase 0 完整通过口径不可满足安全拒绝，均未创建账户、Session 或累计时长。
- 旧启动曾在 backup-first 修复前把实际库由 2.19 增量迁移至 2.21；迁移仅新增对象，但不存在迁移前备份。已保存只读事后取证快照及 manifest，明确记录该限制，不伪造回滚证据。
- 当前真实运行库只读检查：`integrity_check=ok`、0 外键问题、0 active Reservation、0 RUNNING Session，安全状态为 `PAPER + LIVE_DISABLED`。
- 真实公开接口只读冒烟通过：显式零费率市场返回 `clob-fee-rate/base_fee=0`；非零费率市场由完整 market-info 得到 `base_fee=1000`、`feeRatePpm=40000`；盘口含 `min_order_size/tick_size`。旧冻结市场 raw 内容时间约落后 21 秒，但本次公开捕获保守 age 约 659ms，证明 freshness 修复符合真实响应语义。
- 12 小时 Session `PS-7489C9EA1F667923B775` 实际运行 `43,200,002ms`，因旧核心的 `UNRECOVERED_MARKET_DATA_BLOCKER` 失败且 `countsTowardCampaign=false`；失败证据未修改。
- 诊断 ZIP 回归验证：不同 source commit、不同 coreCompatibilityHash 的旧 proof 均不打包；同版本有效 proof 正常打包；本次失败证据和 UNKNOWN 公共 ID 保持诚实。相关 4 个测试文件 20 项通过。
- 诊断路径脱敏与 manifest fail-closed 回归通过；HTTPS URL 不会被误改或误拒绝，相关诊断/打包测试 16 项通过，TypeScript 检查通过。
- Manifest provenance、UNKNOWN 启动失败包、报告版本证据及冲突/null 口径回归通过；诊断/打包测试共 17 项通过，TypeScript、zsh 语法与 diff check 通过。
- HTTPS query/fragment 路径脱敏与 scanner 回归 10 项通过；legacy/Campaign manifest 失败端到端不发布结果的 shell 回归通过；TypeScript、zsh 语法与 diff check 通过。
- 真实业务库通过只读 Online Backup 复制后演练 2.21.0→2.24.0：`integrity_check=ok`、0 外键异常、0 target/source/context 错配、0 缺失 Projection Snapshot、0 非法 Observe 绑定、0 active Reservation；安全状态仍为 `PAPER + LIVE_DISABLED`。源数据库 SHA-256 前后完全相同。
- 独立 RC 复审确认无 P0/P1 阻断；尚未验证的只有新核心实际 12 小时/72 小时自然运行。
- 时钟回归先稳定复现阈值内源端偏差被旧实现返回 `NaN`；修复后 5 个定向测试文件、95 项通过，替代 Campaign 服务层验证确认新累计与最长连续时长均为 0。
- 最新全量验证：48 个测试文件、550 项全部通过；TypeScript、全部 `.command/.sh` zsh 语法和 `git diff --check` 通过。
- Schema 保持 `2.24.0`；时钟修复后的 `coreCompatibilityHash=637191cd09eff0ddcdb8309b71226be62fdb6c08dbd13087208e6ca04cc17d08`，Paper ruleset hash 为 `96e307f8ec0b3ff6a672403dfe17d15e5095f290b6d7c85a117761ec6ddb0429`。
- 干净提交 `ec16d94c631df0ab05de92b5c97fb3b8c04ab7fb` 上的真实 preflight 未访问交易能力、未创建 Campaign；因 CLOB clock offset `+1407ms > 1000ms` 返回 `CLOCK_SAFETY_FAILED`。三方 NTP 与 `timed` 日志证明该阻断是真实系统时钟问题，不是新安全门误报。
- 用户在“日期与时间”界面关闭再开启自动设定并确认 `time.apple.com` 后，Apple/Cloudflare/Google 仍分别约 `+2.050/+2.051/+2.052s`；CLOB 10 次样本范围 `+1064..+1979ms`，说明 GUI 开关没有重置 `timed` 的错误状态。因管理员/终端自动化窗口未能可靠显示，所有悬挂命令均已取消，未修改系统或创建 Campaign。

## Next steps
1. 由用户在可见终端中执行一次管理员校时服务重置；Codex 不接触或代输电脑密码。
2. 重新用 Apple/Cloudflare/Google NTP 与 CLOB `/time` 交叉核对，并在干净提交上重跑只读 preflight；只有 offset 不超过 1000ms 才可继续。
3. preflight 通过后，用户双击桌面“1_开始或继续Paper累计验证.command”；入口将为旧失败 Campaign 创建带 supersedes 证据的新 Campaign，累计从 0 开始。
4. 建议第一次直接健康运行满 12 小时；累计 72 小时、场景覆盖与最终 Observe 全部通过前，不进入 Live 准备。
