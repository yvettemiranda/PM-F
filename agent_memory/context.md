# Context

## Project
- 唯一有效仓库：`/Users/d4clt/Documents/Codex/2026-07-07/ni-k`。
- ni-k 是独立 Polymarket Copy Trading System，不复用旧版 PolymarketBot 的代码、数据库、账本或交易逻辑。
- 当前唯一目标钱包：`0x0c0e270cf879583d6a0142fc817e05b768d0434e`，只访问公开数据。

## Architecture
- Observe：公开 Trades/Activity/Positions 增量抓取、Gap/Cursor、Activity confirmation、Polygon 回执验证、负风险 conversion、Position projection、对账与 checkpoint。
- Paper：不可变 Signal/Execution Context、精确比例金额、Risk、完整深度 VWAP/FAK、Reservation、Execution/Position/Ledger、Fee/PnL、Settlement 与恢复。
- Validation：固定账户/目标/基线/核心的 Campaign，累计 24 小时、至少一次连续 4 小时、40 分钟资格里程碑、场景覆盖、不可变 checkpoint/report/transition；最终同版本 Observe 为 8 小时。
- Live：只有显式 fail-closed 架构和 Fake 测试；没有真实 signer、认证交易客户端或资金操作。

## Safety boundary
- 固定：`execution_mode=PAPER`、`live_gate_state=LIVE_DISABLED`、`liveAllowed=false`。
- 禁止 private key/seed、真实 signer、认证 CLOB submit/cancel、approve、真实 redeem 或链上写入。
- 禁止绕过 geoblock、时钟、安全门或修改历史失败证据。
- Gap Signal 固定不可执行；数据、版本、恢复或账本状态不确定时必须 fail closed。

## Current implementation baseline
- 当前代码 Schema 为 `2.27.0`、Signal `1.6.0`；Strategy `2.2.0`、Risk `1.6.0`、Paper `1.6.0`、Live `1.6.0`、Validation `1.3.0`、Operational `1.3.0`、Ruleset `v1.5.0`、Config `v1.3.0`。
- 负风险 `CONVERSION` 必须由 Activity、Polygon 成功回执/NegRiskAdapter 日志和 Positions 元数据三方证明；证据 append-only 保存并进入 projection/checkpoint 恢复。
- historical-only conversion 只重分 bucket；tracked conversion 当前生成不可执行审计义务并硬阻断，绝不静默跳过或误当 SELL。
- 所有 Paper/Observe 市场时间判断共用 Session 固定的 CLOB `/time` 5 样本中位数偏移；不修改 macOS 时间。
- Session 时长、4/24 小时截止和 checkpoint 使用单调时钟；报告仍保留可审计 UTC 时间。
- Observe 使用固定频率调度，AbortSignal 贯穿公开请求、分页和退避；恢复只抓 cursor 之后的增量历史。
- Settlement 对未决/错误结果使用数据库持久化指数退避，避免每秒重复请求和重复不可变审计。
- `coreCompatibilityHash` 覆盖实际 Paper/Observe/恢复/计时/安全/Schema 语义，TypeScript 按去注释 AST 规范化；Live-only 和注释变化不重置 Campaign。
- 非核心变化分别绑定 `validationPolicyHash`、`verificationSuiteHash`、`operatorBuildHash`、`artifactProvenanceHash`，并以 append-only adjudication 说明旧证据如何继承。
- 任何终态 Campaign 只有在核心不同才可创建 replacement；同核心终态继续 fail closed。不同核心绝不混算累计时长。
- 唯一例外是已 `PASSED` Campaign 的 validation policy 或 verification suite 身份发生变化：保留原始运行时长，以 append-only transition/adjudication 重新打开资格或证据验证；同核心 `BLOCKED/FROZEN` 仍不可重开。
- scoped invariants 复用实体扫描并批量核对 transition audit；历史数据库不做破坏性压缩或覆盖。

## Current runtime and Campaign
- Campaign `PC-0969675B1A77CA978A5B` 已 `BLOCKED`；Session `PS-6FA97901118724B49713` 因旧 projector 无法处理 historical negative-risk conversion 而 `FAILED/RUNTIME_CONSISTENCY_UNSAFE`，该 Session 不计时且证据只读保留。
- 旧 Campaign `PC-94D81ECAD5EF89852D2A` 仍为 `FROZEN`；所有旧核心运行时间均不得计入本轮 `2.27.0` replacement Campaign。
- 真实业务库仍为 Schema `2.26.0`，待代码提交后经 backup-first 入口迁移到 `2.27.0`。
- `PAPER + LIVE_DISABLED`，active Reservation 为 0，当前无 Paper、Observe 或 Campaign supervisor 进程。

## Confirmed BUY policy for next core
- 规则值进入不可变 ruleset snapshot，不写成分散魔法数；当前默认：首开最低 `1 pUSD`、市场最低额自动抬升上限 `5 pUSD`、BUY 最高价格 `0.95`。
- 目标 BUY 价格或实际可成交价格高于 `0.95` 时跳过；订单上限为 `min(target * 1.02, 0.95)`。SELL、止损、结算不受该上限影响。
- 比例金额足够时按原值执行；不足时只允许“该资产当前无仓位”的首开抬到 `1 pUSD`，若市场最低额更高可精确抬升但不得超过 `5 pUSD`。已有仓位时不补足、不累计、不追单；完全平仓后下一次 BUY 可重新视为首开。
- 风控、现金预留和审计必须使用最终实际金额；任何 `BUY_ORDER_CONSTRAINT_INPUT_INVALID` 必须成为验证 blocker。
- Paper 与未来 Live 必须使用同一策略结果；Live 若因订单簿最低额改变最终金额，必须在任何签名/提交前重新完成 Risk、钱包余额/授权、Reservation 和 Live Gate 绑定，不能沿用抬升前批准。
- Live 重试/重启必须从数据库恢复完整 Signal、Execution Context、Capital Decision 和最终 Risk，不得重复抬升、重复预留或退回抬升前金额。

## Operator workflow
- 用户使用桌面 `/Users/d4clt/Desktop/Polymarket验证_点这里` 三个入口：开始/继续、安全暂停、查看结果。
- 已修复预检冻结旧核心后无条件退出的问题；现在同一次启动会冻结旧证据、只读重查并继续 replacement，不需要再靠第二次点击完成状态过渡。
- 上述 BUY 策略的 Paper 与隔离 Live 实现、重启恢复和全量测试均已完成；conversion 投影修复形成新核心，旧 Campaign 不能继续。
- 下一次安全启动必须先迁移数据库，再创建 replacement Campaign 并从 0 验证；旧核心时长不混算。
- 40 分钟资格、连续 4 小时、累计 24 小时、场景覆盖和最终 8 小时 Observe 完成前绝不进入 Live。
