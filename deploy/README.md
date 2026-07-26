# 部署说明

首版与 `sub2api` 共用 PostgreSQL 实例，但只在同一个数据库中新建 `finops` Schema。应用使用专用最小权限角色：对 `public` 只授予同步所需字段的 `SELECT`，禁止读取 `accounts.credentials` 和整张 `public.settings`，只允许在 `finops` Schema 内写入。充值倍率由管理员拥有的 `finops_source.balance_recharge_multiplier` 安全屏障视图暴露唯一非敏感配置行。生产库管理员密码不进入 FinOps 配置，也不需要提供给开发人员。

当前阶段不需要从本地连接线上数据库。应先完成本地迁移和功能验证，再由服务器管理员在服务器内创建专用角色并配置连接串。仓库示例统一使用 `finops_app`：该角色对 `public` 源表只有列级只读权限，对 `finops` Schema 具有应用写入权限；它不是 PostgreSQL 管理员，也不能读取账号凭证。若部署方更希望使用 `finops_reader` 这一名称，可以在服务器执行授权脚本时统一重命名，但不要改变权限边界。

生产核算只有一套 CNY 账本：充值实付、入账余额、用户当前余额、`usage_logs.actual_cost`、采购、收入和利润均按人民币处理。真实 CNY 上游成本只从 `account_cost_periods` 中以人民币登记的账号采购或供应商账单进入；缺少成本记录时标记待补，不用模型定价或 USD 自动换算生成利润。人工成本和资金流水只接受 CNY。`usage_logs.total_cost` 与 `account_stats_cost` 同属 USD 模型/渠道定价参考；同步器只保留 `standard_cost_usd_reference` 作为 Token 标准 USD 目录价值/优惠参考，忽略 `account_stats_cost` 的 CNY 成本推导。

## 迁移边界

FinOps 目前尚未部署到生产环境，正式首次部署只支持新的空 `finops` Schema，依次执行 `001_init` 和 `002_cny_accounting`。

如果任何测试或历史环境的 `finops.schema_migrations` 已包含 `002_dual_ledger`，不要继续自动迁移，也不要把旧 USD Credit 字段批量更新为 CNY。迁移程序会主动拒绝该状态。正确处理流程是：

1. 停止该环境的 FinOps 同步，备份完整 `finops` Schema 和迁移记录；`public` 源表始终不动。
2. 抽样确认旧余额、扣费和收入的实际单位，导出仍需保留的手工成本与审计记录。
3. 由数据库管理员选择新建干净 Schema，或在确认备份可恢复后手工重建旧 Schema；不要直接覆盖旧账。
4. 重新执行只读预检、`002_cny_accounting`、历史回填和 7 天影子对账，确认 CNY 守恒后再启用报表。

## 上线前检查

1. 备份 PostgreSQL，确认数据库恢复流程可用，服务器至少保留 5GB 可用磁盘；更稳妥的目标是保留 20GB。
2. 用 `docker network ls` 和现有 `sub2api` Compose 配置确认真实 Docker 网络名，写入 `APISTATION_DOCKER_NETWORK`。示例文件故意不提供猜测默认值。
3. 执行只读 Schema 预检：确认所需表、字段、类型、主键、时间范围、软删除字段、`finops_source.balance_recharge_multiplier` 和 CNY 单位契约；确认 `accounts.credentials` 与 `public.settings` 不可读，安全屏障视图可读。
4. 抽样核对源表行数、最早/最晚时间、完成支付、退款、钱包用量和订阅用量；比较 `payment_orders.amount/pay_amount` 与充值倍率后再决定首次回填窗口。
5. 生产 `.env` 只保存在服务器，`DATABASE_URL` 使用专用角色，不使用 PostgreSQL 管理员或 `sub2api` 主应用账号。

Schema 预检失败时不得开始同步。预检只查询 `information_schema`、目录视图和有限聚合，不写 `public` 源表。

## 上线步骤

