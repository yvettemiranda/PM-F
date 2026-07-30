# 脱敏验证文件

这里仅保存可以进入 GitHub 私有仓库的结构化验证摘要，不保存数据库、原始 Capture、
运行日志、钱包 session、签名订单意图或任何私密凭据。

`live-production-validation-v2.json` 绑定的是当前 runtime source commit 和 hash。它证明
隔离验证工件的结果，不证明真实订单、真实成交、真实 PnL 或实盘授权。运行时源代码变化
后必须重新执行 `pnpm validate:live-production`，并由发布清单重新核对。
