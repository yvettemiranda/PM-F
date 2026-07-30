# Hecatonchires 全程序审计与操作交付文档

> 审计日期：2026-07-30（Asia/Shanghai）
> 项目：ni-k / Hecatonchires  𑁋 运行在本机的 Polymarket 跟单控制台
> 审计范围：源码、数据库边界、Live 后端装配、Paper/Observe、localhost UI、桌面入口、
> 启停流程、风险参数、验证工件和测试证据。
> 本文件是当前版本的主审计入口；2026-07-29 的审计文件和压缩包保留为历史证据。

## 1. 结论先行

当前程序已经整理为“一个入口、一个本地服务、一个安全状态”的操作方式：

1. 日常启动只双击桌面的 `Hecatonchires.command`。
2. 日常关闭优先点击页面右上角“退出”。程序会先停用 Live、断开钱包会话、停止后台
   服务，然后页面显示安全关闭提示。
3. 重新双击同一个入口即可再次使用。启动前会检查数据库；如果上次异常退出留下了非安全
   Gate 状态，程序先执行正式 emergency-disable，确认回到 `PAPER + LIVE_DISABLED` 后
   才监听端口。
4. 当前仍保持 `PAPER + LIVE_DISABLED`，没有真实订单、成交、授权交易或链上写入。本轮
   审计不加载私钥、seed 或可复用 API secret。

代码路径已经具备正式钱包连接、只读余额/仓位、认证 CLOB、Gate、对账、恢复、授权和
LiveRuntime 的装配接口；这表示“连接正式钱包后可以继续走生产前置流程”，不表示可以
绕过钱包确认，也不表示已经有真实成交证据。

## 2. 当前安全基线

在交付或外部审计开始前，应执行：

```sql
SELECT execution_mode, live_gate_state, state_reason
FROM live_gate_state
WHERE state_id = 'default';
```

交付基线必须是：

| 项目 | 要求 | 当前含义 |
| --- | --- | --- |
| `execution_mode` | `PAPER` | 不进入真实资金执行 |
| `live_gate_state` | `LIVE_DISABLED` | Live Gate 关闭 |
| UI `liveAllowed` | `false` | 页面不能把历史状态当作可下单 |
| Live execution/order/fill | `0 / 0 / 0`（若无用户授权的真实运行） | 没有真实交易样本 |
| 私钥/seed | 未加载 | 浏览器钱包只确认公开地址控制权 |

任何代码完成、测试通过或钱包连接成功，都不能自动改变这组基线。进入 Live 必须由
用户在当前钱包会话中再次明确确认，并且每次签名/链上交易都仍由浏览器钱包弹窗确认。

## 3. 已完成的工作

### 3.1 启动、退出和重启

- 桌面入口直接持有 Node UI 服务 PID，不再持有可能先退出的包管理器外层 PID。
- Node 版本探测固定为 `>=24.14.0 <25`；Finder 的精简 PATH 不再要求能找到 `pnpm`。
- 已运行的控制台会被复用，不重复开服务或重复开标签页。
- 右上角“退出”是正式 API：响应先返回，再由宿主执行 `shutdownSafety()`，停用 Gate、
  停止 runtime、撤销钱包会话和取消待签名请求。
- 终端收到 `SIGINT/SIGTERM` 时执行同一套安全关机；等待最多 10 秒，超时才终止本地进程。
- 服务启动前检查持久化 Gate。若发现 `LIVE`、`LIVE_ARMING` 或 `LIVE_ACTIVE` 残留，先
  清理并再次读取数据库；无法精确确认 `PAPER + LIVE_DISABLED` 时拒绝监听。
- UI 启停接口只接受 localhost，并校验 mutation `Origin`，不会暴露到局域网。

### 3.2 钱包会话稳定性

- 支持 EIP-6963、OKX 延迟注入、`window.okxwallet` 和传统 EIP-1193 注入。
- 连接流程只保存公开地址、Polygon 网络、一次性 challenge 签名和短期 session lease。
- 钱包断开、换账户、换链、过期或页面心跳停止时，后端撤销 runtime action 并执行安全停用。
- 配置没有变化时重复保存不会强制断开钱包；钱包身份、交易资金地址、网络或 Live 风险
  参数变化时才断开旧 runtime，避免旧参数继续绑定到新会话。
