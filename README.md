# Morpho Auto Redeem

用于观察 Morpho 借贷市场流动性，并研究在流动性恢复时自动退出供给仓位的开源工具。
基于 [antoncoding/auto-redeem](https://github.com/antoncoding/auto-redeem) 扩展。

**新用户请从只读监控开始：只需 RPC 和持仓公开地址，不需要 Bot 钱包、私钥、授权或 ETH。**

## 当前状态与适用范围

| 模式 | 分支 / 状态 | 会发送主网交易吗？ | 需要什么？ |
| --- | --- | --- | --- |
| 只读监控 | `master`，第一阶段已合并 | 不会 | Ethereum RPC、持仓公开地址 |
| 只读提现计划（dry-run） | `feat/scoped-morpho-auto-exit`，[Draft PR #2](https://github.com/ChrisZyy3/morpho-auto-redeem/pull/2) | 不会 | 同上，无需 Bot 钱包 |
| 限权自动提现（`--live`） | 同一开发分支，尚未完成主网实盘验收 | 会，必须显式启用 | 自行部署并核验的执行合约、主钱包授权、独立 Bot 和 Gas |
| 上游旧模式 | 保留兼容，见文末 | 可能会 | 依各模式配置；权限模型不同 |

当前新增的监控与限权执行路径**只适用于 Ethereum 主网的以下直接 Lend 仓位**：

| 项目 | 固定值 |
| --- | --- |
| Chain ID | `1` |
| 借出资产 / 抵押资产 | USDC / dCOMP |
| Market ID | `0x24852d8d7464402ddcd717415e009d42bf7427d6a8893487f83c75ee0f4a0ea6` |
| Morpho Blue | `0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb` |
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| dCOMP | `0x91d14789071e5E195FFC9F745348736677De3292` |

同一市场的其他持仓人可以填自己的公开地址使用。ERC-4626 Vault 份额、其他
Morpho 市场或其他链不属于这条新路径的适用范围；修改配置地址不会自动获得兼容性。
日志中的金额是存储状态估值，不是可立即成交的提现报价。

## 1. 安装并运行只读监控

要求 Node.js 20+（推荐 22）、pnpm 10.13.1（由 `package.json` 固定），以及能读取
Ethereum 主网状态的 HTTP(S) RPC。以下命令适用于 macOS / Linux shell。

```bash
git clone https://github.com/ChrisZyy3/morpho-auto-redeem.git
cd morpho-auto-redeem
git switch master
node --version
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
```

如果环境没有 Corepack，请先安装匹配的 pnpm 版本。运行本页只读 JavaScript 入口
不需要启用依赖安装脚本；上游旧模式有自己的运行要求。

创建本机配置，已有 `.env` 时先保留并核对，避免覆盖：

```bash
cp -n .env.safe.example .env
chmod 600 .env
```

编辑 `.env`：

```dotenv
RPC_URL=https://YOUR_ETHEREUM_MAINNET_RPC
OWNER_ADDRESS=0xYOUR_POSITION_HOLDER_ADDRESS
POLL_MS=1000
MIN_ALERT_USDC=1000
HEARTBEAT_MS=30000
STALE_MS=120000
```

占位值必须替换为真实配置。`OWNER_ADDRESS` 是**持有该市场供给仓位的地址**。
不要在只读配置中放入任何私钥或助记词；RPC API Key 只保存在本机。

```bash
node --test src/modes/auto-withdraw/safe-math.test.mjs src/modes/auto-withdraw/safe-monitor.test.mjs
node src/modes/auto-withdraw/safe-monitor.mjs
```

按 `Ctrl+C` 停止。**`pnpm start` 是上游旧交互入口，不是这里的只读监控命令。**

### 如何确认监控正常

| 日志事件 | 含义 / 应检查的内容 |
| --- | --- |
| `started` | 配置和市场检查通过；不代表已经读到仓位 |
| `snapshot` | 首次成功读取仓位；核对持仓估值、份额和区块 |
| `status` | 定期健康记录；看 `health`、最后成功时间、区块是否推进 |
| `liquidity_detected` | 估计可提金额达到提醒阈值；没有发送交易 |
| `liquidity_drained` | 低于提醒阈值，不一定为零 |
| `rpc_error` / `rpc_recovered` | 连接异常 / 随后恢复；异常不代表余额为零 |
| `head_stale` / `head_recovered` | 区块长时间未推进 / 恢复推进 |
| `position_empty` | 当前地址在该市场没有供给份额，程序正常退出 |

无流动性时也应有初始快照和持续健康记录。`MIN_ALERT_USDC` 只是日志阈值，
不会改变仓位或触发提现。日志是本机事件，**没有邮件、手机或聊天推送**。

每轮完成后才等待 `POLL_MS`，因此 RPC 慢时实际间隔会增加。仓位和市场读取
固定在同一区块；监控不会回补错过的区块，也不按区块哈希识别同高度重组。
同一笔交易内出现又消失的流动性无法靠这种区块后轮询捕获。

Mac mini 的后台启动、路径配置与停止方式见
[部署文档](./docs/safe-monitor-macmini.md)。只有完成前台验收后，再配置常驻服务。

## 2. 验证 RPC，再考虑自动提现

只读监控、RPC 排查和本地测试都不需要 Bot 钱包或 Gas。RPC 至少应通过：

1. 确认 Chain ID 为 `1`，并验证市场参数中的代币地址。
2. 连续读取新块及对应区块的市场状态，而非只成功返回一次链 ID。
3. 持续观察快照、区块推进、错误恢复和旧数据告警。

公共 RPC 可能限流、超时或拒绝部分方法。重试恢复证明程序处理了故障，不代表
连接已经满足实盘稳定性要求。先对比直连和代理；不要仅因系统启用了代理，就
强制 Node 也走代理。`--use-env-proxy` 还要求所用 Node 版本支持该选项。

开发分支另外提供只读诊断入口（先切换到下一节的分支）：

```bash
NODE_USE_ENV_PROXY=0 node scripts/check-rpc.mjs
```

它不会输出端点 URL 或任意服务商错误详情。详细对照方法见
[RPC 排查文档](https://github.com/ChrisZyy3/morpho-auto-redeem/blob/feat/scoped-morpho-auto-exit/docs/rpc-connection-check.md)。
短时测试成功不能证明长期可用率。

## 3. 只读提现计划：无需钱包的下一步

第二阶段尚在开发分支，**默认克隆的 `master` 不包含以下入口**。
已按第一节安装并保存只读配置后：

```bash
git fetch origin
git switch feat/scoped-morpho-auto-exit
pnpm install --frozen-lockfile --ignore-scripts
EXIT_ENV_FILE=.env node src/modes/safe-exit/script.mjs --once
```

不加 `--live` 时只读取仓位、计算本轮可提计划，可能输出 `dry_run` 或
`no_liquidity`。它**不会创建签名账户、执行交易模拟、授权或广播交易**；真实
执行模式才会在签名前做交易模拟。这种只读演练不证明交易可以成功成交。

`--once` 表示执行一轮；省略后会持续检查。演练也会创建本机状态文件及锁，
应使用与实盘不同的 `JOURNAL_PATH`。第二阶段变量模板为
[.env.exit.example](https://github.com/ChrisZyy3/morpho-auto-redeem/blob/feat/scoped-morpho-auto-exit/.env.exit.example)。

## 4. 真实提现前需要哪些准备

本仓库没有可直接复用的已核验公共执行合约地址。每个使用者需要为自己的
`positionOwner` 和 `botOperator` 部署并核验实例；目前没有一键部署或主网
自动配置流程。详细步骤见
[限权自动提现文档](https://github.com/ChrisZyy3/morpho-auto-redeem/blob/feat/scoped-morpho-auto-exit/docs/scoped-auto-exit.md)。

```text
主钱包持有仓位 → 在 Morpho 中授权执行合约
独立 Bot → 调用执行合约 → 从固定市场提现 → USDC 直接回主钱包
```

- **主钱包**：始终持有仓位并接收 USDC，私钥不进入脚本。
- **Bot EOA**：普通的独立执行账户，公开地址在准备部署参数时才需要；私钥到
  实盘配置时才由使用者存入本机。建议使用独立助记词并妥善备份。
- **执行合约**：固定市场、持仓人和执行账户，收款人始终为持仓人；没有任意
  调用、借款、提取抵押品、升级或修改收款人的入口。主钱包可暂停合约或撤销授权。
- **ETH**：Bot 支付提现 Gas，部署账户支付部署 Gas，主钱包支付授权 Gas。
  不需要把 Lending 仓位或 USDC 转给 Bot；充值应根据实际费用估算决定。

**Morpho 授权本身覆盖账户在该合约内的相关仓位，不是单市场限额授权。**
这条新路径依靠执行合约代码限制权限。不要直接给 Bot EOA 这种广泛授权，
也不要认为“使用新 Bot 钱包就只有 Bot 里的 ETH 有风险”。合约缺陷可能影响
被授权的 Morpho 仓位；Bot 私钥泄露也可能导致 Gas 被消耗、仓位被提前提回。

实盘顺序：审查源码和测试 → 验证 RPC → 准备 Bot 地址及部署参数 → 核验部署
字节码与固定地址 → 主钱包仅授权已核验执行合约 → 配置本机 Bot Key 和费用
预算 → 先做有金额上限的单次小额验收 → 核对到账后再考虑连续运行。

实盘配置使用 `.env.exit.local`，而不是把 Bot Key 加进只读 `.env`。还需要
`OPERATOR_ADDRESS`、`EXECUTOR_ADDRESS`、核验后的 `EXECUTOR_CODE_HASH`、
`BOT_PRIVATE_KEY` 和 `LIVE_CONFIRMATION=WITHDRAW_TO_OWNER`。
**`--live` 会发送交易**，应在完成上述准备后按详细文档操作。

### 自动执行的限制

- 工作者先模拟同一笔调用、估算 Gas 并检查提现金额及费用上限，再签名。
- 每次按明确资产数量提现；默认最低 100、最高 1,000 USDC，可能留下不足阈值
  的尾款。默认值是配置示例，不是对所有用户的费用或金额建议。
- 默认 Gas 上限 200,000、最高费率 5 gwei、优先费率 0.5 gwei、每笔费用上限
  0.001 ETH、UTC 每日预算 0.003 ETH、3 次区块确认；都应按实际情况核对。
- 未确认交易会保存在本机，广播不确定时只重发同一签名；不会自动加速或取消。
  只有区块哈希、nonce、确认数和 USDC 转入事件符合要求才记录为确认到账。
- 状态文件和锁负责预算及重复交易保护。不要删除或更换状态路径来解决未知
  交易；崩溃后先确认旧进程已停止、查清链上状态，再处理陈旧锁。
- `state/` 含签名交易字节，应保密。模拟失败、部分 RPC 错误或状态异常会停止
  实盘工作者，需人工检查；目前没有实盘自动后台服务模板。

## 5. 验证记录与已知边界

第二阶段的独立 AI 代码审查及修复记录见
[安全审查文档](https://github.com/ChrisZyy3/morpho-auto-redeem/blob/feat/scoped-morpho-auto-exit/docs/scoped-auto-exit-review.md)。
这些记录不等同于第三方机构审计，也不是主网部署或实盘成功证明。

已执行的验证包括只读主网读取、离线测试、模拟 Morpho/USDC 的本地 EVM 签名与
区块重组测试，以及真实 Morpho/USDC 代码的主网分叉测试。分叉中的授权、测试
流动性和提现只发生在本地，不会修改主网。网络分叉测试在未配置时会明确跳过；
不能把跳过算作通过。历史测试数量和快照以审查记录、提交及对应 CI 为准。

本工具不会创造流动性、强制还款、消除坏账或保证抢到提现机会；也没有
Public Allocator 调拨、交易内原子流动性捕获或收益保证。

## 6. 上游旧入口与贡献

`pnpm start`、`start:vault-redeem`、`start:morpho-market-withdraw` 和
`start:legacy` 保留了上游逻辑。它们不是上述限权执行路径，不能因为新路径
有交易记录、预算和合约校验，就假定这些旧模式也具备同样保护。
旧 Morpho 模式依赖直接 EOA 授权，可影响被授权仓位。

贡献代码或报告问题时，请附运行模式、分支、提交、Node 版本、脱敏后的错误
类别及复现步骤。不要提交私钥、助记词、RPC API Key、`.env`、完整签名状态文件
或包含凭据的原始错误。

- [Mac mini 只读部署](./docs/safe-monitor-macmini.md)
- [上游 Vault 模式](./docs/vault-redeem.md)
- [上游模式扩展说明](./docs/adding-modes.md)
- [第二阶段 Draft PR](https://github.com/ChrisZyy3/morpho-auto-redeem/pull/2)
