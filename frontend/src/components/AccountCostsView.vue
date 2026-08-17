<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  Check, ChevronDown, Edit3, History, Link2, Plus,
  RefreshCw, RotateCcw, Search, WalletCards, X,
} from 'lucide-vue-next';
import { get, query, rangeQuery, send } from '../api';
import FilterSelect from './FilterSelect.vue';

type AnyRecord = Record<string, any>;
const props = defineProps<{ refreshToken?: number; range?: string; rangeStart?: string; rangeEnd?: string }>();
const emit = defineEmits<{ toast: [message: string] }>();

const page = ref(1);
const pageSize = ref(20);
const loading = ref(false);
const accounts = ref<AnyRecord>({});
const catalog = ref<AnyRecord>({
  suppliers: [], filterSuppliers: [], batches: [], supplierKeys: [],
  platforms: [], accountTypes: [], groups: [],
});
const profiles = ref<AnyRecord[]>([]);
const editor = ref<AnyRecord | null>(null);
const periodEditor = ref<AnyRecord | null>(null);
const history = ref<AnyRecord | null>(null);
const saving = ref(false);
const emptyFilters = () => ({
  search: '',
  platform: '',
  accountType: '',
  status: '',
  privacyMode: '',
  groupId: '',
  supplier: '',
  costMode: '',
});
const filters = ref(emptyFilters());
const appliedFilters = ref(emptyFilters());
const sortBy = ref('createdAt');
const sortOrder = ref<'asc' | 'desc'>('desc');
let loadRequestId = 0;
let editorOptionsPromise: Promise<void> | null = null;
let editorOptionsLoaded = false;
let searchTimer: number | undefined;

