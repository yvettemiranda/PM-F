# Progress

## Current task
- 2026-07-19 用户首次启动优化版本时，旧核心 Campaign 被安全冻结，但预检无条件抛出 `PAPER_CAMPAIGN_FROZEN_BEFORE_MIGRATION`，入口生成 `UNKNOWN_UNKNOWN` 包后退出。
- 已修复并提交为同一次预检先冻结旧证据、再只读重查并返回 replacement；不会再要求用户靠第二次点击跨过该状态。
- 2026-07-18 已按用户授权安全停止刚开始的 12 小时验证，完成全系统运行时韧性、证据身份和长期 Campaign 语义优化。
- 停止未修改历史证据；旧核心约 0.54 小时运行保留但不得计入优化后核心。
- 尚未启动优化后核心的新验证。

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
- 最新全量：48 个测试文件、574 项全部通过。
- 新增“同一次预检冻结并进入 replacement-ready”回归测试，先稳定复现原错误，再在修复后通过。
- Campaign 服务目标测试 28 项、操作入口目标测试 12 项、policy/evidence/clock 目标测试 12 项全部通过。
- 修复提交后的真实库预检通过：Campaign `FROZEN`、`replacementRequired=true`、当前核心 hash 匹配、市场时钟 5/5 样本校准成功，且仍为 `PAPER + LIVE_DISABLED + liveAllowed=false`。
- 目标迁移测试：13 项通过；新增数据库级 NULL 身份回归先复现外键错误，修复后按预期由兼容身份触发器拒绝。
- 所有 `.command` / `.sh` 通过 `zsh -n`；`git diff --check` 通过。
- 真实业务库只读核验：
  - Schema `2.24.0`；
  - `PRAGMA integrity_check=ok`；
  - 外键异常 0；
  - active Reservation 0；
  - RUNNING Session 0；
  - `PAPER + LIVE_DISABLED`；
  - 最新旧核心 Campaign `FROZEN`、Session `COMPLETED`，冻结原因 `CORE_COMPATIBILITY_MISMATCH_BEFORE_MIGRATION`。
- 真实库 Online Backup 临时副本演练 `2.24.0→2.25.0` 通过：完整性正常、外键异常 0、安全状态不变、旧 Campaign/Session 保留。
- 演练前后源数据库 SHA-256 均为 `a4c9c00fa41adb746d78322623190205141513bbcea9995977a8b0dde82d6f7e`，源库未被修改。
- 最终迁移副本确认 `PASSED→RUNNING` 重验边存在、旧 7 个 Session 身份保持 NULL legacy 语义，新 Session 仍由触发器强制完整身份。
- 演练临时副本已移到废纸篓，不属于项目证据。

## Current Git state
- 本轮基准 HEAD：`baa23c87d35ae2c6124166892599cb9ce182df43`，分支 `main`。
- 主优化提交：`62ebfb1699f1df7615b15e81e3c7ac5a109ce275`。
- Standards/Spec 双重复核完成并已提交：追加 fail-closed 测试清单一致性、移除 replacement 无效参数、修复 Observe abort 后遗留 cadence timer，并关闭同核心 PASSED Campaign 的 policy/suite 重验死锁。
- `UNKNOWN_UNKNOWN` 根因修复已提交，最终版本以当前 Git HEAD 为准。
- 最终代码版本以当前 Git HEAD 为准；交接记录不固化自引用 HEAD。
- Schema：`2.25.0`。
- Core compatibility：`e490b5d1a91ec38242558e27e2e9fa40cdcca102e84dd64d248e40e3f70fac00`。
- Validation policy：`99a26397bdea7ea8911be4e5d268805b195d129aae43c52f64ada94f4d6672ce`。
- Operator build：`0b5e3e2fa74e1f5291bc3fed357635f2135058d335898271ee904b5990d87ff8`。
- Verification suite：`9f674bbbd25be0948b8eb741c8974e36bb69a0810508a358a4f3958df45f93b2`。
- Artifact provenance：`7597ff65e894c1d3367a4ba1d7dcb7dddcc7999a23659fb14cfc82dcb5090b23`。

## Next steps
1. 用户下一步双击“1_开始或继续Paper累计验证.command”。
2. 正式启动流程识别已 `FROZEN` 的旧核心，重建当前隔离 proof，先备份并将真实业务库从 `2.24.0` 迁移到 `2.25.0`，随后为优化后核心从 0 创建 replacement Campaign。
3. 首先完成连续 12 小时资格验证；通过后继续累计 72 小时、关键场景覆盖及最终版本 24 小时 Observe。
4. 全程保持 `PAPER + LIVE_DISABLED`；未完成所有验证前不得启用 Live。
