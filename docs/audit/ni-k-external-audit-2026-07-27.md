# ni-k / Hecatonchires 外部审计文档

> 文档用途：交给外部审计、技术尽调、生产接入和安全复核人员使用。
> 文档日期：2026-07-27（Asia/Shanghai）
> 审计基线源码提交：`b2c3c60`（`feat(operator): add secure wallet connection flow`）
> 项目目录：`/Users/d4clt/Documents/Codex/2026-07-07/ni-k`
> 当前分支：`codex/operator-ui-integration`
> 项目名称：`ni-k`；操作台品牌：`Hecatonchires`

## 0. 给外部审计方的先读结论

本项目已经完成：

1. Polymarket 跟单系统的 Observe、Signal、Risk、Paper、Replay、账本、对账、恢复、审计和 Live Gate 主体架构。
2. 按用户指定的“3 → 2 → 1”顺序完成 Live/后端能力接线、可操作 localhost 控制台、Paper/隔离验证和安全门验证。
3. Hecatonchires 明亮 UI、目标/我的对照视图、可折叠参数与执行明细、Paper/LIVE 模式二次确认、真实后台快照和钱包连接页面。
4. 正式钱包的公开身份连接链：EIP-1193、一次性 chain-bound `personal_sign` challenge、会话租约、运行时绑定、钱包替换/断开/过期撤销。
5. 连接后生产运行时的显式依赖装配入口：secure signer、认证 CLOB、余额、市场、合规、地域和时钟 provider 必须由安全宿主注入。
6. 大量 fail-closed 控制和隔离测试；当前最新全量测试为 `62` 个测试文件、`818` 个测试通过。

本项目目前**没有**完成，也没有声称完成：

- 真实钱包连接后的生产宿主部署；
- 真实 signer、私钥、助记词、认证 CLOB 凭据或真实资金接入；
- 真实订单 submit/cancel、approve、redeem 或任何链上写操作；
- 真实 Live 订单、成交、资金变化或小额灰度实盘；
- 用户在所有生产前置条件通过后的再次明确授权；
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

> “软件安全接线、验证框架和生产依赖边界已形成；系统尚未达到可直接授权真实交易的最终生产状态。”

这不是投资建议、合规意见、法律意见或实时交易授权。

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

- Git commit：`b2c3c60`
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
`2bdb7e3bd2553b4cb8b64e4df78784a5d58ebf2b`。本次新增的钱包连接、生产准备、UI 控制面和 Live 依赖接线应由审计方在当前基线重新执行验证，不能把旧 commit 的报告直接当作当前 commit 的完整证明。

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
- 在生产宿主显式提供全部真实依赖并通过 Gate 后，才具备进入 Live 的技术路径；
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
  isolated account      explicit host injection only
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
connectedLiveRuntimeFactory (security host)
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

当前默认 `prototype/live-ui/server.mjs` 没有注入
`connectedLiveRuntimeFactory`，所以连接按钮可以工作，但没有安全宿主时仍显示等待前置条件。这是刻意的 fail-closed 行为，不是遗漏的自动启用。

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

默认 adapter 为 disabled/fake 或未配置状态。生产装配入口不扫描环境、不发现私钥、不自动生成认证客户端。

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
- `src/live/wallet-provider.ts`
- `src/operator/operator-actions.ts`
- `src/operator/operator-ui-server.ts`

装配要求：

- 当前 session 必须是 Polygon 主网；
- `connectedLiveRuntimeFactory` 必须显式提供依赖；
- `walletProvider.getChainId()` 必须存在；
- provider 自身读取的 chainId 必须是 `137`；
- provider chainId 必须与 factory bundle 的 `verifiedChainId` 一致；
- signer 地址必须等于钱包 session 地址；
- proxy/funder 地址必须继续经过 `LiveIdentityBinding`；
- factory 返回的 action 必须由服务端 wrapper 绑定当前钱包 session；
- 未绑定、已撤销或漂移的 action 不得继续执行。

### 4.5 凭据边界

当前浏览器和 localhost UI：

- 不读取私钥；
- 不读取 seed/mnemonic；
- 不读取 API key；
- 不保存 signed order；
- 不加载认证 CLOB；
- 不自动发现生产 signer；
- 不根据配置文件勾选真实 provider；
- 不自动把钱包连接视为交易授权。

