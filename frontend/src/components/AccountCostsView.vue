<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { Check, Clock3, Edit3, History, Link2, Plus, RefreshCw, WalletCards, X } from 'lucide-vue-next';
import { get, query, rangeQuery, send } from '../api';

type AnyRecord = Record<string, any>;
const props = defineProps<{ refreshToken?: number; range?: string; rangeStart?: string; rangeEnd?: string }>();
const emit = defineEmits<{ toast: [message: string] }>();

const search = ref('');
const page = ref(1);
const pageSize = ref(30);
const loading = ref(false);
const accounts = ref<AnyRecord>({});
const catalog = ref<AnyRecord>({ suppliers: [], batches: [], supplierKeys: [] });
const profiles = ref<AnyRecord[]>([]);
const editor = ref<AnyRecord | null>(null);
const periodEditor = ref<AnyRecord | null>(null);
const history = ref<AnyRecord | null>(null);
const saving = ref(false);
let searchTimer: number | undefined;
let loadRequestId = 0;
let editorOptionsPromise: Promise<void> | null = null;
let editorOptionsLoaded = false;

const rows = computed(() => accounts.value.items || []);
const pages = computed(() => Math.max(1, Math.ceil(Number(accounts.value.total || 0) / pageSize.value)));
const selectedSupplierKeys = computed(() => (catalog.value.supplierKeys || []).filter((item: AnyRecord) => (
  !item.accountId || Number(item.accountId) === Number(editor.value?.id)
)));
const supplierBatches = computed(() => {
  const supplier = editor.value?.supplier || periodEditor.value?.supplier || '';
  return (catalog.value.batches || []).filter((item: AnyRecord) => !supplier || item.supplier === supplier);
});

function isOAuthSupplyAccount(account: AnyRecord) {
  return account.currentCostSupplier === 'OAuth Supply'
    || account.supplier === 'OAuth Supply'
    || String(account.currentCostPurchaseBatch || account.purchaseBatch || '').startsWith('oauth-supply:');
}

