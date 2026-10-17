# PM-F 完整修复与结构优化

日期：2026-10-17。修改基线为 `1e551ba125282b0a783152abd06f324d24a3dce2`。
PM-NAUTILUS 仅作只读参考，未修改源码、仓库或部署。

## 底座选择

保留 TypeScript、Node 24、SQLite 和浏览器钱包签名。PM-F 的核心是跟随目标账户事件；
PM-NAUTILUS 的自主扫描、筛选与仲裁流程不是可以直接替换的同一种策略。
没有证据表明迁移到 Python/Nautilus 会减少网络、浏览器授权或交易所确认时间。
整套替换还会改变历史规则、订单恢复与账本兼容边界，因此本轮采用职责分离和共享规则。

新增的公共模块承载风险敞口、待退出权益、链上事件顺序、结算余数、协议路由、
交易钱包执行、赎回日志与到账证据。Paper 与 Live 复用数量和风险不变量；
外部调用留在适配器，现金与持仓应用留在 SQLite 事务。已有大类仍作为协调层保留，
没有为了缩短文件或行数搬走有恢复价值的审计逻辑。

## 审计问题的处理

| 编号 | 改动与回归保护 |
| --- | --- |
| F01 | 服务端生命周期代次使紧急停用、断开和关闭立即废止旧激活；覆盖所有主要 await 的并发请求。 |
| F02 | 保存经验证的 block/transaction/log 顺序，跨源归并及重启复用；无权威顺序的同秒歧义阻断受影响信号。旧基线迁移同时识别 conversion 的源、目的条件。 |
| F03 | 敞口统一为持仓成本加有效在途 BUY 义务；风险、预留和提交重查一致，替换本笔只扣其待成交预留。 |
| F04 | 比例 SELL 作用于扣除此前退出义务后的剩余跟随权益，再确定性分配到各 lot；成交早晚不改变退出目标。 |
| F05 | CTF 普通、CTF neg-risk、Protocol V2 分别使用正确签名域、交易所、collateral、outcome ledger 和授权对象；市场身份和路由随签名持久化。 |
| F06 | BUY 签名现金加保守费用不超过既有批准预算；更优价格增加实际 shares 合法，仍严格检查签名现金、限价及全额费用预算。提交与恢复共用校验。 |
| F07 | runner 接入受管赎回；先核对归属与批准，再原子保存整组意图；提交哈希先落盘，确认实际销毁和 pUSD 净入后再原子记账、清仓。 |
| F08 | 仅在明确零费时兼容 SDK 的指数 0/1 约定；非零费及缺失证据继续严格检查。 |
| F09 | 钱包或 signer 返回非法地址时生成明确失败项，不能因缺项而误报 identity.ready。 |
| F10 | final Gate 后、adapter 预读后及真实 SDK transport POST 前检查盘口时效、停用状态和代次，覆盖隐藏的认证和服务器时间 await；确定未发送的旧报价可重新规划。 |
| F11 | 资产级累计结算保留分 lot 舍入余数，兼容重启与历史 ruleset，不重写已关闭历史账本。 |

恢复额外修补了累计 SELL 快照的边界：同一订单已入账的成交份额只用于恢复累计校验，
不会再卖出或再次记账；未终结的部分成交继续保留义务。同一 fill ID 的经济字段改变、
或累计回报丢失已记账历史时明确阻断。

## 赎回和钱包边界

CTF 的当前 collateral adapters 会处理同 condition 两边余额，单边 indexSets 参数并不能
约束其行为。因此按 condition 聚合全部受管 lot，使用实际 adapter 的基础 collateral
派生两边 token ID，逐边验证钱包余额与受管权益完全一致。任何额外手动或 baseline
仓位都会在发送前阻断。CTF neg-risk 使用 wrapped collateral 的派生关系。

Protocol V2 按 asset 调用 Router 的精确数量赎回，允许保留额外钱包份额。收到的真实
pUSD 只记一次，按各 lot 已确认结算权益分配；对立结果不会按份额均分奖金。
回报必须证明正确交易、钱包、ledger、各资产销毁和 pUSD 净入，成功 receipt 本身不够。

默认生产装配支持 EOA，以及链上验证为单 owner、threshold=1、由当前浏览器 EOA
拥有的 Safe。Safe 通过其 execTransaction 执行，浏览器 EOA 支付 gas。
POLY_PROXY/POLY_1271 未有完整链上执行闭环，默认装配在交易前明确拒绝。

