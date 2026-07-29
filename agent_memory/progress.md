# Progress

## Current task
- 2026-07-29 钱包连接稳定性修复已完成：页面加入独立钱包发现层，优先通过 EIP-6963 识别 OKX，并兼容延迟注入、`ethereum.providers` 与传统 `window.ethereum`；服务重启/会话过期时 UI 明确提示重新签名，不会把安全性误报成连接成功。
- 2026-07-28 对仓库和本机运行产物做了定向清理：保留最终审计证据和当前运行入口，移出过期报告、重复交接包、旧中间日志/证据、过期迁移备份、未引用的旧 Campaign 文件和 `.DS_Store`；源码入口、数据库迁移和当前 Paper 数据未改动。
- 删除了唯一残留的 `LiveExecutorPlaceholder` 和旧测试断言，测试改为验证 Paper/Live 共用执行上下文完整性；没有改变正式 Live 执行链路。
- Paper 跨 Core 累计 24 小时验证已经完成；当前只保留最终证据和进入小额 Live 前的独立阻断项。
- 最终报告标记 `OWNER_AUTHORIZED_MIXED_CORE_AGGREGATION` 与 `OWNER_AUTHORIZED_EXTERNAL_FINALIZATION_EXCEPTION`，且没有改写原始数据库或同 Core Campaign 的内建计时。
- 已完成 Paper/Live 运行时交接与最终估值恢复修复：同一 Paper 账户和 baseline 可在安全 replacement 中承接旧仓位；最终 drain/估值有界重试；估值未完成时新 BUY 延后且不消费；Live 仅保留禁用态交接与隔离恢复。
- 普通浏览器 EOA 的最终 Live 代码路径已闭环：session-bound 钱包请求 broker、
  browser signer、惰性认证 CLOB、真实余额/allowance/仓位、CLOB submit/cancel、
  EOA approve/redeem、官方 geoblock、时钟、合规、生产账户、Gate、外部对账和默认
  production assembly 已接入 localhost host。配置变化强制重连；Gate 确认后同步
  recovery 不 ready 会回滚；后台循环异常 emergency stop。真实钱包和真实订单未触达。
- 第 2 阶段 UI 已从 throwaway 原型落为真实 localhost 控制台：品牌名为 `Hecatonchires`，保持用户选定的明亮 Animal Island-inspired 视觉、原创海豹/边牧/乌鸦背景、紧凑目标/我的对照卡、默认收起设置和执行明细。页面不再有 sample/in-memory 数据，3 秒轮询 `/api/operator/snapshot`，所有账户、策略、Signal、Market、Risk、Paper/Live 订单/成交/持仓/盈亏/账本、日志、对账、恢复和审计均由 SQLite 后台投影提供；参数表单按真实 micros/ms 字段转换并通过原有 profile 服务保存/恢复默认。新增运行与恢复、Live Gate 和后台明细折叠区，Paper 生命周期调用既有安全入口，Live 按 Gate 和外部依赖明确阻断。
- 用户要求改用 `guokaigdg/animal-island-ui` 参考后，原型改为独立的 Animal Island-inspired 皮肤：奶油米白画布、暖棕文字、薄荷青绿/焦点黄、波点纹理、pill 控件、燕尾标题、暖色虚线表格和轻微按键式动效。没有复制参考仓库代码、图片、字体文件或 Nintendo 资产；原仓库的 CC BY-NC 许可已记录在原型 README。原有目标地址、账户概览、对照卡、可编辑设置、PAPER/LIVE 二次确认和执行明细信息结构保持不变。
- 根据用户最新反馈，新增独立绘制的海豹、边牧和乌鸦岛屿插画 `prototype/live-ui/assets/island-background-v3.png`，以低透明度固定背景层呈现于页面两侧与底部；不改变信息结构、交互逻辑或 PAPER/LIVE 安全边界。
- 新增 `src/operator/operator-dashboard.ts`、`operator-actions.ts`、`operator-ui-server.ts`：提供统一后台快照、目标/规则集 mutation、Paper 启停/恢复、Live Gate 真实预检/请求/确认/恢复/紧急停用，以及未配置 Live runtime 的明确错误；`prototype/live-ui/server.mjs` 已切换为真实 API 服务器。

