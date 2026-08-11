<template>
  <div class="page-view replenishment-view">
    <section class="replenishment-hero">
      <div>
        <div class="eyebrow-line"><RefreshCw :size="15" /> 供应链自动化</div>
        <h2>自动补号</h2>
        <p>按“商品 + 平台 + 目标账号池”管理库存、下单、验号、导入和采购成本。</p>
      </div>
      <div class="replenishment-hero-actions">
        <button class="icon-text-button" :disabled="loading" @click="load"><RefreshCw :size="15" :class="{ spinning: loading }" />刷新</button>
        <span class="connection-indicator" :class="{ connected: connected }"><i />{{ connected ? 'OAuth Supply 已连接' : '等待连接' }}</span>
      </div>
    </section>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <section class="metric-grid replenishment-metrics">
      <div class="metric-card"><span>启用策略</span><strong>{{ dashboard.summary?.enabledRules || 0 }}</strong><small>可参与自动检查</small></div>
      <div class="metric-card"><span>进行中订单</span><strong>{{ dashboard.summary?.activeOrders || 0 }}</strong><small>审批、下单或导入中</small></div>
      <div class="metric-card"><span>已导入账号</span><strong>{{ dashboard.summary?.importedAccounts || 0 }}</strong><small>验号通过后计入</small></div>
      <div class="metric-card good"><span>累计采购成本</span><strong>{{ money(dashboard.summary?.totalCostCny) }}</strong><small>以实际支付金额为准</small></div>
      <div class="metric-card"><span>OAuth 可用余额</span><strong>{{ moneyFen(dashboard.oauthSupply?.balance?.available_fen) }}</strong><small>总余额 {{ moneyFen(dashboard.oauthSupply?.balance?.balance_fen) }}</small></div>
    </section>

    <div class="replenishment-layout">
      <section class="panel">
        <div class="panel-head">
          <div><h2>补号策略</h2><p>并发与优先级只在购买后写入账号，运行期间不会动态调整。</p></div>
          <button class="primary-button" @click="newRule"><Plus :size="15" />新增策略</button>
        </div>
        <div v-if="!rules.length" class="empty-state">还没有补号策略</div>
        <div v-else class="rule-list">
          <article v-for="rule in rules" :key="rule.id" class="rule-row">
            <div class="rule-main">
              <div class="rule-title"><strong>{{ rule.name }}</strong><span class="status-pill" :class="rule.enabled ? 'success' : 'warning'">{{ rule.enabled ? '启用' : '停用' }}</span><span class="mode-pill">{{ modeLabel(rule.mode) }}</span></div>
              <small>{{ rule.product }} · {{ rule.platform }} · {{ rule.targetPoolKey }}</small>
              <div class="rule-facts"><span>库存低于 {{ rule.minAvailableAccounts }} 触发</span><span>每次 {{ rule.replenishQuantity }} 个</span><span>并发 {{ rule.concurrency }}</span><span>优先级 {{ rule.priority }}</span><span>模型 {{ rule.verificationModel }}</span></div>
            </div>
            <div class="row-actions">
              <button class="icon-button" title="立即检查并执行" @click="trigger(rule)"><Play :size="15" /></button>
              <button class="icon-button" title="编辑策略" @click="editRule(rule)"><Settings2 :size="15" /></button>
            </div>
          </article>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><div><h2>商品映射</h2><p>第一版默认 oauth_30d，后续可扩展更多商品。</p></div><button class="secondary-button" @click="newMapping"><Plus :size="15" />新增映射</button></div>
        <div class="mapping-list">
          <div v-for="mapping in mappings" :key="mapping.id" class="mapping-row">
            <div><strong>{{ mapping.product }}</strong><small>{{ mapping.platform }} · {{ mapping.targetPoolKey }}</small></div>
            <div class="mapping-actions"><span>{{ (mapping.targetGroupIds || []).map((id: number) => `#${id}`).join('、') || '未绑定分组' }}</span><button class="icon-button" title="编辑映射" @click="editMapping(mapping)"><Settings2 :size="14" /></button></div>
          </div>
          <div v-if="!mappings.length" class="empty-state">还没有商品映射</div>
        </div>
      </section>
    </div>

    <section class="panel">
      <div class="panel-head"><div><h2>补号订单</h2><p>审批模式的订单需要人工确认；自动模式会按策略直接创建并轮询取货。</p></div><span class="table-note">最近 {{ orders.length }} 条</span></div>
      <div class="order-table-wrap">
        <table class="data-table replenishment-table">
          <thead><tr><th>订单</th><th>商品 / 账号池</th><th>状态</th><th>数量</th><th>成本</th><th>创建时间</th><th></th></tr></thead>
          <tbody>
            <tr v-for="order in orders" :key="order.id">
              <td><strong>#{{ order.id }}</strong><small>{{ order.externalOrderId || '等待创建' }}</small></td>
              <td><strong>{{ order.product }}</strong><small>{{ order.targetPoolKey }}</small></td>
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
      <div class="panel-head"><div><h2>账号修复</h2><p>OAuth Supply 会在账号异常后持续重授权；可认领时再把新版凭据写回对应 Sub2API 账号。</p></div><span class="table-note">最近 {{ recoveries.length }} 条</span></div>
      <div class="recovery-list">
        <div v-for="recovery in recoveries" :key="recovery.id" class="mapping-row">
          <div><strong>{{ recovery.accountName || `修复记录 #${recovery.id}` }}</strong><small>版本 {{ recovery.credentialVersion || '--' }}<span v-if="recovery.targetAccountId"> · Sub2API #{{ recovery.targetAccountId }}</span></small></div>
          <div class="recovery-actions"><span class="status-pill" :class="recovery.ready ? 'success' : 'warning'">{{ recovery.ready ? '可认领' : (recovery.deliveryStatus || '处理中') }}</span><button v-if="recovery.ready" class="secondary-button compact-button" @click="claimRecovery(recovery)">认领并更新</button></div>
        </div>
        <div v-if="!recoveries.length" class="empty-state">暂无待处理修复记录</div>
      </div>
    </section>

    <section v-if="editor" class="modal-layer" @click.self="editor = null">
      <div class="modal form-modal replenishment-editor">
        <header><div><h2>{{ editor.kind === 'rule' ? (editor.id ? '编辑补号策略' : '新增补号策略') : (editor.id ? '编辑商品映射' : '新增商品映射') }}</h2><p>配置保存后会立即用于下一轮检查。</p></div><button class="icon-button" @click="editor = null"><X :size="18" /></button></header>
        <div v-if="editor.kind === 'mapping'" class="form-grid">
          <label>商品编码<input v-model.trim="editor.product" placeholder="oauth_30d" /></label>
          <label>平台<input v-model.trim="editor.platform" placeholder="openai" /></label>
          <label>目标账号池<input v-model.trim="editor.targetPoolKey" placeholder="openai-team-primary" /></label>
          <label>Sub2API 正式分组 ID<input v-model.trim="editor.groupIdsText" placeholder="1, 2, 3" /></label>
          <label class="full-field">备注<textarea v-model.trim="editor.notes" rows="3" /></label>
        </div>
        <div v-else class="form-grid">
          <label class="full-field">策略名称<input v-model.trim="editor.name" placeholder="OAuth 30D 主账号池" /></label>
          <label>商品映射<select v-model.number="editor.productMappingId"><option :value="null" disabled>请选择商品映射</option><option v-for="mapping in mappings" :key="mapping.id" :value="mapping.id">{{ mapping.product }} · {{ mapping.targetPoolKey }}</option></select></label>
          <label>运行模式<select v-model="editor.mode"><option value="observe">观察模式</option><option value="approval">审批模式</option><option value="auto">全自动模式</option></select></label>
          <label>库存低于<input v-model.number="editor.minAvailableAccounts" type="number" min="0" /></label>
          <label>每次补号数量<input v-model.number="editor.replenishQuantity" type="number" min="1" max="1000" /></label>
          <label>固定并发数<input v-model.number="editor.concurrency" type="number" min="1" /></label>
          <label>固定优先级<input v-model.number="editor.priority" type="number" min="0" /></label>
          <label>单次成本上限<input v-model.number="editor.maxOrderAmountCny" type="number" min="0" step="0.01" placeholder="留空不限制" /></label>
          <label>每日成本上限<input v-model.number="editor.maxDailyAmountCny" type="number" min="0" step="0.01" placeholder="留空不限制" /></label>
          <label>验号模型<input v-model.trim="editor.verificationModel" /></label>
          <label>轮询间隔（秒）<input v-model.number="editor.pollIntervalSeconds" type="number" min="3" /></label>
          <label class="full-field">验号提示词<textarea v-model.trim="editor.verificationPrompt" rows="3" /></label>
          <label class="switch-row full-field"><input v-model="editor.enabled" type="checkbox" /><span><strong>启用策略</strong><small>观察模式只查库存和报价，不会创建订单。</small></span></label>
        </div>
        <div v-if="editorError" class="form-error-banner" role="alert">{{ editorError }}</div>
        <footer><button class="secondary-button" @click="editor = null">取消</button><button class="primary-button" :disabled="saving" @click="saveEditor">{{ saving ? '保存中…' : '保存' }}</button></footer>
      </div>
    </section>

    <section v-if="selectedOrder" class="modal-layer" @click.self="selectedOrder = null">
      <div class="modal order-detail-modal"><header><div><h2>补号订单 #{{ selectedOrder.id }}</h2><p>{{ selectedOrder.product }} · {{ selectedOrder.targetPoolKey }}</p></div><button class="icon-button" @click="selectedOrder = null"><X :size="18" /></button></header><div class="detail-metrics"><Metric title="状态" :value="orderStatusLabel(selectedOrder.status)" /><Metric title="有效账号" :value="`${selectedOrder.validQuantity || 0} / ${selectedOrder.requestedQuantity}`" /><Metric title="实际成本" :value="money(selectedOrder.actualPaidAmountCny ?? selectedOrder.quotedAmountCny)" tone="good" /></div><p class="order-detail-error" v-if="selectedOrder.lastError">{{ selectedOrder.lastError }}</p><div class="event-note">账号导入后会固定写入策略中的正式分组、并发数和优先级，验号模型为 {{ selectedRule?.verificationModel || 'gpt-5.6-luna' }}。</div></div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ChevronRight, Play, Plus, RefreshCw, Settings2, X } from 'lucide-vue-next';