已有交易可在 Gate 关闭或浏览器会话过期后只读恢复到账。未知提交且未取得哈希时，
系统保留 SUBMITTING 并阻断新 BUY，不自动重发；需要外部证明后人工处理。
链上明确失败也不会被当作可随意重试的成功。待确认赎回每轮只查询一次，避免长轮询
占住整个交易循环。未确认的原有退出仍可继续处理。

CTF 底层合约没有数量参数：发送前的归属读取与钱包确认之间仍存在外部转入窗口。
系统会再次读取两边余额，回报也会拒绝未授权销毁，但事后检查不能撤回已发生的链动作。
因此不能宣称 CTF 对并发手动转入具备链上原子隔离；专属交易钱包可减少归属混用。

依据：[官方订单协议](https://docs.polymarket.com/trading/place-orders)、
[合约表](https://docs.polymarket.com/resources/contracts)、
[仓位管理](https://docs.polymarket.com/trading/positions/manage)、
[费用](https://docs.polymarket.com/trading/fees)，以及实际部署
[CTF adapter 的已验证源码](https://sourcify.dev/server/v2/contract/137/0xAdA100Db00Ca00073811820692005400218FcE1f?fields=all)。

## 冗余与延迟

静态依赖检查覆盖全部 CLI、UI server 和测试入口，没有发现完全无引用的 TypeScript
生产模块。五个 fake 组件供隔离测试使用；保留它们不会给正常交易轮次增加调用。
历史报告、文档和验证代码也不是每轮交易热路径，删除它们不能证明交易更快。

实际整理包括：去掉 LiveStore 重复的敞口求和；风险判断复用一次账户投影；
同次钱包检查用一个响应取得余额和对应 spender allowance；signer 复用当前盘口路由；
Observe 复用事件索引、批量检查已有信号；Paper 批量读取待退出义务；赎回按组查询
并消除逐 lot 重复全量扫描。没有跨轮缓存钱包余额或放宽报价时效来换速度。

10,000 个持仓、2,500 个待成交 BUY、5,000 条预留流水的内存 SQLite 对比，
敞口读取从 6 组查询变为 2 组，旧实现中位约 4.771 ms，新实现约 4.686 ms。
这属于基本持平的合成诊断，不能宣称显著 CPU 加速或真实成交延迟降低。
优化过程中曾发现简单减少查询反而增加对象转换开销，最终采用精确 BigInt 聚合，
大于 64 位整数也不会转换为浮点金额。

网络、钱包交互、流动性和链上确认仍决定实际等待时间。没有运行真实资金基准，
不承诺下单耗时或收益。运行健康视图现在暴露失败阶段、连续次数和 BUY 阻断原因，
恢复成功后清除当前故障项，避免只有进程 RUNNING 却看不到维护错误。

## 数据迁移与验收

schema 更新为 2.34.0，新增 038 事件顺序证据/歧义阻断、039 赎回持久化日志。
沿用既有升级前数据库备份与 schema 检查。发现旧基线存在无法证明顺序的同秒事件时，
将其标记为需要新的已验证基线；不会重写已发布信号或猜测历史因果顺序。
升级后应查看 Observe 的 rebase 阻断原因，重新建立符合当前规则的基线。

生产验收改用显式机器可读产物和内容哈希，移除对某个七月文件名及精确毫秒文本的依赖。
依然要求合格 Paper campaign、连续稳定窗口、Observe 健康、当前核心与测试套件匹配，
以及已验证的隔离证明；源码变化不会自动继承旧验收结论。

生成命令必须指定真实产物，例如：

```sh
pnpm validate:live-production \
  --paper-report=data/paper-validation/campaigns/<campaignId>/paper-campaign-report.json \
  --observe-report=data/paper-validation/campaigns/<campaignId>/sessions/<sessionId>/observe-internal.json \
  --isolated-verification=data/operator/paper-campaign-isolated-verification.json
```

Paper 累计活跃时间至少 24 小时，保留既有至少 4 小时连续 Campaign 门槛；
独立 Observe 验证要求至少 8 小时连续健康数据。命令验证产物，不会替用户生成经过
这些时长的运行事实。旧 v2 生产工件需用当前版本重新验收。

本次只使用临时 SQLite、受控时钟、假公开 API/钱包/链上回报和锁定的真实 SDK。
没有连接真实钱包、私有账户、下单、写链或部署服务器，也没有伪造新的生产验收产物。
本地最终全量验证：83 个测试文件、1,142 项测试全部通过，TypeScript 检查、
5 个浏览器脚本语法、zsh 启动器语法及 `git diff --check` 均通过。
GitHub CI 的最终结果见本次提交记录及交付报告。
自动检查不能替代当前版本的长期 Paper、真实手续费、持仓、地区可用性与赎回闭环验收。