1. 修改并执行 `deploy/postgres-grants.sql`，统一数据库名、角色名和强随机密码；执行后复核 `public` 权限与 `finops` Schema 所有权。
2. 将 `.env.example` 复制为服务器上的 `.env`，配置 `DATABASE_URL`、强随机 `ADMIN_TOKEN` 和已核实的 Docker 网络名。
3. 执行只读预检：`docker compose -f deploy/docker-compose.example.yml run --rm apistation-finops pnpm preflight`。预检失败时立即停止，不执行迁移或同步。
4. 执行迁移：`docker compose -f deploy/docker-compose.example.yml run --rm apistation-finops pnpm migrate`。
5. 在低峰期执行可中断、可续传的历史回填：`docker compose -f deploy/docker-compose.example.yml run --rm apistation-finops pnpm backfill`。
6. 启动服务：`docker compose -f deploy/docker-compose.example.yml up -d --build`。
7. 检查 `/health` 确认进程存活，再检查 `/ready` 确认数据库连接、`002_cny_accounting` 迁移和同步状态正常。
8. 使用 Nginx/Caddy 将独立域名反向代理到 `127.0.0.1:8090`，并启用 HTTPS；8090 不直接暴露公网。
9. 连续运行 7 天影子同步，只观察和对账，不把报表作为结算依据。请求数、Token、CNY 余额扣减、现金收退款和成本批次稳定后再转为正式经营报表。

## 影子同步验收

- FinOps 对 `sub2api` 始终是只读旁路；停止 FinOps 不影响转发、余额扣减或支付。
- 钱包与订阅按 `billing_type` 分开核对，订阅现金收入单列，不提前混入钱包确认收入。
- CNY 账本核对实付、入账余额、赠送/返利、当前余额、`actual_cost`、现金退款、采购、费用、确认收入和利润。
- 钱包确认收入按 CNY 充值余额批次 FIFO 消耗；赠送、返利等现金基础为 0 的批次不能伪装成现金收入。
- `total_cost` / `standard_cost_usd_reference` 只核对 Token 标准 USD 目录价值，不进入人民币余额、成本、收入或利润，也不自动换算为 CNY。
- `account_stats_cost`、`total_cost` 及其倍率公式均为 USD 定价参考，不能直接计入 CNY 成本或毛利；人工账号成本和资金流水只允许人民币金额，不使用任何 USD→CNY 估算参数。
- 每日记录源表和 FinOps 的请求数、Token、金额差异及原因；任何不明差异先修正口径，不回写源表。

## 2C4G 建议

- 容器内存上限 384MB，Node 堆上限建议 256MB。
- 数据库连接池保持 5 个连接，同步周期 60 秒、每批 1,000 条。
- 每轮最多 3 批，避免历史积压抢占 `sub2api` 的 CPU 和数据库 I/O。
- 第一次历史回填按天分批执行，不要与 ApiStation 高峰期重叠。
- 上线前连续影子运行 7 天；用量、支付和成本对账稳定后再用于正式利润判断。
- Compose 将管理端口绑定到 `127.0.0.1`，并将容器日志限制为 3 个 10MB 文件。

## 安全要求

- 生产环境必须设置 `AUTH_DISABLED=false`，`ADMIN_TOKEN` 至少 24 个字符。
- 生产环境必须设置非空 `DATABASE_URL`；缺失时服务拒绝启动，不允许退回演示模式。
- 不向 FinOps 授予 `accounts.credentials` 的业务访问能力，也不在日志中输出密钥。
- 不向 FinOps 授予 `public.settings` 表或其 `key/value` 列权限；只允许读取管理员拥有、仅返回 `BALANCE_RECHARGE_MULTIPLIER` 的 `finops_source.balance_recharge_multiplier` 安全屏障视图。
- PostgreSQL 不暴露公网；反向代理只开放管理端域名。
- 每日备份 `finops` Schema，采购成本和现金流水按财务数据保留。
- `DETAIL_RETENTION_DAYS` 目前只是保留策略配置，占位任务未启用前不得假定明细会被自动清理。
