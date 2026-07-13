Polymarket 跟单系统：最简单操作方式

你不用记命令。
只需要按顺序双击这些文件。

第一步：
双击：
1_先点我_检查环境.command

如果没有红色报错，再进行第二步。

第二步：
双击：
2_开始Observe_24小时.command

然后保持电脑开着，保持弹出的 Terminal 窗口开着。
它会跑 24 小时。
系统会自动启用 macOS 防睡眠；屏幕可以关闭，但不要关机。
第一次遇到数据库升级时，系统会先自动备份，再迁移和检查；不要在准备过程中强制关机。

如果你想提前停止：
在运行窗口按 Ctrl-C
或者双击：
3_停止当前运行.command

第三步：
运行结束后，双击：
4_打开报告文件夹.command

把最新的这些文件发给 Codex：
- data/observe/ 里的 observe-xxx.json
- data/operator/logs/ 里的 observe-24h-xxx.log

如果 Codex 说需要更多诊断：
双击：
5_一键生成诊断报告.command

然后把最新的：
- data/validation/.../validation-report.json
- data/operational/.../operational-report.json
发给 Codex。

Paper 入口：
6_开始Paper_24小时_等我确认后再点.command

这个先不要自己点。
建议先把 Observe 报告发给 Codex 看过，确认没问题后再运行。
它会先恢复上次的同一个 Paper 模拟账户，再同时运行 Observe 和 Paper。
这样运行期间会持续产生新 Signal，重启也不会重复消费已处理的 Signal。
结束后请同时发送：
- data/observe/ 里的最新 observe-xxx.json
- data/paper/ 里的最新 paper-xxx.json
- data/operator/logs/ 里的最新 paper-24h-xxx.log

安全说明：
- 这些入口不会开启 Live。
- 不会读取 private key。
- 不会创建真实订单。
- 不会执行链上操作。
- 当前只是 Observe 和 Paper 模拟验证。

运行 24 小时时建议接上电源。入口会自动防止系统睡眠；屏幕可以正常关闭。
