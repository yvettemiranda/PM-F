# 发布与版本封存清单

目标版本：

```text
v0.1.0-production-candidate-2026-07-30
```

目标是可追溯、可恢复的生产候选封存，不是实盘授权。

## A. 工作树和版本身份

- [ ] 当前分支和 HEAD 已记录
- [ ] 未提交文件已逐项分类
- [ ] 业务代码、交易规则、风险参数、Gate 和数据库结构没有本次整理改动
- [ ] `git diff --check` 通过
- [ ] `git log -1 --oneline` 与发布记录一致
- [ ] tag 名称不存在，或已明确说明不重复覆盖

## B. 敏感文件边界

- [ ] `git ls-files` 中没有 `.env`、数据库、WAL/SHM、日志或临时文件
- [ ] 没有私钥、seed、助记词、API Key、CLOB secret 或钱包导出文件
- [ ] 没有 session、签名订单意图或真实恢复数据库
- [ ] `git check-ignore -v` 能解释本地运行数据为何被忽略
- [ ] 当前 Git 历史没有敏感文件路径或真实凭据；若发现，先备份再制定历史清理方案

可复核命令：

```bash
git ls-files
git ls-files | rg '(^|/)(\.env|.*\.(sqlite|db|pem|key|p12|log))$' || true
git check-ignore -v data/phase0/phase0.sqlite data/operator/live-production.json
```

## C. 文档和运行说明

- [ ] 根目录 `README.md`
- [ ] `docs/SETUP.md`
- [ ] `docs/BACKUP_AND_RESTORE.md`
- [ ] `docs/TESTING_ROADMAP.md`
- [ ] `docs/RELEASE_CHECKLIST.md`
- [ ] 完整外部审计报告和程序审计报告
- [ ] README 明确 `PAPER + LIVE_DISABLED + liveAllowed=false`
- [ ] README 明确连接钱包不等于订单授权
- [ ] README 明确测试通过不等于真实成交通过

## D. 验证

```bash
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm test
node --check prototype/live-ui/app.js
node --check prototype/live-ui/server.mjs
zsh -n scripts/launch-hecatonchires-ui.command
git diff --check
pnpm validate:live-production --paper-report="<真实Campaign报告路径>" --observe-report="<真实Observe报告路径>"
```

报告要求和可选隔离证明路径见[当前生产验收说明](PM_F_FULL_REPAIR_2026_10_17.md)。
仅在已有合格运行证据后执行；旧 v2 工件不能直接放行当前版本。

记录以下结果：

- [ ] 测试文件数和测试总数
- [ ] TypeScript 结果
- [ ] runtime hash
- [ ] validation artifact schema、状态和 source commit
- [ ] 数据库 `quick_check`、外键和 Live 计数
- [ ] 启动、心跳、安全退出、重启复核

## E. 数据库和源码归档

- [ ] 停止服务后单独备份 SQLite
- [ ] 备份保留权限和 SHA-256
- [ ] 数据库没有进入 GitHub 或 Release 附件
- [ ] 使用 `git archive` 生成不含 `.git`、`node_modules`、`data/` 的源码 ZIP
- [ ] 源码 ZIP 生成 `.sha256` sidecar
- [ ] 至少在临时目录解压并检查 ZIP 内容

## F. Commit 和 annotated tag

建议提交信息：

```text
chore: archive production candidate and prepare private github release
```

tag message 至少说明：

- 这是 `PRODUCTION-CANDIDATE`；
- Paper/Observe 隔离验证已完成；
- 真实 Live 尚未授权和证明；
- 默认保持 `PAPER + LIVE_DISABLED`；
- 本 tag 不包含私钥、数据库或 session。

示例：

```bash
git add .gitignore README.md docs
git commit -m "chore: archive production candidate and prepare private github release"
git tag -a v0.1.0-production-candidate-2026-07-30 \
  -m "Hecatonchires production candidate; Paper/Observe verified; real Live not authorized or proven; default PAPER + LIVE_DISABLED"
```

## G. GitHub Private Release

- [ ] 已确认 remote 指向用户明确提供的私有仓库
- [ ] 已确认仓库可见性为 Private
- [ ] 已确认 GitHub 登录和 push 权限
- [ ] 推送当前分支
- [ ] 推送 annotated tag
- [ ] 创建 Release：`Hecatonchires v0.1.0 Production Candidate`
- [ ] Release 说明包含当前范围、测试结果、安全状态、未完成事项和恢复方式
- [ ] 未上传数据库、日志、钱包 session、密钥或签名 payload

没有 remote、仓库地址或权限时，只做本地 commit/tag/ZIP；不要创建公开仓库，也不要
声称已经推送。

## H. 恢复测试

- [ ] 从 tag 或源码 ZIP 在临时目录恢复
- [ ] 重新安装依赖
- [ ] 重新运行类型检查和测试
- [ ] 启动后仍为 `PAPER + LIVE_DISABLED`
- [ ] 单独恢复数据库副本并通过完整性检查
- [ ] 记录恢复时间、commit、tag 和哈希
