# Hecatonchires 外部审计包说明

## 1. 审计包身份

- 生成日期：`2026-07-29`（Asia/Shanghai）
- 源码提交：`15d96a74e828148e9bb96c38f7597430da04a901`
- 分支：`codex/operator-ui-integration`
- 目标地址：`0x1f9e15f39bbd5d163b0eacf0fbef647ced9e4f1a`
- 当前安全状态：`PAPER + LIVE_DISABLED`
- 当前真实 Live execution/order attempt/fill：`0 / 0 / 0`

## 2. 建议阅读顺序

1. `docs/ni-k-external-audit-2026-07-29.md`
2. `metadata/package-metadata.json`
3. `evidence/observe/` 下的两轮通过报告和一轮安全中止报告
4. `evidence/database/` 下的结构、运行摘要、一致性和 Live 安全快照
5. `evidence/validation/` 下的当前提交生产验证工件
6. `evidence/paper/` 下的 Paper 24 小时独立汇总与原证据包
7. `source/` 下绑定到精确 Git commit 的源码归档
8. 根目录 `SHA256SUMS`

## 3. Observe 证据口径

两轮有效 Observe 均为 8 小时 10 分钟、`DURATION_COMPLETE`、最终 `SYNCED`、
`liveStabilityEligible=true` 且 blocker 为空：

- 第一轮：`3a9f1686-ba4a-4dd1-9426-da20cd8b36b8`
- 第二轮：`aead6def-fc4d-466a-87c6-d665255acde0`

第二轮结束后由 launchd KeepAlive 自动启动的短轮
`4f36e7c7-d3ae-4648-8d65-343e0f7c3e0b` 只运行约 77 秒，按用户要求安全中止。
它保留为负面/中止证据，`liveStabilityEligible=false`，不能计入有效 8 小时时长。

## 4. Paper 证据口径

Paper 报告中的 24 小时是用户接受的跨 Core 独立汇总，不是单 Campaign 原生 24
小时。报告保留原始失败、中止和外部收尾例外，不能把隔离测试或零成交描述为真实
资金运行。

## 5. 未包含内容

便携审计包故意不包含：

- `data/phase0/phase0.sqlite` 完整运行数据库；
- 原始 Capture payload 和大体积运行日志；
- 私钥、助记词、可复用 CLOB/API secret；
- `live_order_attempts.request_json/response_json`；
- `live_orders.signed_payload_json`；
- 任何真实钱包签名或 signed order intent。

完整数据库约 1.3 GB，继续保留在原工作机。审计方如需数据库级复核，应通过受控
介质取得只读副本，并先完成敏感字段审查；便携包中的 schema、运行摘要、最终对账、
Live 计数和 SQLite 一致性结果用于初步审计，不能替代受控数据库检查。

数据库摘要中的默认 `live_gate_state` 行是 2026-07-23 创建的历史禁用元数据，
其 `source_code_commit` 早于本次 Observe 报告绑定的 commit。因为本次未激活 Live
Gate，系统没有改写这条历史行；这不改变 `PAPER + LIVE_DISABLED` 的当前安全事实。

## 6. 完整性验证

在解压后的审计包根目录运行：

```bash
shasum -a 256 -c SHA256SUMS
```

压缩包外部还提供同名 `.sha256` 文件，用于在解压前核对整个 ZIP。

## 7. 审计限制

本包证明的是源码、历史 Paper、当前提交 Observe、安全边界和验证工件。它不证明：

- 用户正式钱包已经连接；
- 真实余额、allowance、仓位和 CLOB 凭据已经验收；
- 真实订单、成交、取消、approve、redeem 或 PnL 已经发生；
- 外部审计已经签字；
- 用户已经授权真实 Live。

在这些外部事实和授权完成前，系统必须保持：

```text
PAPER + LIVE_DISABLED + liveAllowed=false
```
