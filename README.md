# ApiStation FinOps

ApiStation 的成本、用量、充值与利润核算旁路系统。

当前目录已包含可运行的 MVP 原型。技术路线为 Node.js 22 单服务：同一进程承载 HTTP API、周期同步器和静态管理前端，复用现有 PostgreSQL 实例并使用独立 `finops` Schema。FinOps 不参与转发和扣费主链路，只读访问 `sub2api` 所需源字段，不读取账号凭证，也不修改用户余额。

核算采用单一 CNY 账本：用户充值、余额、实际扣费、采购成本、确认收入和利润均为人民币。当前用户侧只支持按量计费，充值和扣减均按 CNY 入账；钱包余额按充值批次 FIFO 消耗确认人民币经营收入。账号采购可以登记周期固定成本，但不等同于用户订阅。真实 CNY 上游成本只来自 `account_cost_periods` 中以人民币登记的账号采购或供应商账单；没有成本记录的账号/请求标记为待补，不自动以模型定价推导利润。人工成本和资金录入只接受 CNY，不提供美元成本或自动汇率换算。`total_cost` 与 `account_stats_cost` 同属 USD 定价参考，其中 `standard_cost_usd_reference` / `tokenListValueUsd` 仅用于展示模型 Token 的标准 USD 目录价值和优惠参考，不是用户余额、成本、收入或第二套经营账。

## 文档

- `docs/ApiStation-FinOps-产品与技术设计-v0.2.md`：当前可编辑设计稿
- `docs/ApiStation-FinOps-产品与技术设计-v0.1.docx`：上一版 Word 评审稿，仅供历史参考
- `deploy/README.md`：Docker、数据库最小权限和 2C4G 部署说明

## 本地运行

需要 Node.js 22。开发环境未设置 `DATABASE_URL` 时会自动使用演示数据，不会连接或修改 ApiStation；生产环境缺少 `DATABASE_URL` 会直接拒绝启动。

```powershell
pnpm install
pnpm start
```

打开 `http://127.0.0.1:8090`。当前不需要在本地连接线上数据库，也不要把生产数据库密码发给开发人员或写进仓库。功能和迁移在本地验证完成后，由服务器管理员创建专用最小权限角色，在服务器本地配置连接串，先做 Schema 预检，再进行 7 天只读影子同步。

FinOps 目前尚未上线。首次生产部署应在新的 `finops` Schema 中执行 `001_init` 与 `002_cny_accounting`。如果任何测试或历史环境已记录旧版 `002_dual_ledger`，迁移会拒绝继续，不能把旧 USD Credit 数据自动改标为 CNY；必须先备份旧 `finops` 数据，再由管理员手工重建/核对并重新预检。

常用验证命令：`pnpm test`、`pnpm check`。所有金额台账字段在 PostgreSQL 使用 `NUMERIC`，Node.js 计算使用 `decimal.js`。

## 当前结论

- 2C4G/30M 在当前业务规模下可以部署 ApiStation 与 FinOps 两个应用服务。
- FinOps 不再部署独立 PostgreSQL/Redis，而是在现有 PostgreSQL 实例中使用独立数据库或 Schema。
- FinOps 对 `public` 源 Schema 只有所需列的 `SELECT`，只在自己的 `finops` Schema 写入台账和聚合。
- FinOps 不读取 `accounts.credentials` 或 `public.settings`；充值倍率仅通过管理员拥有的 `finops_source.balance_recharge_multiplier` 安全屏障视图读取。
- `users.balance`、支付入账和 `usage_logs.actual_cost` 均按 CNY 核算；上游成本以人工采购/账单的 CNY 入账和分摊为准，USD 只作为 Token 目录价值参考展示。
- 已实现经营总览、用户账务与利润、用量与扣费、账号台账与成本、供应商与采购、成本核算、充值与资金、对账中心、数据同步和告警中心 10 个管理页面。
- 已实现 `002_cny_accounting`、只读预检、可续传历史回填、用户/账号/用量/支付订单同步、日聚合、演示模式、CSV 导出、供应商采购聚合、来源级同步状态及成本档案录入。
- 已实现独立 `/monitor` 分组可用性监控页：管理端可配置展示的 `source_group_id`、名称、模型标签和排序；公开页可直接打开，也可在 FinOps 或上游控制台页面中通过 iframe 嵌入。监控配置与观测全部写入独立 FinOps 数据库，不修改上游服务、数据库或数据。
- 已包含 Dockerfile、Compose 示例、最小数据库权限脚本和部署说明。
- 上线前仍需完成生产 Schema 预检、历史回填演练、压测、备份恢复和连续 7 天影子对账。
