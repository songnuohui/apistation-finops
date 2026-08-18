<template>
  <div class="page-view replenishment-view">
    <section class="replenishment-hero">
      <div>
        <div class="eyebrow-line"><RefreshCw :size="15" /> 库存自动化</div>
        <p>根据 FinOps 已采购账号的健康状态、剩余额度和修复进度自动维持目标库存。</p>
      </div>
      <div class="replenishment-hero-actions">
        <button class="icon-text-button" :disabled="loading" @click="load"><RefreshCw :size="15" :class="{ spinning: loading }" />刷新</button>
        <span class="connection-indicator" :class="{ connected }"><i />{{ connected ? 'OAuth Supply 已连接' : '等待连接' }}</span>
      </div>
    </section>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <section class="metric-grid replenishment-metrics">
      <div class="metric-card"><span>期间有效库存</span><strong>{{ dashboard.summary?.effectiveAccounts || 0 }}</strong><small>筛选期间采购，当前健康且额度充足</small></div>
      <div class="metric-card warning"><span>期间低额度账号</span><strong>{{ dashboard.summary?.lowQuotaAccounts || 0 }}</strong><small>筛选期间采购，当前达到额度阈值</small></div>
      <div class="metric-card danger"><span>期间不可用账号</span><strong>{{ dashboard.summary?.unavailableAccounts || 0 }}</strong><small>筛选期间采购，当前停用、过期或异常</small></div>
      <div class="metric-card"><span>期间修复中</span><strong>{{ dashboard.summary?.repairingAccounts || 0 }}</strong><small>筛选期间采购，当前等待认领或重试</small></div>
      <div class="metric-card"><span>期间进行中订单</span><strong>{{ dashboard.summary?.activeOrders || 0 }}</strong><small>当前筛选范围内审批、下单或导入中</small></div>
      <div class="metric-card good"><span>期间采购成本</span><strong>{{ money(dashboard.summary?.totalCostCny) }}</strong><small>当前筛选范围实际支付金额</small></div>
      <div class="metric-card"><span>当前 OAuth 可用余额</span><strong>{{ moneyFen(dashboard.oauthSupply?.balance?.available_fen) }}</strong><small>实时值，不随历史区间变化；总余额 {{ moneyFen(dashboard.oauthSupply?.balance?.balance_fen) }}</small></div>
    </section>

    <nav class="replenishment-tabs" aria-label="自动补号工作区">
      <button :class="{ active: activeSection === 'setup' }" @click="changeSection('setup')"><Settings2 :size="16" /><span>策略与映射</span><small>{{ rules.length }}</small></button>
      <button :class="{ active: activeSection === 'logs' }" @click="changeSection('logs')"><History :size="16" /><span>执行日志</span><small>{{ eventsLoaded ? executionEvents.length : '…' }}</small></button>
      <button :class="{ active: activeSection === 'orders' }" @click="changeSection('orders')"><ShoppingCart :size="16" /><span>补号订单</span><small>{{ ordersLoaded ? orderData.total : (dashboard.summary?.totalOrders || 0) }}</small></button>
      <button :class="{ active: activeSection === 'repairs' }" @click="changeSection('repairs')"><Wrench :size="16" /><span>账号修复</span><small>{{ recoveriesLoaded ? recoveryData.pendingTotal : (dashboard.summary?.repairingAccounts || 0) }}</small></button>
    </nav>

    <div v-if="activeSection === 'setup'" class="replenishment-layout">
      <section class="panel">
        <div class="panel-head">
          <div><h2>补号策略</h2><p>支持库存阈值、智能容量预测和定时定量三种补号方式。</p></div>
          <button class="primary-button" @click="newRule"><Plus :size="15" />新增策略</button>
        </div>
        <div v-if="!rules.length" class="empty-state">还没有补号策略</div>
        <div v-else class="rule-list">
          <article v-for="rule in rules" :key="rule.id" class="rule-row">
            <div class="rule-main">
              <div class="rule-title">
                <strong>{{ rule.name }}</strong>
                <span class="status-pill" :class="rule.enabled ? 'success' : 'warning'">{{ rule.enabled ? '启用' : '停用' }}</span>
                <span class="mode-pill">{{ modeLabel(rule.mode) }}</span>
                <span class="mode-pill">{{ triggerStrategyLabel(rule.triggerStrategy) }}</span>
              </div>
              <small>{{ rule.product }} · {{ platformText(rule.platform) }} · {{ groupSummary(rule.targetGroupIds) }}</small>
              <div class="rule-facts">
                <template v-if="rule.triggerStrategy === 'inventory_threshold'">
                  <span>有效 {{ rule.lastInventorySnapshot?.effectiveAccounts ?? '--' }}</span>
                  <span>低于 {{ rule.minAvailableAccounts }} 触发</span>
                  <span>补到 {{ rule.targetAvailableAccounts }}</span>
                  <span>额度 {{ quotaWindowLabel(rule.quotaWindow) }} ≥ {{ rule.quotaUsedThresholdPercent }}%</span>
                </template>
                <template v-else-if="rule.triggerStrategy === 'smart_forecast'">
                  <span>有效 {{ rule.lastForecastSnapshot?.effectiveAccounts ?? '--' }}</span>
                  <span>回看 {{ hoursValue(rule.lastForecastSnapshot?.lookbackHours) }}</span>
                  <span>保障 {{ hoursValue(rule.lastForecastSnapshot?.coverageHours) }}</span>
                  <span>安全余量 {{ safetyPercent(rule.lastForecastSnapshot?.safetyFactor) }}</span>
                  <span>续航 {{ hoursValue(rule.lastForecastSnapshot?.runwayHours) }}</span>
                  <span>建议补 {{ rule.lastForecastSnapshot?.recommendedQuantity ?? '--' }}</span>
                </template>
                <span v-else>每次固定购买 {{ rule.replenishQuantity }}</span>
                <span>补号时段 {{ rule.scheduleStartTime }}-{{ rule.scheduleEndTime }}</span>
                <span v-if="rule.triggerStrategy === 'smart_forecast'">动态检查 {{ duration(rule.lastForecastSnapshot?.nextCheckSeconds || 600) }}</span>
                <span v-else>补号间隔 {{ duration(rule.scheduleIntervalSeconds) }}</span>
                <span>修复策略 {{ recoveryPolicyFor(rule).enabled ? (recoveryPolicyFor(rule).mode === 'auto' ? '自动' : '手动') : '停用' }}</span>
              </div>
              <div v-if="rule.triggerStrategy === 'inventory_threshold' && rule.lastInventorySnapshot?.capturedAt" class="inventory-strip">
                <span>跟踪 {{ rule.lastInventorySnapshot.trackedAccounts || 0 }}</span>
                <span>低额度 {{ rule.lastInventorySnapshot.lowQuotaAccounts || 0 }}</span>
                <span>修复中 {{ rule.lastInventorySnapshot.repairingAccounts || 0 }}</span>
                <span>在途 {{ rule.lastInventorySnapshot.pendingAccounts || 0 }}</span>
                <small>{{ dateTime(rule.lastInventorySnapshot.capturedAt) }}</small>
              </div>
              <div v-else-if="rule.triggerStrategy === 'smart_forecast' && rule.lastForecastSnapshot?.capturedAt" class="inventory-strip forecast-strip">
                <span>近1小时 {{ usageValue(rule.lastForecastSnapshot.observedUsage1h) }}</span>
                <span>近6小时 {{ usageValue(rule.lastForecastSnapshot.observedUsage6h) }}</span>
                <span>提前期 P50/P90 {{ hoursValue(rule.lastForecastSnapshot.leadTimeHoursP50) }} / {{ hoursValue(rule.lastForecastSnapshot.leadTimeHoursP90) }}</span>
                <span>在途容量 {{ usageValue(rule.lastForecastSnapshot.inFlightCapacity) }}</span>
                <span>容量缺口 {{ usageValue(rule.lastForecastSnapshot.capacityGap) }}</span>
                <span>单号P25 {{ usageValue(rule.lastForecastSnapshot.conservativeAccountCapacity) }}</span>
                <span>样本 {{ rule.lastForecastSnapshot.capacitySampleCount || 0 }}</span>
                <small>{{ dateTime(rule.lastForecastSnapshot.capturedAt) }}</small>
              </div>
            </div>
            <div class="row-actions">
              <button class="icon-button" title="查看执行日志" @click="openRuleLogs(rule)"><History :size="15" /></button>
              <button class="icon-button" :title="rule.enabled ? '暂停策略' : '启动策略'" :disabled="actioningId === `rule-${rule.id}`" @click="toggleRule(rule)">
                <Pause v-if="rule.enabled" :size="15" />
                <Play v-else :size="15" />
              </button>
              <button class="icon-button" :title="triggerActionLabel(rule)" :disabled="actioningId === `rule-${rule.id}`" @click="trigger(rule)"><Zap :size="15" /></button>
              <button class="icon-button" title="编辑策略" @click="editRule(rule)"><Settings2 :size="15" /></button>
              <button class="icon-button danger-action" title="删除策略" :disabled="actioningId === `rule-${rule.id}`" @click="removeRule(rule)"><Trash2 :size="15" /></button>
            </div>
          </article>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><div><h2>商品映射</h2><p>选择账号导入后的平台和一个或多个 Sub2API 正式分组。</p></div><button class="secondary-button" @click="newMapping"><Plus :size="15" />新增映射</button></div>
        <div class="mapping-list">
          <div v-for="mapping in mappings" :key="mapping.id" class="mapping-row">
            <div><strong>{{ mapping.product }}</strong><small>{{ platformText(mapping.platform) }}</small></div>
            <div class="mapping-actions">
              <span class="mapping-group-summary" :title="groupSummary(mapping.targetGroupIds)">{{ groupSummary(mapping.targetGroupIds) }}</span>
              <button class="icon-button" title="编辑映射" @click="editMapping(mapping)"><Settings2 :size="14" /></button>
              <button class="icon-button danger-action" title="删除映射" :disabled="actioningId === `mapping-${mapping.id}`" @click="removeMapping(mapping)"><Trash2 :size="14" /></button>
            </div>
          </div>
          <div v-if="!mappings.length" class="empty-state">还没有商品映射</div>
        </div>
      </section>
    </div>

    <section v-if="activeSection === 'logs'" ref="executionLogPanel" class="panel execution-log-panel">
      <div class="panel-head execution-log-head">
        <div><h2>执行日志</h2><p>记录策略库存检查、跳过或阻止原因、下单、导入和账号修复操作。</p></div>
        <div class="execution-log-actions">
          <select v-model="eventRuleId" aria-label="筛选补号策略" @change="loadEvents">
            <option value="">全部策略</option>
            <option v-for="rule in rules" :key="rule.id" :value="String(rule.id)">{{ rule.name }}</option>
          </select>
          <button class="icon-button" title="刷新执行日志" :disabled="eventsLoading" @click="loadEvents"><RefreshCw :size="15" :class="{ spinning: eventsLoading }" /></button>
        </div>
      </div>
      <div class="execution-log-viewport" :aria-busy="eventsLoading">
        <div v-if="eventsLoading && !executionEvents.length" class="empty-state">正在读取执行日志…</div>
        <div v-else-if="!executionEvents.length" class="empty-state">暂无执行日志，策略下一次检查后会显示在这里</div>
        <div v-else class="execution-log-list">
          <article
            v-for="event in executionEvents"
            :key="event.id"
            class="execution-log-row"
            role="button"
            tabindex="0"
            :aria-label="`查看${eventTypeLabel(event.eventType)}详情`"
            @click="viewEvent(event)"
            @keydown.enter.prevent="viewEvent(event)"
            @keydown.space.prevent="viewEvent(event)"
          >
            <span class="execution-log-marker" :class="eventTone(event.eventType)" />
            <div class="execution-log-main">
              <div class="execution-log-title">
                <strong>{{ event.ruleName || (event.ruleId ? `策略 #${event.ruleId}` : '补号任务') }}</strong>
                <span class="status-pill" :class="eventTone(event.eventType)">{{ eventTypeLabel(event.eventType) }}</span>
              </div>
              <p>{{ event.message || '操作已完成' }}</p>
              <small>
                <span v-if="event.orderId">订单 #{{ event.orderId }}</span>
                <span v-if="event.itemId">账号项 #{{ event.itemId }}</span>
                <span>{{ triggerLabel(event.details?.trigger) }}</span>
                <span>{{ event.actor || 'system' }}</span>
              </small>
            </div>
            <div class="execution-log-tail">
              <time :datetime="event.createdAt">{{ dateTimeWithSeconds(event.createdAt) }}</time>
              <div class="execution-log-row-actions">
                <button
                  v-if="eventAction(event)"
                  class="secondary-button compact-button"
                  :disabled="actioningId === `event-${event.id}`"
                  @click.stop="runEventAction(event)"
                >{{ eventAction(event)?.label }}</button>
                <button class="icon-button" title="查看日志详情" @click.stop="viewEvent(event)"><ChevronRight :size="15" /></button>
              </div>
            </div>
          </article>
        </div>
      </div>
    </section>

    <section v-if="activeSection === 'orders'" class="panel">
      <div class="panel-head"><div><h2>补号订单</h2><p>购买数量已经扣除有效库存和在途账号，避免重复或超量下单。</p></div><span class="table-note">共 {{ orderData.total || 0 }} 条</span></div>
      <form class="replenishment-filterbar" @submit.prevent="applyOrderFilters">
        <label><span>FinOps 订单</span><input v-model.trim="orderFilters.orderId" placeholder="例如 27" /></label>
        <label><span>OAuth Supply 订单</span><input v-model.trim="orderFilters.externalOrderId" placeholder="供应商订单号" /></label>
        <label class="filter-wide"><span>账号</span><input v-model.trim="orderFilters.accountName" placeholder="账号名称或邮箱" /></label>
        <label><span>Sub2API</span><input v-model.trim="orderFilters.sub2apiAccountId" placeholder="账号编号" /></label>
        <label><span>策略 / 商品</span><input v-model.trim="orderFilters.ruleProduct" placeholder="策略或商品" /></label>
        <label><span>状态</span><select v-model="orderFilters.status"><option value="">全部状态</option><option v-for="option in orderStatusOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
        <div class="filter-actions">
          <button class="icon-button filter-submit" type="submit" title="查询" :disabled="ordersLoading"><RefreshCw v-if="ordersLoading" :size="15" class="spinning" /><Search v-else :size="15" /></button>
          <button class="icon-button" type="button" title="清空筛选" :disabled="ordersLoading" @click="clearOrderFilters"><RotateCcw :size="15" /></button>
        </div>
      </form>
      <div class="order-table-wrap" :aria-busy="ordersLoading">
        <table class="data-table replenishment-table">
          <thead><tr>
            <th><button class="column-sort" @click="toggleOrderSort('id')">订单 <ArrowUp v-if="orderSortBy === 'id' && orderSortOrder === 'asc'" :size="13" /><ArrowDown v-else-if="orderSortBy === 'id'" :size="13" /></button></th>
            <th>策略 / 商品</th>
            <th><button class="column-sort" @click="toggleOrderSort('status')">状态 / 触发 <ArrowUp v-if="orderSortBy === 'status' && orderSortOrder === 'asc'" :size="13" /><ArrowDown v-else-if="orderSortBy === 'status'" :size="13" /></button></th>
            <th><button class="column-sort" @click="toggleOrderSort('valid_quantity')">数量拆分 <ArrowUp v-if="orderSortBy === 'valid_quantity' && orderSortOrder === 'asc'" :size="13" /><ArrowDown v-else-if="orderSortBy === 'valid_quantity'" :size="13" /></button></th>
            <th>健康分类</th>
            <th><button class="column-sort" @click="toggleOrderSort('actual_paid_amount_cny')">金额 <ArrowUp v-if="orderSortBy === 'actual_paid_amount_cny' && orderSortOrder === 'asc'" :size="13" /><ArrowDown v-else-if="orderSortBy === 'actual_paid_amount_cny'" :size="13" /></button></th>
            <th><button class="column-sort" @click="toggleOrderSort('created_at')">时间 <ArrowUp v-if="orderSortBy === 'created_at' && orderSortOrder === 'asc'" :size="13" /><ArrowDown v-else-if="orderSortBy === 'created_at'" :size="13" /></button></th>
            <th></th>
          </tr></thead>
          <tbody>
            <tr v-for="order in orders" :key="order.id">
              <td><strong>#{{ order.id }}</strong><small>OAuth Supply {{ order.externalOrderId || '--' }}</small><small>运行 #{{ order.runId || '--' }}</small></td>
              <td><strong>{{ order.ruleName || '--' }}</strong><small>{{ order.product }} · {{ platformText(order.platform) }}</small><small>{{ groupSummary(order.targetGroupIds) }}</small></td>
              <td><span class="status-pill" :class="orderStatusClass(order.status)">{{ orderStatusLabel(order.status) }}</span><small>{{ triggerLabel(order.trigger) }} · {{ modeLabel(order.mode) }}</small><small v-if="order.lastError" class="recovery-error">{{ order.lastError }}</small></td>
              <td><strong>{{ order.validQuantity || 0 }} / {{ order.requestedQuantity || 0 }} 有效</strong><small>已交付 {{ order.deliveredQuantity || 0 }} · 待交付 {{ order.pendingDeliveryQuantity || 0 }}</small><small>待导入 {{ order.pendingImportQuantity || 0 }} · 失败 {{ order.failedQuantity || 0 }}</small></td>
              <td><small>健康 {{ order.healthyItemCount || 0 }}</small><small>低额度 {{ order.lowQuotaItemCount || 0 }}</small><small>不可用 {{ order.unavailableItemCount || 0 }} · 修复中 {{ order.repairingItemCount || 0 }}</small></td>
              <td><small>报价 {{ money(order.quotedAmountCny) }}</small><small>实付 {{ money(order.actualPaidAmountCny) }}</small><small>释放 {{ money(order.releasedAmountCny) }}</small></td>
              <td><small>创建 {{ dateTime(order.createdAt) }}</small><small>更新 {{ dateTime(order.updatedAt) }}</small></td>
              <td><button v-if="order.status === 'approval_required'" class="secondary-button compact-button" @click="approve(order)">批准下单</button><button v-else class="icon-button" title="查看订单" @click="viewOrder(order)"><ChevronRight :size="15" /></button></td>
            </tr>
            <tr v-if="ordersLoading && !orders.length"><td colspan="8" class="empty-cell">正在查询订单…</td></tr>
            <tr v-else-if="!orders.length"><td colspan="8" class="empty-cell">暂无补号订单</td></tr>
          </tbody>
        </table>
      </div>
      <div v-if="orderData.pages > 1" class="pager"><button class="small-button" :disabled="ordersLoading || orderPage <= 1" @click="moveOrderPage(-1)">上一页</button><span>第 {{ orderPage }} / {{ orderData.pages }} 页，共 {{ orderData.total }} 条</span><button class="small-button" :disabled="ordersLoading || orderPage >= orderData.pages" @click="moveOrderPage(1)">下一页</button></div>
    </section>

    <section v-if="activeSection === 'repairs'" class="panel recovery-panel">
      <div class="panel-head"><div><h2>账号修复</h2><p>系统自动领取并导入成功的账号归入已修复；供应商显示已领取但未完成导入时仍保留在待修复。</p></div><span class="table-note">共 {{ recoveryData.total || 0 }} 条</span></div>
      <div class="view-segmented recovery-tabs" role="tablist" aria-label="账号修复状态">
        <button :class="{ active: recoveryTab === 'pending' }" role="tab" @click="changeRecoveryTab('pending')">待修复 <span>{{ recoveryData.pendingTotal || 0 }}</span></button>
        <button :class="{ active: recoveryTab === 'completed' }" role="tab" @click="changeRecoveryTab('completed')">已修复 <span>{{ recoveryData.completedTotal || 0 }}</span></button>
      </div>
      <form class="replenishment-filterbar recovery-filterbar" @submit.prevent="applyRecoveryFilters">
        <label class="filter-wide"><span>账号</span><input v-model.trim="recoveryFilters.accountName" placeholder="账号名称或邮箱" /></label>
        <label><span>FinOps 订单</span><input v-model.trim="recoveryFilters.orderId" placeholder="订单编号" /></label>
        <label><span>OAuth Supply 订单</span><input v-model.trim="recoveryFilters.externalOrderId" placeholder="供应商订单号" /></label>
        <label><span>Sub2API</span><input v-model.trim="recoveryFilters.sub2apiAccountId" placeholder="账号编号" /></label>
        <label><span>状态</span><select v-model="recoveryFilters.status"><option value="">全部状态</option><option v-for="option in recoveryStatusOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
        <div class="filter-actions">
          <button class="icon-button filter-submit" type="submit" title="查询" :disabled="recoveriesLoading"><RefreshCw v-if="recoveriesLoading" :size="15" class="spinning" /><Search v-else :size="15" /></button>
          <button class="icon-button" type="button" title="清空筛选" :disabled="recoveriesLoading" @click="clearRecoveryFilters"><RotateCcw :size="15" /></button>
        </div>
      </form>
      <div class="order-table-wrap" :aria-busy="recoveriesLoading">
        <table class="data-table replenishment-table recovery-table">
          <thead><tr>
            <th><button class="column-sort" @click="toggleRecoverySort('account_name')">类型 / 账号 <ArrowUp v-if="recoverySortBy === 'account_name' && recoverySortOrder === 'asc'" :size="13" /><ArrowDown v-else-if="recoverySortBy === 'account_name'" :size="13" /></button></th>
            <th><button class="column-sort" @click="toggleRecoverySort('order_id')">关联订单 <ArrowUp v-if="recoverySortBy === 'order_id' && recoverySortOrder === 'asc'" :size="13" /><ArrowDown v-else-if="recoverySortBy === 'order_id'" :size="13" /></button></th>
            <th><button class="column-sort" @click="toggleRecoverySort('sub2api_account_id')">Sub2API <ArrowUp v-if="recoverySortBy === 'sub2api_account_id' && recoverySortOrder === 'asc'" :size="13" /><ArrowDown v-else-if="recoverySortBy === 'sub2api_account_id'" :size="13" /></button></th>
            <th><button class="column-sort" @click="toggleRecoverySort('status')">状态 / 来源 <ArrowUp v-if="recoverySortBy === 'status' && recoverySortOrder === 'asc'" :size="13" /><ArrowDown v-else-if="recoverySortBy === 'status'" :size="13" /></button></th>
            <th>健康 / 额度</th>
            <th><button class="column-sort" @click="toggleRecoverySort('account_cost_cny')">成本 <ArrowUp v-if="recoverySortBy === 'account_cost_cny' && recoverySortOrder === 'asc'" :size="13" /><ArrowDown v-else-if="recoverySortBy === 'account_cost_cny'" :size="13" /></button></th>
            <th><button class="column-sort" @click="toggleRecoverySort('created_at')">领取 / 完成时间 <ArrowUp v-if="recoverySortBy === 'created_at' && recoverySortOrder === 'asc'" :size="13" /><ArrowDown v-else-if="recoverySortBy === 'created_at'" :size="13" /></button></th>
            <th><button class="column-sort" @click="toggleRecoverySort('attempt_count')">尝试 / 下次重试 <ArrowUp v-if="recoverySortBy === 'attempt_count' && recoverySortOrder === 'asc'" :size="13" /><ArrowDown v-else-if="recoverySortBy === 'attempt_count'" :size="13" /></button></th>
            <th>错误 / 操作</th>
          </tr></thead>
          <tbody>
            <tr v-for="recovery in recoveries" :key="`${recovery.kind || 'account'}-${recovery.id}`">
              <td><strong>{{ recovery.accountName || `修复任务 #${recovery.id}` }}</strong><small>{{ recovery.kind === 'import' ? '导入重试' : '账号凭据修复' }}</small><small>{{ recovery.externalAccountKey || '--' }}</small></td>
              <td><strong>FinOps #{{ recovery.orderId || '--' }}</strong><small>OAuth Supply {{ recovery.externalOrderId || '--' }}</small><small>{{ recovery.product || '--' }} · {{ platformText(recovery.platform) }}</small></td>
              <td><strong>#{{ recovery.targetAccountId || '--' }}</strong><small>凭据 v{{ recovery.credentialVersion || '--' }}</small><small>分组 {{ groupSummary(recovery.targetGroupIds) }}</small></td>
              <td><span class="status-pill" :class="recoveryStatusClass(recovery.status)">{{ recoveryStatusLabel(recovery.status) }}</span><small v-if="recovery.status === 'recovered'">{{ recoveryCompletionLabel(recovery) }}</small><small v-else>{{ recovery.deliveryStatus || '--' }}</small></td>
              <td><small>{{ recovery.healthStatus || 'unknown' }}</small><small v-if="recovery.quotaUsedPercent !== null && recovery.quotaUsedPercent !== undefined">额度 {{ recovery.quotaUsedPercent }}% · {{ quotaWindowLabel(recovery.quotaWindow) }}</small><small v-else>额度 --</small></td>
              <td>{{ money(recovery.accountCostCny) }}</td>
              <td><small>领取 {{ dateTime(recovery.claimedAt) }}</small><small>完成 {{ dateTime(recovery.recoveredAt) }}</small><small>发现 {{ dateTime(recovery.firstSeenAt) }}</small></td>
              <td><small>{{ recovery.attemptCount || 0 }} 次</small><small>下次 {{ dateTime(recovery.nextRetryAt) }}</small></td>
              <td>
                <small v-if="recovery.lastError" class="recovery-error">{{ recovery.lastError }}</small><small v-else>--</small>
                <div v-if="recoveryTab === 'pending' && recovery.status !== 'recovered'" class="recovery-actions">
                  <button v-if="recovery.ready" class="secondary-button compact-button" :disabled="actioningId === `recovery-${recovery.id}`" @click="retryRecovery(recovery)">立即重试</button>
                  <button class="secondary-button compact-button" :disabled="actioningId === `recovery-${recovery.id}`" @click="completeRecoveryManually(recovery)">标记已修复</button>
                </div>
              </td>
            </tr>
            <tr v-if="recoveriesLoading && !recoveries.length"><td colspan="9" class="empty-cell">正在查询修复任务…</td></tr>
            <tr v-else-if="!recoveries.length"><td colspan="9" class="empty-cell">{{ recoveryTab === 'pending' ? '当前没有待修复任务' : '暂无已修复记录' }}</td></tr>
          </tbody>
        </table>
      </div>
      <div v-if="recoveryData.pages > 1" class="pager"><button class="small-button" :disabled="recoveriesLoading || recoveryPage <= 1" @click="moveRecoveryPage(-1)">上一页</button><span>第 {{ recoveryPage }} / {{ recoveryData.pages }} 页，共 {{ recoveryData.total }} 条</span><button class="small-button" :disabled="recoveriesLoading || recoveryPage >= recoveryData.pages" @click="moveRecoveryPage(1)">下一页</button></div>
    </section>

    <section v-if="editor" class="modal-layer" @click.self="editor = null">
      <div class="modal form-modal replenishment-editor">
        <header><div><h2>{{ editor.kind === 'rule' ? (editor.id ? '编辑补号策略' : '新增补号策略') : (editor.id ? '编辑商品映射' : '新增商品映射') }}</h2><p>保存后会在下一轮库存检查中生效。</p></div><button class="icon-button" @click="editor = null"><X :size="18" /></button></header>
        <div v-if="editor.kind === 'mapping'" class="form-grid">
          <label>商品编码<input v-model.trim="editor.product" placeholder="oauth_30d" /></label>
          <label>平台<select v-model="editor.platform" @change="onMappingPlatformChange"><option value="" disabled>请选择平台</option><option v-for="platform in catalog.platforms" :key="platform" :value="platform">{{ platformText(platform) }}</option></select></label>
          <div class="catalog-field full-field">
            <span class="field-label">Sub2API 正式分组</span>
            <div v-if="mappingGroups.length" class="group-selector">
              <label v-for="group in mappingGroups" :key="group.id" class="group-option" :class="{ disabled: group.status && group.status !== 'active' }">
                <input v-model="editor.targetGroupIds" type="checkbox" :value="group.id" :disabled="group.status && group.status !== 'active'" />
                <span><strong>{{ group.name || `分组 #${group.id}` }}</strong><small>ID {{ group.id }}<template v-if="group.status && group.status !== 'active'"> · 已停用</template></small></span>
              </label>
            </div>
            <div v-else class="group-selector-empty">当前平台没有可选正式分组</div>
          </div>
          <label class="full-field">备注<textarea v-model.trim="editor.notes" rows="3" /></label>
        </div>
        <div v-else class="form-grid">
          <label class="full-field">策略名称<input v-model.trim="editor.name" placeholder="OAuth 30D 主账号池" /></label>
          <label>商品映射<select v-model.number="editor.productMappingId" @change="onRuleMappingChange"><option :value="null" disabled>请选择商品映射</option><option v-for="mapping in mappings" :key="mapping.id" :value="mapping.id">{{ mapping.product }} · {{ platformText(mapping.platform) }} · {{ groupSummary(mapping.targetGroupIds) }}</option></select></label>
          <label>运行模式<select v-model="editor.mode"><option value="observe">观察模式</option><option value="approval">审批模式</option><option value="auto">全自动模式</option></select></label>
          <label>补号方式<select v-model="editor.triggerStrategy" @change="onTriggerStrategyChange"><option value="inventory_threshold">按库存补号</option><option value="smart_forecast">智能预测补号</option><option value="fixed_schedule">定时定量补号</option></select></label>
          <template v-if="editor.triggerStrategy === 'inventory_threshold'">
            <label>最低有效库存<input v-model.number="editor.minAvailableAccounts" type="number" min="1" /></label>
            <label>目标库存<input v-model.number="editor.targetAvailableAccounts" type="number" min="1" /></label>
            <label>单次最多购买<input v-model.number="editor.replenishQuantity" type="number" min="1" max="1000" /></label>
            <label>额度消耗阈值<input v-model.number="editor.quotaUsedThresholdPercent" type="number" min="0" max="100" step="1" /></label>
            <label>额度判断窗口<select v-model="editor.quotaWindow"><option value="any">任一窗口</option><option value="short">短窗口（5小时）</option><option value="long">长窗口（7天）</option></select></label>
            <label>额度未知处理<select v-model="editor.quotaUnknownPolicy"><option value="warn">计入库存并告警</option><option value="low">按低额度处理</option><option value="ignore">计入库存且忽略</option></select></label>
          </template>
          <template v-else-if="editor.triggerStrategy === 'smart_forecast'">
            <label>最低有效账号数<input v-model.number="editor.minAvailableAccounts" type="number" min="1" /><small class="field-hint">预测不可用或库存突降时，系统自动补回这个下限。</small></label>
            <label>单次最多购买<input v-model.number="editor.replenishQuantity" type="number" min="1" max="1000" /></label>
            <div class="form-note full-field">回看周期、安全余量、到账后保障、采购提前期、账号容量、在途成功率和检查频率均由系统动态计算。固定使用不可恢复的7天额度，修复账号只有成功导入 Sub2API 后才计入容量。</div>
          </template>
          <label v-else>每次固定购买<input v-model.number="editor.replenishQuantity" type="number" min="1" max="1000" /></label>
          <label v-if="editor.triggerStrategy === 'inventory_threshold'">修复等待（秒）<input v-model.number="editor.repairGraceSeconds" type="number" min="0" max="86400" /></label>
          <label>自动补号开始<input v-model="editor.scheduleStartTime" type="time" /></label>
          <label>自动补号结束<input v-model="editor.scheduleEndTime" type="time" /><small class="field-hint">开始和结束相同表示全天执行；跨午夜时段也支持。</small></label>
          <label v-if="editor.triggerStrategy !== 'smart_forecast'">自动补号轮询间隔（秒）<input v-model.number="editor.scheduleIntervalSeconds" type="number" min="3" max="86400" /></label>
          <label class="full-field">独立修复策略
            <span class="policy-editor">
              <select v-model="recoveryEditor.mode"><option value="manual">手动修复</option><option value="auto">自动修复</option></select>
              <label class="inline-toggle"><input v-model="recoveryEditor.enabled" type="checkbox" />启用修复</label>
            </span>
          </label>
          <label>修复最大重试<input v-model="recoveryEditor.retryLimit" type="number" min="0" max="20" placeholder="留空为无限制" /></label>
          <label>修复重试间隔（秒）<input v-model.number="recoveryEditor.retryIntervalSeconds" type="number" min="15" max="86400" /></label>
          <label>固定并发数<input v-model.number="editor.concurrency" type="number" min="1" /></label>
          <label>固定优先级<input v-model.number="editor.priority" type="number" min="0" /></label>
          <label>账号负载因子<input v-model.number="editor.loadFactor" type="number" min="1" max="10000" placeholder="留空使用 Sub2API 默认" /></label>
          <label>导入账号代理<select v-model.number="editor.proxyId"><option :value="null">无代理</option><option v-for="proxy in catalog.proxies || []" :key="proxy.id" :value="proxy.id">{{ proxy.name || `代理 #${proxy.id}` }} · {{ proxy.protocol }}://{{ proxy.host }}:{{ proxy.port }}<template v-if="proxy.status && proxy.status !== 'active'"> · {{ proxy.status }}</template></option></select><small class="field-hint">代理由 Sub2API 管理，导入、重试和修复时都会绑定到账号。</small></label>
          <label>账号计费倍率<input v-model.number="editor.rateMultiplier" type="number" min="0" max="999999.9999" step="0.0001" /></label>
          <label class="toggle-field full-field"><input v-model="editor.autoPauseOnExpired" type="checkbox" /><span><strong>账号过期自动暂停调度</strong><small>过期后由 Sub2API 自动停止调度。</small></span></label>
          <label>单次成本上限<input v-model.number="editor.maxOrderAmountCny" type="number" min="0" step="0.01" placeholder="留空不限制" /></label>
          <label>每日成本上限<input v-model.number="editor.maxDailyAmountCny" type="number" min="0" step="0.01" placeholder="留空不限制" /></label>
          <label>验号模型<input v-model.trim="editor.verificationModel" /></label>
          <label class="full-field">账号可用模型
            <input v-model.trim="modelSearch" class="model-search" placeholder="搜索模型" />
            <span class="field-hint">空着表示不限制模型，已选择 {{ editor.modelWhitelist?.length || 0 }} 个模型。</span>
            <span class="model-options">
              <label v-for="model in filteredRuleModels" :key="model" class="model-option">
                <input v-model="editor.modelWhitelist" type="checkbox" :value="model" />
                <span>{{ model }}</span>
              </label>
              <small v-if="!filteredRuleModels.length" class="field-hint">当前平台暂无模型目录。</small>
            </span>
          </label>
          <label>订单轮询间隔（秒）<input v-model.number="editor.pollIntervalSeconds" type="number" min="3" /></label>
          <label class="full-field">验号提示词<textarea v-model.trim="editor.verificationPrompt" rows="3" /></label>
          <label class="switch-row full-field"><input v-model="editor.enabled" type="checkbox" /><span><strong>启用策略</strong><small>观察模式会检查有效库存和报价，但不会创建订单。</small></span></label>
        </div>
        <div v-if="editorError" class="form-error-banner" role="alert">{{ editorError }}</div>
        <footer><button class="secondary-button" @click="editor = null">取消</button><button class="primary-button" :disabled="saving" @click="saveEditor">{{ saving ? '保存中…' : '保存' }}</button></footer>
      </div>
    </section>

    <section v-if="selectedOrder" class="modal-layer" @click.self="selectedOrder = null">
      <div class="modal order-detail-modal"><header><div><h2>补号订单 #{{ selectedOrder.id }}</h2><p>{{ selectedOrder.product }} · {{ orderGroupSummary(selectedOrder) }}</p></div><button class="icon-button" @click="selectedOrder = null"><X :size="18" /></button></header><div class="detail-metrics"><Metric title="状态" :value="orderStatusLabel(selectedOrder.status)" /><Metric title="有效账号" :value="`${selectedOrder.validQuantity || 0} / ${selectedOrder.requestedQuantity}`" /><Metric title="实际成本" :value="money(selectedOrder.actualPaidAmountCny ?? selectedOrder.quotedAmountCny)" tone="good" /></div><p class="order-detail-error" v-if="selectedOrder.lastError">{{ selectedOrder.lastError }}</p><div class="event-note">账号导入后固定写入策略中的正式分组、并发数和优先级；修复时只更新凭据并重新验号。</div></div>
    </section>

    <section v-if="selectedEvent" class="modal-layer" @click.self="selectedEvent = null">
      <div class="modal execution-event-modal">
        <header>
          <div>
            <h2>{{ eventTypeLabel(selectedEvent.eventType) }}</h2>
            <p>{{ selectedEvent.ruleName || (selectedEvent.ruleId ? `策略 #${selectedEvent.ruleId}` : '补号任务') }} · {{ dateTimeWithSeconds(selectedEvent.createdAt) }}</p>
          </div>
          <button class="icon-button" title="关闭" @click="selectedEvent = null"><X :size="18" /></button>
        </header>
        <div class="execution-event-summary">
          <span class="status-pill" :class="eventTone(selectedEvent.eventType)">{{ eventTypeLabel(selectedEvent.eventType) }}</span>
          <p>{{ selectedEvent.message || '操作已完成' }}</p>
        </div>
        <dl class="execution-event-facts">
          <div v-if="selectedEvent.orderId"><dt>关联订单</dt><dd>#{{ selectedEvent.orderId }}</dd></div>
          <div v-if="selectedEvent.itemId"><dt>关联账号项</dt><dd>#{{ selectedEvent.itemId }}</dd></div>
          <div><dt>触发方式</dt><dd>{{ triggerLabel(selectedEvent.details?.trigger) }}</dd></div>
          <div><dt>执行人</dt><dd>{{ selectedEvent.actor || 'system' }}</dd></div>
        </dl>
        <div v-if="eventDetailEntries(selectedEvent).length" class="execution-event-details">
          <h3>执行数据</h3>
          <dl>
            <div v-for="entry in eventDetailEntries(selectedEvent)" :key="entry.key">
              <dt>{{ entry.label }}</dt>
              <dd>{{ entry.value }}</dd>
            </div>
          </dl>
        </div>
        <footer>
          <button class="secondary-button" @click="selectedEvent = null">关闭</button>
          <button v-if="selectedEvent.orderId" class="secondary-button" @click="openEventOrder(selectedEvent)">查看订单</button>
          <button
            v-if="eventAction(selectedEvent)"
            class="primary-button"
            :disabled="actioningId === `event-${selectedEvent.id}`"
            @click="runEventAction(selectedEvent)"
          >{{ eventAction(selectedEvent)?.label }}</button>
        </footer>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import {
  ArrowDown, ArrowUp, ChevronRight, History, Pause, Play, Plus, RefreshCw, RotateCcw, Search,
  Settings2, ShoppingCart, Trash2, Wrench, X, Zap,
} from 'lucide-vue-next';
import { get, query, rangeQuery, send } from '../api';

