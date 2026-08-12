<template>
  <div class="page-view replenishment-view">
    <section class="replenishment-hero">
      <div>
        <div class="eyebrow-line"><RefreshCw :size="15" /> 供应链自动化</div>
        <h2>自动补号</h2>
        <p>根据 FinOps 已采购账号的健康状态、剩余额度和修复进度自动维持目标库存。</p>
      </div>
      <div class="replenishment-hero-actions">
        <button class="icon-text-button" :disabled="loading" @click="load"><RefreshCw :size="15" :class="{ spinning: loading }" />刷新</button>
        <span class="connection-indicator" :class="{ connected }"><i />{{ connected ? 'OAuth Supply 已连接' : '等待连接' }}</span>
      </div>
    </section>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <section class="metric-grid replenishment-metrics">
      <div class="metric-card"><span>有效库存</span><strong>{{ dashboard.summary?.effectiveAccounts || 0 }}</strong><small>健康且额度充足</small></div>
      <div class="metric-card warning"><span>低额度账号</span><strong>{{ dashboard.summary?.lowQuotaAccounts || 0 }}</strong><small>达到策略额度阈值</small></div>
      <div class="metric-card danger"><span>不可用账号</span><strong>{{ dashboard.summary?.unavailableAccounts || 0 }}</strong><small>停用、过期或异常</small></div>
      <div class="metric-card"><span>修复中</span><strong>{{ dashboard.summary?.repairingAccounts || 0 }}</strong><small>等待认领或重试</small></div>
      <div class="metric-card"><span>进行中订单</span><strong>{{ dashboard.summary?.activeOrders || 0 }}</strong><small>审批、下单或导入中</small></div>
      <div class="metric-card good"><span>累计采购成本</span><strong>{{ money(dashboard.summary?.totalCostCny) }}</strong><small>按实际支付金额</small></div>
      <div class="metric-card"><span>OAuth 可用余额</span><strong>{{ moneyFen(dashboard.oauthSupply?.balance?.available_fen) }}</strong><small>总余额 {{ moneyFen(dashboard.oauthSupply?.balance?.balance_fen) }}</small></div>
    </section>

    <div class="replenishment-layout">
      <section class="panel">
        <div class="panel-head">
          <div><h2>补号策略</h2><p>有效库存达到阈值时补到目标数量；在途订单和修复等待会自动扣除。</p></div>
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
              </div>
              <small>{{ rule.product }} · {{ platformText(rule.platform) }} · {{ groupSummary(rule.targetGroupIds) }}</small>
              <div class="rule-facts">
                <span>有效 {{ rule.lastInventorySnapshot?.effectiveAccounts ?? '--' }}</span>
                <span>≤ {{ rule.minAvailableAccounts }} 触发</span>
                <span>补到 {{ rule.targetAvailableAccounts }}</span>
                <span>额度 {{ quotaWindowLabel(rule.quotaWindow) }} ≥ {{ rule.quotaUsedThresholdPercent }}%</span>
                <span>补号时段 {{ rule.scheduleStartTime }}-{{ rule.scheduleEndTime }}</span>
                <span>补号间隔 {{ duration(rule.scheduleIntervalSeconds) }}</span>
                <span>修复策略 {{ recoveryPolicyFor(rule).enabled ? (recoveryPolicyFor(rule).mode === 'auto' ? '自动' : '手动') : '停用' }}</span>
              </div>
              <div v-if="rule.lastInventorySnapshot?.capturedAt" class="inventory-strip">
                <span>跟踪 {{ rule.lastInventorySnapshot.trackedAccounts || 0 }}</span>
                <span>低额度 {{ rule.lastInventorySnapshot.lowQuotaAccounts || 0 }}</span>
                <span>修复中 {{ rule.lastInventorySnapshot.repairingAccounts || 0 }}</span>
                <span>在途 {{ rule.lastInventorySnapshot.pendingAccounts || 0 }}</span>
                <small>{{ dateTime(rule.lastInventorySnapshot.capturedAt) }}</small>
              </div>
            </div>
            <div class="row-actions">
              <button class="icon-button" title="查看执行日志" @click="openRuleLogs(rule)"><History :size="15" /></button>
              <button class="icon-button" :title="rule.enabled ? '暂停策略' : '启动策略'" :disabled="actioningId === `rule-${rule.id}`" @click="toggleRule(rule)">
                <Pause v-if="rule.enabled" :size="15" />
                <Play v-else :size="15" />
              </button>
              <button class="icon-button" title="立即检查并按策略执行" :disabled="actioningId === `rule-${rule.id}`" @click="trigger(rule)"><Zap :size="15" /></button>
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

    <section ref="executionLogPanel" class="panel execution-log-panel">
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

    <section class="panel">
      <div class="panel-head"><div><h2>补号订单</h2><p>购买数量已经扣除有效库存和在途账号，避免重复或超量下单。</p></div><span class="table-note">最近 {{ orders.length }} 条</span></div>
      <div class="order-table-wrap">
        <table class="data-table replenishment-table">
          <thead><tr><th>订单</th><th>商品 / 正式分组</th><th>状态</th><th>数量</th><th>成本</th><th>创建时间</th><th></th></tr></thead>
          <tbody>
            <tr v-for="order in orders" :key="order.id">
              <td><strong>#{{ order.id }}</strong><small>{{ order.externalOrderId || '等待创建' }}</small></td>
              <td><strong>{{ order.product }}</strong><small>{{ orderGroupSummary(order) }}</small></td>
              <td><span class="status-pill" :class="orderStatusClass(order.status)">{{ orderStatusLabel(order.status) }}</span></td>
              <td>{{ order.validQuantity || 0 }} / {{ order.requestedQuantity }}</td>
              <td>{{ money(order.actualPaidAmountCny ?? order.quotedAmountCny) }}</td>
              <td>{{ dateTime(order.createdAt) }}</td>
              <td><button v-if="order.status === 'approval_required'" class="secondary-button compact-button" @click="approve(order)">批准下单</button><button v-else class="icon-button" title="查看订单" @click="viewOrder(order)"><ChevronRight :size="15" /></button></td>
            </tr>
            <tr v-if="!orders.length"><td colspan="7" class="empty-cell">暂无补号订单</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head"><div><h2>账号修复</h2><p>401 账号会退出有效库存；认领后先保存新版凭据，再更新原 Sub2API 账号并重新验号。</p></div><span class="table-note">最近 {{ recoveries.length }} 条</span></div>
      <div class="recovery-list">
        <div v-for="recovery in recoveries" :key="`${recovery.kind || 'account'}-${recovery.id}`" class="recovery-row">
          <div class="recovery-main">
            <strong>{{ recovery.accountName || `修复任务 #${recovery.id}` }}</strong>
            <small>FinOps 订单 #{{ recovery.orderId || '--' }} · OAuth Supply 订单 {{ recovery.externalOrderId || '--' }}</small>
            <small>{{ recovery.kind === 'import' ? '导入重试' : `Sub2API #${recovery.targetAccountId} · 版本 ${recovery.credentialVersion || '--'}` }} · 尝试 {{ recovery.attemptCount || 0 }} 次</small>
            <small v-if="recovery.lastError" class="recovery-error">{{ recovery.lastError }}</small>
          </div>
          <div class="recovery-actions">
            <span class="status-pill" :class="recoveryStatusClass(recovery.status)">{{ recoveryStatusLabel(recovery.status) }}</span>
            <button v-if="recovery.ready && recovery.status !== 'recovered'" class="secondary-button compact-button" @click="retryRecovery(recovery)">立即重试</button>
          </div>
        </div>
        <div v-if="!recoveries.length" class="empty-state">暂无账号修复任务</div>
      </div>
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
          <label>最低有效库存<input v-model.number="editor.minAvailableAccounts" type="number" min="0" /></label>
          <label>目标库存<input v-model.number="editor.targetAvailableAccounts" type="number" min="1" /></label>
          <label>单次最多购买<input v-model.number="editor.replenishQuantity" type="number" min="1" max="1000" /></label>
          <label>额度消耗阈值<input v-model.number="editor.quotaUsedThresholdPercent" type="number" min="0" max="100" step="1" /></label>
          <label>额度判断窗口<select v-model="editor.quotaWindow"><option value="any">任一窗口</option><option value="short">短窗口（5小时）</option><option value="long">长窗口（7天）</option></select></label>
          <label>额度未知处理<select v-model="editor.quotaUnknownPolicy"><option value="warn">计入库存并告警</option><option value="low">按低额度处理</option><option value="ignore">计入库存且忽略</option></select></label>
          <label>自动补号开始<input v-model="editor.scheduleStartTime" type="time" /></label>
          <label>自动补号结束<input v-model="editor.scheduleEndTime" type="time" /><small class="field-hint">开始和结束相同表示全天执行；跨午夜时段也支持。</small></label>
          <label>自动补号轮询间隔（秒）<input v-model.number="editor.scheduleIntervalSeconds" type="number" min="30" max="86400" /></label>
          <label>修复等待（秒）<input v-model.number="editor.repairGraceSeconds" type="number" min="0" max="86400" /></label>
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
import { ChevronRight, History, Pause, Play, Plus, RefreshCw, Settings2, Trash2, X, Zap } from 'lucide-vue-next';
import { get, send } from '../api';

