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
                <span>修复等待 {{ duration(rule.repairGraceSeconds) }}</span>
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
        <div v-for="recovery in recoveries" :key="recovery.id" class="recovery-row">
          <div class="recovery-main">
            <strong>{{ recovery.accountName || `修复任务 #${recovery.id}` }}</strong>
            <small>Sub2API #{{ recovery.targetAccountId }} · 版本 {{ recovery.credentialVersion || '--' }} · 尝试 {{ recovery.attemptCount || 0 }} 次</small>
            <small v-if="recovery.lastError" class="recovery-error">{{ recovery.lastError }}</small>
          </div>
          <div class="recovery-actions">
            <span class="status-pill" :class="recoveryStatusClass(recovery.status)">{{ recoveryStatusLabel(recovery.status) }}</span>
            <button v-if="recovery.ready && recovery.status !== 'recovered'" class="secondary-button compact-button" @click="claimRecovery(recovery)">立即重试</button>
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
          <label>商品映射<select v-model.number="editor.productMappingId"><option :value="null" disabled>请选择商品映射</option><option v-for="mapping in mappings" :key="mapping.id" :value="mapping.id">{{ mapping.product }} · {{ platformText(mapping.platform) }} · {{ groupSummary(mapping.targetGroupIds) }}</option></select></label>
          <label>运行模式<select v-model="editor.mode"><option value="observe">观察模式</option><option value="approval">审批模式</option><option value="auto">全自动模式</option></select></label>
          <label>最低有效库存<input v-model.number="editor.minAvailableAccounts" type="number" min="0" /></label>
          <label>目标库存<input v-model.number="editor.targetAvailableAccounts" type="number" min="1" /></label>
          <label>单次最多购买<input v-model.number="editor.replenishQuantity" type="number" min="1" max="1000" /></label>
          <label>额度消耗阈值<input v-model.number="editor.quotaUsedThresholdPercent" type="number" min="0" max="100" step="1" /></label>
          <label>额度判断窗口<select v-model="editor.quotaWindow"><option value="any">任一窗口</option><option value="short">短窗口（5小时）</option><option value="long">长窗口（7天）</option></select></label>
          <label>额度未知处理<select v-model="editor.quotaUnknownPolicy"><option value="warn">计入库存并告警</option><option value="low">按低额度处理</option><option value="ignore">计入库存且忽略</option></select></label>
          <label>修复等待（秒）<input v-model.number="editor.repairGraceSeconds" type="number" min="0" max="86400" /></label>
          <label>修复最大重试<input v-model.number="editor.recoveryRetryLimit" type="number" min="0" max="20" /></label>
          <label>固定并发数<input v-model.number="editor.concurrency" type="number" min="1" /></label>
          <label>固定优先级<input v-model.number="editor.priority" type="number" min="0" /></label>
          <label>单次成本上限<input v-model.number="editor.maxOrderAmountCny" type="number" min="0" step="0.01" placeholder="留空不限制" /></label>
          <label>每日成本上限<input v-model.number="editor.maxDailyAmountCny" type="number" min="0" step="0.01" placeholder="留空不限制" /></label>
          <label>验号模型<input v-model.trim="editor.verificationModel" /></label>
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
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ChevronRight, Pause, Play, Plus, RefreshCw, Settings2, Trash2, X, Zap } from 'lucide-vue-next';
import { get, send } from '../api';

const props = defineProps<{ refreshToken: number }>();
const emit = defineEmits<{ (event: 'toast', message: string): void }>();
const loading = ref(false);
const saving = ref(false);
const actioningId = ref('');
const error = ref('');
const editorError = ref('');
const dashboard = ref<any>({ summary: {}, oauthSupply: {} });
const catalog = ref<any>({ groups: [], platforms: [] });
const mappings = ref<any[]>([]);
const rules = ref<any[]>([]);
const orders = ref<any[]>([]);
const recoveries = ref<any[]>([]);
const editor = ref<any | null>(null);
const selectedOrder = ref<any | null>(null);