## Implemented
- Risk Manager 现在把 `POLYGON_TRADE_FEED_UNSAFE` 事故限定到事故所属 Observe Run：新 Run 的 Signal 不再被旧 Run 的事故误拒绝，同时旧事故记录保持 `OPEN`，同 Run、归属缺失/损坏及其他 `MAJOR_DESYNC` 继续硬阻断。
- Polygon confirmed-cursor 恢复现在先二次读取同一区块，过滤负载均衡节点的一次性链视图不一致；确认重组后，仅在上一锚点仍匹配且被重组批次没有目标成交时回退并重扫，同时把 reorg recovery 固化进 Polygon capture。存在已发布目标成交或更深重组时继续硬阻断。
- 新增 `OWNER_AUTHORIZED_EXTERNAL_FINALIZATION_EXCEPTION` 验收策略：只在完整计划时长、完整健康段、Observe 最终同步且无 gap/major desync、数据库一致性通过、外部市场数据已恢复、PAPER 安全门完整，并且 blocker 精确限定为最终估值超时时计入独立业主汇总；不会改写系统原始失败报告。
- Paper Campaign preflight 和 supervisor 启动前读取 `IOREG AppleClamshellState`：合盖时以 `MACBOOK_LID_CLOSED` fail closed，开盖或无 clamshell 的桌面设备才允许继续。
- `src/paper-validation/campaign-child-result.ts` 区分正常 Paper 报告与 Paper 失败 JSON；失败结果不会再被当作正常 `paper.report` 使用。
- supervisor 收尾路径识别失败/无效 Paper 与 Observe 报告，进入失败收尾并把 Paper 原始失败信息写入报告 payload。
- supervisor catch 对 pointer 写入失败做 best effort，保留原始错误并记录 `PAPER_CAMPAIGN_RECOVERY_POINTER_WRITE_FAILED`。
- 启动顺序先回收或安全冻结旧 core 的遗留 `RUNNING` Session，再按 core hash 创建 replacement，避免重复点击和残留 `RUNNING`。
- 新增受限 `--recover-only` supervisor 模式，只做遗留 Session 回收/安全冻结并退出，不创建新 Session、不启动 Paper/Observe。
- 新源码与回归测试已纳入 Core compatibility manifest。
- 2026-07-25 首次启动时，隔离套件中的重型 Shell 打包参数化用例在全套并发下触发默认 `5 s` 超时；已仅将该两组集成用例的显式时限调整为 `15 s`，不改生产逻辑或安全 Gate。