- 切换交易资金地址时，空的旧账户会被审计后标记为 `DISABLED`；若旧账户有未终态执行、
  订单、资金/资产保留或非零持仓，切换会明确失败，不会静默丢弃业务状态；空旧账户的
  wallet metadata 也会同步标记为 `DISABLED`，避免多个活动钱包造成歧义，切回时由正式
  装配流程重新激活。

### 3.3 参数和风控

Live 风险参数现在只有一套来源：UI 中可见、保存并确认的配置。默认值仍是：

| 参数 | 默认值 |
| --- | ---: |
| 资金包上限 | 10 pUSD |
| 单笔上限 | 1 pUSD |
| 总敞口上限 | 3 pUSD |
| 单日亏损上限 | 1 pUSD |

用户可以把参数改成任意正数（最多 6 位小数），但必须满足：

```text
单笔上限 ≤ 总敞口上限 ≤ 资金包上限
单日亏损上限 ≤ 资金包上限
```

本轮审计移除了以下没有在 UI 中体现、且会与用户设置冲突的限制：

- 资金包按固定百分比再缩小的隐藏上限；
- 固定绝对额的第二套总敞口/市场/仓位上限；
- 固定“连续亏损 5 次就阻断”的隐藏规则；
- 前端和后台的 `100 pUSD` 硬编码上限；
- 因为钱包余额低于配置资金包而拒绝生产路径准备。

仍然保留的检查不是“莫名其妙的最低余额”，而是执行成立所必需的边界：

- 余额、allowance、单笔和总敞口在具体 BUY 下单前必须足够；
- 价格、市场最小订单量、FAK/盘口深度和市场结束时间必须有效；
- 目标/我的 Signal、Risk Decision、Ruleset、账本和外部订单/仓位必须一一对应；
- 数据重大不同步、冻结仓位、时钟不安全、官方地域限制、合规证据过期时继续 fail closed；
- SELL/止损退出不被 BUY 资金上限阻止，但仍必须通过仓位、市场和对账检查。

因此，钱包里有 0 pUSD 时仍可连接、显示余额、完成身份绑定和装配只读生产组件；真正发出
某一笔 BUY 时，若当时没有足够余额，该笔会被拒绝并保留原因，不会伪造成交，也不会把
账户永久锁死。

首页四项资金总览现在严格按真实执行模式选择数据源：Paper 只显示 Paper 组合投影；Live
优先显示最新 Live 估值。若 Live 尚未生成估值且没有本系统管理仓位，则总权益和可用现金
直接使用最新钱包 pUSD 现金，持仓价值为 0；若存在管理仓位但估值尚不完整，则显示“待同步”，
绝不回退到 Paper 的 `1,000 pUSD` 演示账户。启动前隔离仓位不计入本系统管理组合，仍在
“启动前仓位”中单独展示和对账。

### 3.4 验证工件和版本绑定

生产验证工件升级为 v2。哈希包含：

- `src/**/*.ts`、`src/**/*.sql`；
- `tests/**/*.ts`、`tests/**/*.sql`；
- localhost UI 的 JavaScript/MJS/HTML；
- `package.json`、锁文件、TypeScript 配置、桌面启动脚本和操作入口脚本。

文档、报告、图片和纯 CSS 不改变运行时验证哈希。验证工件记录源码提交、运行时哈希、
类型检查、全套测试和差异检查结果。生产装配只接受与当前运行时哈希一致的工件；源码或
测试发生变化后必须重新验证并重启服务。纯文档或纯视觉调整不会让业务运行时误报过期。

## 4. 日常操作手册

### 4.1 开启

1. 双击桌面的 `Hecatonchires.command`。
2. 浏览器打开 `http://127.0.0.1:4173/`。
3. 顶部先确认是 `PAPER`；右上角状态会显示后台时间和同步状态。
4. 目标地址在“目标地址”输入框修改，点击“确认”保存；运行期间有未完成任务时系统会
   拒绝改绑。
5. Live 参数在折叠的“Live 风险参数”里修改，点击“保存参数”。保存后立即写入配置，
   下一次 Live 运行使用新参数；若只改了同样的值，不需要重新连接钱包。