import { get, send } from '../api';

const props = defineProps<{ refreshToken: number }>();
const emit = defineEmits<{ (event: 'toast', message: string): void }>();
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const editorError = ref('');
const dashboard = ref<any>({ summary: {}, oauthSupply: {} });
const mappings = ref<any[]>([]);
const rules = ref<any[]>([]);
const orders = ref<any[]>([]);
const recoveries = ref<any[]>([]);
const editor = ref<any | null>(null);
const selectedOrder = ref<any | null>(null);

const connected = computed(() => Boolean(dashboard.value.oauthSupply?.balance && !dashboard.value.oauthSupply.balance.error));
const selectedRule = computed(() => selectedOrder.value ? rules.value.find((rule) => rule.id === selectedOrder.value.ruleId) : null);
const money = (value: any) => value === null || value === undefined ? '--' : `¥${Number(value || 0).toFixed(2)}`;
const moneyFen = (value: any) => value === null || value === undefined ? '--' : money(Number(value) / 100);
const dateTime = (value: any) => value ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '--';
const modeLabel = (value: string) => ({ observe: '观察', approval: '审批', auto: '全自动' } as Record<string, string>)[value] || value;
const orderStatusLabel = (value: string) => ({ approval_required: '待审批', ordering: '创建订单', queued: '排队中', processing: '处理中', ready_to_collect: '待取货', importing: '导入验号', completed: '已完成', partial_failed: '部分失败', failed: '失败' } as Record<string, string>)[value] || value;
const orderStatusClass = (value: string) => ['completed'].includes(value) ? 'success' : ['failed', 'partial_failed'].includes(value) ? 'danger' : 'warning';
const copyRule = (rule: any) => ({ ...rule, kind: 'rule' });

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [nextDashboard, nextMappings, nextRules, nextOrders, nextRecoveries] = await Promise.all([
      get('/replenishment/dashboard'),
      get('/replenishment/mappings'),
      get('/replenishment/rules'),
      get('/replenishment/orders?limit=50'),
      get('/replenishment/recoveries').catch((err: any) => ({
        items: [],
        error: err?.message || '账号修复记录暂时不可用',
      })),
    ]);
    dashboard.value = nextDashboard;
    mappings.value = nextMappings;
    rules.value = nextRules;
    orders.value = nextOrders;
    recoveries.value = nextRecoveries.items || [];
    if (nextRecoveries.error && !nextDashboard.oauthSupply?.balance?.error) {
      error.value = nextRecoveries.error;
    }
  } catch (err: any) {
    error.value = err.message || '补号数据加载失败';
  } finally {
    loading.value = false;
  }
}