const rows = computed(() => accounts.value.items || []);
const summary = computed(() => accounts.value.summary || {});
const pages = computed(() => Math.max(1, Math.ceil(Number(accounts.value.total || 0) / pageSize.value)));
const metricScope = computed(() => summary.value.partialUsageSummary ? '当前页' : '筛选结果');
const suppliers = computed(() => [...new Set(
  catalog.value.filterSuppliers || catalog.value.suppliers || [],
)].sort((left, right) => String(left).localeCompare(String(right), 'zh-CN')));
const platformLabels: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  grok: 'Grok',
};
const accountTypeLabels: Record<string, string> = {
  oauth: 'OAuth',
  'setup-token': 'Setup Token',
  apikey: 'API Key',
  api_key: 'API Key',
  bedrock: 'AWS Bedrock',
};
const platformOptions = computed(() => [
  { value: '', label: '全部平台' },
  ...[...new Set([
    'anthropic', 'openai', 'gemini', 'antigravity', 'grok',
    ...(catalog.value.platforms || []),
  ])].filter(Boolean).map((value) => ({
    value: String(value),
    label: platformLabels[String(value)] || String(value),
  })),
]);
const accountTypeOptions = computed(() => [
  { value: '', label: '全部类型' },
  ...[...new Set([
    'oauth', 'setup-token', 'apikey', 'bedrock',
    ...(catalog.value.accountTypes || []),
  ])].filter(Boolean).map((value) => ({
    value: String(value),
    label: accountTypeLabels[String(value)] || String(value),
  })),
]);
const statusOptions = [
  { value: '', label: '全部状态' },
  { value: 'active', label: '正常' },
  { value: 'inactive', label: '未激活' },
  { value: 'error', label: '错误' },
  { value: 'rate_limited', label: '限流中' },
  { value: 'temp_unschedulable', label: '临时不可调度' },
  { value: 'unschedulable', label: '不可调度' },
];
const privacyOptions = [
  { value: '', label: '全部Privacy状态' },
  { value: '__unset__', label: '未设置' },
  { value: 'training_off', label: 'Privacy' },
  { value: 'training_set_cf_blocked', label: 'CF' },
  { value: 'training_set_failed', label: 'Fail' },
];
const groupOptions = computed(() => [
  { value: '', label: '全部分组' },
  { value: 'ungrouped', label: '未分组' },
  ...(catalog.value.groups || []).map((group: AnyRecord) => ({
    value: String(group.id),
    label: group.platform ? `${group.name} · ${group.platform}` : group.name,
  })),
]);
const costTypeOptions = [
  { value: '', label: '全部成本类型' },
  { value: 'fixed_purchase', label: '固定采购' },
  { value: 'probe_multiplier', label: '供应商倍率' },
  { value: 'manual_multiplier', label: '手动倍率' },
  { value: 'free', label: '免费资源' },
  { value: 'unconfigured', label: '未配置' },
];
const supplierOptions = computed(() => [
  { value: '', label: '全部供应商' },
  ...suppliers.value.map((supplier) => ({ value: String(supplier), label: String(supplier) })),
]);
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
function moneyOrDash(value: any) {
  if (value === null || value === undefined || value === '') return '--';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? money(parsed) : '--';
}
function compact(value: any) {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 }).format(Number(value || 0));
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
function localDayStartInput() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return inputDateTime(date);
}
function statusClass(value: any) {
  return ['complete', 'configured', 'free', 'priced'].includes(String(value)) ? 'success' : ['missing', 'failed'].includes(String(value)) ? 'danger' : 'warning';
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
function accountTypeLabel(account: AnyRecord) {
  if (account.accountType === 'oauth') return 'OAuth 授权';
  if (account.accountType === 'api') return 'API';
  return account.accountType || account.platform || '--';
}
function accountStatusLabel(account: AnyRecord) {
  if (account.sourceDeletedAt) return '已删除';
  if (account.expiresAt && new Date(account.expiresAt).getTime() <= Date.now()) return '已过期';
  if (['failed', 'error', 'unavailable'].includes(String(account.healthStatus))) return '异常';
  if (account.status === 'active') return '可调度';
  if (account.status === 'disabled') return '已停用';
  return account.status || '未知';
}
function accountStatusClass(account: AnyRecord) {
  const label = accountStatusLabel(account);
  return label === '可调度' ? 'success' : ['异常', '已过期', '已删除'].includes(label) ? 'danger' : 'warning';
}
function profitClass(value: any) {
  if (value === null || value === undefined || value === '') return '';
  return Number(value) >= 0 ? 'positive' : 'negative';
}
function multiplierRange(account: AnyRecord, prefix: 'upstream' | 'selling') {
  const label = prefix === 'upstream' ? 'Upstream' : 'Selling';
  const minValue = account[`period${label}MultiplierMin`];
  const maxValue = account[`period${label}MultiplierMax`];
  if (minValue == null || maxValue == null) return '';
  const min = Number(minValue);
  const max = Number(maxValue);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return '';
  return Math.abs(min - max) < 0.0000001 ? `${min}x` : `${min}-${max}x`;
}
function coverageLabel(account: AnyRecord) {
  return ({
    complete: '成本已核算',
    configured: '倍率已配置',
    partial: '部分用量未定价',
    missing: '成本待补',
    pending: account.costMode === 'unconfigured' ? '未配置成本' : '暂无期间用量',
  } as Record<string, string>)[String(account.costCoverageStatus || '')] || '待核算';
}
function costBasisLabel(account: AnyRecord) {
  const costSource = String(account.multiplierCostSource || '');
  if (costSource === 'sub2api_account_multiplier') {
    const min = Number(account.sourceAccountMultiplierMin);
    const max = Number(account.sourceAccountMultiplierMax);
    const range = Number.isFinite(min) && Number.isFinite(max)
      ? Math.abs(min - max) < 0.0000001 ? `${min}x` : `${min}-${max}x`
      : '';
    return `Sub2API 账号倍率${range ? ` ${range}` : ''}`;
  }
  if (costSource === 'mixed_rate_snapshots') return '按倍率历史分段核算';
  if (account.costMode === 'fixed_purchase') return '完整采购实扣';
  if (account.costMode === 'free') return '免费资源';
  const upstream = multiplierRange(account, 'upstream')
    || (account.supplierKeyInventoryMultiplier != null ? `${account.supplierKeyInventoryMultiplier}x` : '')
    || (account.upstreamMultiplier != null ? `${account.upstreamMultiplier}x` : '');
  const selling = multiplierRange(account, 'selling');
  const sourceLabel = costSource === 'supplier_rate_snapshot'
    ? '供应商自动倍率'
    : costSource === 'manual_rate_snapshot'
    ? '手动倍率'
    : '进货倍率';
  if (upstream && selling) return `${sourceLabel} ${upstream} · 销售 ${selling}`;
  if (upstream) return `${sourceLabel} ${upstream}`;
  return coverageLabel(account);
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
    customEffectiveFrom: localDayStartInput(),
    tagsText: Array.isArray(account.tags) ? account.tags.join(',') : '',
  };
}