const connected = computed(() => Boolean(dashboard.value.oauthSupply?.balance && !dashboard.value.oauthSupply.balance.error));
const selectedRule = computed(() => selectedOrder.value ? rules.value.find((rule) => rule.id === selectedOrder.value.ruleId) : null);
const groupById = computed<Map<number, any>>(() => new Map((catalog.value.groups || []).map((group: any) => [Number(group.id), group])));
const mappingGroups = computed(() => !editor.value?.platform ? [] : (catalog.value.groups || []).filter((group: any) => group.platform === editor.value.platform));
const money = (value: any) => value === null || value === undefined ? '--' : `¥${Number(value || 0).toFixed(2)}`;
const moneyFen = (value: any) => value === null || value === undefined ? '--' : money(Number(value) / 100);
const dateTime = (value: any) => value ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '--';
const duration = (seconds: any) => Number(seconds) >= 3600 ? `${Math.round(Number(seconds) / 3600)} 小时` : `${Math.round(Number(seconds) / 60)} 分钟`;
const modeLabel = (value: string) => ({ observe: '观察', approval: '审批', auto: '全自动' } as Record<string, string>)[value] || value;
const quotaWindowLabel = (value: string) => ({ short: '5小时', long: '7天', any: '任一窗口' } as Record<string, string>)[value] || value;
const orderStatusLabel = (value: string) => ({ approval_required: '待审批', ordering: '创建订单', queued: '排队中', processing: '处理中', ready_to_collect: '待取货', importing: '导入验号', completed: '已完成', partial_failed: '部分失败', failed: '失败' } as Record<string, string>)[value] || value;
const orderStatusClass = (value: string) => value === 'completed' ? 'success' : ['failed', 'partial_failed'].includes(value) ? 'danger' : 'warning';
const recoveryStatusLabel = (value: string) => ({ detected: '发现401', waiting_supplier: '等待供应商', claimable: '可认领', credentials_saved: '凭据已保存', updating_sub2api: '更新账号中', verifying: '验号中', retry_wait: '等待重试', manual_required: '需要人工处理', recovered: '已恢复' } as Record<string, string>)[value] || value;
const recoveryStatusClass = (value: string) => value === 'recovered' ? 'success' : value === 'manual_required' ? 'danger' : 'warning';
const platformText = (value: string) => ({ openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', antigravity: 'Antigravity', grok: 'Grok', composite: 'Composite' } as Record<string, string>)[value] || value || '--';
const groupSummary = (ids: any[] = []) => ids.length ? ids.map((id) => groupById.value.get(Number(id))?.name || `分组 #${id}`).join('、') : '未选择正式分组';
const orderGroupSummary = (order: any) => groupSummary(rules.value.find((rule) => Number(rule.id) === Number(order.ruleId))?.targetGroupIds || []);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [nextDashboard, nextCatalog, nextMappings, nextRules, nextOrders, nextRecoveries] = await Promise.all([
      get('/replenishment/dashboard'), get('/replenishment/catalog'), get('/replenishment/mappings'),
      get('/replenishment/rules'), get('/replenishment/orders?limit=50'),
      get('/replenishment/recoveries').catch((err: any) => ({ items: [], error: err?.message || '账号修复记录暂时不可用' })),
    ]);
    dashboard.value = nextDashboard;
    catalog.value = nextCatalog;
    mappings.value = nextMappings;
    rules.value = nextRules;
    orders.value = nextOrders;
    recoveries.value = nextRecoveries.items || [];
    if (nextRecoveries.error && !nextDashboard.oauthSupply?.balance?.error) error.value = nextRecoveries.error;
  } catch (err: any) {
    error.value = err.message || '补号数据加载失败';
  } finally {
    loading.value = false;
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
    repairGraceSeconds: 900, recoveryRetryLimit: 6,
    maxOrderAmountCny: null, maxDailyAmountCny: null, concurrency: 5, priority: 20,
    verificationModel: 'gpt-5.6-luna',
    verificationPrompt: 'Reply with a short success marker if this account can complete a basic request.',
    pollIntervalSeconds: 5, retryLimit: 3, cooldownSeconds: 300,
  };
}
function editRule(rule: any) { editorError.value = ''; editor.value = { ...rule, kind: 'rule' }; }
function editMapping(mapping: any) { editorError.value = ''; editor.value = { ...mapping, kind: 'mapping', targetGroupIds: [...(mapping.targetGroupIds || [])] }; }
function onMappingPlatformChange() { editor.value.targetGroupIds = []; editorError.value = ''; }

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
      await send(editor.value.id ? `/replenishment/rules/${editor.value.id}` : '/replenishment/rules', editor.value.id ? 'PATCH' : 'POST', { ...editor.value, kind: undefined });
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

onMounted(load);
watch(() => props.refreshToken, load);
</script>