function newMapping() {
  error.value = '';
  editorError.value = '';
  editor.value = { kind: 'mapping', product: 'oauth_30d', platform: 'openai', targetPoolKey: '', groupIdsText: '', notes: '' };
}
function newRule() {
  const first = mappings.value[0];
  if (!first) {
    newMapping();
    editorError.value = '请先创建商品映射，再新增补号策略。';
    return;
  }
  error.value = '';
  editorError.value = '';
  editor.value = {
    kind: 'rule', name: '', productMappingId: first?.id || null, mode: 'observe', enabled: false,
    minAvailableAccounts: 3, replenishQuantity: 2, maxOrderAmountCny: null, maxDailyAmountCny: null,
    concurrency: 5, priority: 20, verificationModel: 'gpt-5.6-luna',
    verificationPrompt: 'Reply with a short success marker if this account can complete a basic request.',
    pollIntervalSeconds: 5, retryLimit: 3, cooldownSeconds: 300,
  };
}
function editRule(rule: any) { error.value = ''; editorError.value = ''; editor.value = copyRule(rule); }
function editMapping(mapping: any) { error.value = ''; editorError.value = ''; editor.value = { ...mapping, kind: 'mapping', groupIdsText: (mapping.targetGroupIds || []).join(', ') }; }

function validateEditor() {
  if (editor.value.kind === 'mapping') {
    if (!editor.value.product) return '请输入商品编码。';
    if (!editor.value.platform) return '请输入平台。';
    if (!editor.value.targetPoolKey) return '请输入目标账号池。';
    return '';
  }
  if (!editor.value.name) return '请输入策略名称。';
  if (!Number.isSafeInteger(Number(editor.value.productMappingId)) || Number(editor.value.productMappingId) <= 0) {
    return '请选择商品映射。';
  }
  return '';
}

