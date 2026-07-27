# Progress

## Current task
- Paper 跨 Core 累计 24 小时验证已经完成；当前只保留最终证据和进入小额 Live 前的独立阻断项。
- 最终报告标记 `OWNER_AUTHORIZED_MIXED_CORE_AGGREGATION` 与 `OWNER_AUTHORIZED_EXTERNAL_FINALIZATION_EXCEPTION`，且没有改写原始数据库或同 Core Campaign 的内建计时。
- 已完成 Paper/Live 运行时交接与最终估值恢复修复：同一 Paper 账户和 baseline 可在安全 replacement 中承接旧仓位；最终 drain/估值有界重试；估值未完成时新 BUY 延后且不消费；Live 仅保留禁用态交接与隔离恢复。
- 第 3 阶段 Live/后端能力和安全接线已完成：禁用态跨 Core 交接、外部订单/成交/仓位恢复对账、合规/geoblock/时钟安全 provider、钱包/signer 身份绑定、风控/arming/kill switch、启动与估值恢复、账本隔离及完整运行时装配均已有公开后端 seam；仍保持真实 Live 禁用，仅用 fake/isolated 测试验证。
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
- 本轮补齐正式钱包连接链：`src/operator/live-wallet-session.ts` 实现只在内存存在的一次性、绑定 chain 的 challenge、EIP-191 地址控制权验证、Polygon/Amoy chain 校验、后台租约定时过期、断开与过期会话；运行时绑定会在钱包替换/断开/过期时撤销 action 并触发 emergency stop，失败会重试一次并返回明确错误。localhost 新增 `/api/operator/live/wallet-session/{challenge,connect,disconnect}`，UI 的“连接钱包”调用通用 EIP-1193，不读取私钥。`src/live/live-connected-runtime.ts` 提供连接后唯一生产装配入口，在交给既有 `assembleLiveRuntime` 前核对会话网络、wallet provider 自身读取的真实 provider chain、signer 与会话地址，proxy/funder 地址仍由 `LiveIdentityBinding` 核对；`connectedLiveRuntimeFactory` 是连接成功后由安全宿主注入 capability 的唯一 seam。新增钱包会话、连接装配和失效撤销隔离测试；`pnpm typecheck`、定向 `4 files / 18 tests`、全量 `62 files / 817 tests`、`node --check` 与 `git diff --check` 通过。localhost 桌面与 390px 移动回归无横向溢出和控制台错误；无钱包浏览器点击连接会明确提示未检测到 EIP-1193，后台仍是 `PAPER + LIVE_DISABLED + liveAllowed=false`。当前连接后仍会等待安全宿主注入真实 signer/CLOB/余额/政策 provider。
- 已生成供外部技术、安全与生产接入审计使用的完整 Markdown 文档 `docs/audit/ni-k-external-audit-2026-07-27.md`，覆盖审计基线、系统架构、当前安全状态、代码证据、Paper 证据限制、风险登记册、生产前置步骤、取证清单、复现命令和审计结论模板；明确区分“工程能力已形成”“真实 Live 未就绪”和“用户未授权”。

## Runtime state
- 当前无 Observe/Paper/Supervisor/launcher 进程，operator lock、marker、FIFO 均已清理。
- 最终 `PC-53F4B34D814FCDDFB663 / PS-04B30EBA4C1C49656AF7` 正常完成并计入 `14,400,002 ms`；独立业主累计为 `86,400,012 ms`，达到 24 小时。
- 最终轮 `25` 个事件、`13` 个 Signal、`11` 个可执行 BUY 全部 Risk ALLOW 并被 Paper 消费；因安全限价/截止时间，`1,239` 个订单均零成交，当前无 Paper 持仓、手续费或盈亏。
- Observe 最终 `SYNCED`，scheduling gap/major desync 为 `0`；数据库 Schema `2.30.0`、`quick_check=ok`、外键问题 `0`。
- `PAPER + LIVE_DISABLED + liveAllowed=false` 保持不变，Live execution/order/attempt/fill 全为 `0`。
- 最终报告：`data/operator/final-reports/ni-k-paper-mixed-core-24h-final-20260727-0300.md`。

## Next steps
1. 完成本轮钱包会话与连接后生产装配接线，并做一次全量测试与浏览器回归。
2. 用户连接正式 Polygon 钱包后，由受授权宿主调用 `assembleConnectedLiveRuntime`，显式提供 signer、认证 CLOB、余额/合规/地域/时钟 provider、市场数据和 `ConfiguredOperatorLiveRuntimeActions`，再进行真实 Gate 预检和二次授权；当前不宣称已具备实盘凭据或真实运行证据。
3. 在真实钱包连接前继续保持 `PAPER + LIVE_DISABLED + liveAllowed=false`，不自动启动 Paper、不提交真实订单。
