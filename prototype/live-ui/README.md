# Hecatonchires operator console

这是 Hecatonchires 的 localhost 操作控制台。页面通过 `/api/operator/snapshot` 读取后台权威投影，并通过同源 API 写入目标地址、规则集、Paper 生命周期和 Live Gate；浏览器不保存账户、订单或模式状态，也不伪造交易数据。

设计结论：采用“目标 / 我的对照台”，每一笔目标开仓或平仓都直接对照我的执行结果。A/B 两个候选结构已经删除。

视觉方向：当前采用独立实现的 Animal Island-inspired 皮肤：奶油米白画布、暖棕文字、薄荷青绿/焦点黄、波点纹理、pill 控件、燕尾标题和轻微按键式动效；BUY/SELL、YES/NO 与执行状态仍保留交易语义色。页面底部加入原创的海豹、边牧和乌鸦插画作为低透明度装饰层，保证背景有角色但不影响数字与明细阅读。没有复制参考仓库的代码、图片、字体文件或 Nintendo 资产。

参考：[guokaigdg/animal-island-ui](https://github.com/guokaigdg/animal-island-ui)。该仓库使用 CC BY-NC 4.0，本原型只借鉴公开的视觉语言，不直接依赖其包或资源；如未来进入商业产品，需要重新设计并进行许可审查。

运行：

```bash
pnpm operator:ui
```

浏览器打开 `http://127.0.0.1:4173/`。

UI 每 3 秒重新读取快照（编辑输入时不会被静默轮询打断）。Paper 启动、暂停、恢复会复用现有安全入口；Live 按最终生产流程展示公开钱包登记、前置条件 readiness、Gate 预检、运行、对账、恢复和紧急停用入口。当前没有正式钱包、signer、认证 CLOB、真实资金或授权运行时，所以所有真实执行入口会由后台明确阻断。页面只保存公开钱包地址和网络，不读取私钥，也不会提交真实订单。

后台明细包含 Live 账户、执行、订单尝试、订单、成交、持仓、资金/手续费/PnL 账本、对账、恢复、隔离异常和审计；原始订单请求/响应与日志内容不进入快照，只保留失败原因和安全的文件索引。

生产钱包公开配置写入被 Git 忽略的 `data/operator/live-production.json`，只包含地址、网络和安全宿主注入标识。等正式钱包连接后，受授权宿主进程显式注入已经装配好的 `LiveRuntime`/`LiveExecutor`，并通过 `ConfiguredOperatorLiveRuntimeActions` 的 `production` capability overrides 提供每个真实 provider 已注入的证据，才会把对应 readiness 项变为 READY；随后启动、紧急停止、订单取消、单笔执行重试、对账和恢复可接入同一控制面。UI 服务器本身不会发现或加载任何凭据，默认使用“待前置条件”的 `UnconfiguredOperatorLiveRuntimeActions`。

视觉参考：[guokaigdg/animal-island-ui](https://github.com/guokaigdg/animal-island-ui)。本地皮肤独立实现，没有复制参考仓库代码、图片、字体或 Nintendo 资产；海豹、边牧和乌鸦背景图也是本项目原创绘制。