const props = defineProps<{
  refreshToken: number;
  range?: string;
  rangeStart?: string;
  rangeEnd?: string;
}>();
const emit = defineEmits<{ (event: 'toast', message: string): void }>();
const loading = ref(false);
const saving = ref(false);
const actioningId = ref('');
const error = ref('');
const editorError = ref('');
const eventsLoading = ref(false);
const ordersLoading = ref(false);
const recoveriesLoading = ref(false);
const eventsLoaded = ref(false);
const ordersLoaded = ref(false);
const recoveriesLoaded = ref(false);
const dashboard = ref<any>({ summary: {}, oauthSupply: {} });
const catalog = ref<any>({ groups: [], platforms: [], proxies: [] });
const modelSearch = ref('');
const mappings = ref<any[]>([]);
const rules = ref<any[]>([]);
const orders = ref<any[]>([]);
const recoveries = ref<any[]>([]);
const orderPage = ref(1);
const orderData = ref<any>({ items: [], page: 1, pageSize: 20, total: 0, pages: 0 });
const emptyOrderFilters = () => ({
  orderId: '', externalOrderId: '', accountName: '', sub2apiAccountId: '', ruleProduct: '', status: '',
});
const orderFilters = ref(emptyOrderFilters());
const appliedOrderFilters = ref(emptyOrderFilters());
const orderSortBy = ref('created_at');
const orderSortOrder = ref<'asc' | 'desc'>('desc');
const recoveryPage = ref(1);
const recoveryData = ref<any>({ items: [], page: 1, pageSize: 20, total: 0, pages: 0, pendingTotal: 0, completedTotal: 0 });
const emptyRecoveryFilters = () => ({
  accountName: '', orderId: '', externalOrderId: '', sub2apiAccountId: '', status: '',
});
const recoveryFilters = ref(emptyRecoveryFilters());
const appliedRecoveryFilters = ref(emptyRecoveryFilters());
const recoverySortBy = ref('created_at');
const recoverySortOrder = ref<'asc' | 'desc'>('desc');
const recoveryPolicies = ref<any[]>([]);
const executionEvents = ref<any[]>([]);
const eventRuleId = ref('');
const activeSection = ref<'setup' | 'logs' | 'orders' | 'repairs'>('setup');
const recoveryTab = ref<'pending' | 'completed'>('pending');
const executionLogPanel = ref<HTMLElement | null>(null);
const editor = ref<any | null>(null);
const recoveryEditor = ref<any>({ enabled: true, mode: 'manual', retryLimit: null, retryIntervalSeconds: 60 });
const selectedOrder = ref<any | null>(null);
const selectedEvent = ref<any | null>(null);