## Verification
- 第 3 阶段新增：Live 账户 handoff 拒绝未终态外部订单、未结现金/资产 reservation、负现金或非零冻结仓位；Live Gate reconciliation 检查 Live 现金、reservation、孤儿执行/仓位、负仓位和冻结仓位；合规 provider 默认生产禁用并失败关闭；身份绑定在启动、arming 申请/确认与轮询入口拒绝钱包/signer 漂移；`assembleLiveRuntime` 只接受显式注入的依赖。TypeScript、定向 6 files / 241 tests、最终全量 56 files / 794 tests 和 `git diff --check` 通过。
- 事故范围红测先稳定复现：上一 Observe Run 的 `POLYGON_TRADE_FEED_UNSAFE` 使当前 Run BUY 进入 `REJECTED`；修复后当前 Run BUY `EXECUTED`，事故所属旧 Run 的 BUY 仍以原事故 ID 拒绝，旧事故记录未改写。Paper Executor `122/122`、TypeScript、全套 `56 files / 777 tests` 和 `git diff --check` 通过。
- Polygon 重组恢复红测先以 `POLYGON_TRADE_FEED_CONFIRMED_REORG:0x65` 失败；实现后定向 `2 files / 66 tests`、TypeScript、全套 `56 files / 776 tests` 通过。额外覆盖单次 RPC 哈希不一致可恢复，以及已发布目标成交后重组仍拒绝。
- 用户授权例外红测先以 `paperOwnerAuthorizedFinalizationRuntimePolicy is not a function` 失败；实现后策略测试 `8/8`、TypeScript、全套 `56 files / 773 tests` 通过。
- 用第 2 轮真实指标执行策略得到 `accepted=true`、`creditedRuntimeMs=14,400,002`、`reasons=[]`。
- 新回归先红：`evaluatePaperCampaignPowerSafety is not a function`；实现后 `paper-campaign-clock-safety` `5/5` 通过。
- TypeScript 通过；相关 `4 files / 24 tests` 通过；全套 `56 files / 771 tests` 通过。
- 当前实机检查返回 `PASSED + lidState=OPEN`；`git diff --check` 通过。
- 失败测试先红：缺失 child-result 模块。
- 当前通过：TypeScript；相关测试 `5 files / 53 tests`；此前全量 `56 files / 769 tests` 通过；恢复工件清理后追加 Shell 生命周期测试 `2 files / 16 tests` 通过，`git diff --check` 通过。
- `--recover-only` 与恢复工件清理修复均已提交。
- 超时修复后，Shell 打包文件 `12/12` 通过；TypeScript 与全套 `56 files / 769 tests` 通过。
- 本次运行时交接/估值恢复改动完成后，TypeScript 通过；定向 Campaign/Live 风险测试 `2 files / 40 tests` 通过；全套 `56 files / 784 tests` 通过；`git diff --check` 通过。
- 本轮 UI 视觉重构后，浏览器实机检查通过：桌面版首屏、参数折叠/保存、PAPER→LIVE 二次确认、交易对照卡和展开后的九列表格均正常；未改变原型安全边界。TypeScript、全量 `56 files / 794 tests` 与 `git diff --check` 通过；UI 原型未发现网络请求、私钥或敏感凭据读取。
- Animal 皮肤浏览器检查通过：首屏、参数面板、动森风格有机弹窗、交易对照卡和九列表格均正常，控制台无错误；仅修改 UI/CSS/说明文档，未改变 Paper/Live 运行逻辑或安全边界。
- 海豹/边牧/乌鸦背景浏览器检查通过：角色在首屏两侧和交易卡后方可见，透明度与层级不遮挡地址、金额和状态；PNG 已确认是 RGBA 透明背景，控制台无错误。
- 本轮接入收尾修正通过：Live 账户/执行/订单尝试/账本/隔离异常均进入后台明细；Paper/Live/目标/参数操作按后台 capability 禁用确定失败入口；原始 Live 请求/响应和日志正文不进入快照，仅保留安全摘要/索引。`pnpm typecheck`、定向 4 files / 14 tests、全量 59 files / 802 tests、`git diff --check` 均通过；真实 localhost 快照仍为 `PAPER + LIVE_DISABLED + STOPPED`，桌面/390px 移动回归无浏览器控制台错误。
- 本轮 Live 生产准备接线通过：`src/operator/live-production-readiness.ts` 定义非敏感生产钱包配置、逐项 provider/Signer/Runtime/Gate readiness 和安全宿主 capability overrides；新增 `PUT /api/operator/live/configuration` 只保存公开钱包地址与网络，UI Live 安全面板展示“生产路径待前置条件”、准备项和明确阻断原因。默认 capability 为 `PENDING_PREREQUISITES`，真实 Live 仍不会触达。`pnpm typecheck`、定向 readiness/actions/UI 测试 `3 files / 10 tests`、最终全量 `60 files / 806 tests`、`node --check` 和 `git diff --check` 通过；localhost 快照确认 `PAPER + LIVE_DISABLED + liveAllowed=false`。
- 当前生产路径定向测试 `13 files / 70 tests` 已通过；全量首次回归因新增测试未登记
  到 verification-suite 清单而 fail closed，更新受审计清单后相关 `4 files / 55 tests`
  和 core compatibility `11/11` 已通过。最终 TypeScript、前端语法、`git diff --check`
  和全量 `71 files / 854 tests` 均通过。
- 无钱包 UI 实机验收通过：PAPER→LIVE 先显示“不直接下单”的检查确认；Live 面板
  跨 3 秒刷新保持展开，编辑中的参数不会被覆盖；默认 `10/1/3/1 pUSD` 正确，
  1280px 无横向溢出且浏览器控制台无错误。未连接钱包、未启动 Paper、未写入 Live
  授权、未发送订单或链上交易。
- 最终安全复核补齐：持久化配置在读取时也执行小额硬上限，篡改超限配置会退回
  断开默认态；每次 CLOB 调用前后都复核 wallet session；UI 宿主退出会先停 Gate、
  停 runtime、撤销会话；runtime database 和新迁移备份强制 `0600`，宿主使用
  `umask 077`。审计文档已如实披露 crash recovery 所需 signed order intent 的
  本地持久化及其残余风险。
- 外部审计文档已升级为
  `docs/audit/ni-k-external-audit-2026-07-29.md`，记录实际已实现生产路径、仍未发生
  的钱包/资金事实、操作顺序、风险、证据索引和外部审计判定口径。
- 已补充当前提交的两轮 8 小时 10 分钟 Observe 证据、第三轮 KeepAlive 安全中止
  说明，并生成便携外部审计包
  `data/operator/final-reports/Hecatonchires-external-audit-2026-07-29.zip` 及其
  `.sha256` 校验文件。包内不含完整运行数据库、原始日志、私钥或 signed order intent。