const props = defineProps<{ refreshToken: number }>();
const emit = defineEmits<{ (event: 'toast', message: string): void }>();
const loading = ref(false);
const saving = ref(false);
const actioningId = ref('');
const error = ref('');
const editorError = ref('');
const eventsLoading = ref(false);
const dashboard = ref<any>({ summary: {}, oauthSupply: {} });
const catalog = ref<any>({ groups: [], platforms: [] });
const modelSearch = ref('');
const mappings = ref<any[]>([]);
const rules = ref<any[]>([]);
const orders = ref<any[]>([]);
const recoveries = ref<any[]>([]);
const recoveryPolicies = ref<any[]>([]);
const executionEvents = ref<any[]>([]);
const eventRuleId = ref('');
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
const dateTime = (value: any) => value ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '--';
const dateTimeWithSeconds = (value: any) => value ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) : '--';
const duration = (seconds: any) => Number(seconds) >= 3600 ? `${Math.round(Number(seconds) / 3600)} 小时` : `${Math.round(Number(seconds) / 60)} 分钟`;
const modeLabel = (value: string) => ({ observe: '观察', approval: '审批', auto: '全自动' } as Record<string, string>)[value] || value;
const quotaWindowLabel = (value: string) => ({ short: '5小时', long: '7天', any: '任一窗口' } as Record<string, string>)[value] || value;
const orderStatusLabel = (value: string) => ({ approval_required: '待审批', ordering: '创建订单', queued: '排队中', processing: '处理中', ready_to_collect: '待取货', importing: '导入验号', import_retry: '等待修复', completed: '已完成', partial_failed: '部分失败', failed: '失败' } as Record<string, string>)[value] || value;
const orderStatusClass = (value: string) => value === 'completed' ? 'success' : ['failed', 'partial_failed'].includes(value) ? 'danger' : 'warning';
const recoveryStatusLabel = (value: string) => ({ detected: '发现401', waiting_supplier: '等待供应商', waiting_supplier_recovery: '等待供应商恢复', claimable: '补发文件可认领', credentials_saved: '凭据已保存', updating_sub2api: '更新账号中', importing: '导入中', verifying: '验号中', retry_wait: '等待重试', manual_required: '已人工领取/需处理', recovered: '已恢复' } as Record<string, string>)[value] || value;
const recoveryStatusClass = (value: string) => value === 'recovered' ? 'success' : value === 'manual_required' ? 'danger' : 'warning';
const retryLimitLabel = (value: any) => value === null || value === undefined || value === '' ? '无限制' : `${value} 次`;
const eventTypeLabel = (value: string) => ({
  inventory_healthy: '库存正常', order_skipped: '已跳过', rule_blocked: '已阻止',
  observed_replenishment: '观察记录', rule_execution_failed: '执行失败',
  rule_enabled: '策略启动', rule_disabled: '策略暂停',
  approval_required: '等待审批', order_planned: '准备下单', order_created: '订单已创建',
  delivery_processed: '导入完成', import_failed: '导入失败', import_retry_scheduled: '导入重试',
  import_retry_succeeded: '重试成功', import_retry_reimported: '重新导入', import_retry_manual_required: '人工处理',
  import_recovery_waiting_supplier: '等待供应商恢复', recovery_reimported: '认领后重新导入',
  account_recovery_detected: '发现异常', recovery_retry_scheduled: '等待重试',
  recovery_manual_required: '人工处理', recovery_verified: '修复完成',
} as Record<string, string>)[value] || value || '操作记录';
const eventTone = (value: string) => ['rule_execution_failed', 'import_failed', 'recovery_manual_required'].includes(value)
  ? 'danger' : ['rule_blocked', 'order_skipped', 'approval_required', 'recovery_retry_scheduled', 'account_recovery_detected', 'rule_disabled'].includes(value)
    ? 'warning' : 'success';