const connected = computed(() => Boolean(dashboard.value.oauthSupply?.balance && !dashboard.value.oauthSupply.balance.error));
const selectedRule = computed(() => selectedOrder.value ? rules.value.find((rule) => rule.id === selectedOrder.value.ruleId) : null);
const groupById = computed<Map<number, any>>(() => new Map((catalog.value.groups || []).map((group: any) => [Number(group.id), group])));
const mappingGroups = computed(() => !editor.value?.platform ? [] : (catalog.value.groups || []).filter((group: any) => group.platform === editor.value.platform));
const filteredRuleModels = computed(() => {
  const platform = editor.value?.kind === 'rule'
    ? mappings.value.find((mapping) => Number(mapping.id) === Number(editor.value.productMappingId))?.platform
    : '';
  const models = platform ? (catalog.value.modelsByPlatform?.[platform] || []) : Object.values(catalog.value.modelsByPlatform || {}).flat();
  const selected = editor.value?.modelWhitelist || [];
  const query = modelSearch.value.toLowerCase().trim();
  return [...new Set([...(models as any[]).map(String), ...selected.map(String)])]
    .filter((model) => !query || model.toLowerCase().includes(query));
});
const money = (value: any) => value === null || value === undefined ? '--' : `¥${Number(value || 0).toFixed(2)}`;
const moneyFen = (value: any) => value === null || value === undefined ? '--' : money(Number(value) / 100);
const usageValue = (value: any) => value === null || value === undefined ? '--' : Number(value || 0).toFixed(2);
const hoursValue = (value: any) => value === null || value === undefined || value === ''
  ? '--'
  : `${Number(value).toFixed(Number(value) % 1 === 0 ? 0 : 1)}小时`;
