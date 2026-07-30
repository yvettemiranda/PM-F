# Hecatonchires 外部审计包说明（2026-07-30）

这是当前版本的便携审计包说明。完整程序审计见
[`ni-k-program-audit-2026-07-30.md`](./ni-k-program-audit-2026-07-30.md)；包内的
`evidence/validation/live-production-validation.json` 是与运行时代码提交绑定的最新验证凭证。

## 包身份

- 源码提交：`b1aaa7d8d12e1c8308bc0df909eb302ebd12f7ae`
- 运行时哈希：`85fb3f113414c4e95181e9057ede31b5fce065b58831c1e6e47ae60846115d2c`
- 测试：`77` 个文件、`939` 项通过
- 当前安全状态：`PAPER + LIVE_DISABLED`
- Live execution/order/attempt/fill：`0 / 0 / 0`
- 私钥、seed、可复用 CLOB/API secret：未包含

## 建议阅读顺序

1. `docs/ni-k-program-audit-2026-07-30.md`
2. `evidence/validation/live-production-validation.json`
3. `evidence/database/live-safety-snapshot.json`、`integrity-check.txt` 和 schema
4. `evidence/observe/`、`evidence/paper/` 中的历史验证证据
5. `source/` 中绑定精确提交的源码归档
6. 根目录 `SHA256SUMS`

## 包内边界

包内只保留审计需要的结构化摘要、历史报告和源码归档，不包含：

- `data/phase0/phase0.sqlite` 完整运行数据库；
- 原始 Capture payload、大体积运行日志或浏览器扩展数据；
- `live_order_attempts.request_json/response_json`；
- `live_orders.signed_payload_json`；
- 任何真实钱包签名、私钥或 signed order intent。

因此，包证明的是当前源码的安全边界、隔离测试和数据库安全快照，不证明真实资金已经
发生 FILL、PnL、approve、submit、cancel 或 redeem。连接钱包、通过 Gate 或测试通过也
不会自动授权真实交易；进入 Live 仍须用户在当次会话中明确确认，并逐笔确认钱包弹窗。

## 完整性检查

在解压后的包根目录运行：

```bash
shasum -a 256 -c SHA256SUMS
```

压缩包旁的 `.sha256` 文件用于在解压前核对 ZIP 本身。

## 当前本机复核

生成包前已只读检查 SQLite `quick_check`、外键、Gate 和 Live 计数，并安全重启
`Hecatonchires.command`。最终页面显示 `PAPER`、`LIVE_DISABLED`、顶部时间持续变化，
Live 钱包余额显示 `0.00 pUSD · 数据已过期`；没有连接钱包、签名或链上操作。