const triggerLabel = (value: string) => value === 'manual' ? '手动执行' : value === 'scheduled' ? '自动检查' : '系统任务';
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
  if (rule?.enabled && ['inventory_healthy', 'order_skipped', 'rule_blocked', 'observed_replenishment', 'rule_execution_failed'].includes(event?.eventType)) {
    return { type: 'trigger', label: '立即检查', target: rule };
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
  };
  return Object.entries(event?.details || {})
    .filter(([key]) => key !== 'trigger')
    .map(([key, value]) => ({ key, label: labels[key] || key, value: detailValue(value) }));
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [nextDashboard, nextCatalog, nextMappings, nextRules, nextRecoveryPolicies, nextOrders, nextRecoveries] = await Promise.all([
      get('/replenishment/dashboard'),
      get('/replenishment/catalog').catch((err: any) => ({
        groups: [], platforms: [], error: err?.message || 'Sub2API 分组目录暂时不可用',
      })),
      get('/replenishment/mappings'),
      get('/replenishment/rules'), get('/replenishment/recovery-policies'), get('/replenishment/orders?limit=50'),
      get('/replenishment/recoveries').catch((err: any) => ({ items: [], error: err?.message || '账号修复记录暂时不可用' })),
    ]);
    dashboard.value = nextDashboard;
    catalog.value = nextCatalog;
    mappings.value = nextMappings;
    rules.value = nextRules;
    recoveryPolicies.value = nextRecoveryPolicies;
    orders.value = nextOrders;
    recoveries.value = nextRecoveries.items || [];
    if (nextCatalog.error) error.value = nextCatalog.error;
    else if (nextRecoveries.error && !nextDashboard.oauthSupply?.balance?.error) error.value = nextRecoveries.error;
  } catch (err: any) {
    error.value = err.message || '补号数据加载失败';
  } finally {
    loading.value = false;
  }
  await loadEvents();
}