const safetyPercent = (value: any) => value === null || value === undefined
  ? '--'
  : `${Math.max(0, (Number(value) - 1) * 100).toFixed(0)}%`;
const dateTime = (value: any) => value ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '--';
const dateTimeWithSeconds = (value: any) => value ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) : '--';
const duration = (seconds: any) => Number(seconds) >= 3600
  ? `${Math.round(Number(seconds) / 3600)} 小时`
  : Number(seconds) >= 60
    ? `${Math.round(Number(seconds) / 60)} 分钟`
    : `${Number(seconds) || 0} 秒`;
const modeLabel = (value: string) => ({ observe: '观察', approval: '审批', auto: '全自动' } as Record<string, string>)[value] || value;
const triggerStrategyLabel = (value: string) => ({
  inventory_threshold: '按库存',
  smart_forecast: '智能预测',
  fixed_schedule: '定时定量',
} as Record<string, string>)[value] || value;
const triggerActionLabel = (rule: any) => rule.triggerStrategy === 'fixed_schedule'
  ? '立即执行一次'
  : rule.triggerStrategy === 'smart_forecast'
    ? '立即预测容量'
    : '立即检查库存';
const quotaWindowLabel = (value: string) => ({ short: '5小时', long: '7天', any: '任一窗口' } as Record<string, string>)[value] || value;
const orderStatusLabel = (value: string) => ({ approval_required: '待审批', ordering: '创建订单', queued: '排队中', processing: '处理中', ready_to_collect: '待取货', importing: '导入验号', import_retry: '等待修复', completed: '已完成', partial_failed: '部分失败', failed: '失败' } as Record<string, string>)[value] || value;
const orderStatusOptions = Object.entries({
  approval_required: '待审批', ordering: '创建订单', queued: '排队中', processing: '处理中',
  ready_to_collect: '待取货', importing: '导入验号', import_retry: '等待修复',
  completed: '已完成', partial_failed: '部分失败', failed: '失败',
}).map(([value, label]) => ({ value, label }));
const orderStatusClass = (value: string) => value === 'completed' ? 'success' : ['failed', 'partial_failed'].includes(value) ? 'danger' : 'warning';
const recoveryStatusLabel = (value: string) => ({ detected: '发现401', waiting_supplier: '等待供应商', waiting_supplier_recovery: '等待供应商恢复', claimable: '补发文件可认领', credentials_saved: '凭据已保存', updating_sub2api: '更新账号中', importing: '导入中', verifying: '验号中', retry_wait: '等待重试', manual_required: '需要人工处理', recovered: '已恢复' } as Record<string, string>)[value] || value;
const recoveryStatusOptions = Object.entries({
  detected: '发现401', waiting_supplier: '等待供应商', waiting_supplier_recovery: '等待供应商恢复',
  claimable: '补发文件可认领', credentials_saved: '凭据已保存',
  updating_sub2api: '更新账号中', importing: '导入中', verifying: '验号中',
  retry_wait: '等待重试', manual_required: '需要人工处理', recovered: '已恢复',
}).map(([value, label]) => ({ value, label }));
const recoveryStatusClass = (value: string) => value === 'recovered' ? 'success' : value === 'manual_required' ? 'danger' : 'warning';
const retryLimitLabel = (value: any) => value === null || value === undefined || value === '' ? '无限制' : `${value} 次`;
const recoveryCompletionLabel = (recovery: any) => ({
  manual_claimed: '历史人工领取完成',
  manual_compensation: '人工补偿已修复',
  system: '系统修复并导入',
} as Record<string, string>)[recovery.completionSource] || '系统修复并导入';
const eventTypeLabel = (value: string) => ({
  inventory_healthy: '库存正常', order_skipped: '已跳过', rule_blocked: '已阻止',
  forecast_healthy: '容量充足', forecast_insufficient: '预测样本不足',
  observed_replenishment: '观察记录', rule_execution_failed: '执行失败',
  rule_enabled: '策略启动', rule_disabled: '策略暂停',
  approval_required: '等待审批', order_planned: '准备下单', order_created: '订单已创建',
  delivery_processed: '导入完成', import_failed: '导入失败', import_retry_scheduled: '导入重试',
  import_retry_succeeded: '重试成功', import_retry_reimported: '重新导入', import_retry_manual_required: '人工处理',
  import_recovery_waiting_supplier: '等待供应商恢复', recovery_reimported: '认领后重新导入',
  account_recovery_detected: '发现异常', recovery_retry_scheduled: '等待重试',
  recovery_manual_required: '人工处理', recovery_manual_completed: '人工领取完成',
  recovery_manual_compensated: '人工补偿已修复', import_retry_manual_compensated: '导入人工补偿已修复',
  recovery_verified: '修复完成',
  recovery_supplier_claim_observed: '供应商领取状态',
} as Record<string, string>)[value] || value || '操作记录';
const eventTone = (value: string) => ['rule_execution_failed', 'import_failed', 'recovery_manual_required'].includes(value)
  ? 'danger' : ['forecast_insufficient', 'rule_blocked', 'order_skipped', 'approval_required', 'recovery_retry_scheduled', 'account_recovery_detected', 'rule_disabled'].includes(value)
    ? 'warning' : 'success';