安全宿主将来必须在独立边界内提供 signer/CLOB/provider；推荐使用系统安全存储、硬件钱包、独立进程或受控密钥服务，不能把私钥写入仓库、日志、截图、配置示例或前端 bundle。

### 4.6 快照和日志脱敏

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

### 4.7 数据库和迁移安全

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

### 5.3 视觉资源和许可证风险

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

---

## 7. 当前验证证据

### 7.1 当前源码基线验证

在审计基线 `b2c3c60` 及其同一工作树上完成：

```text
pnpm typecheck                          PASS
定向测试 4 files / 19 tests             PASS
全量测试 62 files / 818 tests           PASS
node --check prototype/live-ui/app.js   PASS
git diff --check                        PASS
最终代码复审                             无新的 P1/P2
```

Node 24 的 `node:sqlite` experimental warning 是环境提示，不是测试失败。

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

---

## 8. 已完成、未完成和“不要误判”的矩阵

| 能力 | 当前状态 | 证据 | 是否可直接用于真实资金 |
|---|---|---|---|
| Observe 目标交易识别 | 已实现 | Observe、Capture、reconciliation、测试 | 否，仍需当前基线重新 soak |
| Signal/Risk | 已实现 | Signal context、Risk tests | 否 |
| Paper 模拟执行 | 已实现 | Paper executor、账本、Paper report | 否 |
| Paper 24h 独立汇总 | 已完成 | final report | 否，且不是单 Campaign 原生 24h |
| Replay/一致性/恢复 | 已实现并有回归 | validation tests/reports | 否 |
| Live Gate 架构 | 已实现 | `live-gate-service.ts`、Gate tests | 否，默认关闭 |
| Live Runtime 架构 | 已实现 | `live-runtime.ts`、`live-executor.ts` | 否，依赖未注入 |
| Live 身份绑定 | 已实现 | `live-identity-binding.ts` | 否 |
| 钱包公开身份连接 | 已实现 | `live-wallet-session.ts` | 否，只证明地址控制权 |
| 安全宿主 factory | 接口已定义，默认未部署 | `connectedLiveRuntimeFactory` seam | 否 |
| Secure signer | 未接入 | readiness pending | 否 |
| 认证 CLOB | 未接入 | readiness pending | 否 |
| 只读余额/仓位 | 生产实例未接入 | readiness pending | 否 |
| Compliance/Geoblock/Clock | 生产证据未接入 | readiness pending | 否 |
| 真实 wallet funds | 未提供证据 | 无 | 否 |
| 真实订单 | `0` | final report | 否 |
| 用户最终 Live 授权 | 未发生 | Gate pending | 否 |
| 真实小额灰度 | 未开始 | 无 | 否 |

---

## 9. 当前风险登记册

### R-001：生产依赖未部署（阻断级）

- 状态：Open
- 影响：连接钱包后仍不能安全签名或提交订单。
- 当前控制：默认 `UnconfiguredOperatorLiveRuntimeActions`，readiness 为 `PENDING_PREREQUISITES`。
- 必须完成：
  - 安全宿主；
  - signer；
  - 认证 CLOB；
  - balance/position；
  - compliance/geoblock/clock；
  - market data；
  - `ConfiguredOperatorLiveRuntimeActions`；
  - capability evidence。

### R-002：没有真实资金和真实交易证据（阻断级）

- 状态：Open
- 影响：无法证明订单签名、资金限额、成交回报、取消、恢复和 PnL 在真实网络有效。
- 当前控制：真实 submit/cancel/approve/redeem 均禁用。
- 必须完成：测试网/沙盒合同测试、只读核对、最小限额演练和明确授权。

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

### R-005：8 小时 Observe Gate 证据需重新确认

- 状态：Open / Gate prerequisite
- 影响：短时运行或 4 小时验证不能替代 README 中要求的 Live Gate 前连续 Observe soak。
- 当前控制：Live Gate 对 `SYNCED`、gap、checkpoint、dirty tree 等有硬判断。
- 必须完成：当前基线至少连续 8 小时 Observe，保存完整报告和 checkpoint。

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

