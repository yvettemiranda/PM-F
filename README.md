# Hecatonchires / ni-k

Hecatonchires 是一个独立的 Polymarket 跟单控制台，提供 Observe、Paper 和 Live
生产候选路径。当前版本用于长期保存、恢复和分阶段验收，不代表已经完成真实资金交易验收。

## 当前状态

```text
release target:      v0.1.0-production-candidate-2026-07-30
status:              PRODUCTION-CANDIDATE
execution_mode:      PAPER
live_gate_state:     LIVE_DISABLED
liveAllowed:         false
```

原生产候选归档的隔离验证记录为 `77` 个测试文件、`939` 项测试通过。2026-10-16 参考
PM-NAUTILUS 完成的可靠性和性能改进、当前回归结果见
[本轮优化记录](docs/PM_NAUTILUS_OPTIMIZATION.md)。旧验证工件不代表新源码已经通过实盘验收。
真实钱包、真实 CLOB、真实订单、真实成交、真实 PnL 和链上写入仍未完成最终生产验收。

## 安装与启动

环境要求：

- Node.js `24.14.0`（项目约束为 `>=24.14.0 <25`）
- pnpm `11.9.0`
- macOS（桌面入口使用 `.command` 和浏览器控制台）

首次安装：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
```

日常启动优先双击桌面的 `Hecatonchires.command`。命令行启动方式：

```bash
pnpm operator:ui
```

然后打开 <http://127.0.0.1:4173/>。如果端口被占用，可临时使用
`OPERATOR_UI_PORT=4179 pnpm operator:ui`。

安全退出：先点击页面右上角“退出”，等待安全关闭提示，再关闭终端或关机。正常重启后
程序会先回到 `PAPER + LIVE_DISABLED`，不会自动连接钱包、恢复 Live 或发送订单。

## Paper、Observe、Live

- **Observe**：只读采集和对账，不写 Paper/Live 账本，不下单。
- **Paper**：隔离模拟账户和模拟执行，用于长期验证规则、恢复和账本。
- **Live**：真实资金候选路径；必须经过新鲜钱包会话、只读余额/仓位、CLOB、合规、
  地域、时钟、安全 Gate、恢复和用户当次明确确认。

连接钱包只证明公开地址控制权，不等于订单授权。Paper/Observe 通过也不能替代真实
成交验证。未完成真实生产验收前，不应进入 Live。

## 常用检查

```bash
pnpm typecheck
pnpm test
node --check prototype/live-ui/app.js
node --check prototype/live-ui/server.mjs
zsh -n scripts/launch-hecatonchires-ui.command
pnpm validate:live-production
```

完整的分阶段入口、通过条件和停止条件见
[`docs/TESTING_ROADMAP.md`](docs/TESTING_ROADMAP.md)；发布前逐项核对
[`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md)。

## 数据与上传边界

源码、测试、迁移、schema、UI、桌面脚本、审计报告和脱敏验证文件可以进入私有 GitHub
仓库。SQLite、WAL/SHM、运行日志、Capture、钱包 session、签名订单意图、API/CLOB
secret、私钥、助记词和本地恢复文件必须留在本机或离线加密备份中，不能上传 GitHub。
`.gitignore` 已覆盖这些类别；即使仓库是 Private，也不要把它们当作版本文件。

数据库是运行状态，不是源码。停止本地服务后再备份，并保留文件权限、完整性校验值和
原始备份；不要直接删除或覆盖正在使用的数据库。具体步骤见
[`docs/BACKUP_AND_RESTORE.md`](docs/BACKUP_AND_RESTORE.md)。

## 换电脑恢复

1. 从私有仓库检出目标 tag 或 commit。
2. 安装 Node.js `24.14.0` 和 pnpm `11.9.0`。
3. 执行 `pnpm install --frozen-lockfile`。
4. 运行类型检查和测试。
5. 仅在确认数据库备份来源、权限和 schema 后，按备份文档恢复本地 `data/`。
6. 双击 `Hecatonchires.command`，确认页面仍显示 `PAPER + LIVE_DISABLED`。
7. 需要 Live 时重新连接钱包并完成当次生产前置检查；不要复制旧 session。

## 风险声明

本项目是生产候选软件，不是投资建议、法律意见或合规结论。任何真实交易都可能受到
网络、市场流动性、地域限制、钱包确认、CLOB 可用性和链上状态影响。禁止因为测试通过、
连接钱包或创建 GitHub Release 就推断系统获得真实交易授权。
