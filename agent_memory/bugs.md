# Bugs And Risks

## Active blockers
- 新 Core 尚未开始自然 Paper；累计 `24 h`、连续 `4 h`、`API_RECOVERY` 与特殊操作自然样本未覆盖。
- 无法证明完整 outcome set、余额或退出价格的 MERGE 继续硬阻断。
- 历史 Replay 没有本系统提交的 SPLIT/CONVERSION 完整证明时保持 `INCOMPLETE`；不能只凭 Activity 或市场元数据猜测。
- 官方市场结束时间不可得时仅允许 bounded Paper，Live 继续拒绝。
- geoblock/compliance、隔离钱包、真实 signer、Live runtime 接线、Live arming 和用户再次明确授权均未完成。

## Active risks
- SPLIT/CONVERSION 当前不是链上复制：SPLIT 新腿隔离为 historical，CONVERSION 只退出 tracked source。它能避免全账户被普通特殊操作打断，但组合收益可能偏离目标，必须独立统计发生次数、受影响金额和退出结果。
- 完整 SPLIT 证明依赖官方市场、同轮 Positions 和最终 `SYNCED` 对账；任何一个来源临时缺失都会延迟该轮提交。该取舍优先保证不凭空创建仓位。
- Live 总权益 sizing 需要对所有开放仓位完成退出深度估值；估值不完整会退回可用现金，因此实际金额可能保守偏小。
- 同一 `orderHash` 跨 Polygon transaction 的后续 fill 按用户确认视为独立经济成交，可能比目标原始订单数更多；UI 必须标明“经济成交次数”。
- 每笔 `<1%` BUY 可能放大到 `1—5 pUSD`，虽有 9 次小额追单上限，仍需自然测试累计敞口、收益偏差和费用。
- Polygon WebSocket 只是 wake hint；`1 s` 确认块扫描、Data API `3 s` 和 Positions REST 是完整性兜底。确认深度、API offset 和短暂不同步仍可能触发 gap/reconciliation。
- 不可变 Capture、盘口与特殊操作证据会持续增加磁盘占用；仍需 Campaign 归档和磁盘增长告警。
- Observe 与 Replay 对特殊操作保留两套面向不同输出的投影编排；当前有一致性回归覆盖，但后续再改 SPLIT/CONVERSION 时应优先抽取共享纯 reducer，避免语义漂移。
- `node:sqlite` 在 Node 24 仍有 experimental warning。
- 当前 Live 仅在隔离 fake signer/order adapter 回归，不能把单元测试视为实盘就绪。

## Resolved in current implementation
- Live 比例 BUY 曾以 available cash 作为资金比例基数，持仓后会系统性低估后续跟单；现在完整估值用 total equity，available cash 只作支付 cap。
- Live runner 曾先重试旧 waiting BUY，再消费新目标 SELL；现在新退出先处理，完整新 Signal 序列成功后才允许旧 BUY 重试，异常时跳过该轮 BUY。
- Campaign crash recovery 曾把持久化 Polygon `OrderFilled` 当 Activity 解码；现在正常恢复与 crash recovery 共用 source-aware decoder。
- Core hash 曾漏掉共享 `target-sell-policy.ts`，修改 SELL 规则可能不重置验证时长；当前执行/验证清单均包含该文件。
- SPLIT 曾直接触发 unsupported/major desync；当前完整证据可稳定投影到 historical bucket，弱证据仍失败关闭。
- tracked negative-risk CONVERSION 曾形成不可执行 `TARGET_CONVERSION` 并暂停账户；当前完整证据生成 source `TARGET_SELL` 等价退出，destination 隔离为 historical。旧不可执行 Signal 仍由兼容安全检查阻断。
- Replay 曾用弱于 Observe 的 SPLIT 证据并固定拒绝所有 CONVERSION；当前只有完整持久化证明才允许同语义回放。
- 普通 `TARGET_SELL` 尾仓 `EXIT_PENDING` 曾阻塞后续独立 BUY；当前普通退出与后续 BUY 独立，止损重开锁不变。
- 普通 `STANDARD_TRADE` SELL 达到 `95%` 后曾留下跟单义务；当前按本轮完整退出，MERGE/CONVERSION 不套用该阈值。

## Safety boundary
- 必须保持 `PAPER + LIVE_DISABLED + liveAllowed=false`。
- 未再次明确授权前，禁止 private key/seed、真实 signer、认证 CLOB client、submit/cancel、approve、真实 redeem、真实订单、真实资金和链上写入。
- 禁止覆盖历史失败证据、跨核心混算时长、降低数据/时钟/恢复/账本安全门或绕过 geoblock。
