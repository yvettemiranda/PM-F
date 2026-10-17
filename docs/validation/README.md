# 脱敏验证文件

这里仅保存可以进入 GitHub 私有仓库的结构化验证摘要，不保存数据库、原始 Capture、
运行日志、钱包 session、签名订单意图或任何私密凭据。

目录中的 `live-production-validation-v2.json` 是历史版本的验证摘要，不能作为当前版本
Live 的放行凭据。当前入口使用 `live-production-validation-v3`，绑定 runtime hash、
source commit，以及机器可读 Campaign、Observe、隔离证明的路径和内容哈希。

运行时源码或核心契约变化后，需按[当前修复说明](../PM_F_FULL_REPAIR_2026_10_17.md)
提供真实报告路径重新执行 `pnpm validate:live-production`，并由发布清单复核。
隔离验证通过不证明真实订单、真实成交、真实 PnL 或实盘授权。