- 修复桌面 `Hecatonchires.command` 在 Finder 精简 PATH 下找不到 `pnpm` 而直接退出的
  启动问题：入口现在会从常见用户安装位置和 Codex 自带运行时补齐 pnpm/Node PATH。
  Finder-like 环境与桌面 wrapper 回归均能启动 localhost snapshot，退出后无残留 UI 进程。
- 已补齐成品式日常入口：桌面新增 `Hecatonchires.command`，自动检测/启动 localhost
  控制台并打开浏览器，重复双击只复用现有服务；仓库新增
  `scripts/launch-hecatonchires-ui.command` 和 `README_主入口.md`。三个 Paper 按钮继续
  保留为当前测试阶段的内部工具，未混入 `操作入口/`，因此不改变 Paper core hash。
- 外部审计文档已补充当前主入口、最新 `PASSED` 验证工件摘要、主入口短启动证据、
  已完成工作清单和连接钱包前后的分阶段行动计划；并统一记录 Node.js `>=24.14.0 <25`
  的运行要求。
- 修复 UI 3 秒快照轮询造成的闪烁：首次成功加载保留进入动画，后续后台刷新标记为
  `refresh-render` 并禁用首屏/折叠内容重播；未改变轮询、数据或安全逻辑。
- 本轮验证：前端 `node --check`、定向 Operator UI/Actions 测试 `2 files / 17 tests`、
  `pnpm typecheck` 和 `git diff --check` 均通过。
- 复核“Live 对账”按钮：当前 `PAPER + LIVE_DISABLED`、钱包会话断开且
  `liveRuntimeActions.capability.execution=PENDING_PREREQUISITES`，按钮按安全设计禁用；
  直接调用接口也只返回 `LIVE_RECONCILIATION_RUNTIME_NOT_CONFIGURED`，未产生任何外部操作。
- 在用户当前 Chrome 中完成只读复核：`CONFIRM SMALL LIVE LIMITS` 已实际写入配置，
  小额限额与合规确认时间均已更新；该 Chrome 页面没有注入 `window.ethereum`，所以
  “连接钱包”无法建立 EIP-1193 会话。未点击连接、未签名、未授权、未启动 Live。
- 用户再次点击连接后已复现：OKX Wallet 扩展弹窗实际打开，但主页面仍保持“钱包会话：未连接”，
  说明流程停在扩展授权/账户确认阶段；扩展内部页面不可由本工具读取或代确认，已保留弹窗供用户处理。
- 用户在 OKX 中点击确认后复核：弹窗关闭但页面仍为“钱包会话：未连接 / Signer：未连接”，
  后端未收到完整钱包证明；当前没有交易、链上授权或 Live 启动。
- 已定位并修复该现象的服务端回滚路径：签名验证成功但默认 LiveRuntime 因
  `LIVE_PRODUCTION_SOURCE_DIRTY` 阻断时，现在保留已验证的 `CONNECTED` 钱包会话，返回
  `runtime.accepted=false` 和 `PAPER + LIVE_DISABLED` 安全状态；身份、网络、签名等验证
  错误仍会断开会话。前端会明确提示“钱包已连接，LiveRuntime 暂未装配”，不会开放下单。
  新增回归测试；定向 `2 files / 18 tests`、全量 `71 files / 855 tests`、TypeScript、
  前端语法和 `git diff --check` 均通过。4173 localhost 服务已重启，待用户重新连接一次验证。
- 已重启 4173 本地 UI 服务并通过真实快照复核 `PAPER + LIVE_DISABLED + liveAllowed=false`；
  `pnpm validate:live-production` 仍按设计以 `LIVE_PRODUCTION_VALIDATION_REQUIRES_CLEAN_WORKTREE`
  拒绝当前脏工作区，未提交或清理用户现有改动。
- 用户重新完成 OKX challenge/signature 后，真实快照已确认钱包会话为 `CONNECTED`、Polygon
  `137`、Signer `PENDING_HOST_SIGNER`；`FORMAL_WALLET` 与 `LIVE_LIMITS` 为 `READY`，其余
  生产依赖、LiveRuntime 和最终业主授权仍为 `PENDING`。未启动 Live、未创建订单、未发生链上写入。
- 用户在 UI 执行 Gate 预检后得到 `PREFLIGHT_FAILED`；截图与快照一致，失败项是生产依赖/审计
  前置条件，不是钱包签名失败。当前不需要继续点击 Live 按钮；下一步应在安全禁用态补齐
  `SECURE_SIGNER`、只读余额/allowance、认证 CLOB、合规/地域/时钟 provider、LiveRuntime
  装配及最终授权前的验证证据。
