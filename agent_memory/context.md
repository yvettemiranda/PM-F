# Context

## Project
- 唯一有效仓库：`/Users/d4clt/Documents/Codex/2026-07-07/ni-k`。
- ni-k 是独立 Polymarket Copy Trading System，不复用旧版 PolymarketBot 的代码、数据库、账本或交易逻辑。
- 当前唯一目标钱包：`0x0c0e270cf879583d6a0142fc817e05b768d0434e`，只访问公开数据。

## Architecture
- Observe：公开 Trades/Activity/Positions 增量抓取、Gap/Cursor、Activity confirmation、Position projection、对账与 checkpoint。
- Paper：不可变 Signal/Execution Context、精确比例金额、Risk、完整深度 VWAP/FAK、Reservation、Execution/Position/Ledger、Fee/PnL、Settlement 与恢复。
- Validation：固定账户/目标/基线/核心的 Campaign，累计 72 小时、至少一次连续 12 小时、资格里程碑、场景覆盖、不可变 checkpoint/report/transition。
- Live：只有显式 fail-closed 架构和 Fake 测试；没有真实 signer、认证交易客户端或资金操作。

## Safety boundary
- 固定：`execution_mode=PAPER`、`live_gate_state=LIVE_DISABLED`、`liveAllowed=false`。
- 禁止 private key/seed、真实 signer、认证 CLOB submit/cancel、approve、真实 redeem 或链上写入。
- 禁止绕过 geoblock、时钟、安全门或修改历史失败证据。
- Gap Signal 固定不可执行；数据、版本、恢复或账本状态不确定时必须 fail closed。

## Current implementation baseline
- 待提交代码 Schema 为 `2.25.0`；真实业务库仍安全停留在 `2.24.0`，只在下一次正式启动时 backup-first 升级。
- 所有 Paper/Observe 市场时间判断共用 Session 固定的 CLOB `/time` 5 样本中位数偏移；不修改 macOS 时间。
- Session 时长、12/72 小时截止和 checkpoint 使用单调时钟；报告仍保留可审计 UTC 时间。
- Observe 使用固定频率调度，AbortSignal 贯穿公开请求、分页和退避；恢复只抓 cursor 之后的增量历史。
- Settlement 对未决/错误结果使用数据库持久化指数退避，避免每秒重复请求和重复不可变审计。
- `coreCompatibilityHash` 覆盖实际 Paper/Observe/恢复/计时/安全/Schema 语义，TypeScript 按去注释 AST 规范化；Live-only 和注释变化不重置 Campaign。
- 非核心变化分别绑定 `validationPolicyHash`、`verificationSuiteHash`、`operatorBuildHash`、`artifactProvenanceHash`，并以 append-only adjudication 说明旧证据如何继承。
- 任何终态 Campaign 只有在核心不同才可创建 replacement；同核心终态继续 fail closed。不同核心绝不混算累计时长。
- scoped invariants 复用实体扫描并批量核对 transition audit；历史数据库不做破坏性压缩或覆盖。

## Current runtime and Campaign
- 2026-07-18 最新 Campaign：`PC-088B9A92605F05B2677A`，Session：`PS-9359096BA625BA2AC206`。
- 用户安全暂停后：Campaign `PAUSED`、Session `COMPLETED`，stop reason 为 `USER_SAFE_PAUSE_SIGTERM`。
- 本次有效历史运行 `1,955,053ms`（约 0.54 小时），无 blocker，但不足资格和 12 小时；只作为旧核心历史证据保留。
- 优化后的核心必须新建 replacement Campaign，从 0 累计，不得继承这 0.54 小时。
- 当前无 Paper、Observe 或 Campaign supervisor 进程。

## Operator workflow
- 用户使用桌面 `/Users/d4clt/Desktop/Polymarket验证_点这里` 三个入口：开始/继续、安全暂停、查看结果。
- 下一次正式启动会先做环境/隔离 proof/Phase 0/时钟检查，再 backup-first 升级数据库并创建新核心 Campaign；任一异常在 Session 前停止。
- 建议新 Campaign 第一次连续运行满 12 小时；累计 72 小时、场景覆盖和最终 24 小时 Observe 完成前绝不进入 Live。
