# Progress

## Current task
- 实施“Paper 精度修复与可累计长期验证”，完成 clean commit 后运行真实 2 小时资格 Session。
- 全程固定 `PAPER + LIVE_DISABLED`；旧失败报告只读保留。

## Completed implementation
- 新增 Paper/未来 Live 共用的 BigInt 精确金额模块；约 `0.974709 ppm` 案例得到 `974 micros`，不会提前归零或放大。
- Execution Context、Risk Decision 保存精确比例、商、余数、舍入和不可变 sizing hash。
- 接入公开 `min_order_size`、tick 与 SDK 兼容归一化；买入低于限制事务化释放 Reservation，卖出保持对应 Pending 状态。
- 无盘口、缺失/非法约束与费用不可用继续走冻结、退避、恢复和明确日志，不伪造价格/成交。
- 报告拆分 Signal、Eligible/Gap、Capital、Risk、Order、Fill、Position、Reservation、Fee、PnL、Stop Loss、Settlement 与完整性。
- 对外诊断 ZIP 使用公开 Campaign/Session/Report ID、稳定脱敏别名、manifest 与 SHA-256；不导出内部 Observe/账户 UUID 或绝对路径。
- 新增可累计 Campaign、Session、Checkpoint、Transition、Report 和 `coreCompatibilityHash`；同一账户/基线/cursor，离线交易保持 Gap。
- 三个双击入口已部署到仓库和桌面目录。
- `REAL_SIGNAL_REPLAY` 与 `REAL_EXECUTION_REPLAY v2` 支持数据库重建校验；真实执行证据必须绑定官方公开 orderbook/fee 不可变 capture 和下单时点新鲜度。
- Campaign 报告已增加跨 Session 累计运行指标与完整 Paper funnel；被动 Crash 检查不再记为自然恢复成功。
- 新增生产共用 Crash Recovery 编排：真实进程 SIGKILL 检测、精确 cursor 绑定、checkpoint hash/sequence、WAITING BUY/Reservation 清理、Portfolio 刷新、abandoned Observe 中断、pending exit 保留及二次崩溃冻结证据复用。
- 资格短测提前安全暂停的健康时间按最终规则累计，但不能拼成资格通过；三个入口支持任意 Finder cwd，ZIP 失败会显式指向本次可见未压缩结果而非旧包。

## Verification completed
- Node `24.14.0`、pnpm `11.9.0`。
- `pnpm typecheck` 通过。
- 全量测试：43 个文件、473 项通过。
- Campaign 隔离测试：19 个文件、300 项通过。
- 旧业务库副本依次迁移至 2.20.0/2.21.0：`integrity_check=ok`、0 外键问题、两类市场快照均有 capture FK、5 张 Campaign 表存在。
- 全部 `.command/.sh` zsh 语法与 `git diff --check` 通过。
- 当前库版本准备改为 backup-first、连续 migration 前缀验证，并核对全部 109 个安全触发器；未知未来版本、缺失历史 marker/触发器/关键表列均 fail closed。
- Phase 0 资格证据只接受完整 `PASSED`，或精确列举且相互匹配的 `INCOMPLETE_KNOWN_LIMITATIONS`；不会把 Data API 历史限制冒充完整 Replay。
- 独立启动流、运行时 Schema、报告/Replay 三路复审已关闭启动顺序、遗留进程、历史回放诚实性和 current schema 防护问题；最终无剩余 P0/P1。
- 第一次实际启动在创建 Campaign 前因 pnpm 版本不一致安全拒绝；第二次在创建 Campaign 前因旧 Phase 0 完整通过口径不可满足安全拒绝，均未创建账户、Session 或累计时长。
- 旧启动曾在 backup-first 修复前把实际库由 2.19 增量迁移至 2.21；迁移仅新增对象，但不存在迁移前备份。已保存只读事后取证快照及 manifest，明确记录该限制，不伪造回滚证据。

## Next steps
1. 提交本轮 Phase 0 证据、数据库准备和启动顺序加固，形成 clean commit。
2. clean commit 上自动刷新真实公开数据、执行稳定 Replay 与 19 文件隔离 proof。
3. 启动同一目标钱包、固定 1000 pUSD 账户的 2 小时资格 Session。
4. 检查 Session/Campaign 报告、数据库完整性和脱敏 ZIP；通过才开放后续累计长测。