function notify(message: string) { emit('toast', message); }
function money(value: any) {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 }).format(Number(value || 0));
}
function dateTime(value: any) {
  return value ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '--';
}
function inputDateTime(value: any) {
  if (!value) return '';
  const date = new Date(value);
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function statusClass(value: any) {
  return ['complete', 'free', 'priced'].includes(String(value)) ? 'success' : ['missing', 'failed'].includes(String(value)) ? 'danger' : 'warning';
}
function modeLabel(value: any) {
  return ({
    probe_multiplier: '供应商密钥倍率',
    manual_multiplier: '手动进货倍率',
    fixed_purchase: '固定采购成本',
    free: '免费资源',
    unconfigured: '未配置',
  } as Record<string, string>)[String(value || '')] || String(value || '未配置');
}
function makeEditor(account: AnyRecord) {
  return {
    ...account,
    originalSupplierKeyId: account.supplierKeyId || null,
    costMode: account.costMode || 'fixed_purchase',
    basisMode: account.basisMode || 'revenue_backsolve',
    upstreamMultiplier: account.upstreamMultiplier ?? '',
    cnyPerReferenceUnit: account.cnyPerReferenceUnit ?? '',
    supplierKeyId: account.supplierKeyId || '',
    supplier: account.supplier || account.linkedSupplierName || '',
    purchaseBatch: account.purchaseBatch || '',
    changeStrategy: 'future_only',
    tagsText: Array.isArray(account.tags) ? account.tags.join(',') : '',
  };
}

async function load() {
  const requestId = ++loadRequestId;
  loading.value = true;
  try {
    const params = query({
      ...rangeQuery(props.range, props.rangeStart, props.rangeEnd), page: page.value, page_size: pageSize.value, search: search.value,
    });
    const accountResult = await get(`/accounts?${params}`);
    if (requestId === loadRequestId) accounts.value = accountResult;
  } catch (error: any) {
    if (requestId === loadRequestId) notify(error.message);
  } finally {
    if (requestId === loadRequestId) loading.value = false;
  }
}

function openEditor(account: AnyRecord) {
  editor.value = makeEditor(account);
  void loadEditorOptions();
}

function openPeriodEditor(account: AnyRecord, period: AnyRecord | null = null) {
  periodEditor.value = {
    account,
    id: period?.id || null,
    costProfileId: period?.costProfileId || account.currentCostProfileId || '',
    originalAmount: period?.originalAmount ?? account.currentOriginalAmount ?? '',
    baseAmount: period?.baseAmount ?? account.currentOriginalAmount ?? '',
    feeAmount: period?.feeAmount ?? account.currentFeeAmount ?? 0,
    taxAmount: period?.taxAmount ?? account.currentTaxAmount ?? 0,
    originalCurrency: period?.originalCurrency || 'CNY',
    fxRate: period?.fxRate || 1,
    effectiveFrom: inputDateTime(period?.effectiveFrom || account.currentEffectiveFrom || new Date()),
    effectiveTo: inputDateTime(period?.effectiveTo || account.currentEffectiveTo || new Date(Date.now() + 30 * 86400000)),
    supplier: period?.supplier || account.currentCostSupplier || account.supplier || '',
    purchaseBatch: period?.purchaseBatch || account.currentCostPurchaseBatch || account.purchaseBatch || '',
    notes: period?.notes || account.currentCostNotes || '',
  };
  void loadEditorOptions();
}

function loadEditorOptions() {
  if (editorOptionsLoaded) return Promise.resolve();
  if (editorOptionsPromise) return editorOptionsPromise;
  editorOptionsPromise = Promise.allSettled([
    get('/purchase-catalog').then((result) => { catalog.value = result; }),
    get('/cost-profiles').then((result) => { profiles.value = result.items || []; }),
  ]).then((results) => {
    editorOptionsLoaded = results.every((result) => result.status === 'fulfilled');
    for (const result of results) {
      if (result.status === 'rejected') notify(result.reason?.message || String(result.reason));
    }
  }).finally(() => { editorOptionsPromise = null; });
  return editorOptionsPromise;
}

function tags(value: string) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

async function saveEditor() {
  if (!editor.value) return;
  const current = editor.value;
  saving.value = true;
  try {
    const oldKeyId = current.originalSupplierKeyId;
    if (current.costMode === 'probe_multiplier') {
      if (!current.supplierKeyId) throw new Error('供应商密钥倍率必须选择已连接的密钥');
      await send(`/supplier-keys/${current.supplierKeyId}/account-link`, 'PATCH', {
        accountId: Number(current.id), linked: true,
      });
      const selected = selectedSupplierKeys.value.find((item: AnyRecord) => Number(item.id) === Number(current.supplierKeyId));
      current.supplier = selected?.supplier || current.supplier;
      current.purchaseBatch = selected?.purchaseBatch || current.purchaseBatch;
      current.upstreamMultiplier = null;
      current.cnyPerReferenceUnit = null;
      current.basisMode = 'revenue_backsolve';
    }
    await send(`/accounts/${current.id}`, 'PATCH', {
      costProfileId: current.costProfileId || null,
      supplierKeyId: current.costMode === 'probe_multiplier' ? Number(current.supplierKeyId) : null,
      costMode: current.costMode,
      basisMode: ['manual_multiplier', 'probe_multiplier'].includes(current.costMode) ? current.basisMode : null,
      upstreamMultiplier: current.costMode === 'manual_multiplier' ? current.upstreamMultiplier || null : null,
      cnyPerReferenceUnit: current.costMode === 'manual_multiplier' && current.basisMode === 'reference_cny' ? current.cnyPerReferenceUnit || null : null,
      changeStrategy: current.changeStrategy,
      supplier: current.supplier || '',
      purchaseBatch: current.purchaseBatch || '',
      tags: tags(current.tagsText || ''),
    });
    if (oldKeyId && (current.costMode !== 'probe_multiplier' || Number(oldKeyId) !== Number(current.supplierKeyId))) {
      await send(`/supplier-keys/${oldKeyId}/account-link`, 'PATCH', { accountId: Number(current.id), linked: false });
    }
    editor.value = null;
    notify('账号成本规则已保存');
    await load();
  } catch (error: any) {
    notify(error.message);
  } finally {
    saving.value = false;
  }
}

async function savePeriod() {
  if (!periodEditor.value) return;
  const current = periodEditor.value;
  saving.value = true;
  try {
    const baseAmount = Number(current.baseAmount || current.originalAmount || 0);
    const payload = {
      accountId: Number(current.account.id),
      costProfileId: current.costProfileId || null,
      originalAmount: baseAmount,
      originalCurrency: current.originalCurrency || 'CNY',
      fxRate: Number(current.fxRate || 1),
      baseAmount,
      feeAmount: Number(current.feeAmount || 0),
      taxAmount: Number(current.taxAmount || 0),
      effectiveFrom: new Date(current.effectiveFrom).toISOString(),
      effectiveTo: new Date(current.effectiveTo).toISOString(),
      supplier: current.supplier || '',
      purchaseBatch: current.purchaseBatch || '',
      notes: current.notes || '',
      tags: [],
    };
    if (current.id) {
      await send(`/account-cost-periods/${current.id}`, 'PATCH', {
        ...payload,
        correctionReason: 'FinOps 管理员更新账号固定成本期间',
      });
    } else {
      await send('/account-cost-periods', 'POST', payload);
    }
    periodEditor.value = null;
    notify(current.id ? '固定成本期间已更新' : '固定成本期间已登记');
    await load();
  } catch (error: any) {
    notify(error.message);
  } finally {
    saving.value = false;
  }
}

async function openHistory(account: AnyRecord) {
  history.value = { account, tab: 'rules', rules: null, periods: null, loading: true };
  try {
    const [rules, periods] = await Promise.all([
      get(`/accounts/${account.id}/cost-rules?page=1&page_size=50`),
      get(`/accounts/${account.id}/cost-periods?page=1&page_size=50`),
    ]);
    history.value.rules = rules;
    history.value.periods = periods;
  } catch (error: any) {
    notify(error.message);
  } finally {
    if (history.value) history.value.loading = false;
  }
}

watch(search, () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => { page.value = 1; load(); }, 250);
});
watch(() => props.refreshToken, () => {
  page.value = 1;
  load();
});
onMounted(() => {
  void load();
  void loadEditorOptions();
});
</script>

