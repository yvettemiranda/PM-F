# Progress

## Current task
- 2026-07-25 启动修复后核心的新 Paper Campaign，并每 30 分钟监控一次；每轮最多 4 小时，正常结束后继续下一轮，今晚 23:30 安全暂停并审计结果。
- 全程保持 `PAPER + LIVE_DISABLED + liveAllowed=false`；异常时先判断安全性和数据完整性，再决定修复、重启或停止。
- 已完成一次用户授权的 macOS 深度垃圾清理：仅清理可重建缓存、用户日志、pnpm store 可回收项和废纸篓；保留 Codex runtime、项目源码与个人资料。

## Implemented
- `src/paper-validation/campaign-child-result.ts` 区分正常 Paper 报告与 Paper 失败 JSON；失败结果不会再被当作正常 `paper.report` 使用。
- supervisor 收尾路径识别失败/无效 Paper 与 Observe 报告，进入失败收尾并把 Paper 原始失败信息写入报告 payload。
- supervisor catch 对 pointer 写入失败做 best effort，保留原始错误并记录 `PAPER_CAMPAIGN_RECOVERY_POINTER_WRITE_FAILED`。
- 启动顺序先回收或安全冻结旧 core 的遗留 `RUNNING` Session，再按 core hash 创建 replacement，避免重复点击和残留 `RUNNING`。
- 新增受限 `--recover-only` supervisor 模式，只做遗留 Session 回收/安全冻结并退出，不创建新 Session、不启动 Paper/Observe。
- 新源码与回归测试已纳入 Core compatibility manifest。

## Verification
- 失败测试先红：缺失 child-result 模块。
- 当前通过：TypeScript；相关测试 `5 files / 53 tests`；此前全量 `56 files / 769 tests` 通过；恢复工件清理后追加 Shell 生命周期测试 `2 files / 16 tests` 通过，`git diff --check` 通过。
- `--recover-only` 与恢复工件清理修复均已提交；本次最终只变更项目记忆文件，不影响运行时代码。

## Runtime state
- 当前无 Observe/Paper/Supervisor/launcher 进程，operator lock、marker、FIFO 均已清理。
- 深度清理释放约 2.32 GB；清理后磁盘可用空间约 309 GB。`~/.cache/codex-runtimes` 保留约 1.6 GB。
- `PC-2EB95BD31A8EB9693837 / PS-58AB7048A91D8264E009` 运行约 2 小时 52 分后异常结束：Observe 结果最终 `SYNCED`，Paper 失败为 `unable to open database file`；macOS System Policy/TCC 同时拒绝 WAL 与 operator pointer 访问。
- `--recover-only` 已安全将旧 Session 标记 `BLOCKED`、旧 Campaign 标记 `FROZEN`；正式 Session/Campaign 报告和 ZIP 不生成，数据库 Schema `2.30.0`、`quick_check=ok`、外键问题 `0`，安全 Gate 未变化。
- 已通过 macOS 系统设置核验：终端的“文稿”文件夹访问为开启，ChatGPT 的“完全磁盘访问权限”为开启；本次未重复切换或扩大权限，也未启动新 Paper。

## Next steps
1. 保留旧 Campaign 的冻结失败证据，不把旧时长计入修复后核心。
2. 从干净提交通过正式入口创建新 Campaign，确认目标、进程、日志与安全 Gate。
3. 每 30 分钟检查一次；4 小时正常结束后继续下一轮，今晚 23:30 安全暂停并生成结果。
