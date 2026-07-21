# Bugs And Risks

## Active blockers
- 修复后的新核心尚未执行自然 Paper Campaign，因此资格、连续 12 小时、累计 72 小时和最终 24 小时 Observe 均未通过。
- 最新旧核心 Campaign `PC-94D81ECAD5EF89852D2A` 已安全暂停；约 44.12 小时只保留为旧核心历史证据，修复后 replacement 必须从 0 开始。
- 自然 SELL、Partial Fill、Stop Loss、Settlement/Redeem 等稀有场景仍需长期运行或明确标注的同版本隔离证据；不能伪装成自然行情。
- Live 所需长期稳定、geoblock/compliance、隔离钱包、真实 signer 和用户再次明确授权均未完成。

## Active risks
- 当前 Live 严格禁用。首开 1 pUSD 和 0.95 价格上限已有隔离实现，但“市场最低额不超过 5 pUSD 时动态抬升”尚未在 Live 中完成最终 Risk、Live Gate、外部钱包余额/授权和预留账本的一致重验；允许任何 Live 前必须补齐并隔离验证，不能直接复用 Paper 通过结论。
- Data API 历史 offset 限制和相邻页边界重复仍可能发生；只有另一独立公开接口精确确认 multiplicity 才能核销，否则继续阻断。
- Positions 与 Trades/Activity 可能短暂不同步；同一差异连续达到阈值且持续满 120 秒仍升级 `MAJOR_DESYNC`。
- CLOB `/time` 偏移在 Session 内固定；运行中系统时钟继续漂移时，订单簿安全检查必须 fail closed。
- Settlement resolution 是公开网络依赖；持久化退避减少请求风暴，但不能保证外部接口及时恢复。
- `node:sqlite` 在 Node 24 仍有 experimental warning，长期稳定性只能由 12/72 小时自然 Campaign 证明。
- 真实数据库约 1.3GB；当前去重/压缩可控，但历史证据不可破坏性压缩，长跑后仍需观察增长率。
- 公开 HTTP 响应没有服务器数字签名；当前只能证明官方 URL、内容寻址、本地 append-only capture 与解析一致。

## Resolved in current implementation
- 高价 BUY 的 `target * 1.02` 曾可能达到/超过 `1.0` 并被错误归类为 `BUY_ORDER_CONSTRAINT_INPUT_INVALID`；现 upper 在 tick 计算前按 ruleset `0.95` 封顶，目标价和实际最佳 ask 均有明确拒绝路径，内部 invalid 也会成为验证 blocker。
- 极小比例 BUY 曾只因 pUSD/SDK/min_order_size 精度被拒绝；现保留原始比例证据，仅首开按 1 pUSD 及实际市场最低额（最多 5 pUSD）抬升，最终值重新过风控并完整补记账本。已有仓位/待处理首开不放大，完全平仓后重置。
- 预检曾在成功冻结旧核心 Campaign 后仍无条件抛出 `PAPER_CAMPAIGN_FROZEN_BEFORE_MIGRATION`，导致第一次点击生成 `UNKNOWN_UNKNOWN` 并退出、必须第二次点击才能继续；现冻结后立即只读重查并在同一次启动中返回 replacement-ready，同时保持旧证据不可变。
- Observe 未使用应用内时钟偏移，曾在本机慢约 1.7 秒时制造错误事件边界；现 Observe/Paper/Settlement 共用 MarketClock 并校验报告绑定。
- wall-clock 计算可能因系统拨时延长、缩短 12/72 小时或突发补 checkpoint；现运行时长和调度使用单调时钟。
- 停止时在途公开请求不能取消；现 AbortSignal 贯穿请求、分页和退避，取消轮询不会记失败证据。
- Crash recovery 每次抓完整历史；现按已持久化 cursor 增量恢复，并保留首页漂移安全检查。
- Settlement 在 market end 后每秒查询并重复写相同错误；现使用持久化指数退避、错误去重和恢复审计。
- 核心哈希曾漏掉 CLI 运行语义且会被注释/Live-only 变化误伤；现按去注释 AST 和明确行为边界计算。
- 隔离 proof 曾只绑定部分测试文件，无法证明精确测试套件/工具链；现绑定 48 个文件、配置、lockfile 和版本。
- 验收策略变化要么错误重置时长、要么默默沿用旧判定；现以四类身份和 append-only adjudication 精确重判。
- scoped invariant 曾重复扫描实体并对每条 transition 单独查 audit；现复用扫描并分批比对。
- Session 兼容身份数据库触发器曾允许 SQL NULL 绕过；现显式拒绝 NULL、错误长度和非小写十六进制。
- 诊断包旧 proof 校验在全量并发下接近测试超时；现先拒绝明显 source/core 不匹配，再做昂贵完整校验。
- 新增 `.test.ts` 曾可能进入 suite hash 但漏出静态隔离执行清单；现两者不完全一致时 proof 身份计算直接 fail closed。
- Observe 等待的 `Promise.race` 曾在 abort 后留下 15 秒定时器；现默认 cadence wait 会移除监听并清除 timer，安全停止不会被残留事件循环拖延。
- 同核心 `PASSED` Campaign 在 policy/suite 变化后曾既不能 replacement、也不能追加重验 Session；现只允许该精确条件以 append-only `PASSED→RUNNING` 重验，原始时长保留，旧覆盖/资格按新身份重判；同核心 `BLOCKED/FROZEN` 仍拒绝。

## Safety boundary
- 必须保持 `PAPER + LIVE_DISABLED + liveAllowed=false`。
- 未再次明确授权前，禁止 private key/seed、真实 signer、认证 CLOB client、submit/cancel、approve、真实 redeem 和链上写入。
- 禁止覆盖历史失败证据、跨核心混算时长、降低数据/时钟/恢复/账本安全门或绕过 geoblock。