async function load() {
  const requestId = ++loadRequestId;
  loading.value = true;
  try {
    const params = query({
      ...rangeQuery(props.range, props.rangeStart, props.rangeEnd),
      page: page.value,
      page_size: pageSize.value,
      search: appliedFilters.value.search,
      platform: appliedFilters.value.platform,
      account_type: appliedFilters.value.accountType,
      status: appliedFilters.value.status,
      privacy_mode: appliedFilters.value.privacyMode,
      group_id: appliedFilters.value.groupId,
      supplier: appliedFilters.value.supplier,
      cost_mode: appliedFilters.value.costMode,
      sort_by: sortBy.value,
      sort_order: sortOrder.value,
    });
    const accountResult = await get(`/accounts?${params}`);
    if (requestId === loadRequestId) accounts.value = accountResult;
  } catch (error: any) {
    if (requestId === loadRequestId) notify(error.message);
  } finally {
    if (requestId === loadRequestId) loading.value = false;
  }
}

async function applyFilters() {
  window.clearTimeout(searchTimer);
  appliedFilters.value = { ...filters.value };
  page.value = 1;
  await load();
}

async function clearFilters() {
  window.clearTimeout(searchTimer);
  filters.value = emptyFilters();
  appliedFilters.value = emptyFilters();
  page.value = 1;
  await load();
}

function scheduleSearch() {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => { void applyFilters(); }, 300);
}

