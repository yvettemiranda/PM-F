# ni-k / Hecatonchires 外部审计文档

> 文档用途：交给外部审计、技术尽调、生产接入和安全复核人员使用。
> 文档日期：2026-07-29（Asia/Shanghai）
> 审计基线源码提交：以交付时 `git rev-parse HEAD` 和
> `data/operator/live-production-validation.json.sourceCodeCommit` 的一致值为准。
> 项目目录：`/Users/d4clt/Documents/Codex/2026-07-07/ni-k`
> 当前分支：`codex/operator-ui-integration`
> 项目名称：`ni-k`；操作台品牌：`Hecatonchires`

## 0. 给外部审计方的先读结论

本项目已经完成：

1. Polymarket 跟单系统的 Observe、Signal、Risk、Paper、Replay、账本、对账、恢复、审计和 Live Gate 主体架构。
2. 按用户指定的“3 → 2 → 1”顺序完成 Live/后端能力接线、可操作 localhost 控制台、Paper/隔离验证和安全门验证。
3. Hecatonchires 明亮 UI、目标/我的对照视图、可折叠参数与执行明细、Paper/LIVE 模式二次确认、真实后台快照和钱包连接页面。
4. 正式钱包的公开身份连接链：EIP-1193、一次性 chain-bound
   `personal_sign` challenge、会话租约、运行时绑定、钱包替换/断开/过期撤销。
5. 浏览器钱包的会话级签名通道：后端只投递当前 session 的精确
   `eth_signTypedData_v4` 或 `eth_sendTransaction` 请求；私钥、助记词和可复用
   API secret 不进入 Node、磁盘或前端 bundle。
6. 默认生产装配：浏览器钱包 signer、会话内惰性 CLOB L2 认证、真实只读余额/
   allowance/仓位、真实 CLOB 下单与取消、Polygon 收据确认、EOA 小额授权、二元
   CTF 赎回、官方 geoblock、时钟安全、合规声明、Live 账户和外部对账。
7. 小额 Live 风险参数：默认总资金 `10 pUSD`、单笔 `1 pUSD`、总敞口
   `3 pUSD`、单日亏损 `1 pUSD`；同时存在不可由 UI 放大的硬上限。
8. 生产启动闭环：配置确认会使旧钱包 session 失效；Live 请求、Gate 二次确认、
   同步恢复检查和 runtime 启动被串成一个闭环；启动失败自动回滚 Gate，后台循环
   异常自动 emergency stop；UI 宿主正常退出时先停用 Gate、停止 runtime、撤销
   钱包 session 并清除内存依赖。
9. 当前代码的全量类型检查、测试数量和证据文件由
   `pnpm validate:live-production` 在干净提交上重新生成并绑定到该 commit。
10. 当前源码提交 `15d96a74e828148e9bb96c38f7597430da04a901` 上连续完成两轮
    Observe Only，每轮 8 小时 10 分钟，均为 `DURATION_COMPLETE`、最终
    `SYNCED`、`liveStabilityEligible=true`，且没有验收 blocker。

本项目目前**没有**完成，也没有声称完成：

- 用户正式钱包的本轮实际连接和 EIP-1193 人工签名；
- 用户钱包内 CLOB 凭据派生、真实余额、allowance 和仓位的本轮实测；
- 真实 approve、submit、cancel、fill、redeem 或任何链上写入的本轮实测；
- 真实 Live 订单、成交、资金变化或小额灰度实盘；
- 外部审计签字和真实钱包/真实资金验收；
- 用户在未来小额实盘当次的最终二次确认；
- 通过测试结果自动打开 Live。

当前安全事实必须保持为：

| 项目 | 当前值 | 审计含义 |
|---|---|---|
| `execution_mode` | `PAPER` | 当前运行不进入真实资金执行 |
| `live_gate_state` | `LIVE_DISABLED` | Live Gate 默认关闭 |
| `liveAllowed` | `false` | 后端不允许真实 Live |
| Live execution | `0` | 没有真实 Live 执行样本 |
| Live order attempt/fill | `0 / 0` | 没有真实订单尝试或成交 |
| 真实链上写入 | `0` | 没有 submit、approve、redeem 等链上写入 |
| 私钥/seed | 未加载 | UI、默认服务和当前验证不读取私钥 |

因此，本文件的审计意见应理解为：

> “普通浏览器 EOA 钱包的小额生产代码路径已经闭环到真实 adapter；当前仍未连接
> 用户钱包、未验证真实资金、未发生用户当次最终确认，因此系统保持
> `PAPER + LIVE_DISABLED`。代码完成不等于真实资金验收，也不等于实盘授权。”

这不是投资建议、合规意见、法律意见或实时交易授权。

### 0.1 当前交付快照（2026-07-29）

本次审计交付在当前干净提交上新增了一个日常主入口，但没有把它放进 Paper
核心兼容性清单，因此不会因为“打开 UI”改变 Paper Core hash：

| 交付项 | 当前状态 | 说明 |
|---|---|---|
| 日常桌面入口 | 已完成 | `/Users/d4clt/Desktop/Polymarket验证_点这里/Hecatonchires.command` |
| 仓库启动脚本 | 已完成 | `scripts/launch-hecatonchires-ui.command` |
| 重复启动保护 | 已完成 | 先检查 `/api/operator/snapshot`，已有 UI 时只打开页面 |
| 本地服务边界 | 已完成 | 只监听 `127.0.0.1`，关闭入口终端会停止本次 UI 服务 |
| Paper 测试按钮 | 保留 | 三个旧按钮继续作为开发/验收/安全暂停工具，不作为产品主入口 |
| 最终 macOS `.app` | 尚未封装 | 等真实钱包验收和正式发布前检查完成后再打包 |

本次交付不改变以下安全事实：未连接钱包、未加载私钥、未启动真实 Live、未发送
订单或链上交易，系统继续固定为 `PAPER + LIVE_DISABLED + liveAllowed=false`。

当前生产验证工件的关键字段为：

```text
artifact: data/operator/live-production-validation.json
status: PASSED
sourceCodeDirty: false
testFileCount: 71
testCount: 854
typecheckPassed: true
fullTestPassed: true
diffCheckPassed: true
```

外部审计应以交付时 `git rev-parse HEAD` 与该工件的
`sourceCodeCommit` 完全一致为准。工件同时记录最终 Paper 报告和隔离验证文件的
SHA-256；它不把历史 Paper 报告伪装成当前提交重新产生的自然成交证据。

### 0.2 当前提交的两轮 8 小时 Observe 补充证据

在未启动 Paper、未连接钱包、未加载私钥、未装配订单逻辑的前提下，当前提交
`15d96a74e828148e9bb96c38f7597430da04a901` 连续完成两轮独立 Observe Only：

| 指标 | 第一轮 | 第二轮 |
|---|---:|---:|
| Observe run | `3a9f1686-ba4a-4dd1-9426-da20cd8b36b8` | `aead6def-fc4d-466a-87c6-d665255acde0` |
| 开始时间（UTC） | `2026-07-28T08:09:24.185Z` | `2026-07-28T16:19:30.734Z` |
| 结束时间（UTC） | `2026-07-28T16:19:24.788Z` | `2026-07-29T00:29:32.652Z` |
| 有效时长 | `29,400,603 ms` | `29,401,918 ms` |
| 成功/失败轮询 | `10,988 / 43` | `11,843 / 26` |
| 处理事件/发布 Signal | `62 / 31` | `29 / 10` |
| scheduling gap | `0` | `0` |
| major desync | `0` | `0` |
| unrecovered connection gap | `false` | `false` |
| checkpoint hash mismatch | `false` | `false` |
| 最终同步 | `SYNCED` | `SYNCED` |
| Observe 验收 | `SHORT_SOAK_PASSED` | `SHORT_SOAK_PASSED` |
| Live 稳定性资格 | `true` | `true` |
| blocker | `[]` | `[]` |

两轮均出现已恢复的 API 失败和最终已消失的 minor diff，因此保留
`RECOVERED_API_FAILURES_OBSERVED` 与 `TRANSIENT_MINOR_DIFF_OBSERVED` 警告；这两个
警告没有被删除或降级，但不构成当前 Observe 验收 blocker。

第二轮自然结束后，`launchctl submit` 推断的 KeepAlive 曾自动启动第三轮
`4f36e7c7-d3ae-4648-8d65-343e0f7c3e0b`。该轮仅运行 `77,452 ms`，随后按用户要求
安全中止；数据库原始状态保留为 `ABORTED`，报告明确
`liveStabilityEligible=false`、blocker 为 `MINIMUM_SOAK_NOT_REACHED`。该短轮不计入
任何 8 小时时长，也不影响前两轮通过结论。KeepAlive job 已移除并禁用。

两轮通过报告、短轮中止报告及其 SHA-256 均纳入最新版外部审计包。

