# 备份与恢复

Hecatonchires 把“可恢复的程序代码”和“不可上传的运行状态”分开管理。源码 ZIP 或
GitHub tag 只能恢复程序；SQLite、日志、Capture、session 和本地审计运行证据必须
单独离线备份。

## 1. 哪些内容进入 GitHub

可以进入私有 GitHub 仓库：

- `src/`、`tests/`、`prototype/`、`scripts/`；
- SQLite migration、schema 和数据库访问代码；
- `package.json`、`pnpm-lock.yaml`、TypeScript/测试配置；
- README、`docs/` 下的安装、测试、审计和发布文档；
- 不含地址凭据、session 或签名内容的脱敏验证文件；
- `.gitignore` 和公开的默认目标配置模板。

以下内容留在本机或离线加密存储，不进入 GitHub 或 Release 附件：

- `data/`、SQLite 主文件、`-wal`、`-shm` 和数据库备份；
- Paper/Observe 原始 Capture、运行日志、临时文件和恢复 checkpoint；
- `live-production.json`、钱包 session、session lease、签名订单意图；
- 私钥、seed、助记词、API Key、CLOB secret、浏览器钱包导出文件；
- 本地 `agent_memory/`、研究笔记和其他内部运行资料。

即使仓库设置为 Private，也按上述边界处理。`.gitignore` 只是防误提交，不是秘密存储。

## 2. 备份前的停机要求

1. 点击控制台“退出”，确认服务端口关闭；
2. 确认页面/数据库回到 `PAPER + LIVE_DISABLED`；
3. 确认没有 Paper、Observe 或验证子进程；
4. 再复制数据库和运行证据。

不要在 SQLite 正在写入时复制主文件，也不要只复制主文件而丢弃同目录的 WAL/SHM。

## 3. 数据库备份

下面示例使用新的目标文件，不覆盖原数据库。路径请替换为自己的离线备份目录：

```bash
DB="data/phase0/phase0.sqlite"
BACKUP_DIR="/secure/offline/hecatonchires/2026-07-30"
mkdir -p "$BACKUP_DIR"
sqlite3 "$DB" ".backup '$BACKUP_DIR/phase0.sqlite'"
chmod 600 "$BACKUP_DIR/phase0.sqlite"
shasum -a 256 "$BACKUP_DIR/phase0.sqlite" > "$BACKUP_DIR/phase0.sqlite.sha256"
```

如果 `sqlite3 .backup` 不可用，先确认服务已停止，再使用保留权限的文件复制；复制后
必须同时保存完整性校验值。不要删除原文件或把备份放入仓库 `data/` 之外的 Git 跟踪目录。

建议同时记录：

- 备份时间和本地时区；
- 当前 Git commit/tag；
- 数据库 schema 版本；
- `PRAGMA quick_check` 和 `foreign_key_check` 结果；
- 备份文件 SHA-256；
- 备份介质和访问权限。

## 4. 代码恢复

从 GitHub 恢复固定版本：

```bash
git clone <PRIVATE_REPOSITORY_URL> ni-k
cd ni-k
git checkout v0.1.0-production-candidate-2026-07-30
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

也可以用安全源码 ZIP 恢复。ZIP 只包含 Git 跟踪文件，不包含 `.git`、`node_modules`、
数据库、日志或钱包数据。解压后重新安装依赖，不要把旧 `node_modules` 复制回来。

核对版本：

```bash
git rev-parse HEAD
git describe --tags --always
git show --show-signature --stat v0.1.0-production-candidate-2026-07-30
```

## 5. 恢复本地运行数据

1. 先停止服务；
2. 将旧数据库复制到新的本地数据目录或明确的恢复工作副本；
3. 保留原数据库不动，先在副本上执行启动前迁移和完整性检查；
4. 确认 schema 版本和代码版本兼容；
5. 启动后确认 `PAPER + LIVE_DISABLED`，再查看 Paper/Observe 历史；
6. 只有恢复结果可解释且用户重新授权时，才考虑后续生产验收。

不要把数据库直接覆盖到一个正在运行的实例，也不要用旧数据库覆盖新数据库来“修复”
Gate。遇到 schema 不兼容、WAL 不完整或恢复状态不明确时，保留原件并停止操作。

钱包 session 不应跨电脑复制。换电脑后必须重新建立公开身份会话；连接钱包也不等于
订单授权。

## 6. 归档包和完整性

安全源码 ZIP 应单独保存 SHA-256：

```bash
shasum -a 256 Hecatonchires-v0.1.0-production-candidate-2026-07-30.zip
```

数据库、原始审计证据和源码 ZIP 使用不同的归档边界。源码 ZIP 可以公开给内部审计或
放入私有 Release；数据库和真实运行证据应放在访问受控的离线存储。

## 7. 恢复验收

恢复完成后至少执行：

```bash
pnpm typecheck
pnpm test
node --check prototype/live-ui/app.js
node --check prototype/live-ui/server.mjs
zsh -n scripts/launch-hecatonchires-ui.command
```

恢复当前版本的真实报告后，按[生产验收参数](PM_F_FULL_REPAIR_2026_10_17.md)
运行 `pnpm validate:live-production --paper-report="<真实Campaign报告路径>" --observe-report="<真实Observe报告路径>"`。
历史 v2 验证摘要不自动转为当前版本通过。

然后启动控制台，确认：

```text
execution_mode=PAPER
live_gate_state=LIVE_DISABLED
liveAllowed=false
```

若任何一项不符合，停止继续操作，不连接真实钱包，不发送交易。