const triggerLabel = (value: string) => value === 'manual' ? '手动执行' : value === 'scheduled' ? '自动执行' : '系统任务';
const platformText = (value: string) => ({ openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', antigravity: 'Antigravity', grok: 'Grok', composite: 'Composite' } as Record<string, string>)[value] || value || '--';
const groupSummary = (ids: any[] = []) => ids.length ? ids.map((id) => groupById.value.get(Number(id))?.name || `分组 #${id}`).join('、') : '未选择正式分组';
const orderGroupSummary = (order: any) => groupSummary(rules.value.find((rule) => Number(rule.id) === Number(order.ruleId))?.targetGroupIds || []);
const recoveryPolicyFor = (rule: any) => recoveryPolicies.value.find((policy) => Number(policy.ruleId) === Number(rule.id))
  || { enabled: true, mode: 'manual', retryLimit: null, retryIntervalSeconds: 60 };
const relatedOrder = (event: any) => event?.orderId
  ? orders.value.find((order) => Number(order.id) === Number(event.orderId)) || null
  : null;
const relatedRecovery = (event: any) => event?.itemId
  ? recoveries.value.find((recovery) => Number(recovery.orderItemId) === Number(event.itemId)) || null
  : null;
const relatedRule = (event: any) => event?.ruleId
  ? rules.value.find((rule) => Number(rule.id) === Number(event.ruleId)) || null
  : null;

function eventAction(event: any) {
  const order = relatedOrder(event);
  if (order?.status === 'approval_required') return { type: 'approve', label: '批准下单', target: order };
  const recovery = relatedRecovery(event);
  if (recovery?.ready && recovery.status !== 'recovered') return { type: 'recovery', label: '立即重试', target: recovery };
  const rule = relatedRule(event);
  if (event?.eventType === 'rule_disabled' && rule && !rule.enabled) return { type: 'enable', label: '启动策略', target: rule };
  if (rule?.enabled && ['inventory_healthy', 'forecast_healthy', 'forecast_insufficient', 'order_skipped', 'rule_blocked', 'observed_replenishment', 'rule_execution_failed'].includes(event?.eventType)) {
    return { type: 'trigger', label: triggerActionLabel(rule), target: rule };
  }
  return null;
}

function detailValue(value: any) {
  if (value === null || value === undefined || value === '') return '--';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function eventDetailEntries(event: any) {
  const labels: Record<string, string> = {
    available: '有效库存', availableBalanceCny: '可用余额（CNY）', dailySpend: '今日累计成本（CNY）',
    error: '错误信息', externalOrderId: '供应商订单号', quantity: '计划购买数量',
    quotedCny: '报价（CNY）', reason: '原因代码', remoteStatus: '供应商状态',
    supplierAvailable: '供应商可售数量', trigger: '触发方式',
    triggerStrategy: '补号方式', scheduledFor: '计划执行时间', projectedInventory: '投影库存',
    forecast: '智能预测明细',
  };
  return Object.entries(event?.details || {})
    .filter(([key]) => key !== 'trigger')
    .map(([key, value]) => ({ key, label: labels[key] || key, value: detailValue(value) }));
}

async function load() {
  loading.value = true;
  error.value = '';
  const failures: string[] = [];
  const recordFailure = (fallback: string) => (err: any) => {
    failures.push(err?.message || fallback);
  };
  const rangeParams = query(rangeQuery(props.range, props.rangeStart, props.rangeEnd));
  const tasks = [
    get(`/replenishment/dashboard?${rangeParams}`)
      .then((nextDashboard) => {
        dashboard.value = { ...nextDashboard, oauthSupply: dashboard.value.oauthSupply };
        mappings.value = nextDashboard.mappings || [];
        rules.value = nextDashboard.rules || [];
      })
      .catch(recordFailure('补号统计加载失败')),
    get('/replenishment/balance')
      .then((balance) => {
        dashboard.value = { ...dashboard.value, oauthSupply: { balance } };
      })
      .catch((err: any) => {
        dashboard.value = {
          ...dashboard.value,
          oauthSupply: { balance: { error: err?.message || 'OAuth Supply 余额读取失败' } },
        };
        recordFailure('OAuth Supply 余额读取失败')(err);
      }),
    get('/replenishment/catalog')
      .then((nextCatalog) => {
        catalog.value = nextCatalog;
      })
      .catch(recordFailure('Sub2API 分组目录暂时不可用')),
    get('/replenishment/recovery-policies')
      .then((nextRecoveryPolicies) => {
        recoveryPolicies.value = nextRecoveryPolicies;
      })
      .catch(recordFailure('修复策略加载失败')),
  ];
  if (ordersLoaded.value || activeSection.value === 'orders') {
    tasks.push(loadOrders().catch(recordFailure('补号订单加载失败')));
  }
  if (recoveriesLoaded.value || activeSection.value === 'repairs') {
    tasks.push(loadRecoveries().catch(recordFailure('账号修复列表加载失败')));
  }
  if (eventsLoaded.value || activeSection.value === 'logs') tasks.push(loadEvents());
  await Promise.allSettled(tasks);
  if (failures.length) error.value = failures[0];
  loading.value = false;
}

async function loadOrders() {
  ordersLoading.value = true;
  try {
    const params = query({
      ...rangeQuery(props.range, props.rangeStart, props.rangeEnd),
      page: String(orderPage.value),
      page_size: String(orderData.value.pageSize || 20),
      sort_by: orderSortBy.value,
      sort_order: orderSortOrder.value,
      order_id: appliedOrderFilters.value.orderId,
      external_order_id: appliedOrderFilters.value.externalOrderId,
      account_name: appliedOrderFilters.value.accountName,
      sub2api_account_id: appliedOrderFilters.value.sub2apiAccountId,
      rule_product: appliedOrderFilters.value.ruleProduct,
      status: appliedOrderFilters.value.status,
    });
    const data = await get(`/replenishment/orders?${params}`);
    orderData.value = data;
    orders.value = data.items || [];
    ordersLoaded.value = true;
  } finally {
    ordersLoading.value = false;
  }
}

async function loadRecoveries() {
  recoveriesLoading.value = true;
  try {
    const params = query({
      ...rangeQuery(props.range, props.rangeStart, props.rangeEnd),
      scope: recoveryTab.value,
      page: String(recoveryPage.value),
      page_size: String(recoveryData.value.pageSize || 20),
      sort_by: recoverySortBy.value,
      sort_order: recoverySortOrder.value,
      account_name: appliedRecoveryFilters.value.accountName,
      order_id: appliedRecoveryFilters.value.orderId,
      external_order_id: appliedRecoveryFilters.value.externalOrderId,
      sub2api_account_id: appliedRecoveryFilters.value.sub2apiAccountId,
      status: appliedRecoveryFilters.value.status,
    });
    const data = await get(`/replenishment/recoveries?${params}`);
    recoveryData.value = data;
    recoveries.value = data.items || [];
    recoveriesLoaded.value = true;
  } finally {
    recoveriesLoading.value = false;
  }
}

async function changeSection(section: 'setup' | 'logs' | 'orders' | 'repairs') {
  activeSection.value = section;
  if (section === 'orders' && !ordersLoaded.value) await loadOrders();
  else if (section === 'repairs' && !recoveriesLoaded.value) await loadRecoveries();
  else if (section === 'logs' && !eventsLoaded.value) await loadEvents();
}

async function applyOrderFilters() {
  appliedOrderFilters.value = { ...orderFilters.value };
  orderPage.value = 1;
  await loadOrders();
}

async function clearOrderFilters() {
  orderFilters.value = emptyOrderFilters();
  await applyOrderFilters();
}

async function toggleOrderSort(sortBy: string) {
  if (orderSortBy.value === sortBy) {
    orderSortOrder.value = orderSortOrder.value === 'asc' ? 'desc' : 'asc';
  } else {
    orderSortBy.value = sortBy;
    orderSortOrder.value = sortBy === 'created_at' ? 'desc' : 'asc';
  }
  orderPage.value = 1;
  await loadOrders();
}

async function applyRecoveryFilters() {
  appliedRecoveryFilters.value = { ...recoveryFilters.value };
  recoveryPage.value = 1;
  await loadRecoveries();
}

async function clearRecoveryFilters() {
  recoveryFilters.value = emptyRecoveryFilters();
  await applyRecoveryFilters();
}

async function toggleRecoverySort(sortBy: string) {
  if (recoverySortBy.value === sortBy) {
    recoverySortOrder.value = recoverySortOrder.value === 'asc' ? 'desc' : 'asc';
  } else {
    recoverySortBy.value = sortBy;
    recoverySortOrder.value = sortBy === 'created_at' ? 'desc' : 'asc';
  }
  recoveryPage.value = 1;
  await loadRecoveries();
}

async function moveOrderPage(delta: number) {
  orderPage.value = Math.max(1, Math.min(orderData.value.pages || 1, orderPage.value + delta));
  await loadOrders();
}

async function changeRecoveryTab(tab: 'pending' | 'completed') {
  if (recoveryTab.value === tab) return;
  recoveryTab.value = tab;
  recoveryPage.value = 1;
  await loadRecoveries();
}

async function moveRecoveryPage(delta: number) {
  recoveryPage.value = Math.max(1, Math.min(recoveryData.value.pages || 1, recoveryPage.value + delta));
  await loadRecoveries();
}

async function loadEvents() {
  eventsLoading.value = true;
  try {
    const params = query({
      ...rangeQuery(props.range, props.rangeStart, props.rangeEnd),
      limit: 100,
      ruleId: eventRuleId.value,
    });
    executionEvents.value = await get(`/replenishment/events?${params}`);
    eventsLoaded.value = true;
  } catch (err: any) {
    error.value = err.message || '执行日志读取失败';
  } finally {
    eventsLoading.value = false;
  }
}

async function openRuleLogs(rule: any) {
  activeSection.value = 'logs';
  eventRuleId.value = String(rule.id);
  await loadEvents();
  await nextTick();
  executionLogPanel.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function viewEvent(event: any) {
  selectedEvent.value = event;
}

async function openEventOrder(event: any) {
  if (!event?.orderId) return;
  selectedEvent.value = null;
  await viewOrder({ id: event.orderId });
}

async function runEventAction(event: any) {
  const action = eventAction(event);
  if (!action) return;
  actioningId.value = `event-${event.id}`;
  try {
    if (action.type === 'approve') {
      await send(`/replenishment/orders/${action.target.id}/approve`, 'POST', {});
      emit('toast', `订单 #${action.target.id} 已批准`);
    } else if (action.type === 'recovery') {
      await send(`/replenishment/recoveries/${action.target.id}/claim`, 'POST', {});
      emit('toast', '修复任务已执行');
    } else if (action.type === 'enable') {
      await send(`/replenishment/rules/${action.target.id}/status`, 'PATCH', { enabled: true });
      emit('toast', `策略“${action.target.name}”已启动`);
    } else if (action.type === 'trigger') {
      await send('/replenishment/trigger', 'POST', { ruleId: action.target.id });
      emit('toast', action.target.triggerStrategy === 'fixed_schedule'
        ? `策略“${action.target.name}”已执行一次`
        : `策略“${action.target.name}”库存检查已完成`);
    }
    selectedEvent.value = null;
    await load();
  } catch (err: any) {
    error.value = err.message || '日志操作执行失败';
    await load();
  } finally {
    actioningId.value = '';
  }
}

function newMapping() {
  editorError.value = '';
  editor.value = { kind: 'mapping', product: 'oauth_30d', platform: catalog.value.platforms?.[0] || '', targetGroupIds: [], notes: '' };
}
function newRule() {
  const first = mappings.value[0];
  if (!first) { newMapping(); editorError.value = '请先创建商品映射。'; return; }
  editorError.value = '';
  editor.value = {
    kind: 'rule', name: '', productMappingId: first.id, mode: 'observe', enabled: false,
    triggerStrategy: 'inventory_threshold',
    minAvailableAccounts: 2, targetAvailableAccounts: 5, replenishQuantity: 3,
    quotaUsedThresholdPercent: 80, quotaWindow: 'any', quotaUnknownPolicy: 'warn',
    repairGraceSeconds: 900, recoveryRetryLimit: null,
    scheduleStartTime: '00:00', scheduleEndTime: '00:00', scheduleIntervalSeconds: 300,
    forecastLookbackHours: 168, forecastCoverageHours: 24, forecastSafetyFactor: 1.2,
    forecastFallbackLeadTimeHours: 2, forecastDefaultAccountCapacity: null,
    maxOrderAmountCny: null, maxDailyAmountCny: null, concurrency: 5, loadFactor: null, proxyId: null, priority: 20,
    rateMultiplier: 1, autoPauseOnExpired: true,
    verificationModel: 'gpt-5.6-luna',
    modelWhitelist: [],
    verificationPrompt: 'Reply with a short success marker if this account can complete a basic request.',
    pollIntervalSeconds: 5, retryLimit: 3,
  };
  recoveryEditor.value = { enabled: true, mode: 'manual', retryLimit: null, retryIntervalSeconds: 60 };
}
function editRule(rule: any) {
  editorError.value = '';
  editor.value = {
    ...rule,
    kind: 'rule',
    triggerStrategy: rule.triggerStrategy || 'inventory_threshold',
    forecastLookbackHours: rule.forecastLookbackHours ?? 168,
    forecastCoverageHours: rule.forecastCoverageHours ?? 24,
    forecastSafetyFactor: rule.forecastSafetyFactor ?? 1.2,
    forecastFallbackLeadTimeHours: rule.forecastFallbackLeadTimeHours ?? 2,
    forecastDefaultAccountCapacity: rule.forecastDefaultAccountCapacity ?? null,
    scheduleIntervalSeconds: rule.triggerStrategy === 'smart_forecast'
      ? Math.max(300, Number(rule.scheduleIntervalSeconds || 300))
      : rule.scheduleIntervalSeconds,
    loadFactor: rule.loadFactor ?? null,
    proxyId: rule.proxyId ?? null,
    rateMultiplier: rule.rateMultiplier ?? 1,
    autoPauseOnExpired: rule.autoPauseOnExpired !== false,
    modelWhitelist: [...(rule.modelWhitelist || [])],
  };
  modelSearch.value = '';
  recoveryEditor.value = { ...recoveryPolicyFor(rule) };
}
function editMapping(mapping: any) { editorError.value = ''; editor.value = { ...mapping, kind: 'mapping', targetGroupIds: [...(mapping.targetGroupIds || [])] }; }
function onMappingPlatformChange() { editor.value.targetGroupIds = []; editorError.value = ''; }
function onRuleMappingChange() { editor.value.modelWhitelist = []; modelSearch.value = ''; }
function onTriggerStrategyChange() {
  if (editor.value.triggerStrategy !== 'smart_forecast') return;
  editor.value.quotaWindow = 'long';
  editor.value.targetAvailableAccounts = Number(editor.value.minAvailableAccounts || 1);
  editor.value.repairGraceSeconds = 0;
  editor.value.scheduleIntervalSeconds = 300;
}

function validateEditor() {
  if (editor.value.kind === 'mapping') {
    if (!editor.value.product) return '请输入商品编码。';
    if (!editor.value.platform) return '请选择平台。';
    if (!editor.value.targetGroupIds?.length) return '请至少选择一个 Sub2API 正式分组。';
    return '';
  }
  if (!editor.value.name) return '请输入策略名称。';
  if (editor.value.triggerStrategy !== 'fixed_schedule') {
    if (Number(editor.value.minAvailableAccounts) < 1) return '最低有效库存必须至少为 1。';
    if (editor.value.triggerStrategy === 'inventory_threshold'
      && Number(editor.value.targetAvailableAccounts) < Number(editor.value.minAvailableAccounts)) {
      return '目标库存不能低于最低有效库存。';
    }
  }
  if (!Number.isInteger(Number(editor.value.replenishQuantity))
    || Number(editor.value.replenishQuantity) < 1 || Number(editor.value.replenishQuantity) > 1000) {
    return '购买数量必须在 1 到 1000 之间。';
  }
  const loadFactor = editor.value.loadFactor;
  if (loadFactor !== null && loadFactor !== undefined && loadFactor !== ''
    && (!Number.isInteger(Number(loadFactor)) || Number(loadFactor) < 1 || Number(loadFactor) > 10000)) {
    return '账号负载因子必须留空或填写 1 到 10000 之间的整数。';
  }
  const rateMultiplier = Number(editor.value.rateMultiplier);
  if (!Number.isFinite(rateMultiplier) || rateMultiplier < 0 || rateMultiplier > 999999.9999) {
    return '账号计费倍率必须在 0 到 999999.9999 之间。';
  }
  return '';
}

async function saveEditor() {
  const validationError = validateEditor();
  if (validationError) { editorError.value = validationError; return; }
  saving.value = true;
  editorError.value = '';
  try {
    if (editor.value.kind === 'mapping') {
      await send('/replenishment/mappings', editor.value.id ? 'PATCH' : 'POST', {
        id: editor.value.id, product: editor.value.product, platform: editor.value.platform,
        targetGroupIds: editor.value.targetGroupIds, notes: editor.value.notes, enabled: true,
      });
    } else {
      const savedRule = await send(editor.value.id ? `/replenishment/rules/${editor.value.id}` : '/replenishment/rules', editor.value.id ? 'PATCH' : 'POST', {
        ...editor.value,
        kind: undefined,
        recoveryRetryLimit: editor.value.recoveryRetryLimit === '' ? null : editor.value.recoveryRetryLimit,
      });
      await send(`/replenishment/recovery-policies/${savedRule.id}`, 'PUT', {
        enabled: recoveryEditor.value.enabled,
        mode: recoveryEditor.value.mode,
        retryLimit: recoveryEditor.value.retryLimit === '' ? null : recoveryEditor.value.retryLimit,
        retryIntervalSeconds: recoveryEditor.value.retryIntervalSeconds,
      });
    }
    editor.value = null;
    emit('toast', '补号配置已保存');
    await load();
  } catch (err: any) {
    editorError.value = err.message || '保存失败';
  } finally {
    saving.value = false;
  }
}
async function trigger(rule: any) {
  actioningId.value = `rule-${rule.id}`;
  try {
    await send('/replenishment/trigger', 'POST', { ruleId: rule.id });
    emit('toast', rule.triggerStrategy === 'fixed_schedule'
      ? '已执行一次'
      : rule.triggerStrategy === 'smart_forecast'
        ? '容量预测已完成'
        : '库存检查已完成');
    await load();
  }
  catch (err: any) { error.value = err.message || '执行补号失败'; }
  finally { actioningId.value = ''; }
}
async function toggleRule(rule: any) {
  actioningId.value = `rule-${rule.id}`;
  try {
    await send(`/replenishment/rules/${rule.id}/status`, 'PATCH', { enabled: !rule.enabled });
    emit('toast', rule.enabled ? `策略“${rule.name}”已暂停` : `策略“${rule.name}”已启动`);
    await load();
  } catch (err: any) {
    error.value = err.message || (rule.enabled ? '暂停策略失败' : '启动策略失败');
  } finally {
    actioningId.value = '';
  }
}
async function removeRule(rule: any) {
  if (!window.confirm(`确定删除补号策略“${rule.name}”吗？\n自动修复和导入重试会停止；历史订单、成本和修复记录会保留。`)) return;
  actioningId.value = `rule-${rule.id}`;
  try {
    await send(`/replenishment/rules/${rule.id}`, 'DELETE', {});
    emit('toast', `策略“${rule.name}”已删除`);
    await load();
  } catch (err: any) {
    error.value = err.message || '删除策略失败';
  } finally {
    actioningId.value = '';
  }
}
async function removeMapping(mapping: any) {
  if (!window.confirm(`确定删除商品映射“${mapping.product} · ${platformText(mapping.platform)}”吗？\n关联补号策略及其自动修复会一并停止并软删除；历史记录会保留。`)) return;
  actioningId.value = `mapping-${mapping.id}`;
  try {
    await send(`/replenishment/mappings/${mapping.id}`, 'DELETE', {});
    emit('toast', `商品映射“${mapping.product}”已删除`);
    await load();
  } catch (err: any) {
    error.value = err.message || '删除商品映射失败';
  } finally {
    actioningId.value = '';
  }
}
async function approve(order: any) {
  try { await send(`/replenishment/orders/${order.id}/approve`, 'POST', {}); emit('toast', `订单 #${order.id} 已批准`); await load(); }
  catch (err: any) { error.value = err.message || '批准失败'; }
}
async function viewOrder(order: any) {
  try { selectedOrder.value = await get(`/replenishment/orders/${order.id}`); }
  catch (err: any) { error.value = err.message || '订单读取失败'; }
}
async function claimRecovery(recovery: any) {
  try { await send(`/replenishment/recoveries/${recovery.id}/claim`, 'POST', {}); emit('toast', '修复任务已执行'); await load(); }
  catch (err: any) { error.value = err.message || '修复执行失败'; await load(); }
}
async function retryRecovery(recovery: any) {
  actioningId.value = `recovery-${recovery.id}`;
  try {
    if (recovery.kind === 'import') await send(`/replenishment/import-retries/${recovery.orderItemId}/retry`, 'POST', {});
    else await send(`/replenishment/recoveries/${recovery.id}/claim`, 'POST', {});
    emit('toast', '修复任务已执行'); await load();
  } catch (err: any) { error.value = err.message || '修复执行失败'; await load(); }
  finally { actioningId.value = ''; }
}
async function completeRecoveryManually(recovery: any) {
  if (!window.confirm('确定将此任务标记为已修复吗？\n这只记录 FinOps 的人工补偿结果，不会验证、修改或中断 Sub2API。')) return;
  actioningId.value = `recovery-${recovery.id}`;
  try {
    const endpoint = recovery.kind === 'import'
      ? `/replenishment/import-retries/${recovery.orderItemId}/complete`
      : `/replenishment/recoveries/${recovery.recoveryId}/complete`;
    await send(endpoint, 'POST', {});
    emit('toast', '已记录人工补偿并标记为已修复');
    await load();
  } catch (err: any) {
    error.value = err.message || '人工补偿失败';
    await load();
  } finally {
    actioningId.value = '';
  }
}

onMounted(load);
watch(() => props.refreshToken, () => {
  orderPage.value = 1;
  recoveryPage.value = 1;
  load();
});
</script>