审计注意：运行数据库中的默认 `live_gate_state` 行创建于
`2026-07-23T21:57:46.680Z`，其持久化 `source_code_commit` 为更早的默认禁用状态提交
`7a640a71a384e8ad02cb9c36046496daaf4538a8`。本次 Observe Only 没有激活 Live Gate，
因此没有为了“追齐”源码提交而改写这条历史元数据。它只证明默认 Gate 仍为
`PAPER / LIVE_DISABLED`，不作为当前提交的生产验证证明；当前提交证明以两轮 Observe
报告、`live-production-validation.json` 和精确源码归档为准。

---

## 1. 文档控制与审计口径

### 1.1 审计对象

审计对象是独立的 ni-k Polymarket copy-trading system，不复用旧版
PolymarketBot 的代码、数据库、仓位模型、账本、执行逻辑或页面。

当前目标地址：

```text
0x1f9e15f39bbd5d163b0eacf0fbef647ced9e4f1a
```

旧地址、旧 Core、旧 Campaign 只能作为历史证据引用，不能重新绑定到当前目标，也不能把不同 Core 的时长伪称为单一 Campaign 内建时长。

### 1.2 审计基线

外部审计应固定以下信息：

- Git commit：审计时读取 `git rev-parse HEAD`，并与生产验证 artifact 核对
- Git 工作树：审计前应重新确认 clean
- Node：`>=24.14.0 <25`
- package manager：`pnpm@11.9.0`
- TypeScript：`6.0.3`
- Vitest：`4.1.10`
- viem：`2.55.0`
- SQLite：Node 24 `node:sqlite`
- 当前源码目标版本：
  - Schema `2.31.0`
  - Signal `1.11.0`
  - Strategy `2.9.0`
  - Risk `1.10.0`
  - Replay `2.5.0`
  - Paper `1.18.0`
  - Live `1.16.0`
  - Validation `1.9.0`
  - Operational `1.9.0`
  - Ruleset `v1.11.0`
  - Config `v1.7.0`

注意：历史 Paper 最终报告中的正式运行 commit 是较早的
`2bdb7e3bd2553b4cb8b64e4df78784a5d58ebf2b`。生产验证命令会把该报告和隔离验证
文件的 SHA-256 与当前干净源码 commit 一起写入 ignored artifact；这只能证明
“当前代码测试通过且引用了既有 Paper 证据”，不能把历史报告重新描述为当前
commit 上重新跑出的自然 24 小时 Paper。

### 1.3 用户指定交付顺序

项目按以下顺序推进：

1. **阶段 3：Live/后端能力和安全接线**
2. **阶段 2：Paper/Observe 控制台和 Live 控件**
3. **阶段 1：统一 Paper、隔离 Live、安全 Gate 验证**

顺序不是“先启用 Live”，而是“先把能力做完整，再把 UI 接上，最后验证；验证通过也不等于获得实盘授权”。

---

## 2. 系统概览

### 2.1 业务目标

系统从目标钱包的公开 Polygon 活动中识别目标交易，经过数据完整性、市场语义、Risk 和执行资格判断后：

- 在 Paper 中以隔离账户模拟跟单；
- 在正式 EOA 钱包连接后由默认生产 host 装配真实依赖，并通过小额参数、钱包授权、
  Gate 和最终确认后，才具备进入 Live 的技术路径；
- 把目标行为和我的 Paper/Live 执行结果放在同一张对照台展示。

### 2.2 逻辑数据流

```text
Polygon / Data API / Activity / Positions / pUSD
                 │
                 ▼
      Observe + checkpoint + reconciliation
                 │
                 ▼
   Capture / immutable evidence / source version
                 │
                 ▼
       Signal + execution context
                 │
                 ▼
       Risk Manager + safety gates
          │                    │
          ▼                    ▼
  Paper Executor        Live Gate / Live Runtime
  isolated account      connected EOA production assembly
          │                    │
          ▼                    ▼
 Paper ledger       production ledger/order state
          │                    │
          └──────────────┬─────┘
                         ▼
             Operator dashboard / audit projection
```

### 2.3 默认 Live 生产数据流

```text
Browser EIP-1193 wallet
          │ eth_requestAccounts
          │ eth_chainId
          │ personal_sign(one-time challenge)
          ▼
LiveWalletSessionManager
          │ public address/network/session lease only
          ▼
assembleDefaultConnectedLiveRuntime
          │
          ├─ secure signer
          ├─ wallet provider + provider chainId
          ├─ authenticated CLOB adapter
          ├─ readonly balance/allowance/position provider
          ├─ market data provider
          ├─ compliance provider
          ├─ geoblock provider
          ├─ clock safety provider
          └─ ConfiguredOperatorLiveRuntimeActions
          ▼
assembleConnectedLiveRuntime
          │ signer/address/provider chain verification
          ▼
LiveRuntime + LiveExecutor
          │
          ▼
Live Gate preflight → explicit request → explicit confirmation
```

当前默认 `prototype/live-ui/server.mjs` 已注入
`assembleDefaultConnectedLiveRuntime`：完成 EOA 钱包连接后会自动装配上述生产依赖。
钱包未连接、生产验证 artifact 与源码 commit 不一致、任一外部检查失败或用户未完成
当次最终授权时，装配或 Gate 都会 fail closed。

---

## 3. 架构和代码分层

### 3.1 领域与版本层

主要职责：

- 领域对象、状态机、固定精度金额和价格；
- Signal、Execution Context、Risk Decision；
- Ruleset Registry、Core identity、Source version；
- 不可变审计和内容寻址证据。

主要位置：

- `src/domain/`
- `src/signal-context/`
- `src/execution/`
- `src/services/`
- `src/operational/`

审计重点：

- 旧 Ruleset 不能被新规则重新解释；
- 规则变化会改变 ruleset/core identity；
- 不同 Core 的 Campaign 时长不写回为同一 Campaign；
- 金额和价格使用固定精度，避免浮点误差影响风控。

### 3.2 Observe 和数据完整性层

主要能力：

- Polygon 已确认区块中的目标 `OrderFilled` 扫描；
- WebSocket 只做唤醒，不直接产生 Signal；
- Trades/Activity 交叉确认；
- Positions/pUSD 全量核对；
- checkpoint、cursor、gap recovery；
- reorg 检查；
- `SYNCED`、`MINOR_DIFF`、`MAJOR_DESYNC` 状态；
- Capture Manifest、原始证据和派生 proof。

关键策略：

- 公开 WebSocket 断线不会直接生成错误 Signal；
- 数据源身份无法证明一致时 fail closed；
- 发生确认重组时，只有可证明没有已发布目标成交且上一锚点仍匹配，才允许回退重扫；
- `MAJOR_DESYNC`、无法证明的 gap、损坏的证据不自动跳过；
- 旧 Observe Run 的事故不能无条件污染新 Run，修复后事故按 Run 归属隔离；
- 证据不完整时游标不前移，下一轮重新验证。

主要位置：

- `src/observe/`
- `src/services/capture-manifest.ts`
- `src/validation/`
- `src/domain/idempotency.ts`
- `src/services/trade-multiplicity-evidence.ts`

### 3.3 Signal、Risk 和执行资格层

Signal 只有同时满足以下条件，才可进入 Paper/Live 执行层：

1. 目标交易身份和来源证据通过；
2. 市场元数据和 outcome 语义足够；
3. execution context 完整；
4. 不是 gap、重组、证据缺失或不支持活动；
5. Risk Manager 返回 `ALLOW`；
6. 对应账户、账本和 Gate 状态允许执行。

断线或不完整数据下，Signal 不能进入执行层。

### 3.4 Paper 层

Paper 是独立的模拟账户、reservation、Position、Execution、Order、Fill、Cash、Fee 和 PnL 账本。

已实现能力：

- 模拟 FAK；
- 深度 VWAP；
- 目标价和含手续费价格校验；
- 最低金额和最大金额；
- 追单次数限制；
- 止损、平仓、结算和尾仓；
- Paper 重启恢复；
- Paper 账户跨 replacement Campaign 的安全 handoff；
- 估值不完整时不消费新 BUY；
- final drain 有界重试；
- Paper 与 Live 账本隔离。

重要 Paper 业务规则：

| 规则 | 当前约束 |
|---|---|
| 小额 BUY | 目标资金占比 `<1%` 时每笔 `1—5 pUSD`，市场最低额超过 `5 pUSD` 直接跳过 |
| 小额追单 | 首次实际开仓不计入；后续小额实际成交最多 `9` 次 |
| 比例 BUY | 完整估值用 total equity；available cash 只作为支付上限 |
| 价格 | 含手续费 VWAP 在目标价 `90%—105%`，且不超过 `0.95` |
| FAK | 每笔目标 BUY 独立判断，不累计未成交部分 |
| 普通 SELL | 达到 `95%` 时按本轮全部退出 |
| 特殊退出 | MERGE/CONVERSION 等价退出不套普通 `95%` 规则 |
| 止损 | 退出后锁定同标的，直到本轮仓位和义务归零 |

### 3.5 Live 架构层

Live 不是浏览器直接调用交易 API，而是显式依赖装配：

