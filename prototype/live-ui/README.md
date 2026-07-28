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

UI 每 3 秒重新读取快照（编辑输入时不会被静默轮询打断）。Paper 启动、暂停、恢复会复用现有安全入口；Live 展示小额参数、钱包连接、交易授权、readiness、Gate 预检、运行、对账、恢复和紧急停用。连接按钮使用 EIP-1193 `eth_requestAccounts`、`eth_chainId` 和一次性 `personal_sign` challenge；后端只保存公开地址、网络和内存会话，不读取私钥。只有用户后续明确点击钱包授权或最终 Live 确认时，才可能触发相应的真实外部操作。

后台明细包含 Live 账户、执行、订单尝试、订单、成交、持仓、资金/手续费/PnL 账本、对账、恢复、隔离异常和审计；原始订单请求/响应与日志内容不进入快照，只保留失败原因和安全的文件索引。

生产公开配置写入被 Git 忽略的 `data/operator/live-production.json`，包含公开
signer/trading 地址、Polygon 网络、EOA 类型、小额风险上限和确认时间，不含秘密。
`server.mjs` 在钱包 session 证明通过后调用 `assembleDefaultConnectedLiveRuntime`：
它装配浏览器 signer、会话内惰性认证 CLOB、真实只读余额/allowance/仓位、
Polymarket CLOB adapter、EOA allowance/redeem、官方 geoblock、时钟、合规、
身份绑定、Live 账户、Gate 和外部对账。保存配置会撤销旧 session 并要求重连；
Gate 确认后必须先通过同步恢复检查才能启动，启动失败自动回滚，后台循环异常自动
紧急停用。当前 UI 只开放完整闭环的普通 EOA；智能钱包路径需要官方账户初始化或
relayer，未在页面中伪装为可直接使用。

视觉参考：[guokaigdg/animal-island-ui](https://github.com/guokaigdg/animal-island-ui)。本地皮肤独立实现，没有复制参考仓库代码、图片、字体或 Nintendo 资产；海豹、边牧和乌鸦背景图也是本项目原创绘制。