---

## 10. 进入生产前必须完成的工作

以下顺序不可跳过。

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

### 阶段 B：实现和审计安全宿主

安全宿主必须：

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

交付物：

- 生产宿主源码；
- 依赖清单；
- signer/credential 存储设计；
- CLOB 认证设计；
- provider chain 证明；
- geoblock/compliance 数据源；
- clock safety 设计；
- secret rotation 和撤销设计；
- emergency stop runbook。

### 阶段 C：真实只读和沙盒合同测试

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

至少完成：

1. 当前源码基线的全量测试；
2. 至少连续 8 小时 Observe；
3. 累计 24 小时 Paper；
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
PASS WITH CONTROLLED OPEN ITEMS
```

理由：

- 主要运行时、数据、账本、Gate、UI 和钱包会话接线已实现；
- 全量测试和静态检查通过；
- 最新复审没有新的 P1/P2；
- 仍有明确生产依赖和验证缺口。

### 13.2 生产运行状态

建议结论：

```text
NOT READY FOR LIVE TRADING
```

理由：

- secure signer 未部署；
- 认证 CLOB 未部署；
- provider 真实证据未部署；
- 生产 factory 默认未注入；
- 没有真实订单/成交/资金/PnL 证据；
- 8 小时 Observe Gate 需在当前基线重新确认；
- 用户最终 Live 授权不存在。

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
5. factory 是否可以返回未绑定 session 的任意 action？
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

只有这些问题全部得到证据支持，才可以讨论小额 Live canary；否则应继续保持：

```text
PAPER + LIVE_DISABLED + liveAllowed=false
```

---

## 15. 证据索引

### 15.1 项目说明

- [`README.md`](../../README.md)
- [`prototype/live-ui/README.md`](../../prototype/live-ui/README.md)
- [`package.json`](../../package.json)

### 15.2 Live 和安全边界

- [`src/live/live-runtime.ts`](../../src/live/live-runtime.ts)
- [`src/live/live-runtime-assembly.ts`](../../src/live/live-runtime-assembly.ts)
- [`src/live/live-executor.ts`](../../src/live/live-executor.ts)
- [`src/live/live-gate-service.ts`](../../src/live/live-gate-service.ts)
- [`src/live/live-gate-reconciliation.ts`](../../src/live/live-gate-reconciliation.ts)
- [`src/live/live-identity-binding.ts`](../../src/live/live-identity-binding.ts)
- [`src/live/live-connected-runtime.ts`](../../src/live/live-connected-runtime.ts)
- [`src/live/wallet-provider.ts`](../../src/live/wallet-provider.ts)
- [`src/live/signer.ts`](../../src/live/signer.ts)
- [`src/live/order-adapter.ts`](../../src/live/order-adapter.ts)
- [`src/live/redeem-adapter.ts`](../../src/live/redeem-adapter.ts)
- [`src/operator/live-wallet-session.ts`](../../src/operator/live-wallet-session.ts)
- [`src/operator/live-production-readiness.ts`](../../src/operator/live-production-readiness.ts)
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
- [`tests/operator-actions.test.ts`](../../tests/operator-actions.test.ts)
- [`tests/operator-ui-server.test.ts`](../../tests/operator-ui-server.test.ts)
- `tests/`：当前共 `62` 个 `*.test.ts` 文件

### 15.6 运行和报告

- [`data/operator/final-reports/ni-k-paper-mixed-core-24h-final-20260727-0300.md`](../../data/operator/final-reports/ni-k-paper-mixed-core-24h-final-20260727-0300.md)
- `data/paper-validation/campaigns/`
- `data/operator/paper-campaign-isolated-verification.json`
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
- 显式生产依赖装配；
- session lease；
- runtime identity binding；
- UI 控制面；
- 审计报告和 fail-closed 约束。

它仍然缺少：

- 生产安全宿主；
- 真实 signer/CLOB/provider；
- 当前基线的完整长时验证；
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
生产依赖：未部署
真实 Live：未启用
用户授权：未发生
```

在上述未完成项关闭前，必须保持：

```text
PAPER + LIVE_DISABLED + liveAllowed=false
```
