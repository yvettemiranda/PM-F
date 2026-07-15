Polymarket 跟单系统：操作入口说明

普通使用请只打开项目根目录的“点这里运行”文件夹。

当前推荐顺序：
1. 双击“1_开始Paper短测_2小时.command”。
2. 结束后，把 Finder 选中的 ZIP 发给 Codex。
3. 只有短测自动通过后，再双击“4_开始Paper长期验收_7天.command”。

“操作入口”中的 1—5 号文件保留用于环境检查、Observe 专项复查和诊断，
普通 Paper 验收不需要使用这些旧的高级入口。

安全边界：
- 固定 PAPER + LIVE_DISABLED；
- 没有 Live 双击入口；
- 不读取 private key；
- 不创建真实订单；
- 不执行链上写操作。