### 4.2 关闭

推荐方式：

1. 点击右上角“退出”；
2. 在确认框点击“确认退出”；
3. 等待页面显示“已安全关闭”。

如果终端窗口仍在，也可以关闭终端或按 `Ctrl-C`；入口会发送安全停止信号。不要使用
`kill -9`、强制退出 Node 或直接删除数据库文件，因为任何进程都无法在强制终止时写入
最后的安全审计。即使发生异常强退，下次启动仍会先检查并清除残留 Live Gate。

### 4.3 再次开启会发生什么

- 会读取上次保存的目标地址和 Live 参数，不会要求重复输入旧的确认词。
- 如果上次正常退出，直接回到 `PAPER + LIVE_DISABLED`。
- 如果上次异常退出留下 `LIVE_ACTIVE`，启动时自动 emergency-disable，并在数据库中留下
  审计记录；清理失败则不启动服务。
- 钱包 session 不跨服务进程复用，需要重新连接并签名一次；配置本身不会丢失。
- 既有 Paper 账户、Signal、持仓和审计历史保留，不会因重启重新消费历史 Signal。

### 4.4 切换到 Live（仅在用户明确授权时）

1. 连接 Polygon 钱包并在 OKX 弹窗中确认一次身份签名。
2. 确认显示的 signer、交易资金地址和网络正确。
3. 点击模式按钮，阅读参数摘要并完成二次确认。
4. 系统自动按顺序执行 Gate、Live 对账、钱包准备、最终 Gate、启动恢复和 runtime 启动。
5. 任一步失败会停止 runtime 并回到 `PAPER + LIVE_DISABLED`，页面显示失败阶段和原因。
6. 需要 approve、CLOB 签名或链上交易时，仍逐笔由浏览器钱包确认；后台不会读取私钥。

切回 Paper 只需点击模式按钮并确认；系统先紧急停用 Gate，再停止 runtime。

## 5. 审计证据和验证方式

本轮代码验证命令：

```bash
pnpm exec tsc --noEmit
pnpm test
node --check prototype/live-ui/app.js
node --check prototype/live-ui/server.mjs
zsh -n scripts/launch-hecatonchires-ui.command
git diff --check
pnpm validate:live-production
```

本轮全套测试结果：

```text
Test Files  77 passed
Tests       913 passed
```

验证工件当前为 `data/operator/live-production-validation.json`，状态为
`live-production-validation-v2 / PASSED`。受验证的运行时提交以工件的 `sourceCodeCommit`
为准；若 `git rev-parse HEAD` 只因后续文档提交而更新，可以不同，但 `liveRuntimeHash` 必须
完全一致且 `runtimeSourceDirty=false`。当前运行时哈希为
`d20fe18a5107785cffd0d336df3bff79f0c104f73f4f8620aaf4cb21ef490a1b`。工件同时记录
`typecheckPassed=true`、`fullTestPassed=true`、`diffCheckPassed=true`、`77` 个测试文件和
`913` 个测试；运行时文件没有 dirty 变化。若工作树只有文档或 `agent_memory` 变化，
工件的 `runtimeSourceDirty` 仍应为 `false`，但 `sourceCodeDirty` 会如实记录整个工作树状态。

### 5.1 本轮实际启停复核

在不触碰真实钱包和真实订单的前提下，使用临时本地端口 `4179` 完成了以下闭环：

- 启动后快照返回 `PAPER`、`LIVE_DISABLED`、`liveAllowed=false`，后台状态为 `STOPPED`；
- 间隔约四秒再次读取，`generatedAt` 前进且 `service.instanceId` 不变，证明服务和时间心跳
  正常；
- 调用带 localhost `Origin` 的安全退出接口得到 `202 Accepted`，端口关闭，宿主 Node
  进程正常退出；
- 再次启动得到新的 `service.instanceId`，状态仍为 `PAPER + LIVE_DISABLED`，再次安全退出；
- 退出后 SQLite 复核为 `live_executions=0`、`live_orders=0`、`live_order_attempts=0`、
  `live_fills=0`，非零 Live 仓位为 `0`。

本轮没有执行电脑关机；用户已明确取消关机请求，最终只停止本地服务。