async function loadEvents() {
  eventsLoading.value = true;
  try {
    const filter = eventRuleId.value ? `&ruleId=${encodeURIComponent(eventRuleId.value)}` : '';
    executionEvents.value = await get(`/replenishment/events?limit=100${filter}`);
  } catch (err: any) {
    error.value = err.message || '执行日志读取失败';
  } finally {
    eventsLoading.value = false;
  }
}

async function openRuleLogs(rule: any) {
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
      emit('toast', `策略“${action.target.name}”检查已完成`);
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
    minAvailableAccounts: 2, targetAvailableAccounts: 5, replenishQuantity: 3,
    quotaUsedThresholdPercent: 80, quotaWindow: 'any', quotaUnknownPolicy: 'warn',
    repairGraceSeconds: 900, recoveryRetryLimit: null,
    scheduleStartTime: '00:00', scheduleEndTime: '00:00', scheduleIntervalSeconds: 300,
    maxOrderAmountCny: null, maxDailyAmountCny: null, concurrency: 5, priority: 20,
    verificationModel: 'gpt-5.6-luna',
    modelWhitelist: [],
    verificationPrompt: 'Reply with a short success marker if this account can complete a basic request.',
    pollIntervalSeconds: 5, retryLimit: 3, cooldownSeconds: 300,
  };
  recoveryEditor.value = { enabled: true, mode: 'manual', retryLimit: null, retryIntervalSeconds: 60 };
}
function editRule(rule: any) {
  editorError.value = '';
  editor.value = { ...rule, kind: 'rule', modelWhitelist: [...(rule.modelWhitelist || [])] };
  modelSearch.value = '';
  recoveryEditor.value = { ...recoveryPolicyFor(rule) };
}
function editMapping(mapping: any) { editorError.value = ''; editor.value = { ...mapping, kind: 'mapping', targetGroupIds: [...(mapping.targetGroupIds || [])] }; }
function onMappingPlatformChange() { editor.value.targetGroupIds = []; editorError.value = ''; }
function onRuleMappingChange() { editor.value.modelWhitelist = []; modelSearch.value = ''; }

function validateEditor() {
  if (editor.value.kind === 'mapping') {
    if (!editor.value.product) return '请输入商品编码。';
    if (!editor.value.platform) return '请选择平台。';
    if (!editor.value.targetGroupIds?.length) return '请至少选择一个 Sub2API 正式分组。';
    return '';
  }
  if (!editor.value.name) return '请输入策略名称。';
  if (Number(editor.value.targetAvailableAccounts) <= Number(editor.value.minAvailableAccounts)) return '目标库存必须大于最低有效库存。';
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
  try { await send('/replenishment/trigger', 'POST', { ruleId: rule.id }); emit('toast', '库存检查已完成'); await load(); }
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
  if (!window.confirm(`确定删除补号策略“${rule.name}”吗？\n历史订单、成本和修复记录会保留，此操作不可撤销。`)) return;
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
  if (!window.confirm(`确定删除商品映射“${mapping.product} · ${platformText(mapping.platform)}”吗？\n仍被策略使用的映射无法删除。`)) return;
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
  try {
    if (recovery.kind === 'import') await send(`/replenishment/import-retries/${recovery.orderItemId}/retry`, 'POST', {});
    else await send(`/replenishment/recoveries/${recovery.id}/claim`, 'POST', {});
    emit('toast', '修复任务已执行'); await load();
  } catch (err: any) { error.value = err.message || '修复执行失败'; await load(); }
}

onMounted(load);
watch(() => props.refreshToken, load);
</script>