<template>
  <div class="page-view account-cost-view">
    <div class="toolbar-row">
      <label class="search-box"><WalletCards :size="17" /><input v-model="search" placeholder="搜索账号、平台或供应商" /></label>
      <button class="icon-button" title="刷新列表" aria-label="刷新列表" @click="load"><RefreshCw :size="17" :class="{ spin: loading }" /></button>
      <span v-if="loading" class="loading-note"><RefreshCw :size="15" class="spin" />更新中</span>
    </div>
    <section class="panel table-panel">
      <div class="panel-head"><div><h2>账号成本台账</h2><p>OAuth Supply 账号按采购订单自动登记供应商、批次和账号成本；其他账号继续使用固定成本或供应商倍率规则。</p></div><WalletCards :size="20" class="head-icon" /></div>
      <div class="table-wrap"><table class="account-table"><thead><tr><th>账号</th><th>平台 / 供应商</th><th>成本模式</th><th class="number">销售额</th><th class="number">总成本</th><th class="number">毛利</th><th>覆盖状态</th><th>操作</th></tr></thead><tbody>
        <tr v-if="loading && !rows.length"><td colspan="8" class="table-empty">正在读取账号成本</td></tr>
        <tr v-for="account in rows" :key="account.id">
          <td><strong>{{ account.name }}</strong><small>ID {{ account.id }} · {{ account.platform }}</small></td>
          <td>{{ account.supplier || account.linkedSupplierName || '未关联供应商' }}<small>{{ account.purchaseBatch || account.supplierKeyName || '未关联采购批次' }}</small></td>
          <td><span class="status-pill" :class="statusClass(account.costMode)">{{ isOAuthSupplyAccount(account) ? '自动采购成本' : modeLabel(account.costMode) }}</span><small>{{ isOAuthSupplyAccount(account) ? `账号成本 ${money(account.currentTotalCostCny ?? account.currentOriginalAmount)}` : account.supplierKeyInventoryMultiplier != null ? `密钥 ${account.supplierKeyInventoryMultiplier}x` : account.upstreamMultiplier != null ? `上游 ${account.upstreamMultiplier}x` : account.supplierKeyName || '' }}</small></td>
          <td class="number">{{ money(account.userChargeCny) }}</td><td class="number">{{ money(account.bookedCostCny || account.effectiveCostCny) }}</td><td class="number positive">{{ money(account.bookedProfitCny || account.grossProfitCny) }}</td>
          <td><span class="status-pill" :class="statusClass(account.costCoverageStatus)">{{ account.costCoverageStatus === 'complete' ? '已覆盖' : account.costCoverageStatus === 'missing' ? '待补成本' : account.costCoverageStatus || '待检查' }}</span></td>
          <td><div class="row-actions"><template v-if="!isOAuthSupplyAccount(account)"><button class="small-button" @click="openEditor(account)"><Edit3 :size="14" />成本规则</button><button class="icon-button mini-action" title="登记固定成本" @click="openPeriodEditor(account)"><Plus :size="15" /></button></template><span v-else class="auto-ledger-label"><Link2 :size="14" />订单自动登记</span><button class="icon-button mini-action" title="查看历史" @click="openHistory(account)"><History :size="15" /></button></div></td>
        </tr>
        <tr v-if="!loading && !rows.length"><td colspan="8" class="table-empty">没有找到账号</td></tr>
      </tbody></table></div>
      <div v-if="pages > 1" class="pager"><button class="small-button" :disabled="page <= 1" @click="page--; load()">上一页</button><span>第 {{ page }} / {{ pages }} 页，共 {{ accounts.total }} 个账号</span><button class="small-button" :disabled="page >= pages" @click="page++; load()">下一页</button></div>
    </section>

    <div v-if="editor" class="modal-layer" @click.self="editor = null"><section class="modal form-modal account-editor-modal"><header><div><h2>配置账号成本</h2><p>{{ editor.name }} · {{ editor.platform }}</p></div><button class="icon-button" @click="editor = null"><X :size="19" /></button></header>
      <div class="form-grid">
        <label>成本模式<select v-model="editor.costMode"><option value="probe_multiplier">供应商密钥倍率（自动）</option><option value="manual_multiplier">手动填写进货倍率</option><option value="fixed_purchase">固定采购成本</option><option value="free">免费资源</option></select></label>
        <label>变更范围<select v-model="editor.changeStrategy"><option value="future_only">仅未来用量</option><option value="current_day">从今天 0 点开始</option></select></label>
        <label v-if="editor.costMode === 'probe_multiplier'" class="full-field">采购批次 / 供应商密钥<select v-model="editor.supplierKeyId"><option value="">请选择已连接的密钥</option><option v-for="key in selectedSupplierKeys" :key="key.id" :value="key.id">{{ key.supplier }} · {{ key.name || key.maskedKey }} · {{ key.groupName || '未分组' }}{{ key.rateMultiplier == null ? ' · 暂无倍率' : ` · ${key.rateMultiplier}x` }}</option></select><small class="field-hint">绑定后，后续消费自动使用最新同步的密钥倍率；历史成本不会自动补算。</small></label>
        <label v-if="['manual_multiplier','probe_multiplier'].includes(editor.costMode)">倍率成本基础<select v-model="editor.basisMode"><option value="revenue_backsolve">按实际消费记录回推（推荐）</option><option value="reference_cny">目录价乘 CNY 基准</option></select></label>
        <label v-if="editor.costMode === 'manual_multiplier'">进货倍率<input v-model="editor.upstreamMultiplier" type="number" min="0" step="0.0001" placeholder="例如 0.5" /></label>
        <label v-if="editor.costMode === 'manual_multiplier' && editor.basisMode === 'reference_cny'">每目录单位 CNY 基准<input v-model="editor.cnyPerReferenceUnit" type="number" min="0" step="0.0001" /></label>
        <label v-if="editor.costMode !== 'probe_multiplier'">供应商<select v-model="editor.supplier"><option value="">不选择</option><option v-for="supplier in catalog.suppliers" :key="supplier" :value="supplier">{{ supplier }}</option></select></label>
        <label v-if="editor.costMode === 'fixed_purchase'">采购批次<select v-model="editor.purchaseBatch"><option value="">不选择</option><option v-for="batch in supplierBatches" :key="`${batch.supplier}-${batch.purchaseBatch}`" :value="batch.purchaseBatch">{{ batch.supplier }} · {{ batch.purchaseBatch }}</option></select></label>
        <label class="full-field">账号标签<input v-model="editor.tagsText" placeholder="多个标签用逗号分隔" /></label>
      </div>
      <div class="form-note">绑定了有效供应商密钥的账号无需探测或手工填写进货倍率；只有密钥没有倍率时才需要选择其他成本方式。</div>
      <footer><button class="secondary-button" @click="editor = null">取消</button><button class="primary-button" :disabled="saving" @click="saveEditor"><Check :size="16" />保存成本规则</button></footer>
    </section></div>

    <div v-if="periodEditor" class="modal-layer nested-modal" @click.self="periodEditor = null"><section class="modal form-modal period-editor-modal"><header><div><h2>{{ periodEditor.id ? '编辑固定成本期间' : '登记固定成本期间' }}</h2><p>{{ periodEditor.account.name }} · 固定采购成本按生效时间分摊</p></div><button class="icon-button" @click="periodEditor = null"><X :size="19" /></button></header>
      <div class="form-grid">
        <label>成本模板<select v-model="periodEditor.costProfileId"><option value="">使用账号当前配置</option><option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.name }} · {{ modeLabel(profile.costMode) }}</option></select></label>
        <label>本金（CNY）<input v-model="periodEditor.baseAmount" type="number" min="0" step="0.01" /></label>
        <label>手续费（CNY）<input v-model="periodEditor.feeAmount" type="number" min="0" step="0.01" /></label>
        <label>税费（CNY）<input v-model="periodEditor.taxAmount" type="number" min="0" step="0.01" /></label>
        <label>生效开始<input v-model="periodEditor.effectiveFrom" type="datetime-local" /></label>
        <label>生效结束<input v-model="periodEditor.effectiveTo" type="datetime-local" /></label>
        <label>供应商<select v-model="periodEditor.supplier"><option value="">不选择</option><option v-for="supplier in catalog.suppliers" :key="supplier" :value="supplier">{{ supplier }}</option></select></label>
        <label>采购批次<select v-model="periodEditor.purchaseBatch"><option value="">不选择</option><option v-for="batch in supplierBatches" :key="`${batch.supplier}-${batch.purchaseBatch}`" :value="batch.purchaseBatch">{{ batch.supplier }} · {{ batch.purchaseBatch }}</option></select></label>
        <label class="full-field">备注<textarea v-model="periodEditor.notes" rows="3"></textarea></label>
      </div>
      <div class="form-note">总成本 = 本金 + 手续费 + 税费。修改已经开始的期间会留下审计记录。</div>
      <footer><button class="secondary-button" @click="periodEditor = null">取消</button><button class="primary-button" :disabled="saving" @click="savePeriod"><Check :size="16" />保存固定成本</button></footer>
    </section></div>

    <div v-if="history" class="modal-layer nested-modal" @click.self="history = null"><section class="modal history-modal"><header><div><h2>账号成本历史</h2><p>{{ history.account.name }} · 规则和固定成本期间</p></div><button class="icon-button" @click="history = null"><X :size="19" /></button></header>
      <div class="detail-tabs"><button :class="{ active: history.tab === 'rules' }" @click="history.tab = 'rules'">计价规则</button><button :class="{ active: history.tab === 'periods' }" @click="history.tab = 'periods'">固定成本期间</button></div>
      <div v-if="history.loading" class="table-empty">正在读取历史</div>
      <div v-else-if="history.tab === 'rules'" class="table-wrap compact-table"><table><thead><tr><th>时间</th><th>类型</th><th>模式</th><th>倍率</th><th>状态</th><th>备注</th></tr></thead><tbody><tr v-for="item in history.rules?.items || []" :key="`${item.type}-${item.id || item.eventId}`"><td>{{ dateTime(item.occurredAt || item.cutoffAt) }}</td><td>{{ item.type || 'rule' }}</td><td>{{ modeLabel(item.costMode) }}</td><td>{{ item.upstreamMultiplier == null ? '--' : `${item.upstreamMultiplier}x` }}</td><td>{{ item.status || '--' }}</td><td>{{ item.notes || '--' }}</td></tr><tr v-if="!history.rules?.items?.length"><td colspan="6" class="table-empty">暂无计价版本</td></tr></tbody></table></div>
      <div v-else class="table-wrap compact-table"><table><thead><tr><th>时间</th><th class="number">总成本</th><th>生效期间</th><th>供应商</th><th>采购批次</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="item in history.periods?.items || []" :key="item.id"><td>{{ dateTime(item.createdAt || item.effectiveFrom) }}</td><td class="number">{{ money(item.totalCost ?? (Number(item.baseAmount || item.originalAmount || 0) + Number(item.feeAmount || 0) + Number(item.taxAmount || 0))) }}</td><td>{{ dateTime(item.effectiveFrom) }}<small>至 {{ dateTime(item.effectiveTo) }}</small></td><td>{{ item.supplier || '--' }}</td><td>{{ item.purchaseBatch || '--' }}</td><td>{{ item.status || '--' }}</td><td><button class="small-button" @click="openPeriodEditor(history.account, item)"><Edit3 :size="14" />编辑</button></td></tr><tr v-if="!history.periods?.items?.length"><td colspan="7" class="table-empty">暂无固定成本期间</td></tr></tbody></table></div>
    </section></div>
  </div>
</template>