重点回归覆盖：

- 启动前残留 `LIVE_ACTIVE` 的自动安全复位；
- UI 安全退出 API 和宿主关闭回调；
- 入口直接持有 Node PID、信号退出和重启；
- 钱包重复保存、参数变化断开和旧账户安全停用；
- Live 总览不得读取 Paper 组合，且无估值时只允许使用真实钱包现金或显示“待同步”；
- 0 pUSD 余额的生产准备；
- 任意已确认 Live 限额、五次历史亏损不触发隐藏阻断；
- 测试源码变化使验证哈希失效；
- Gate、Risk、LiveStore、LiveExecutor、对账和恢复的现有回归套件。

外部审计可用以下命令核对当前数据库：

```bash
sqlite3 -header -column data/phase0/phase0.sqlite \
  "SELECT execution_mode,live_gate_state,state_reason,updated_at FROM live_gate_state WHERE state_id='default';"

sqlite3 -header -column data/phase0/phase0.sqlite \
  "SELECT live_account_id,live_wallet_id,status,initial_bankroll_micros,risk_budget_micros FROM live_accounts;"

sqlite3 -header -column data/phase0/phase0.sqlite \
  "SELECT COUNT(*) AS live_executions FROM live_executions;"
```

## 6. 当前保留的限制与风险

这些项目不是本轮删除的“过严风控”，而是进入真实资金前必须由外部审计和用户确认的
实际风险：

1. 尚未用真实资金完成自然 FILL、真实 PnL、真实 approve/submit/cancel/redeem 的端到端
   验收；单元测试和隔离 adapter 测试不能代替真实钱包验收。
2. 官方 geoblock 结果随实际网络出口变化；每次 arming 都必须取得新鲜结果，不能缓存或
   手工覆盖 `GEOBLOCK_BLOCKED`。
3. 交易资金地址可能是 EOA 对应的 Polymarket Gnosis Safe；系统会验证 owner 关系，但
   Safe 的链上授权仍需用户在钱包中确认。
4. 真实运行依赖 Node 24、仓库依赖、浏览器扩展和 Polygon/CLOB 只读服务；目前是本机
   localhost 应用，不是已签名的 macOS `.app` 发布包。
5. 强制杀进程、磁盘损坏、网络长时间不可用时，系统只能保留证据并安全停用，不能保证
   自动完成交易；这是 fail-closed 取舍。
6. 数据库中保留历史 Paper/Observe/审计证据；不会为了“看起来干净”删除被报告引用的
   失败或中止记录。忽略的运行时日志和临时文件可按保留策略归档，但不能改写原始证据。

## 7. 外部审计建议的验收顺序

1. 固定 `git rev-parse HEAD`、Node 版本和验证工件的提交/哈希。
2. 核对数据库为 `PAPER + LIVE_DISABLED`，确认 Live execution/order/fill 计数。
3. 执行全套测试和 `pnpm validate:live-production`。
4. 双击桌面入口，观察 `generatedAt` 和后台同步时间至少变化两次。
5. 点击右上角“退出”，确认端口关闭、session 失效、Gate 保持安全；再双击入口重启。
6. 在隔离钱包上连接并只完成身份签名，验证余额显示与实际返回值一致；不要把身份签名
   误当成交易授权。
7. 若要进入真实 Live，另行记录用户当次明确授权、地域/合规证据、每笔钱包弹窗确认和
   真实订单结果；不能仅凭本文件或自动化测试授权交易。

## 8. 交付判断

当以下条件全部满足时，程序可作为“可连接正式钱包的生产候选版本”交付：

- 主入口可双击启动；
- 右上角可安全退出；
- 重启后自动回到安全 Gate；
- 全套类型检查、测试和验证工件通过；
- Live 参数可保存、可按用户值执行，没有隐藏 100 pUSD/连续亏损限制；
- 钱包余额按实际值显示，零余额只在具体 BUY 时产生余额不足原因；
- 旧钱包账户切换不会丢失未完成订单、保留或持仓；
- 外部审计确认后，用户仍需在当次钱包会话中明确授权，系统才可以从 Paper 进入 Live。

“代码和验证通过”与“已经获准使用真实资金”始终是两个不同状态。