- 用户重新签名后复核成功：快照显示钱包会话 `CONNECTED`、Polygon `137`、`signerStatus=READY`；
  生产钱包、Secure Signer、只读余额、认证 CLOB、合规、地域、时钟、小额限额和 LiveRuntime
  均为 `READY`。生产路径仍为 `PENDING_PREREQUISITES`，唯一生产 readiness 项是
  `USER_AUTHORIZATION=PENDING`；全局 Gate 仍为 `PAPER + LIVE_DISABLED + liveAllowed=false`，
  没有启动 Live、订单或链上写入。旧 Gate 的 `LIVE_WALLET_SESSION_DISCONNECTED` 只是重连前一次
  预检的历史原因，当前钱包会话已连接。
- 用户明确授权当前 `10/1/3/1 pUSD` 小额限额后，重新连接并发起 Live Gate 请求；官方地域检查返回
  `GEOBLOCK_BLOCKED:US:CA`，请求在进入 arming 前失败关闭。当前钱包仍可见为已连接，但 Gate
  继续 `PAPER + LIVE_DISABLED + liveAllowed=false`，没有创建订单或链上写入。

## Latest wallet-connection verification
- 新增 `prototype/live-ui/wallet-provider.js` 和 `tests/wallet-provider.test.ts`：覆盖已注入 provider、延迟 EIP-6963 OKX announcement、无 provider 超时返回；当前 targeted/full Vitest 均通过 `72 files / 858 tests`，TypeScript、前端语法和 `git diff --check` 通过。
- 最新提交服务重启后，在新的 Chrome 页面实际完成 OKX 账户请求和 `personal_sign`：页面显示“钱包会话：已证明地址控制权 / Signer：钱包签名通道已准备”，后台快照为 `CONNECTED`、Polygon `137`、`signerStatus=READY`。Gate 仍为 `PAPER + LIVE_DISABLED + liveAllowed=false`，没有启动 Live 或链上写入。

## Runtime state
- 当前无 Observe/Paper/Supervisor/launcher 进程，operator lock、marker、FIFO 均已清理。
- 独立 Observe 两轮 8 小时 10 分钟验证均已正常完成：第一轮
  `3a9f1686-ba4a-4dd1-9426-da20cd8b36b8` 成功轮询 `10,988`、失败 `43`；第二轮
  `aead6def-fc4d-466a-87c6-d665255acde0` 成功轮询 `11,843`、失败 `26`。两轮均无
  scheduling gap、major desync 或未恢复连接缺口，最终 `SYNCED`，验收 blocker 为空。
- 当前主报告 `data/observe/observe-8h.json` 固定为第二轮通过报告；两轮通过报告和
  自动重启后短暂第三轮的安全中止报告均已按 run id 归档。Observe launchctl job 已移除
  并保持 disabled，不会继续自动重启。
- 最终 `PC-53F4B34D814FCDDFB663 / PS-04B30EBA4C1C49656AF7` 正常完成并计入 `14,400,002 ms`；独立业主累计为 `86,400,012 ms`，达到 24 小时。
- 最终轮 `25` 个事件、`13` 个 Signal、`11` 个可执行 BUY 全部 Risk ALLOW 并被 Paper 消费；因安全限价/截止时间，`1,239` 个订单均零成交，当前无 Paper 持仓、手续费或盈亏。
- Observe 最终 `SYNCED`，scheduling gap/major desync 为 `0`；数据库 Schema `2.30.0`、`quick_check=ok`、外键问题 `0`。
- `PAPER + LIVE_DISABLED + liveAllowed=false` 保持不变，Live execution/order/attempt/fill 全为 `0`。
- 最终报告：`data/operator/final-reports/ni-k-paper-mixed-core-24h-final-20260727-0300.md`。

## Next steps
1. 独立 Observe 两轮已完成，不需要继续累计；外部审计应同时保留两轮通过报告、
   数据库和第三轮安全中止说明，不把短暂第三轮计入有效时长。
2. 用户之后先按 UI 测试 Paper；准备小额实盘时按 UI 顺序连接 Polygon EOA、确认
   `10/1/3/1 pUSD` 或更低限额、完成 allowance 和真实只读核对。
3. 只有用户当次输入最终确认词后才允许 Gate 尝试启动；在此之前继续保持
   `PAPER + LIVE_DISABLED + liveAllowed=false`。