- `LiveRuntime`
- `LiveExecutor`
- `LiveRunner`
- `LiveGateService`
- `LiveIdentityBinding`
- `OrderAdapter`
- `Signer`
- `WalletProvider`
- `LiveReadonlyBalanceProvider`
- `LiveMarketDataProvider`
- `ComplianceProvider`
- `GeoblockProvider`
- `ClockSafetyProvider`

可复用核心在调用方未提供生产依赖时默认使用 disabled/fake 或未配置状态。
localhost Operator UI 则只在正式 EOA 会话验证通过后调用默认生产装配；该入口不扫描
环境、不发现私钥，CLOB 凭据仅在需要认证访问时通过钱包签名惰性派生并保留在内存。

### 3.6 Operator 控制面

主要文件：

- `src/operator/operator-control.ts`
- `src/operator/operator-dashboard.ts`
- `src/operator/operator-actions.ts`
- `src/operator/operator-ui-server.ts`
- `src/operator/operator-mutation-guard.ts`
- `src/operator/diagnostic-redaction.ts`

控制面提供：

- 目标地址查看和变更；
- Ruleset profile 保存、恢复默认；
- Paper start/stop/recover；
- Live Gate preflight/request/confirm/recover/emergency-disable；
- 钱包 challenge/connect/disconnect；
- session-bound typed-data/transaction request broker；
- 小额 Live 参数、合规确认和交易授权检查；
- Gate 确认后的原子 runtime start 与失败回滚；
- Live production readiness；
- 数据库、账户、执行、订单、成交、持仓、账本、对账、恢复、隔离异常和审计投影。

前端不是权威状态源。前端每 3 秒读取后台快照，所有 mutation 通过同源 localhost API 进入既有服务和安全门。

---

## 4. 当前已经完成的安全控制

### 4.1 全局模式硬门

默认数据库模式固定：

```text
execution_mode=PAPER
live_gate_state=LIVE_DISABLED
liveAllowed=false
```

模式切换不是普通表单字段；它必须经过后台 Gate、预检、请求、二次确认和审计记录。

### 4.2 钱包连接安全

实现位置：`src/operator/live-wallet-session.ts`

当前流程：

1. 浏览器调用 `eth_requestAccounts`；
2. 浏览器读取 `eth_chainId`；
3. 后端只为支持的 Polygon 主网 `137` 或 Polygon Amoy `80002` 创建 challenge；
4. challenge 绑定 `challengeId`、network、chainId、时间；
5. 浏览器用 `personal_sign` 签署说明文本；
6. 后端用 EIP-191 验证签名和地址控制权；
7. challenge 单次消费，不能重放；
8. 后端仅保存内存 session；
9. 配置文件只写公开地址和网络；
10. 不保存签名、私钥、助记词、API key 或可复用交易授权。

challenge 文案明确写明：

```text
This signature only proves control of the public wallet address.
It does not authorize trades or move funds.
```

### 4.3 钱包会话租约和撤销

连接会话的默认租约为 `30 min`。会话到期由后台定时器触发，不依赖下一次浏览器请求。

会话被以下任一事件撤销：

- 用户主动断开；
- session 过期；
- 连接新钱包替换旧钱包；
- session ID、地址或 chainId 漂移；
- runtime binding `assertCurrent()` 失败。

撤销后的行为：

- Live action capability 降回 `PENDING_PREREQUISITES`；
- start/cancel/reconcile/recover/retry 被拒绝；
- 运行中的 runtime 收到 abort；
- 调用 emergency stop；
- emergency stop 失败时最多重试一次；
- 断开接口在停用仍失败时返回 `503`，不假报成功。

### 4.4 生产装配和链核对

实现位置：

- `src/live/live-connected-runtime.ts`
- `src/operator/default-connected-live-runtime.ts`
- `src/live/browser-wallet-clob-signer.ts`
- `src/live/session-authenticated-clob-client.ts`
- `src/live/polymarket-readonly-wallet-provider.ts`
- `src/live/browser-wallet-onchain.ts`
- `src/live/wallet-provider.ts`
- `src/operator/operator-actions.ts`
- `src/operator/operator-ui-server.ts`

装配要求：

- 当前 session 必须是 Polygon 主网；
- localhost production host 只在钱包身份证明通过后调用
  `assembleDefaultConnectedLiveRuntime`；
- 当前源码必须是 clean commit，并存在 commit-bound production validation artifact；
- 生产配置的钱包、trading/funder、signature type、network 和小额限额必须一致；
- `walletProvider.getChainId()` 必须存在；
- provider 自身读取的 chainId 必须是 `137`；
- provider chainId 必须与 factory bundle 的 `verifiedChainId` 一致；
- signer 地址必须等于钱包 session 地址；
- proxy/funder 地址必须继续经过 `LiveIdentityBinding`；
- factory 返回的 runtime 和 Gate action 必须由服务端 wrapper 绑定当前钱包 session；
- 未绑定、已撤销或漂移的 action 不得继续执行。

外部规格核对基线：