async function saveEditor() {
  const validationError = validateEditor();
  if (validationError) {
    editorError.value = validationError;
    return;
  }
  saving.value = true;
  editorError.value = '';
  try {
    if (editor.value.kind === 'mapping') {
      await send('/replenishment/mappings', editor.value.id ? 'PATCH' : 'POST', {
        id: editor.value.id,
        product: editor.value.product,
        platform: editor.value.platform,
        targetPoolKey: editor.value.targetPoolKey,
        targetGroupIds: String(editor.value.groupIdsText || '').split(',').map(Number).filter((id: number) => Number.isSafeInteger(id) && id > 0),
        notes: editor.value.notes,
        enabled: true,
      });
    } else {
      await send(editor.value.id ? `/replenishment/rules/${editor.value.id}` : '/replenishment/rules', editor.value.id ? 'PATCH' : 'POST', {
        ...editor.value,
        kind: undefined,
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
  try {
    await send('/replenishment/trigger', 'POST', { ruleId: rule.id });
    emit('toast', '已完成库存检查，订单状态已更新');
    await load();
  } catch (err: any) { error.value = err.message || '执行补号失败'; }
}
async function approve(order: any) {
  try {
    await send(`/replenishment/orders/${order.id}/approve`, 'POST', {});
    emit('toast', `订单 #${order.id} 已批准`);
    await load();
  } catch (err: any) { error.value = err.message || '批准失败'; }
}
async function viewOrder(order: any) {
  try { selectedOrder.value = await get(`/replenishment/orders/${order.id}`); } catch (err: any) { error.value = err.message || '订单读取失败'; }
}
async function claimRecovery(recovery: any) {
  try {
    await send(`/replenishment/recoveries/${encodeURIComponent(recovery.id)}/claim`, 'POST', {});
    emit('toast', '修复账号已认领');
    await load();
  } catch (err: any) { error.value = err.message || '认领失败'; }
}

onMounted(load);
watch(() => props.refreshToken, load);
</script>