async function toggleSort(key: string) {
  if (sortBy.value === key) sortOrder.value = sortOrder.value === 'desc' ? 'asc' : 'desc';
  else {
    sortBy.value = key;
    sortOrder.value = 'desc';
  }
  page.value = 1;
  await load();
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
    const multiplierMode = ['manual_multiplier', 'probe_multiplier'].includes(current.costMode);
    const changeStrategy = multiplierMode ? current.changeStrategy : 'future_only';
    const customEffectiveFrom = changeStrategy === 'custom_time'
      ? new Date(current.customEffectiveFrom)
      : null;
    if (customEffectiveFrom && !Number.isFinite(customEffectiveFrom.getTime())) {
      throw new Error('请选择有效的开始计算日期和时间');
    }
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
      changeStrategy,
      effectiveFrom: customEffectiveFrom?.toISOString() || null,
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
    notify(current.id ? '采购成本已更新' : '采购成本已登记');
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

watch(() => props.refreshToken, () => {
  page.value = 1;
  load();
});
watch(() => [props.range, props.rangeStart, props.rangeEnd], () => {
  page.value = 1;
  load();
});
onMounted(() => {
  void load();
  void loadEditorOptions();
});
onUnmounted(() => window.clearTimeout(searchTimer));
</script>

<template>
  <div class="page-view account-cost-view">
    <div class="metric-grid account-cost-metrics">
      <div class="metric-card"><span>账号数量</span><strong>{{ summary.accountCount || 0 }}</strong><small><template v-if="summary.partialUsageSummary">当前页核算 {{ summary.summarizedAccountCount || rows.length }} 个 · </template>{{ summary.missingCostCount || 0 }} 个成本待核算</small></div>
      <div class="metric-card"><span>{{ metricScope }}已核算成本</span><strong>{{ money(summary.accountCostCny ?? summary.acquisitionCostCny) }}</strong><small>固定采购 {{ money(summary.fixedAcquisitionCostCny) }} · 倍率成本 {{ money(summary.multiplierCostCny) }}</small></div>
      <div class="metric-card"><span>{{ metricScope }}销售额</span><strong>{{ money(summary.userChargeCny) }}</strong><small>{{ compact(summary.requests) }} 次请求<template v-if="summary.unpricedUserChargeCny"> · 待核算销售额 {{ money(summary.unpricedUserChargeCny) }}</template></small></div>
      <div class="metric-card good"><span>{{ metricScope }}已核算收益</span><strong>{{ money(summary.profitCny) }}</strong><small>仅包含成本完整账号<template v-if="summary.unpricedUserChargeCny"> · {{ money(summary.unpricedUserChargeCny) }} 待核算</template></small></div>
    </div>

    <form class="panel account-cost-filterbar" @submit.prevent="applyFilters">
      <div class="account-search">
        <Search :size="17" />
        <input v-model="filters.search" placeholder="搜索账号..." aria-label="搜索账号" @input="scheduleSearch" />
      </div>
      <FilterSelect
        v-model="filters.platform"
        :options="platformOptions"
        ariaLabel="平台"
        search-placeholder="搜索平台..."
        @change="applyFilters"
      />
      <FilterSelect
        v-model="filters.accountType"
        :options="accountTypeOptions"
        ariaLabel="账号类型"
        search-placeholder="搜索账号类型..."
        @change="applyFilters"
      />
      <FilterSelect
        v-model="filters.status"
        :options="statusOptions"
        ariaLabel="账号状态"
        search-placeholder="搜索账号状态..."
        @change="applyFilters"
      />
      <FilterSelect
        v-model="filters.privacyMode"
        :options="privacyOptions"
        ariaLabel="Privacy状态"
        search-placeholder="搜索Privacy状态..."
        @change="applyFilters"
      />
      <FilterSelect
        v-model="filters.groupId"
        :options="groupOptions"
        ariaLabel="分组"
        search-placeholder="搜索分组..."
        @change="applyFilters"
      />
      <FilterSelect
        v-model="filters.costMode"
        :options="costTypeOptions"
        ariaLabel="成本类型"
        search-placeholder="搜索成本类型..."
        @change="applyFilters"
      />
      <FilterSelect
        v-model="filters.supplier"
        :options="supplierOptions"
        ariaLabel="供应商"
        search-placeholder="搜索供应商..."
        @change="applyFilters"
      />
      <div class="filter-actions">
        <button class="icon-button filter-submit" type="button" title="刷新" :disabled="loading" @click="load"><RefreshCw :size="16" :class="{ spin: loading }" /></button>
        <button class="icon-button" type="button" title="清空筛选" :disabled="loading" @click="clearFilters"><RotateCcw :size="15" /></button>
      </div>
    </form>

    <section class="panel table-panel">
      <div class="panel-head"><div><h2>账号采购与收益台账</h2><p>账号按采购或导入时间筛选；用户消耗、倍率成本和收益均按所选时间范围统计。固定采购成本一次确认，补发继续归属原订单。</p></div><WalletCards :size="20" class="head-icon" /></div>
      <div class="table-wrap"><table class="account-table"><thead><tr>
        <th><button class="column-sort" @click="toggleSort('name')">账号 <ChevronDown :size="13" /></button></th>
        <th>类型 / 状态</th>
        <th>供应商 / 订单</th>
        <th class="number"><button class="column-sort" @click="toggleSort('acquisitionCostCny')">账号成本 <ChevronDown :size="13" /></button></th>
        <th class="number"><button class="column-sort" @click="toggleSort('userChargeCny')">用户消耗 <ChevronDown :size="13" /></button></th>
        <th class="number"><button class="column-sort" @click="toggleSort('profitCny')">收益 <ChevronDown :size="13" /></button></th>
        <th class="number"><button class="column-sort" @click="toggleSort('requests')">Token / 请求 <ChevronDown :size="13" /></button></th>
        <th><button class="column-sort" @click="toggleSort('createdAt')">采购时间 <ChevronDown :size="13" /></button></th>
        <th><button class="column-sort" @click="toggleSort('expiresAt')">有效期 <ChevronDown :size="13" /></button></th>
        <th>操作</th>
      </tr></thead><tbody>
        <tr v-if="loading && !rows.length"><td colspan="10" class="table-empty">正在读取账号采购与收益数据</td></tr>
        <tr v-for="account in rows" :key="account.id">
          <td><strong>{{ account.externalAccountKey || account.name }}</strong><small>{{ account.name }}</small><small>Sub2API #{{ account.id }}</small></td>
          <td><span class="status-pill" :class="statusClass(account.costMode)">{{ accountTypeLabel(account) }}</span><small>{{ account.platform }}</small><span class="status-pill account-state" :class="accountStatusClass(account)">{{ accountStatusLabel(account) }}</span></td>
          <td><strong>{{ account.supplier || account.linkedSupplierName || '未关联供应商' }}</strong><small>{{ account.externalOrderId ? `OAuth #${account.externalOrderId}` : account.purchaseBatch || '未关联采购批次' }}</small><small v-if="account.repairCompletionSource">修复来源 {{ account.repairCompletionSource === 'system' ? '系统自动' : account.repairCompletionSource }}</small></td>
          <td class="number"><strong>{{ moneyOrDash(account.accountCostCny ?? account.acquisitionCostCny) }}</strong><small>{{ costBasisLabel(account) }}</small><small v-if="account.costMode === 'fixed_purchase' && account.originalPriceCny != null">原价 {{ money(account.originalPriceCny) }}</small><small v-if="account.costMode === 'fixed_purchase' && account.releasedCostCny">优惠 / 释放 {{ money(account.releasedCostCny) }}</small><small v-if="['missing','partial'].includes(account.costCoverageStatus)" class="error-text">{{ coverageLabel(account) }}<template v-if="account.unpricedUserChargeCny"> {{ money(account.unpricedUserChargeCny) }}</template></small><small v-else-if="account.costCoverageStatus === 'configured'" class="success-text">{{ coverageLabel(account) }}</small></td>
          <td class="number"><strong>{{ money(account.userChargeCny) }}</strong><small>筛选期间实际扣费</small></td>
          <td class="number" :class="profitClass(account.profitCny)"><strong>{{ moneyOrDash(account.profitCny) }}</strong><small>{{ account.grossMargin == null ? coverageLabel(account) : `${(Number(account.grossMargin) * 100).toFixed(1)}%` }}</small></td>
          <td class="number"><strong>{{ compact(account.tokens) }}</strong><small>{{ compact(account.requests) }} 次</small></td>
          <td>{{ dateTime(account.acquiredAt || account.createdAt) }}<small>{{ account.product || modeLabel(account.costMode) }}</small></td>
          <td>{{ dateTime(account.expiresAt) }}<small v-if="account.lastHealthAt">检查 {{ dateTime(account.lastHealthAt) }}</small><small v-else>未上报到期时间</small></td>
          <td><div class="row-actions"><template v-if="!isOAuthSupplyAccount(account)"><button class="icon-button mini-action" title="配置成本规则" @click="openEditor(account)"><Edit3 :size="15" /></button><button class="icon-button mini-action" title="登记采购成本" @click="openPeriodEditor(account)"><Plus :size="15" /></button></template><span v-else class="auto-ledger-label" title="成本由采购订单自动登记"><Link2 :size="14" />自动</span><button class="icon-button mini-action" title="查看成本历史" @click="openHistory(account)"><History :size="15" /></button></div></td>
        </tr>
        <tr v-if="!loading && !rows.length"><td colspan="10" class="table-empty">当前时间和筛选条件下没有账号</td></tr>
      </tbody></table></div>
      <div v-if="pages > 1" class="pager"><button class="small-button" :disabled="page <= 1" @click="page--; load()">上一页</button><span>第 {{ page }} / {{ pages }} 页，共 {{ accounts.total }} 个账号</span><button class="small-button" :disabled="page >= pages" @click="page++; load()">下一页</button></div>
    </section>

    <div v-if="editor" class="modal-layer" @click.self="editor = null"><section class="modal form-modal account-editor-modal"><header><div><h2>配置账号成本</h2><p>{{ editor.name }} · {{ editor.platform }}</p></div><button class="icon-button" @click="editor = null"><X :size="19" /></button></header>
      <div class="form-grid">
        <label>成本模式<select v-model="editor.costMode"><option value="probe_multiplier">供应商密钥倍率（自动）</option><option value="manual_multiplier">手动填写进货倍率</option><option value="fixed_purchase">固定采购成本</option><option value="free">免费资源</option></select></label>
        <label v-if="['manual_multiplier','probe_multiplier'].includes(editor.costMode)">变更范围<select v-model="editor.changeStrategy"><option value="future_only">仅未来用量</option><option value="current_day">从今天 0 点开始</option><option value="custom_time">自定义日期和时间</option></select></label>
        <label v-if="['manual_multiplier','probe_multiplier'].includes(editor.costMode) && editor.changeStrategy === 'custom_time'">开始计算时间<input v-model="editor.customEffectiveFrom" type="datetime-local" step="60" /></label>
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

    <div v-if="periodEditor" class="modal-layer nested-modal" @click.self="periodEditor = null"><section class="modal form-modal period-editor-modal"><header><div><h2>{{ periodEditor.id ? '编辑采购成本' : '登记采购成本' }}</h2><p>{{ periodEditor.account.name }} · 采购金额在生效开始时间一次确认</p></div><button class="icon-button" @click="periodEditor = null"><X :size="19" /></button></header>
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
      <div class="form-note">总成本 = 本金 + 手续费 + 税费。生效开始是采购成本确认时间，生效结束只表示账号服务覆盖期，不再用于线性摊销。</div>
      <footer><button class="secondary-button" @click="periodEditor = null">取消</button><button class="primary-button" :disabled="saving" @click="savePeriod"><Check :size="16" />保存采购成本</button></footer>
    </section></div>

    <div v-if="history" class="modal-layer nested-modal" @click.self="history = null"><section class="modal history-modal"><header><div><h2>账号成本历史</h2><p>{{ history.account.name }} · 规则和固定成本期间</p></div><button class="icon-button" @click="history = null"><X :size="19" /></button></header>
      <div class="detail-tabs"><button :class="{ active: history.tab === 'rules' }" @click="history.tab = 'rules'">计价规则</button><button :class="{ active: history.tab === 'periods' }" @click="history.tab = 'periods'">固定成本期间</button></div>
      <div v-if="history.loading" class="table-empty">正在读取历史</div>
      <div v-else-if="history.tab === 'rules'" class="table-wrap compact-table"><table><thead><tr><th>时间</th><th>类型</th><th>模式</th><th>倍率</th><th>状态</th><th>备注</th></tr></thead><tbody><tr v-for="item in history.rules?.items || []" :key="`${item.type}-${item.id || item.eventId}`"><td>{{ dateTime(item.occurredAt || item.cutoffAt) }}</td><td>{{ item.type || 'rule' }}</td><td>{{ modeLabel(item.costMode) }}</td><td>{{ item.upstreamMultiplier == null ? '--' : `${item.upstreamMultiplier}x` }}</td><td>{{ item.status || '--' }}</td><td>{{ item.notes || '--' }}</td></tr><tr v-if="!history.rules?.items?.length"><td colspan="6" class="table-empty">暂无计价版本</td></tr></tbody></table></div>
      <div v-else class="table-wrap compact-table"><table><thead><tr><th>时间</th><th class="number">总成本</th><th>生效期间</th><th>供应商</th><th>采购批次</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="item in history.periods?.items || []" :key="item.id"><td>{{ dateTime(item.createdAt || item.effectiveFrom) }}</td><td class="number">{{ money(item.totalCost ?? (Number(item.baseAmount || item.originalAmount || 0) + Number(item.feeAmount || 0) + Number(item.taxAmount || 0))) }}</td><td>{{ dateTime(item.effectiveFrom) }}<small>至 {{ dateTime(item.effectiveTo) }}</small></td><td>{{ item.supplier || '--' }}</td><td>{{ item.purchaseBatch || '--' }}</td><td>{{ item.status || '--' }}</td><td><button class="small-button" @click="openPeriodEditor(history.account, item)"><Edit3 :size="14" />编辑</button></td></tr><tr v-if="!history.periods?.items?.length"><td colspan="7" class="table-empty">暂无固定成本期间</td></tr></tbody></table></div>
    </section></div>
  </div>
</template>