- [Polymarket Trading Overview](https://docs.polymarket.com/trading/overview)；
- [Polymarket Deposit Wallets](https://docs.polymarket.com/trading/deposit-wallets)；
- [Polymarket CLOB Client V2](https://github.com/Polymarket/clob-client-v2)。

仓库固定使用 `@polymarket/clob-client-v2@1.0.8`，实际依赖完整性以
`pnpm-lock.yaml` 为准。合约地址由该 SDK 的 Polygon `getContractConfig` 返回，不在
UI 中接受任意 spender 或 Conditional Tokens 地址。

### 4.5 凭据边界

当前浏览器和 localhost production host：

- 不读取私钥；
- 不读取 seed/mnemonic；
- 不把 API key/secret/passphrase 写入配置、磁盘、快照或日志；
- 为 crash recovery 和未知提交结果对账，`live_orders.signed_payload_json` 会持久化
  精确 signed order intent；该字段不进入 UI、普通日志或审计包，但必须按敏感数据
  管理；
- CLOB L1 EIP-712 只在第一次认证操作时由当前钱包 session 签署；
- 派生的 L2 API credentials 只存在于内存 SDK 实例，session 失效即丢弃引用；
- 每个订单 EIP-712 payload 都由 SDK 构造，并由当前浏览器钱包逐次签名；
- 链上授权和赎回只通过精确 `eth_sendTransaction` 请求交给当前钱包确认；
- 不自动发现文件或环境变量中的生产 signer；
- 不根据配置文件勾选真实 provider；
- 不自动把钱包连接视为交易授权。

当前 UI 只开放已经形成闭环的普通 EOA 浏览器钱包。Proxy、Safe 和 EIP-1271
签名类型在底层 signer/identity 模型中保留，但链上 allowance/redeem 仍需要
Polymarket 官方账户初始化或 relayer；因此它们没有被 UI 伪装成“一连接即可完整
实盘”。如后续开放智能钱包，必须补齐官方 relayer、单独测试和审计。

### 4.6 钱包交易授权和链上写入边界

实现位置：`src/live/browser-wallet-onchain.ts`

- collateral 只检查 Exchange V3 spender；
- allowance 不足时，EOA 可请求 `approve(exchangeV3, confirmedBankroll)`；
- outcome token 只请求 `setApprovalForAll(exchangeV3, true)`；
- 每笔交易都需要钱包单独确认；
- 后端验证返回值必须是 32-byte transaction hash；
- 独立 Polygon RPC 等待成功 receipt 和至少 2 个 confirmation；
- revert、超时、hash/receipt 不匹配全部失败关闭；
- 二元市场赎回调用 Conditional Tokens `redeemPositions`；
- 智能钱包 allowance/redeem 没有官方 relayer 时明确拒绝。

小额 Live 上限在写入和读取时都会校验：总资金最多 `100 pUSD`、单笔最多
`10 pUSD`、总敞口最多 `25 pUSD`、单日亏损最多 `10 pUSD`，并要求
`单笔 ≤ 总敞口 ≤ 总资金`、`单日亏损 ≤ 总资金`。配置文件若被手工改成超限值，
读取会退回未连接、未确认的安全默认状态，不能把超限配置带入生产装配。

当前没有调用上述链上写入口；本轮验证仅覆盖隔离测试。

### 4.7 快照和日志脱敏

Operator snapshot 只返回：

- 结构化状态；
- 错误代码；
- 报告和日志索引；
- 文件大小和更新时间；
- 公开地址和网络；
- 结构化失败原因。

不返回：

- `live_order_attempts.request_json`；
- `live_order_attempts.response_json`；
- 原始日志尾部；
- 私钥或认证凭据；
- 可直接复用的 signed order。

### 4.8 数据库和迁移安全

项目使用 SQLite：

- 迁移前 WAL-safe Online Backup；
- `integrity_check`；
- `foreign_key_check`；
- 运行锁和单实例控制；
- Campaign/Session/Account 具有明确作用域；
- 原始失败证据不可覆盖；
- Paper/Live 账本隔离；
- replacement Campaign handoff 有前置条件；
- 无法证明 handoff 安全时不接续。

---

## 5. UI 和操作台审计说明

### 5.1 UI 已实现内容

UI 位于：

- `prototype/live-ui/app.js`
- `prototype/live-ui/styles.css`
- `prototype/live-ui/index.html`
- `prototype/live-ui/assets/island-background-v3.png`

页面展示：

- 当前模式 Paper/Live；
- 模式二次确认；
- 目标地址输入和确认；
- 总权益、可用现金、持仓价值、已实现盈亏；
- 跟单设置；
- 目标 / 我的对照卡；
- BUY、SELL、YES、NO 语义色；
- 跟单状态、执行状态、成交价格、投入金额、占比；
- 执行明细表；
- Live readiness；
- 钱包连接/断开；
- EOA 小额 Live 参数保存、固定确认词和合规确认；
- allowance 检查/设置入口；
- 钱包签名与链上交易请求的逐次人工确认；
- Gate 预检、请求、确认、恢复和紧急停用入口；
- Paper 生命周期；
- 后台日志、报告、对账、恢复和审计索引。

### 5.2 UI 不承担的职责

UI 不决定：

- 是否允许 Live；
- 是否允许下单；
- 是否允许取消；
- 是否允许跳过 gap；
- 是否允许绕过 geoblock；
- 是否允许把 Paper 当作真实成交；
- 是否允许读取私钥；
- 是否允许自动恢复 Live。

所有关键状态以后台 snapshot、Live Gate、Operator capability 和 SQLite 证据为准。

### 5.3 推荐的实际操作顺序

当前 UI 设计的安全顺序是：

1. 先使用 Paper，确认目标地址和跟单参数；
2. 保持 Paper 停止或安全状态；
3. 点击右上角 Paper，选择切换到 Live；
4. 连接 Polygon 主网普通浏览器钱包并完成地址控制权签名；
5. 保存小额 Live 参数和合规声明；
6. 因配置变化自动断开后重新连接同一钱包；
7. 点击“检查 / 设置交易授权”，逐笔审阅钱包交易；
8. 发起 Live Gate 检查；
9. 输入 `ENABLE LIVE TRADING` 完成最终二次确认；
10. Gate 确认后，后台先同步恢复；只有恢复 ready 才启动 runtime；
11. 任一检查、钱包拒绝、网络漂移、后台异常或启动失败都保持或退回
    `PAPER + LIVE_DISABLED`。

第 4、7、9 步必须由用户本人在未来实际操作。本轮开发没有代替用户执行这些步骤。

### 5.4 成品式日常入口与测试入口的边界

当前测试阶段已经具备“像程序一样双击打开”的主入口，但还没有把 Node.js 运行时
封装进最终 `.app`：

1. 双击桌面 `Hecatonchires.command`；
2. 入口先请求本地 `GET /api/operator/snapshot`；
3. 如果控制台已经运行，只调用系统 `open` 打开现有
   `http://127.0.0.1:4173/`，不创建第二个服务；
4. 如果没有运行，入口启动 `pnpm operator:ui`，等待 snapshot 可读后再打开浏览器；
5. 入口进程保持终端存活，用户关闭终端或按 `Ctrl-C` 时先停止本次 UI 服务；
6. 入口脚本位于 `scripts/`，不属于 `操作入口/`，避免纯 UI 启动操作改变 Paper
   Core compatibility manifest。

三个旧桌面按钮的审计定位如下：

| 按钮 | 用途 | 是否是产品主入口 |
|---|---|---|
| `1_开始或继续Paper累计验证.command` | 启动/继续 Paper 长时验证 | 否，开发/验收工具 |
| `2_安全暂停并生成报告.command` | 安全停止 Observe/Paper 并生成报告 | 否，开发/验收工具 |
| `3_查看进度和打开最新结果.command` | 查看累计进度并定位最新 ZIP | 否，开发/验收工具 |

正式产品发布时，建议只保留一个 Hecatonchires 应用图标；三个按钮可以继续留在
内部验收目录，但不应出现在最终用户的产品安装包中。当前主入口仍依赖本机
`pnpm` 和 Node.js 20+，因此外部审计应把“已具备开发阶段可双击入口”和“已完成
自带运行时的正式 macOS `.app`”分开判定。当前项目要求 Node.js `>=24.14.0 <25`。

### 5.5 视觉资源和许可证风险

当前使用独立实现的 Animal Island-inspired CSS 视觉，参考仓库为：

```text
https://github.com/guokaigdg/animal-island-ui
```

当前没有复制参考仓库代码、图片、字体或 Nintendo 资产。海豹、边牧、乌鸦背景为项目原创绘制。

参考仓库许可证为 CC BY-NC 4.0。若未来项目商业化，必须：

1. 重新设计并去除可能受限制的视觉表达；或
2. 获取明确的商业授权；
3. 由法务确认品牌、角色、字体、图片和代码来源。

---

## 6. Paper 验证证据

### 6.1 最终报告位置

```text
data/operator/final-reports/ni-k-paper-mixed-core-24h-final-20260727-0300.md
```

报告结论为用户授权的独立跨 Core 汇总：

```text
OWNER_AUTHORIZED_MIXED_CORE_AGGREGATION
OWNER_AUTHORIZED_EXTERNAL_FINALIZATION_EXCEPTION
```

独立汇总有效时长：

```text
86,400,012 ms
```

即超过 24 小时门槛 `86,400,000 ms` 十二毫秒。

### 6.2 跨 Core 口径

报告明确区分：

- 旧 Core 的有效轮次；
- 新 Core 的有效轮次；
- 一个最终估值超时但经用户授权仅纳入独立汇总的失败轮；
- 最终修复验证轮；
- 不能计入的合盖失败、重组失败和旧事故误拒轮次。

原始 Campaign/Session 状态和 `countsTowardCampaign` 没有被篡改。

审计方不能把 `86,400,012 ms` 重新描述为：

> “单一 Campaign 原生完成 24 小时。”

正确描述是：

> “在用户授权的独立业主汇总口径下，多个 Core/Session 的有效区间合计超过 24 小时；其中包含一个保留原始 FAILED 状态的外部收尾例外。”

### 6.3 最终正式运行样本

报告中的最终修复验证轮：

- Core：`e284de7d...`
- Campaign：`PC-53F4B34D814FCDDFB663`
- Session：`PS-04B30EBA4C1C49656AF7`
- Observe run：`df205d83-d073-4de7-9a0f-3a2915c8ab8a`
- 有效时长：`14,400,002 ms`
- 成功轮询：`10,241`
- 失败轮询：`25`，均已恢复
- 目标事件：`25`
- Signal：`13`
- BUY：`11`
- SELL：`2`
- scheduling gap：`0`
- major desync：`0`
- 最终同步：`SYNCED`
- Paper execution：`11`
- Paper orders：`1,239`
- fills：`0`
- Paper positions：`0`
- 手续费：`0`
- PnL：`0`
- active reservation：`0`
- 现金和总权益：`1,000,000,000 micros`
- 数据库 quick check：`ok`
- foreign key issues：`0`

### 6.4 Paper 证据的限制

本轮所有可执行 BUY 因价格、盘口或截止条件正常过期，没有自然成交。

因此当前没有自然覆盖：

- FILL；
- POSITION_UPDATE；
- FEE；
- realized PnL；
- unrealized PnL；
- 买入后自然平仓。

该事实不表示 Paper 逻辑漏跟。它表示当前市场条件没有满足安全执行边界。

外部审计方应区分：

| 证据类型 | 当前状态 | 是否等同真实交易 |
|---|---|---|
| Paper executor 单元/集成测试 | 有 | 否 |
| fake signer/order adapter 隔离测试 | 有 | 否 |
| Paper 24h 用户授权跨 Core 汇总 | 有 | 否 |
| 自然 Paper fill | 当前没有 | 否 |
| 真实 Live order | 没有 | 否 |
| 真实资金 PnL | 没有 | 否 |

### 6.5 当前提交的 Observe 长时证据

当前源码提交已经补齐两轮独立的 8 小时 10 分钟 Observe Only。两轮都满足：

- `sourceCodeDirty=false`；
- `DURATION_COMPLETE`；
- `schedulingGapCount=0`；
- `majorDesyncCount=0`；
- `unrecoveredConnectionGap=false`；
- `checkpointProjectionHashMismatch=false`；
- `finalSyncStatus=SYNCED`；
- `liveStabilityEligible=true`；
- `liveStabilityBlockers=[]`；
- `privateKeyLoaded=false`；
- `orderLogicPresent=false`；
- `ordersCreated=0`。

证据文件：

```text
data/observe/archive/observe-8h-run-3a9f1686-ba4a-4dd1-9426-da20cd8b36b8-passed.json
data/observe/archive/observe-8h-run-aead6def-fc4d-466a-87c6-d665255acde0-passed.json
data/observe/archive/observe-8h-run-4f36e7c7-d3ae-4648-8d65-343e0f7c3e0b-aborted.json
```

其中第三个文件是 KeepAlive 自动重启后的短时中止证据，不是通过证据，不能计入
8 小时验证。外部审计应同时查看它，以确认系统没有删除失败/中止历史。

---

## 7. 当前验证证据

### 7.1 当前源码基线验证

在本文件所述工作树上完成，并要求在最终干净交付 commit 再由
`pnpm validate:live-production` 固化：

```text
TypeScript --noEmit                     PASS
生产路径定向测试 13 files / 70 tests     PASS
全量测试 71 files / 854 tests            PASS
node --check prototype/live-ui/app.js   PASS
git diff --check                        PASS
```

Node 24 的 `node:sqlite` experimental warning 是环境提示，不是测试失败。
最终有效测试数字以 commit-bound production validation artifact 为准；任何后续源码
变更都会使该 artifact 与当前 commit 不一致并阻断默认生产装配。

当前交付工件的精确记录为：

```text
status: PASSED
sourceCodeDirty: false
testFileCount: 71
testCount: 854
typecheckPassed: true
fullTestPassed: true
diffCheckPassed: true
finalPaperReportSha256: e78c90143aba9a1ba3fece487c5deb96e49c41eae528a3cebd561445bf641bce
isolatedVerificationSha256: 76752e4788a8e37d4f1a2a2cd9cf85634c7fc662aa8cd9393b0611babca75a63
```

审计方必须重新读取 `sourceCodeCommit`，不能只复制上述数字。只要源码、测试清单、
审计文档或运行时实现发生新提交，就必须重新运行验证命令并更新该 artifact。

### 7.2 定向测试覆盖

本轮重点测试：

- `tests/live-wallet-session.test.ts`
  - 正常 Polygon 钱包证明；
  - 无秘密字段；
  - 签名错误；
  - challenge 重放；
  - challenge 过期；
  - chain mismatch；
  - session replacement；
  - session disconnect；
  - 后台租约自动过期。
- `tests/live-connected-runtime.test.ts`
  - Amoy 不允许进入生产装配；
  - 主网 session 才能请求生产依赖；
  - wallet provider 缺失 chain verifier 时拒绝；
  - provider chain 与 production chain 不一致时拒绝。
- `tests/operator-actions.test.ts`
  - 配置 Live action；
  - session replacement 后 emergency stop；
  - capability 降级；
  - 失效后 cancel/retry 等操作被拒绝。
- `tests/operator-ui-server.test.ts`
  - EIP-1193 challenge/connect/disconnect API；
  - 公开配置只写公开字段；
  - factory 接线；
  - disconnect 后 capability/readiness 降级；
  - 失效后 runtime start 被后端拒绝；
  - Paper/Live/Gate API 路由。

### 7.3 UI 验证

此前 localhost 实机检查覆盖：

- 桌面首屏；
- Live 面板和无钱包提示；
- 参数折叠和保存；
- PAPER/LIVE 二次确认；
- 目标/我的对照卡；
- 展开执行明细；
- Animal Island-inspired 背景；
- 海豹、边牧、乌鸦层级和透明度；
- 390px 移动布局；
- 无横向溢出；
- 无浏览器控制台错误。

审计方应在当前基线重新打开 UI，不能只依赖历史截图。

本次主入口的实际短启动验收还包括：

- 使用独立 localhost 端口启动 `scripts/launch-hecatonchires-ui.command`；
- `/api/operator/snapshot` 可读，并返回 `PAPER/LIVE_DISABLED`；
- 以相同端口重复执行入口时返回“已在运行”并复用现有服务；
- 终止入口进程后，snapshot 不再可读，子服务被清理；
- `zsh -n` 检查仓库入口和桌面 wrapper 通过；
- 该入口未加入 `操作入口/`，不会进入 Paper core compatibility manifest。

---

## 8. 已完成、未完成和“不要误判”的矩阵

| 能力 | 当前状态 | 证据 | 是否可直接用于真实资金 |
|---|---|---|---|
| Observe 目标交易识别 | 已实现，当前提交已完成两轮 8h10m | Observe 报告、Capture、reconciliation、测试 | 否，不等同真实资金执行 |
| Signal/Risk | 已实现 | Signal context、Risk tests | 否 |
| Paper 模拟执行 | 已实现 | Paper executor、账本、Paper report | 否 |
| Paper 24h 独立汇总 | 已完成 | final report | 否，且不是单 Campaign 原生 24h |
| Replay/一致性/恢复 | 已实现并有回归 | validation tests/reports | 否 |
| Live Gate 架构 | 已实现 | `live-gate-service.ts`、Gate tests | 否，默认关闭 |
| Live Runtime 架构 | 已实现 | `live-runtime.ts`、`live-executor.ts` | 代码可用，真实钱包未验收 |
| Live 身份绑定 | 已实现 | `live-identity-binding.ts` | 否 |
| 钱包公开身份连接 | 已实现 | `live-wallet-session.ts` | 否，只证明地址控制权 |
| 默认生产装配 | 已实现并接入 localhost host | `default-connected-live-runtime.ts` | 需真实钱包验收 |
| Secure signer | EIP-1193 EOA 已实现 | `browser-wallet-clob-signer.ts` | 需用户逐次签名 |
| 认证 CLOB | 会话内惰性派生已实现 | `session-authenticated-clob-client.ts` | 需真实钱包验收 |
| 只读余额/仓位 | CLOB + Data API provider 已实现 | `polymarket-readonly-wallet-provider.ts` | 需真实账户验收 |
| Approve/redeem | EOA 真实交易构造和 receipt 已实现 | `browser-wallet-onchain.ts` | 本轮未实际发送 |
| Compliance/Geoblock/Clock | provider 已装配 | production factory、Gate | 需真实网络新鲜证据 |
| 真实订单 submit/cancel | 真实 adapter 已装配 | `polymarket-clob-adapter.ts` | 本轮未实际发送 |
| 真实 wallet funds | 未提供证据 | 无 | 否 |
| 真实订单 | `0` | final report | 否 |
| 用户最终 Live 授权 | 未发生 | Gate pending | 否 |
| 真实小额灰度 | 未开始 | 无 | 否 |

---

## 9. 当前风险登记册

### R-001：真实钱包和生产外部事实尚未验收（阻断级）

- 状态：Open；代码实现已完成，外部验收未完成
- 影响：在没有用户真实 EOA、真实余额、allowance、官方 API 响应和钱包签名的情况下，
  不能证明生产环境端到端可用。
- 当前控制：无钱包时 default runtime 不装配；readiness 保持 pending；任何请求失败
  都不会把 Gate 留在 active。
- 必须完成：用户按 UI 顺序连接 Polygon EOA，完成只读核对、CLOB 凭据签名和
  allowance 检查，并由审计方保存脱敏结果。

### R-002：没有真实资金和真实交易证据（阻断级）

- 状态：Open
- 影响：无法证明订单签名、资金限额、成交回报、取消、恢复和 PnL 在真实网络有效。
- 当前控制：这些入口只有在钱包连接、参数确认、Gate 和用户逐笔确认后可达；
  本轮没有调用。
- 必须完成：先真实只读核对，再在用户明确授权下执行最小额度 canary，并验证
  submit/cancel/fill/reconcile/emergency-stop。

### R-003：用户最终授权不存在（阻断级）

- 状态：Open
- 影响：即使技术 readiness 全部通过，也不能进入 Live。
- 当前控制：`USER_AUTHORIZATION` readiness 需要数据库中有明确授权，模式切换有 Gate。
- 必须完成：生产前置条件全部通过后，用户重新确认精确授权内容、账户、限额、持续时间、撤销方式。

### R-004：自然成交覆盖不足

- 状态：Open
- 影响：Paper 还没有自然 FILL、FEE、PnL 和买入后平仓样本。
- 当前控制：不放宽限价、不伪造 fill、不把 fake/isolated 样本称为自然成交。
- 必须完成：在当前源码基线继续自然市场 Paper 观察，或者由审计方明确接受“逻辑覆盖与自然覆盖分离”。

### R-005：历史 Paper 证据与当前源码基线不同

- 状态：Partially closed；当前提交 Observe 已补齐，Paper 24 小时仍是历史提交证据
- 影响：当前提交已有两轮 8 小时 10 分钟 Observe，但用户授权的 Paper 24 小时独立
  汇总仍引用较早 Core/commit，且没有自然 fill。
- 当前控制：两轮 Observe 报告直接绑定当前提交；owner-accepted 历史 Paper 报告和
  隔离验证以 SHA-256 写入当前 commit 的 production validation artifact；运行时 Gate
  仍检查实时 `SYNCED`、gap、checkpoint、dirty tree 和新鲜度。
- 必须完成：外部审计方决定是否接受“当前提交两轮 Observe + 历史 Paper 24 小时 +
  当前代码全量回归”的组合口径；若不接受，再在冻结提交上重跑所需 Paper 时长。

### R-006：跨 Core 24h 是独立汇总，不是单 Campaign 原生时长

- 状态：已受控
- 影响：审计或运营报告若表述错误，会夸大验证结论。
- 当前控制：原始报告保留 FAILED/count=false，独立报告明确例外。
- 必须完成：任何外部报告都保留原始 Campaign/Session 表和独立汇总表。

### R-007：SPLIT/CONVERSION 不是链上复制

- 状态：Open / 设计限制
- 影响：组合经济结果可能不同于目标实际链上特殊操作。
- 当前控制：完整证据才投影；SPLIT 新腿隔离为 historical；CONVERSION 用 source 退出等价处理；弱证据 fail closed。
- 必须完成：如果业务要求经济完全等价，需要单独设计并审计真实链上复制/转换 adapter。

### R-008：最终估值和公共 API 可用性

- 状态：受控但仍有残余风险
- 影响：公共只读 API 中断可能使 final drain 不完整。
- 当前控制：有界重试、保留失败证据、replacement Campaign、外部收尾例外不改原始失败状态。
- 必须完成：生产 provider 的 SLA、超时、重试、回退和人工升级流程。

### R-009：链重组和多源重复

- 状态：受控但仍有残余风险
- 影响：可能重复跟单或漏报成交。
- 当前控制：确认区块、二次 hash 核验、Polygon/Data API 精确证明、无法证明则阻断。
- 必须完成：生产 RPC 多节点、监控、reorg 演练和事件证据保留。

### R-010：桌面运行环境和合盖

- 状态：Open / 运维风险
- 影响：MacBook 合盖可能导致 DarkWake、调度空窗或 gap。
- 当前控制：启动前 `AppleClamshellState` 检查、合盖 fail closed、运行使用 `caffeinate`。
- 必须完成：生产使用稳定电源、开盖服务器或独立主机，不能把 MacBook 作为无人值守生产节点。

### R-011：UI 参考仓库商业许可

- 状态：Open / 法务风险
- 影响：Animal Island 视觉参考仓库为 CC BY-NC 4.0，可能不适用于商业产品。
- 当前控制：未复制其代码、图片、字体或 Nintendo 资产。
- 必须完成：商业化前重新设计或取得明确许可，并完成法务审查。

### R-012：证据和日志磁盘增长

- 状态：Open / 运维风险
- 影响：Capture、盘口、审计、checkpoint 和报告长期增长。
- 当前控制：内容寻址、日志索引、报告索引和既有归档入口。
- 必须完成：容量预算、归档策略、校验和恢复演练。

### R-013：已签订单意图的本地持久化

- 状态：受控但仍有残余风险
- 影响：为 crash recovery 保存的 `live_orders.signed_payload_json` 在尚未提交或结果
  未知时可能仍具有使用价值；本机数据库或备份泄露会扩大攻击面。
- 当前控制：该字段不进入 UI、快照、普通日志或外部审计包；runtime database 和新
  迁移备份强制为 `0600`，Operator UI 进程使用 `umask 077`；钱包会话失效时停止
  runtime 并丢弃内存 CLOB credentials。
- 必须完成：生产主机启用全盘加密、受控用户账户、备份访问控制和保留期限；外部
  审计只核对 hash、状态与恢复设计，不复制 signed payload。

---

## 10. 进入生产前必须完成的工作

以下顺序不可跳过。

### 10.0 当前最直接的下一步

外部审计不需要从头猜测项目状态，建议按以下顺序推进：

1. **先冻结审计基线**：记录 `HEAD`、`sourceCodeCommit`、工作树状态、依赖锁定文件、
   数据库 Schema、Ruleset hash 和 `live-production-validation.json`。
2. **审查当前代码安全边界**：重点看 wallet session、session-bound request broker、
   Live Gate、identity binding、CLOB adapter、链上授权/赎回、日志脱敏和 emergency
   stop；此时不要连接正式钱包。
3. **决定是否接受历史 Paper 口径**：当前已有用户授权的跨 Core 24 小时独立汇总，
   但没有自然 fill；如果审计要求同一提交重新产生全套自然证据，则在当前 clean
   commit 重新跑 Observe/Paper。
4. **复核已完成的两轮 Observe Only soak**：当前提交已有两轮各 8 小时 10 分钟，
   均最终 `SYNCED`，无 scheduling gap、`MAJOR_DESYNC`、checkpoint hash mismatch
   或未恢复连接缺口；审计方应核对原始报告和 SHA-256，而不是再次盲目累计时长。
5. **连接正式 Polygon EOA 做只读验收**：只验证地址、chainId、signer、余额、
   allowance、仓位、open orders、fills、geoblock、compliance 和 clock；这一步不等于
   允许下单。
6. **完成授权和最小 canary 的书面方案**：明确钱包、账户、网络、资金、单笔限额、
   总敞口、日损失、运行时间、人工在场、停止和撤销方式。
7. **由用户重新做最终授权**：技术测试、审计通过和历史 Paper 报告都不能替代这次
   用户授权；在授权前继续保持 `LIVE_DISABLED`。
8. **最后才做真实小额 canary**：先只读，再 allowance，再最小订单/取消/成交/对账，
   然后验证 emergency stop 和恢复；任何异常都应回到 `PAPER + LIVE_DISABLED`。
9. **canary 通过后再封装正式 `.app`**：把 Node.js 运行时、启动/停止、日志路径、
   更新、卸载和权限策略一起固化，并从最终用户入口移除三个 Paper 测试按钮。

上述第 5—8 步都属于新的外部事实和新的授权，不应由本次代码提交自动完成。

### 阶段 A：冻结和复核源码基线

进入条件：

- 审计方确认 commit；
- 工作树 clean；
- lockfile 固定；
- 依赖来源可复现；
- 配置、数据库、报告、capture 和日志路径已登记。

退出标准：

- `pnpm typecheck` 通过；
- `pnpm test` 全量通过；
- `git diff --check` 通过；
- 当前源码版本、Ruleset、Schema、数据库迁移一致。

### 阶段 B：复核已实现的浏览器钱包生产宿主

当前实现已经做到：

1. 不向浏览器暴露私钥；
2. 不从任意环境变量盲目发现凭据；
3. 将 signer/CLOB/provider 绑定到 wallet session；
4. 明确返回 provider chainId；
5. 通过 `LiveIdentityBinding` 核对注册账户、钱包、signer、proxy/funder；
6. 记录 provider 版本、配置 hash、检查时间和环境；
7. 能独立执行 emergency stop；
8. 能在 stop 失败时告警、重试、人工升级；
9. 不允许 fake adapter 在 production 环境冒充真实 adapter；
10. 不允许通过 UI 参数直接勾选 readiness。

审计交付物：

- 生产宿主源码；
- 依赖清单；
- signer/credential 内存生命周期设计；
- CLOB 认证设计；
- provider chain 证明；
- geoblock/compliance 数据源；
- clock safety 设计；
- secret rotation 和撤销设计；
- emergency stop runbook。

### 阶段 C：真实钱包只读和小额合同测试

在不提交真实交易的情况下，先验证：

- 真实 Polygon chainId；
- 钱包地址；
- signer 地址；
- proxy/funder；
- CLOB market read；
- 账户余额；
- allowance；
- positions；
- open orders 读取；
- fills 读取；
- provider 超时和断线；
- geoblock；
- clock skew；
- API 限流；
- reorg；
- 数据源不一致。

如果平台提供官方沙盒或测试网，应先使用沙盒；任何真实资金操作都必须有单独授权和限额。

### 阶段 D：重新执行完整验证

当前状态与待审计项：

1. 当前源码基线的全量测试；
2. 至少连续 8 小时 Observe：**已在当前提交连续完成两轮**；
3. 累计 24 小时 Paper：**已有用户授权的历史跨 Core 汇总，是否接受由审计方决定**；
4. Crash Recovery；
5. 长时间账本和仓位一致性；
6. 估值恢复；
7. provider 故障恢复；
8. reorg 演练；
9. wallet/session replacement；
10. emergency stop 失败重试；
11. Live Gate fake path；
12. 真实依赖只读合同测试。

所有报告必须引用同一 commit、同一 Ruleset 和明确 Campaign/Session 作用域。

### 阶段 E：外部审计签字

审计方应明确签字或出具意见：

- 安全边界是否满足；
- 生产宿主是否不会泄露私钥；
- CLOB submit/cancel 是否有账户和授权边界；
- provider 数据是否足够新鲜；
- geoblock/compliance 是否有明确来源；
- 失败是否 fail closed；
- emergency stop 是否可验证；
- 账本、外部余额和订单状态是否可对账；
- 真实小额策略是否在批准范围内。

### 阶段 F：用户重新授权

必须在所有前置条件通过后重新确认：

- 使用哪个钱包；
- 哪个 Polygon 网络；
- 哪个账户、proxy/funder；
- 最大总资金；
- 单笔最大资金；
- 每日最大损失；
- 最大同时持仓；
- 是否允许自动取消；
- 是否允许自动平仓；
- 是否允许恢复；
- 运行时间；
- emergency stop 方式；
- revoke/撤销方式；
- 是否仅允许 canary；
- 是否允许真实 submit。

旧的“技术实现完成”不构成新的实盘授权。

### 阶段 G：小额 canary

建议顺序：

1. 只读；
2. sandbox/testnet；
3. 极小资金、单账户、单市场；
4. 单笔上限和总损失上限；
5. 观察订单、成交、取消、对账、PnL；
6. 人工在场；
7. 先验证 stop，再验证恢复；
8. 达到预定义样本后再决定是否扩大范围。

canary 期间仍不得关闭任何 gap、reorg、clock、geoblock、balance、ledger 或 identity Gate。

---

## 11. 外部审计方应索取的证据包

### 11.1 源码和构建

- Git commit hash；
- branch；
- `package.json`；
- `pnpm-lock.yaml`；
- Node/pnpm 版本；
- TypeScript/Vitest 版本；
- `git status --short`；
- `git diff --check`；
- 依赖安装日志；
- 构建和 typecheck 日志；
- 测试完整日志。

### 11.2 配置和状态

- `config/default-target-wallet.txt`；
- `data/operator/target-wallet.txt`（必要时脱敏）；
- `data/operator/ruleset-profile.json`；
- `data/operator/live-production.json`（仅公开字段）；
- 数据库 schema 和 migration 版本；
- Gate state；
- operator lock；
- 当前运行状态；
- 账户 registry；
- provider capability evidence。

### 11.3 Paper/Observe 证据

- `data/operator/final-reports/ni-k-paper-mixed-core-24h-final-20260727-0300.md`；
- `data/operator/final-reports/ni-k-paper-mixed-core-24h-final-20260727-0300.zip`；
- `data/observe/archive/observe-8h-run-3a9f1686-ba4a-4dd1-9426-da20cd8b36b8-passed.json`；
- `data/observe/archive/observe-8h-run-aead6def-fc4d-466a-87c6-d665255acde0-passed.json`；
- `data/observe/archive/observe-8h-run-4f36e7c7-d3ae-4648-8d65-343e0f7c3e0b-aborted.json`；
- `data/paper-validation/campaigns/` 下涉及的 Campaign；
- Session 报告；
- Observe report；
- Capture Manifest；
- checkpoint；
- reconciliation report；
- recovery report；
- database backup；
- `integrity_check`；
- `foreign_key_check`；
- 原始失败报告；
- 外部收尾例外授权。

### 11.4 Live 生产依赖证据

- signer 的存储和访问设计；
- signer 地址证明；
- provider chainId 原始读取；
- CLOB 认证方式；
- CLOB adapter 版本；
- balance/allowance/position 原始读取；
- open order/fill 原始读取；
- compliance 来源和时间；
- geoblock 来源和时间；
- clock provider 和 skew 阈值；
- emergency stop 实测记录；
- stop 失败重试记录；
- provider outage 记录；
- secrets rotation 和 revoke 记录。

### 11.5 授权和运营证据

- 用户明确授权原文；
- 授权时间；
- 授权账户；
- 资金和风险限额；
- canary 计划；
- 值班人；
- 告警渠道；
- 事故升级人；
- 手工停止 runbook；
- 恢复 runbook；
- 交易后核对 runbook。

审计方不应索取、保存或复制用户私钥、助记词、可复用 API secret 或 signed order。审计只需要证明其保护设计、访问控制和结果，不需要把秘密本身放入审计包。

---

## 12. 可复现验证命令

以下命令应在审计基线的干净工作树执行：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
node --check prototype/live-ui/app.js
git diff --check
git status --short
```

预期：

- typecheck exit code `0`；
- test exit code `0`；
- 所有测试文件和测试用例通过；
- UI JavaScript syntax check 通过；
- `git diff --check` 无输出；
- 审计前工作树 clean。

Paper/Observe 验证命令：

```bash
pnpm phase0:validate -- 0x目标地址
pnpm phase05:replay-capture -- capture_run_id
pnpm observe:run -- 0x目标地址 --duration-seconds=300 --poll-seconds=1 --reconciliation-seconds=15
pnpm paper:run -- --duration-seconds=300 --interval-seconds=1
pnpm validate:final -- --type=all --campaign-id=PC-... --session-id=PS-...
pnpm operational:validate -- --mode=health_monitor --duration-seconds=0
```

长期验证不得只执行短命令后直接宣布 Live。必须保存完整报告、版本、数据库、capture、checkpoint 和失败证据。

UI 验证：

```bash
pnpm operator:ui
```

打开：

```text
http://127.0.0.1:4173/
```

核对：

- 初始 Paper；
- Live 面板为 pending；
- 无钱包时连接按钮提示没有 EIP-1193；
- 钱包连接只写公开身份；
- disconnect 后 runtime capability 降级；
- 原始订单请求/响应不会进入 snapshot；
- Paper/LIVE 模式切换有二次确认；
- 移动宽度没有横向溢出。

---

## 13. 审计判定建议

外部审计报告建议将结论拆为三个独立状态：

### 13.1 软件实现状态

建议结论：

```text
READY FOR WALLET-BOUND ACCEPTANCE
```

理由：

- 运行时、数据、账本、Gate、UI、钱包会话、浏览器 signer、认证 CLOB、只读
  provider、真实 order adapter、EOA allowance/redeem 和失败回滚均已接线；
- 干净提交上的全量测试和生产 validation artifact 是连接钱包的硬前置；
- 仍缺用户真实钱包和真实外部服务的端到端验收。

### 13.2 生产运行状态

建议结论：

```text
CODE READY; WALLET/FUNDS ACCEPTANCE NOT PERFORMED
```

理由：

- 当前未连接用户钱包；
- CLOB 凭据尚未由用户钱包实际派生；
- provider 尚无本轮真实余额、allowance、仓位和官方服务响应证据；
- 没有真实订单/成交/资金/PnL 证据；
- 用户最终 Live 二次确认尚未发生。

### 13.3 授权状态

建议结论：

```text
NOT AUTHORIZED
```

理由：

- 技术验证通过不能替代授权；
- 当前全局 Gate 仍是 `LIVE_DISABLED`；
- 任何小额灰度都需要新的明确授权和独立 canary 计划。

---

## 14. 审计方重点复核问题

请不要只看测试数量，至少回答以下问题：

1. 是否可以在没有私钥的情况下从浏览器直接提交订单？
2. wallet session 被替换后，旧 runtime 是否仍能执行？
3. session 过期而没有下一次 HTTP 请求时，runtime 是否会停？
4. emergency stop 失败时，接口是否会假报成功？
5. default factory 返回的 runtime 与 Gate 是否都绑定同一个 session，配置变化后是否
   强制重新装配？
6. provider 是否自己证明了 chainId，而不是只信任浏览器 body？
7. signer 地址、钱包地址、注册账户和 proxy/funder 是否逐层核对？
8. 断线、reorg、gap、clock、geoblock、余额、账本异常是否全部 fail closed？
9. 旧 Observe Run 的事故是否会污染新 Run？
10. 跨 Core 24 小时是否被错误写成单 Campaign 24 小时？
11. Paper 零成交是否被错误描述为真实成交覆盖？
12. SPLIT/CONVERSION 是否被错误描述为真实链上复制？
13. UI 是否可能绕过后台 capability 或 Gate？
14. 原始订单请求、响应、签名和日志是否被 API 返回？
15. 数据库迁移失败或最终估值失败时，原始证据是否保留？
16. 生产宿主是否可以证明每个 provider 的新鲜度、来源、版本和撤销路径？
17. 发生 stop 失败时，是否存在人工升级和资金冻结路径？
18. 用户授权是否明确到钱包、账户、资金、限额、时长和撤销？
19. 钱包请求 broker 是否拒绝跨 session、过期、错误地址、错误 chain 和并发请求？
20. Gate 已确认但 runtime 同步恢复失败时，是否真的回滚为 `LIVE_DISABLED`？
21. runtime 后台循环异步崩溃时，是否独立触发 emergency stop？
22. allowance 是否只面向 Exchange V3，collateral 授权金额是否等于确认的 bankroll？

只有这些问题全部得到证据支持，才可以讨论小额 Live canary；否则应继续保持：

```text
PAPER + LIVE_DISABLED + liveAllowed=false
```

---

## 15. 证据索引

### 15.1 项目说明

- [`README.md`](../../README.md)
- [`README_主入口.md`](../../README_主入口.md)
- [`prototype/live-ui/README.md`](../../prototype/live-ui/README.md)
- [`package.json`](../../package.json)

桌面入口位于仓库外的本机路径，交付时应同时核对：

- `/Users/d4clt/Desktop/Polymarket验证_点这里/Hecatonchires.command`
- `/Users/d4clt/Desktop/Polymarket验证_点这里/说明_只需要看这个.txt`
- [`scripts/launch-hecatonchires-ui.command`](../../scripts/launch-hecatonchires-ui.command)

### 15.2 Live 和安全边界

- [`src/live/live-runtime.ts`](../../src/live/live-runtime.ts)
- [`src/live/live-runtime-assembly.ts`](../../src/live/live-runtime-assembly.ts)
- [`src/live/live-executor.ts`](../../src/live/live-executor.ts)
- [`src/live/live-gate-service.ts`](../../src/live/live-gate-service.ts)
- [`src/live/live-gate-reconciliation.ts`](../../src/live/live-gate-reconciliation.ts)
- [`src/live/live-identity-binding.ts`](../../src/live/live-identity-binding.ts)
- [`src/live/live-connected-runtime.ts`](../../src/live/live-connected-runtime.ts)
- [`src/live/browser-wallet-clob-signer.ts`](../../src/live/browser-wallet-clob-signer.ts)
- [`src/live/session-authenticated-clob-client.ts`](../../src/live/session-authenticated-clob-client.ts)
- [`src/live/polymarket-readonly-wallet-provider.ts`](../../src/live/polymarket-readonly-wallet-provider.ts)
- [`src/live/browser-wallet-onchain.ts`](../../src/live/browser-wallet-onchain.ts)
- [`src/live/polymarket-clob-adapter.ts`](../../src/live/polymarket-clob-adapter.ts)
- [`src/live/wallet-provider.ts`](../../src/live/wallet-provider.ts)
- [`src/live/signer.ts`](../../src/live/signer.ts)
- [`src/live/order-adapter.ts`](../../src/live/order-adapter.ts)
- [`src/live/redeem-adapter.ts`](../../src/live/redeem-adapter.ts)
- [`src/operator/live-wallet-session.ts`](../../src/operator/live-wallet-session.ts)
- [`src/operator/live-wallet-request-broker.ts`](../../src/operator/live-wallet-request-broker.ts)
- [`src/operator/live-production-readiness.ts`](../../src/operator/live-production-readiness.ts)
- [`src/operator/live-operator-compliance-provider.ts`](../../src/operator/live-operator-compliance-provider.ts)
- [`src/operator/production-live-account.ts`](../../src/operator/production-live-account.ts)
- [`src/operator/production-live-prerequisites.ts`](../../src/operator/production-live-prerequisites.ts)
- [`src/operator/default-connected-live-runtime.ts`](../../src/operator/default-connected-live-runtime.ts)
- [`src/operator/operator-actions.ts`](../../src/operator/operator-actions.ts)
- [`src/operator/operator-ui-server.ts`](../../src/operator/operator-ui-server.ts)
- [`src/operator/operator-mutation-guard.ts`](../../src/operator/operator-mutation-guard.ts)
- [`src/operator/diagnostic-redaction.ts`](../../src/operator/diagnostic-redaction.ts)

### 15.3 Observe/Paper/Validation

- [`src/observe/`](../../src/observe/)
- [`src/execution/`](../../src/execution/)
- [`src/paper-validation/`](../../src/paper-validation/)
- [`src/validation/`](../../src/validation/)
- [`src/replay/`](../../src/replay/)
- [`src/operational/`](../../src/operational/)

### 15.4 操作台

- [`prototype/live-ui/index.html`](../../prototype/live-ui/index.html)
- [`prototype/live-ui/app.js`](../../prototype/live-ui/app.js)
- [`prototype/live-ui/styles.css`](../../prototype/live-ui/styles.css)
- [`prototype/live-ui/server.mjs`](../../prototype/live-ui/server.mjs)
- [`prototype/live-ui/assets/island-background-v3.png`](../../prototype/live-ui/assets/island-background-v3.png)

### 15.5 测试

- [`tests/live-wallet-session.test.ts`](../../tests/live-wallet-session.test.ts)
- [`tests/live-connected-runtime.test.ts`](../../tests/live-connected-runtime.test.ts)
- [`tests/live-wallet-request-broker.test.ts`](../../tests/live-wallet-request-broker.test.ts)
- [`tests/browser-wallet-clob-signer.test.ts`](../../tests/browser-wallet-clob-signer.test.ts)
- [`tests/session-authenticated-clob-client.test.ts`](../../tests/session-authenticated-clob-client.test.ts)
- [`tests/polymarket-readonly-wallet-provider.test.ts`](../../tests/polymarket-readonly-wallet-provider.test.ts)
- [`tests/browser-wallet-onchain.test.ts`](../../tests/browser-wallet-onchain.test.ts)
- [`tests/live-operator-compliance-provider.test.ts`](../../tests/live-operator-compliance-provider.test.ts)
- [`tests/production-live-account.test.ts`](../../tests/production-live-account.test.ts)
- [`tests/production-live-prerequisites.test.ts`](../../tests/production-live-prerequisites.test.ts)
- [`tests/default-connected-live-runtime.test.ts`](../../tests/default-connected-live-runtime.test.ts)
- [`tests/operator-actions.test.ts`](../../tests/operator-actions.test.ts)
- [`tests/operator-ui-server.test.ts`](../../tests/operator-ui-server.test.ts)
- `tests/`：当前共 `71` 个 `*.test.ts` 文件

### 15.6 运行和报告

- [`data/operator/final-reports/ni-k-paper-mixed-core-24h-final-20260727-0300.md`](../../data/operator/final-reports/ni-k-paper-mixed-core-24h-final-20260727-0300.md)
- [`data/observe/observe-8h.json`](../../data/observe/observe-8h.json)
- [`data/observe/archive/observe-8h-run-3a9f1686-ba4a-4dd1-9426-da20cd8b36b8-passed.json`](../../data/observe/archive/observe-8h-run-3a9f1686-ba4a-4dd1-9426-da20cd8b36b8-passed.json)
- [`data/observe/archive/observe-8h-run-aead6def-fc4d-466a-87c6-d665255acde0-passed.json`](../../data/observe/archive/observe-8h-run-aead6def-fc4d-466a-87c6-d665255acde0-passed.json)
- [`data/observe/archive/observe-8h-run-4f36e7c7-d3ae-4648-8d65-343e0f7c3e0b-aborted.json`](../../data/observe/archive/observe-8h-run-4f36e7c7-d3ae-4648-8d65-343e0f7c3e0b-aborted.json)
- `data/paper-validation/campaigns/`
- `data/operator/paper-campaign-isolated-verification.json`
- `data/operator/live-production-validation.json`（ignored、本机生成、绑定当前 commit）
- `data/operator/paper-campaign-latest.json`

---

## 16. 最终审计声明模板

外部审计方可在补齐证据后使用以下模板：

```text
我们审阅了 ni-k / Hecatonchires 在 [commit] 的源码、配置、测试、Paper/Observe
报告和生产接线证据。基于审计范围 [范围]、排除项 [排除项] 和证据清单 [清单]，
我们认为：

1. 当前 PAPER + LIVE_DISABLED + liveAllowed=false 的安全边界 [通过/不通过]；
2. Live 钱包身份、signer、CLOB、余额、合规、地域、时钟、市场数据和账户绑定
   [已证明/未证明]；
3. 数据完整性、账本、恢复、紧急停用和审计证据 [已证明/未证明]；
4. Paper/Observe 验证结果 [接受/不接受]，其自然成交覆盖限制为 [说明]；
5. 当前是否允许进入真实 Live [允许/不允许]；
6. 若允许，允许的账户、网络、资金、单笔限额、总限额、时长和撤销条件为 [说明]。

除非用户在全部前置条件通过后再次明确授权，否则本系统不得自动进入真实 Live。
```

---

## 17. 最终总结

当前项目不是一个“还没有 UI 的交易脚本”，也不是一个“测试通过即可直接下单”的系统。

它已经具备：

- 可追溯的数据采集；
- 多源一致性；
- Signal/Risk；
- Paper 账本和恢复；
- Live Gate；
- Live Runtime 和 Executor 架构；
- 钱包公开身份证明；
- 浏览器 EOA 安全 signer；
- 会话内认证 CLOB；
- 真实只读余额/allowance/仓位；
- 真实 CLOB submit/cancel adapter；
- EOA approve/redeem 和收据确认；
- 默认生产依赖装配；
- session lease；
- runtime identity binding；
- UI 控制面；
- 审计报告和 fail-closed 约束。

它仍然缺少的不是接口，而是外部真实事实和验收：

- 用户本轮正式钱包连接和签名；
- 真实钱包余额、allowance、仓位和 CLOB 凭据的验收；
- 当前提交两轮 Observe 已完成；若审计不接受历史 Paper 口径，仍需在冻结提交重跑
  所需 Paper 时长和自然市场样本；
- 自然成交和真实资金证据；
- 外部审计签字；
- 用户新的明确 Live 授权；
- 受限 canary 和撤销演练。

因此当前正确的工程状态是：

```text
工程能力：已形成
安全接线：已形成
验证框架：已形成
Paper 证据：已形成，但自然成交覆盖有限
生产代码路径：已闭环到普通 EOA 钱包
生产外部事实：未连接、未验收
真实 Live：未启用
用户授权：未发生
```

在上述未完成项关闭前，必须保持：

```text
PAPER + LIVE_DISABLED + liveAllowed=false
```
