# Progress

## Current task
- 2026-07-18 已按用户授权安全停止刚开始的 12 小时验证，完成全系统运行时韧性、证据身份和长期 Campaign 语义优化。
- 停止未修改历史证据；旧核心约 0.54 小时运行保留但不得计入优化后核心。
- 当前正在完成最终代码复核、提交和新 Campaign 启动结论；尚未启动新验证。

## Completed implementation
- MarketClock 同时进入 Observe、Paper BUY deadline、订单簿、恢复、Stop Loss、估值和 Settlement 边界；报告校验偏移不一致并阻断。
- 12/72 小时期限、资格里程碑和 checkpoint 改为单调时钟；checkpoint 记录 `MONOTONIC_V1`，避免系统拨时制造时长或补发突发 checkpoint。
- Observe 改为固定频率且不重叠调度；AbortSignal 贯穿 Data API/CLOB 请求、分页、退避和 pUSD。
- Public API 新增 cursor-aware `tradesSince`；恢复保留首页漂移检查，但不再每次拉完整历史。
- Settlement 新增 `paper_settlement_retry_state`：5 秒到 5 分钟持久化指数退避，相同错误只写一次审计，恢复与成功可追溯。
- Schema 升至 `2.25.0`，新增 Session 四类兼容身份及 append-only evidence adjudication；数据库触发器拒绝新 Session 的 NULL、长度错误或非小写十六进制身份。
- 核心哈希纳入真实 CLI、scoped invariants 和 `030_paper_runtime_resilience.sql`，排除 Live-only CLOB fee；注释变化不重置，语义变化会重置。
- 隔离验证身份扩展到 48 个测试文件、fixtures、TypeScript 配置、lockfile 和 Node/tsx/TypeScript/Vitest 工具链版本。
- 策略/测试套件/操作器/产物变化可保留同核心运行时长，但会按规则重新判断资格、覆盖或 isolated proof，并写不可变 adjudication。
- replacement 策略从缺陷白名单升级为通用规则：终态且核心不同才新建；transition 记录旧/新核心与变化组件。
- scoped invariant 去掉重复实体扫描，将 transition→audit 的 N+1 查询改为分批精确匹配。
- 删除全仓库无引用的 `src/live/paper-balance-provider.ts`，合并重复的 12 小时常量；保留 Live fail-closed 占位器。
- 诊断打包对明显过期 isolated proof 先轻量拒绝，再执行完整核心/套件校验；两个独立旧证据场景分开受 5 秒测试限额约束。

## Verification completed
- `pnpm typecheck` 通过。
- 最新全量：48 个测试文件、570 项全部通过。
- 目标迁移测试：13 项通过；新增数据库级 NULL 身份回归先复现外键错误，修复后按预期由兼容身份触发器拒绝。
- 所有 `.command` / `.sh` 通过 `zsh -n`；`git diff --check` 通过。
- 真实业务库只读核验：
  - Schema `2.24.0`；
  - `PRAGMA integrity_check=ok`；
  - 外键异常 0；
  - active Reservation 0；
  - RUNNING Session 0；
  - `PAPER + LIVE_DISABLED`；
  - 最新 Campaign `PAUSED`、Session `COMPLETED`。
- 真实库 Online Backup 临时副本演练 `2.24.0→2.25.0` 通过：完整性正常、外键异常 0、安全状态不变、旧 Campaign/Session 保留。
- 演练前后源数据库 SHA-256 均为 `a4c9c00fa41adb746d78322623190205141513bbcea9995977a8b0dde82d6f7e`，源库未被修改。
- 演练临时副本已移到废纸篓，不属于项目证据。

## Current Git state
- 本轮基准 HEAD：`baa23c87d35ae2c6124166892599cb9ce182df43`，分支 `main`。
- 代码和项目记录尚待提交；提交后需记录最终 commit、核心哈希和验证套件哈希。

## Next steps
1. 完成 Standards/Spec 双重复核，修复任何 P0/P1 或实质缺陷。
2. 重新执行全量测试、类型、脚本语法、diff 和只读安全检查。
3. 提交优化版本并核对最终 HEAD/hash。
4. 若全部通过，用户下一步只需双击“1_开始或继续Paper累计验证.command”，从 0 创建新核心 Campaign。
