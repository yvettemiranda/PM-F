# Hecatonchires 安装与启动

本文面向新电脑或重新安装环境。它只准备本地代码和 Paper/Observe 控制台，不会连接
真实钱包，也不会发送交易。

## 1. 环境要求

| 项目 | 要求 |
|---|---|
| 操作系统 | macOS（桌面入口为 `.command`） |
| Node.js | `24.14.0`；范围 `>=24.14.0 <25` |
| pnpm | `11.9.0` |
| 浏览器 | 支持 localhost 的 Chrome 或其他 Chromium 浏览器 |

`.node-version` 是项目的 Node 版本基准，`package.json` 的 `packageManager` 是 pnpm
版本基准。不要用 Node 20 或其他大版本替换。

## 2. 拉取和安装

```bash
git clone <PRIVATE_REPOSITORY_URL> ni-k
cd ni-k
git checkout v0.1.0-production-candidate-2026-07-30
pnpm install --frozen-lockfile
```

如果使用已有工作树，只需确认当前 commit 和 tag，再运行 `pnpm install --frozen-lockfile`。
不要把 `node_modules/` 复制进 Git 或源码 ZIP。

## 3. 安装后检查

```bash
pnpm typecheck
node --check prototype/live-ui/app.js
node --check prototype/live-ui/server.mjs
zsh -n scripts/launch-hecatonchires-ui.command
pnpm test
```

测试完成后，确认本地数据库（若存在）仍处于：

```text
execution_mode=PAPER
live_gate_state=LIVE_DISABLED
liveAllowed=false
```

已有合格长期运行报告后，可按[生产验收参数](PM_F_FULL_REPAIR_2026_10_17.md)
运行 `pnpm validate:live-production` 重新生成 v3 验证工件；验证通过不会授予 Live 权限。

## 4. 启动控制台

日常使用时双击桌面的 `Hecatonchires.command`。它会：

1. 复用已经打开的 localhost 页面；
2. 启动本地 Node 服务；
3. 在监听前检查并复位不安全的 Gate；
4. 打开控制台页面。

命令行等价方式：

```bash
pnpm operator:ui
```

浏览器地址为 <http://127.0.0.1:4173/>。需要临时换端口时：

```bash
OPERATOR_UI_PORT=4179 pnpm operator:ui
```

只读 Paper/Observe 不需要钱包。钱包身份、生产 CLOB 和真实资金只有在未来明确进入
Live 验收时才重新连接。

## 5. 安全关闭、重启和关机

优先点击页面右上角“退出”，等待“安全关闭”后再关终端或关机。正常 macOS 关机、
重启和终止终端也有安全停止处理，但不应使用 `kill -9` 或直接删除数据库。

关机期间本地 Paper/Observe 会暂停，不会后台运行。再次启动不会自动恢复 Live，不会
自动连接钱包，也不会自动发送订单；配置、历史 Paper 账本和审计记录仍保留。需要连续
Observe/Paper 时，电脑必须保持唤醒并让服务持续运行；合盖睡眠会造成采集空窗，唤醒后
系统会重新检查 checkpoint、时间和对账。

## 6. 常见启动问题

### 找不到 Node.js

安装 Node.js `24.14.0`，或让 `node` 出现在 PATH 中，再重新运行入口。桌面入口会尝试
使用项目支持的本机运行时；它不会下载未知版本的二进制。

### 端口已经被占用

先打开 <http://127.0.0.1:4173/>，确认是否已有控制台。若是本项目旧实例，使用页面
“退出”；不要直接杀掉不明进程。临时诊断可改用 `OPERATOR_UI_PORT=4179`。

### 页面显示旧的安全状态

重启 localhost 服务并刷新页面。启动前会复位残留 Gate；如果仍不是
`PAPER + LIVE_DISABLED`，停止继续操作并保留错误信息，不能手工改数据库绕过。

### 依赖安装失败

确认使用 pnpm `11.9.0`、Node `24.14.0`，再运行 `pnpm install --frozen-lockfile`。
不要删除 `data/` 试图解决依赖问题；数据库恢复请看
[`BACKUP_AND_RESTORE.md`](BACKUP_AND_RESTORE.md)。

### 数据库被锁定

先安全退出所有本项目控制台、Paper 和 Observe 进程，再重试。不要复制正在写入的
SQLite 主文件，也不要删除 `.sqlite-wal` 或 `.sqlite-shm`。

## 7. 不做的事情

本安装流程不会读取私钥/助记词，不会保存 CLOB secret，不会执行 approve、submit、
cancel、redeem 或其他链上写入。GitHub 仓库只保存源码和文档；本地运行数据必须按照
[`BACKUP_AND_RESTORE.md`](BACKUP_AND_RESTORE.md) 单独保护。
