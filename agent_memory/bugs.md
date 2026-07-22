# Bugs And Risks

## Active blockers
- 当前 Campaign `PC-0969675B1A77CA978A5B` 已因旧 projector 的负风险转换缺陷 `BLOCKED`；不可修补、重开或计入新核心，只能创建 replacement Campaign。
- 新核心仍需从 0 完成 40 分钟资格、连续 4 小时、累计 24 小时、自然关键场景及最终 8 小时 Observe。
- 新目标高频使用 `MERGE`，而现有 Observe 只记录 MERGE、不更新 projection、不生成跟单义务；普通 Trades 也未覆盖最近抽样 MERGE。Paper 长测可能因 Position diff 进入 `MAJOR_DESYNC`，小额 Live 前必须补齐语义或明确立即 fail-closed。
- tracked negative-risk conversion 的真实执行能力尚未实现：当前会生成不可执行义务并硬阻断 Campaign。没有受控 Paper/Fake 执行语义和未来明确授权的链上适配器前，不可宣称 Live-ready。
- Live 所需 geoblock/compliance、隔离钱包、真实 signer 和用户再次明确授权均未完成。

## Active risks
- Data API `CONVERSION` Activity 可能省略 `eventSlug`、asset、title 等字段；只能在 Polygon 成功回执、NegRiskAdapter 事件和目标 Positions 元数据完全一致时接受。
- 目标若在长 Gap 内连续发生 conversion 与后续卖出，当前 Positions 可能已不再包含全部目标资产元数据；系统会失败关闭，不能猜测或追补。
- Positions 与 Trades/Activity 可能短暂不同步；同一差异连续达到阈值且持续满 120 秒仍升级 `MAJOR_DESYNC`。
- Data API 历史 offset 限制和相邻页边界重复仍可能发生；没有独立公开证据精确确认时继续阻断。
- CLOB `/time` 偏移在 Session 内固定；系统时钟继续漂移时订单簿检查必须失败关闭。
- `node:sqlite` 在 Node 24 仍有 experimental warning；长期稳定性仍需新核心自然 Campaign 验证。
- 真实数据库较大；转换回执使用压缩、内容寻址和 append-only 保存，但仍需观察长跑增长率。
- `data` 当前约 6.9 GB，其中 `data/operator/backups` 约 3.6 GB（3 份数据库备份）。数据库 Campaign/Session/capture 记录有外键和审计价值，不应删除；如需腾空间，应另行确认保留最新 `2.27.0` 前备份后，把更旧备份做可恢复归档，而不是直接清库。
- 公开 HTTP/RPC 响应没有服务器数字签名；目前能证明的是官方 URL、链上回执内容、本地内容寻址和不可变证据的一致性。

## Resolved in current implementation
- 目标切换曾只替换固定地址但 preflight/runner/status 仍选择全库 Campaign，可能误续跑或冻结旧钱包；现所有入口按目标钱包/target 隔离。
- 隔离 proof 和 supplemental Replay evidence 曾可能跨钱包复用；现 Phase 0 proof 绑定 `targetWallet`，Replay evidence 只计入当前目标 signal binding。
- Observe 曾把 `CONVERSION` 只作为 combo Activity 记录并直接跳过 projection，导致源资产残留、目标资产缺失和 `MAJOR_DESYNC`；现用链上 ERC-1155 净额、Adapter 事件与 Positions 三方验证后重分 bucket。
- 简单匹配单条 TransferBatch 会被 NegRiskAdapter 的内部中转腿误导；现按目标钱包汇总整笔回执的所有 CTF TransferBatch 净变化。
- Data API 真实 `CONVERSION.eventSlug` 为空；现只在 Activity 有值时核对，否则由全部目标 Positions 的一致事件归属推导。
- 转换证据曾无持久化与重启语义；现 capture/legs/hash append-only 保存并进入 checkpoint replay，重启不重复 RPC。
- historical-only 转换不会误发交易；mixed/tracked 转换不会静默标记成功，而会生成明确不可执行义务并在 Gate/Integrity 硬阻断。
- Adapter 转换证明现精确绑定目标钱包 stakeholder 且必须唯一；0 条、重复或歧义证明均失败关闭。
- 普通 reconciliation 的数量容差不再用于签发 conversion verified evidence；转换涉及资产按 micros 零容差对账。
- tracked conversion 不再只等到验收时阻断；Paper/Live 在候选选择前和逐笔执行前复核，Paper 立即暂停/冻结，Live 立即 emergency stop，竞态窗口已有注入测试。
- 真实业务库已 backup-first 升到 `2.27.0`，历史终态、`PAPER + LIVE_DISABLED`、0 active Reservation 和 0 running Observe 均只读复核通过。
- 回执或 provider 异常曾可能只能表现为后续通用对账差异；现 Poll 在写入前以具体错误失败关闭，不留下半成品。
- 首开最低 1 pUSD、市场最低额最多 5 pUSD、BUY 最高价 0.95、最终 Risk/Reservation/Gate 绑定和 Live Fake 恢复语义已完成，旧核心证据只读保留。
- Observe/Paper/Settlement 共用应用内 MarketClock；运行时长和调度使用单调时钟；AbortSignal 贯穿公开请求、分页和退避。
- 核心哈希覆盖实际 Paper/Observe/恢复/Schema 语义，测试文件清单与 suite hash 不一致时直接失败关闭。

## Safety boundary
- 必须保持 `PAPER + LIVE_DISABLED + liveAllowed=false`。
- 未再次明确授权前，禁止 private key/seed、真实 signer、认证 CLOB client、submit/cancel、approve、真实 redeem 和链上写入。
- 禁止覆盖历史失败证据、跨核心混算时长、降低数据/时钟/恢复/账本安全门或绕过 geoblock。
