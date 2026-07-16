# Bugs And Risks

## Active blockers
- 新版本 2 小时 Paper 资格 Session 尚未执行，因此 Campaign 尚未 qualified，累计长测尚未开放。
- 即使资格通过，仍需累计有效运行 72 小时、至少一个连续 12 小时 Session，并满足最终一致性与覆盖门槛。
- 自然 SELL、Partial Fill、Stop Loss、Settlement/Redeem 等稀有场景可能需要继续运行或使用明确标注的同版本隔离证据；不能伪装成自然行情。
- 当前环境历史 geoblock 曾返回受限，CLOB clock offset 曾不安全；Live 前必须在合法环境重新验证，禁止绕过。
- private key、真实 signer、认证交易 provider、隔离钱包和用户小额实盘授权均未接入/未完成。

## Active risks
- Data API 历史 offset 限制仍可能使完整历史 Replay 不可得；不得把不完整历史冒充完整回放。
- `node:sqlite` 在 Node 24 仍有 experimental warning，长期稳定性需要 72 小时 Campaign 证明。
- 公开钱包依赖增量轮询，数据源可能短暂不同步；Gap、MINOR_DIFF/MAJOR_DESYNC 与 reconciliation 必须继续 fail closed。
- 2 秒 orderbook 新鲜度提高安全性但可能降低成交率；不得为提高通过率放宽。
- 公开 HTTP 响应没有服务器数字签名；当前证据能证明内容寻址、官方 URL、不可变本地 capture 与解析一致，但不是密码学级服务器签名。

## Resolved in current implementation
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

## Safety boundary
- 必须保持 `PAPER + LIVE_DISABLED + liveAllowed=false`。
- 未再次明确授权前，禁止 private key/seed、真实 signer、认证 CLOB client、submit/cancel、approve、真实 redeem 和链上写入。
- 数据不一致、版本不一致、恢复状态不确定、Gap、Risk Reject、stale orderbook 或冻结状态一律保守阻断，不得手工改判。
