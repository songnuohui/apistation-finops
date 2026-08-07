<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { Activity, ArrowDownUp, Check, CheckSquare, ChevronDown, ChevronUp, ExternalLink, KeyRound, Pencil, RefreshCw, Search, Square, Trash2, X } from 'lucide-vue-next';
import { get, query, send } from '../api';

type AnyRecord = Record<string, any>;
const props = defineProps<{ refreshToken?: number }>();
const emit = defineEmits<{ toast: [message: string] }>();

const search = ref('');
const supplier = ref('');
const platform = ref('');
const page = ref(1);
const pageSize = ref(20);
const sortBy = ref('last_check_at');
const sortOrder = ref('desc');
const loading = ref(false);
const data = ref<AnyRecord>({ items: [], total: 0, pageSize: 20, suppliers: [], platforms: [] });
const detail = ref<AnyRecord | null>(null);
const detailLoading = ref(false);
const deleting = ref<number | null>(null);
const selectedKeyIds = ref<number[]>([]);
const keyBatchEditor = ref<AnyRecord | null>(null);
const keyBatchSaving = ref(false);
const selectedAccountIds = ref<number[]>([]);
const batchEditor = ref<AnyRecord | null>(null);
const batchSaving = ref(false);
const accountGroups = ref<AnyRecord | null>(null);
const accountGroupsLoading = ref(false);
let timer: number | undefined;

const rows = computed(() => data.value.items || []);
const suppliers = computed(() => data.value.suppliers || []);
const platforms = computed(() => data.value.platforms || []);
const total = computed(() => Number(data.value.total || 0));
const pages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
const selectedKeyCount = computed(() => selectedKeyIds.value.length);
const allKeysSelected = computed(() => Boolean(rows.value.length)
  && rows.value.every((item: AnyRecord) => selectedKeyIds.value.includes(Number(item.id))));
const selectedCount = computed(() => selectedAccountIds.value.length);
const allSelected = computed(() => {
  const accounts = detail.value?.accounts || [];
  return Boolean(accounts.length)
    && accounts.every((item: AnyRecord) => selectedAccountIds.value.includes(Number(item.id)));
});
const selectedEnabledCount = computed(() => (detail.value?.accounts || [])
  .filter((item: AnyRecord) => selectedAccountIds.value.includes(Number(item.id)) && item.profitGuard?.enabled).length);
const batchMinimumSaleMultiplier = computed(() => {
  const current = batchEditor.value;
  if (!current || current.thresholdMode !== 'margin') return null;
  const upstream = Number(detail.value?.key?.rateMultiplier);
  const margin = Number(current.minimumMarginPercent) / 100;
  if (!Number.isFinite(upstream) || !Number.isFinite(margin) || upstream < 0 || margin < 0 || margin >= 1) return null;
  return upstream / (1 - margin);
});
const keyBatchMinimumSaleMultiplier = computed(() => {
  const current = keyBatchEditor.value;
  if (!current || current.thresholdMode !== 'margin') return null;
  const upstream = Number(current.upstreamMultiplier);
  const margin = Number(current.minimumMarginPercent) / 100;
  if (!Number.isFinite(upstream) || !Number.isFinite(margin) || upstream < 0 || margin < 0 || margin >= 1) return null;
  return upstream / (1 - margin);
});

function notify(message: string) { emit('toast', message); }
function dateTime(value: any) {
  if (!value) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}
function multiplier(value: any) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${parsed.toFixed(4).replace(/\.?0+$/, '')}x` : '--';
}
function compactNumber(value: any) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return '0';
  return parsed >= 1_000_000
    ? `${(parsed / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
    : parsed >= 1_000
      ? `${(parsed / 1_000).toFixed(1).replace(/\.0$/, '')}K`
      : parsed.toLocaleString('zh-CN');
}
function amountCny(value: any) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? `¥${parsed.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '¥0.00';
}
function percentText(value: any) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${(parsed * 100).toFixed(1).replace(/\.0$/, '')}%` : '--';
}
function profitRangeText(row: AnyRecord) {
  if (Number(row.targetMarginVariantCount || 0) > 1) return '混合配置';
  if (row.targetMarginMinMin !== null && row.targetMarginMinMin !== undefined
    && row.targetMarginMaxMax !== null && row.targetMarginMaxMax !== undefined) {
    return `${percentText(row.targetMarginMinMin)} - ${percentText(row.targetMarginMaxMax)}`;
  }
  return row.accountCount ? '未启用自动归组' : '未配置';
}
function minimumMarginText(row: AnyRecord) {
  if (Number(row.thresholdModeVariantCount || 0) > 1) return '混合配置';
  if (row.profitGuardThresholdMode === 'minimum_sale_multiplier') return '成本倍率触发';
  if (Number(row.minimumMarginVariantCount || 0) > 1) return '混合配置';
  if (row.minimumMarginMin !== null && row.minimumMarginMin !== undefined) {
    return `≥ ${percentText(row.minimumMarginMin)}`;
  }
  return row.accountCount ? '未配置' : '--';
}
function quota(row: AnyRecord) {
  if (row.quotaRemaining !== null && row.quotaRemaining !== undefined) {
    return `${Number(row.quotaRemaining).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${row.quotaCurrency || ''}`;
  }
  return '--';
}
function supplierBalance(row: AnyRecord) {
  const value = row.supplierBalance !== null && row.supplierBalance !== undefined
    ? row.supplierBalance
    : row.quotaRemaining;
  const currency = row.supplierBalance !== null && row.supplierBalance !== undefined
    ? row.supplierBalanceCurrency
    : row.quotaCurrency;
  if (value === null || value === undefined) return '--';
  return `${Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${currency || ''}`.trim();
}
function platformText(value: any) {
  const normalized = String(value || '').trim().toLowerCase();
  return ({ openai: 'OpenAI', anthropic: 'Claude', 'claude code': 'Claude Code', gemini: 'Gemini', google: 'Google' } as AnyRecord)[normalized] || value || '未识别';
}
function statusClass(value: any) {
  const normalized = String(value || '').toLowerCase();
  if (['active', 'ok', 'success', 'resolved'].includes(normalized)) return 'success';
  if (['failed', 'error', 'removed'].includes(normalized)) return 'danger';
  return 'warning';
}
function statusLabel(value: any) {
  return ({
    active: '可用', ok: '正常', failed: '失败', pending: '待检查', removed: '已移除', warning: '需关注',
  } as AnyRecord)[String(value || '').toLowerCase()] || String(value || '--');
}
function marginText(policy: AnyRecord | null) {
  if (!policy) return '未配置';
  const min = policy.targetMarginMin === null || policy.targetMarginMin === undefined ? null : Number(policy.targetMarginMin) * 100;
  const max = policy.targetMarginMax === null || policy.targetMarginMax === undefined ? null : Number(policy.targetMarginMax) * 100;
  if (policy.autoAssignEnabled && min !== null && max !== null) return `自动归组 ${min.toFixed(1)}% - ${max.toFixed(1)}%`;
  return policy.enabled ? `保护 ${Number(policy.minimumMargin || 0) * 100}%` : '已关闭';
}
function policySeed(account: AnyRecord | null) {
  const policy = account?.profitGuard || {};
  return {
    enabled: Boolean(policy.enabled),
    thresholdMode: policy.thresholdMode || 'margin',
    minimumMarginPercent: Number(policy.minimumMargin || 0) * 100,
    minimumSaleMultiplier: policy.minimumSaleMultiplier ?? '',
    allowEmptyGroups: policy.allowEmptyGroups ?? true,
    autoAssignEnabled: Boolean(policy.autoAssignEnabled),
    targetMarginMinPercent: policy.targetMarginMin === null || policy.targetMarginMin === undefined ? '' : Number(policy.targetMarginMin) * 100,
    targetMarginMaxPercent: policy.targetMarginMax === null || policy.targetMarginMax === undefined ? '' : Number(policy.targetMarginMax) * 100,
  };
}

async function load() {
  loading.value = true;
  try {
    const result = await get(`/supplier-keys?${query({
      search: search.value, supplier: supplier.value, platform: platform.value, status: 'active',
      sort_by: sortBy.value, sort_order: sortOrder.value,
      page: page.value, page_size: pageSize.value,
    })}`);
    data.value = result;
    if (page.value > Math.max(1, Math.ceil(Number(result.total || 0) / pageSize.value))) {
      page.value = 1;
      await load();
    }
  } catch (error: any) { notify(error.message); }
  finally { loading.value = false; }
}
function sortColumn(column: string) {
  if (sortBy.value === column) sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc';
  else {
    sortBy.value = column;
    sortOrder.value = 'asc';
  }
  page.value = 1;
  load();
}
function sortIcon(column: string) {
  if (sortBy.value !== column) return ArrowDownUp;
  return sortOrder.value === 'asc' ? ChevronUp : ChevronDown;
}
function toggleKey(id: number) {
  const normalized = Number(id);
  selectedKeyIds.value = selectedKeyIds.value.includes(normalized)
    ? selectedKeyIds.value.filter((item) => item !== normalized)
    : [...selectedKeyIds.value, normalized];
}
function toggleAllKeys() {
  const currentIds = rows.value.map((item: AnyRecord) => Number(item.id));
  if (allKeysSelected.value) {
    selectedKeyIds.value = selectedKeyIds.value.filter((id) => !currentIds.includes(id));
  } else {
    selectedKeyIds.value = [...new Set([...selectedKeyIds.value, ...currentIds])];
  }
}
function keyPolicySeed(row: AnyRecord | null) {
  return {
    enabled: Boolean(row?.profitGuardAccountCount),
    thresholdMode: row?.profitGuardThresholdMode || 'margin',
    minimumMarginPercent: row?.minimumMarginMin === null || row?.minimumMarginMin === undefined ? 30 : Number(row.minimumMarginMin) * 100,
    minimumSaleMultiplier: '',
    allowEmptyGroups: true,
    autoAssignEnabled: Boolean(row?.targetMarginVariantCount),
    targetMarginMinPercent: row?.targetMarginMinMin === null || row?.targetMarginMinMin === undefined ? 20 : Number(row.targetMarginMinMin) * 100,
    targetMarginMaxPercent: row?.targetMarginMaxMax === null || row?.targetMarginMaxMax === undefined ? 40 : Number(row.targetMarginMaxMax) * 100,
    upstreamMultiplier: row?.rateMultiplier,
  };
}
function openKeyBatchEditor() {
  if (!selectedKeyCount.value) {
    notify('请先选择需要统一配置的供应商密钥');
    return;
  }
  const first = rows.value.find((item: AnyRecord) => selectedKeyIds.value.includes(Number(item.id)));
  keyBatchEditor.value = keyPolicySeed(first || null);
}
async function saveKeyBatchProfitGuard() {
  if (!keyBatchEditor.value || !selectedKeyCount.value) return;
  const current = keyBatchEditor.value;
  keyBatchSaving.value = true;
  try {
    const result = await send('/supplier-keys/profit-guard', 'PATCH', {
      keyIds: selectedKeyIds.value,
      enabled: Boolean(current.enabled),
      thresholdMode: current.thresholdMode,
      minimumMargin: Number(current.minimumMarginPercent || 0) / 100,
      minimumSaleMultiplier: current.thresholdMode === 'minimum_sale_multiplier' ? Number(current.minimumSaleMultiplier) : null,
      allowEmptyGroups: Boolean(current.allowEmptyGroups),
      autoAssignEnabled: Boolean(current.autoAssignEnabled),
      targetMarginMin: current.autoAssignEnabled && current.targetMarginMinPercent !== '' ? Number(current.targetMarginMinPercent) / 100 : null,
      targetMarginMax: current.autoAssignEnabled && current.targetMarginMaxPercent !== '' ? Number(current.targetMarginMaxPercent) / 100 : null,
    });
    notify(`已为 ${result.keyIds?.length || selectedKeyCount.value} 个密钥统一保存利润控制，覆盖 ${result.updated || 0} 个关联账号${result.evaluation?.changed ? `，已调整 ${result.evaluation.changed} 个账号的分组` : ''}`);
    keyBatchEditor.value = null;
    selectedKeyIds.value = [];
    await load();
  } catch (error: any) { notify(error.message); }
  finally { keyBatchSaving.value = false; }
}
async function openDetails(id: number) {
  detailLoading.value = true;
  selectedAccountIds.value = [];
  try {
    detail.value = await get(`/supplier-keys/${id}/details`);
    return detail.value;
  } catch (error: any) {
    notify(error.message);
    return null;
  }
  finally { detailLoading.value = false; }
}
function openConnection(id: number) {
  window.history.pushState({}, '', `/suppliers?connection=${id}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
function toggleAccount(id: number) {
  const normalized = Number(id);
  selectedAccountIds.value = selectedAccountIds.value.includes(normalized)
    ? selectedAccountIds.value.filter((item) => item !== normalized)
    : [...selectedAccountIds.value, normalized];
}
function toggleAllAccounts() {
  selectedAccountIds.value = allSelected.value
    ? []
    : (detail.value?.accounts || []).map((item: AnyRecord) => Number(item.id));
}
function openBatchEditor() {
  if (!selectedCount.value || !detail.value) {
    notify('请先选择需要批量配置的关联账号');
    return;
  }
  const first = detail.value.accounts.find((item: AnyRecord) => Number(item.id) === selectedAccountIds.value[0]);
  batchEditor.value = policySeed(first || null);
}
async function openProfitEditor(id: number) {
  const loaded = await openDetails(id);
  const accountIds = (loaded?.accounts || []).map((item: AnyRecord) => Number(item.id));
  if (!accountIds.length) {
    notify('当前密钥没有关联账号，无法修改利润控制');
    return;
  }
  selectedAccountIds.value = accountIds;
  openBatchEditor();
}
async function saveBatchProfitGuard() {
  if (!detail.value || !batchEditor.value || !selectedCount.value) return;
  const current = batchEditor.value;
  batchSaving.value = true;
  try {
    const result = await send(`/supplier-keys/${detail.value.key.id}/profit-guard`, 'PATCH', {
      accountIds: selectedAccountIds.value,
      enabled: Boolean(current.enabled),
      thresholdMode: current.thresholdMode,
      minimumMargin: Number(current.minimumMarginPercent || 0) / 100,
      minimumSaleMultiplier: current.thresholdMode === 'minimum_sale_multiplier' ? Number(current.minimumSaleMultiplier) : null,
      allowEmptyGroups: Boolean(current.allowEmptyGroups),
      autoAssignEnabled: Boolean(current.autoAssignEnabled),
      targetMarginMin: current.autoAssignEnabled && current.targetMarginMinPercent !== '' ? Number(current.targetMarginMinPercent) / 100 : null,
      targetMarginMax: current.autoAssignEnabled && current.targetMarginMaxPercent !== '' ? Number(current.targetMarginMaxPercent) / 100 : null,
    });
    notify(`已为 ${result.updated || selectedCount.value} 个账号保存利润控制${result.evaluation?.changed ? `，已执行 ${result.evaluation.changed} 个账号的分组调整` : ''}`);
    batchEditor.value = null;
    selectedAccountIds.value = [];
    await openDetails(Number(detail.value.key.id));
    await load();
  } catch (error: any) { notify(error.message); }
  finally { batchSaving.value = false; }
}
async function openAccountGroups(account: AnyRecord) {
  if (!detail.value) return;
  accountGroupsLoading.value = true;
  try {
    accountGroups.value = await get(`/supplier-keys/${detail.value.key.id}/accounts/${account.id}/groups`);
  } catch (error: any) { notify(error.message); }
  finally { accountGroupsLoading.value = false; }
}
async function deleteKey(row: AnyRecord) {
  const label = row.name || row.maskedKey || row.id;
  if (!window.confirm(`确定删除供应商密钥“${label}”吗？关联的 Sub2API 账号也会通过管理接口删除。`)) return;
  deleting.value = Number(row.id);
  try {
    const result = await send(`/supplier-keys/${row.id}`, 'DELETE', {});
    notify(`密钥已删除，已处理 ${result.deletedAccounts?.length || 0} 个关联账号`);
    detail.value = null;
    await load();
  } catch (error: any) { notify(error.message); }
  finally { deleting.value = null; }
}
function movePage(delta: number) {
  page.value = Math.min(pages.value, Math.max(1, page.value + delta));
  load();
}
function changePageSize() {
  page.value = 1;
  load();
}

watch(() => props.refreshToken, () => load());
watch(search, () => {
  window.clearTimeout(timer);
  page.value = 1;
  timer = window.setTimeout(load, 250);
});
watch(supplier, () => { page.value = 1; load(); });
watch(platform, () => { page.value = 1; load(); });
onMounted(load);
</script>

<template>
  <div class="page-view supplier-view">
    <div class="toolbar-row">
      <label class="search-box"><Search :size="17" /><input v-model="search" placeholder="搜索供应商、密钥名称、连接或地址" /></label>
      <select v-model="supplier" class="toolbar-select"><option value="">全部供应商</option><option v-for="item in suppliers" :key="item" :value="item">{{ item }}</option></select>
      <select v-model="platform" class="toolbar-select"><option value="">全部平台</option><option v-for="item in platforms" :key="item" :value="item">{{ platformText(item) }}</option></select>
      <button class="secondary-button" :disabled="!selectedKeyCount" @click="openKeyBatchEditor"><CheckSquare :size="16" />统一配置<span v-if="selectedKeyCount">（{{ selectedKeyCount }}）</span></button>
      <select v-model.number="pageSize" class="toolbar-select" @change="changePageSize"><option :value="20">20 条/页</option><option :value="50">50 条/页</option><option :value="100">100 条/页</option></select>
      <button class="icon-button" title="刷新密钥列表" aria-label="刷新密钥列表" @click="load"><RefreshCw :size="17" :class="{ spin: loading }" /></button>
      <span class="loading-note" v-if="loading"><RefreshCw :size="15" class="spin" />更新中</span>
    </div>
    <section class="panel table-panel">
      <div class="panel-head"><div><h2>上游供应商密钥</h2><p>支持供应商筛选、分页查看、关联账号分组详情和批量利润控制。</p></div><KeyRound :size="20" class="head-icon" /></div>
      <div class="table-wrap">
        <table class="supplier-key-table">
          <thead><tr>
            <th><button class="icon-button mini-action" title="全选当前页" aria-label="全选当前页" @click="toggleAllKeys"><CheckSquare v-if="allKeysSelected" :size="16" /><Square v-else :size="16" /></button></th>
            <th><button class="sort-button" @click="sortColumn('name')">密钥 <component :is="sortIcon('name')" :size="14" /></button></th>
            <th><button class="sort-button" @click="sortColumn('supplier')">供应商 / 余额 <component :is="sortIcon('supplier')" :size="14" /></button></th>
            <th><button class="sort-button" @click="sortColumn('base_url')">上游地址 <component :is="sortIcon('base_url')" :size="14" /></button></th>
            <th><button class="sort-button" @click="sortColumn('platform')">平台 <component :is="sortIcon('platform')" :size="14" /></button></th>
            <th><button class="sort-button" @click="sortColumn('rate_multiplier')">倍率 <component :is="sortIcon('rate_multiplier')" :size="14" /></button></th>
            <th><button class="sort-button" @click="sortColumn('profit_range')">利润控制区间 <component :is="sortIcon('profit_range')" :size="14" /></button></th>
            <th><button class="sort-button" @click="sortColumn('minimum_margin')">最低毛利率控制 <component :is="sortIcon('minimum_margin')" :size="14" /></button></th>
            <th><button class="sort-button" @click="sortColumn('status')">状态 <component :is="sortIcon('status')" :size="14" /></button></th>
            <th><button class="sort-button" @click="sortColumn('usage_amount')">使用量 <component :is="sortIcon('usage_amount')" :size="14" /></button></th>
            <th><button class="sort-button" @click="sortColumn('account_count')">关联账号个数 <component :is="sortIcon('account_count')" :size="14" /></button></th>
            <th><button class="sort-button" @click="sortColumn('last_check_at')">最近同步时间 <component :is="sortIcon('last_check_at')" :size="14" /></button></th>
            <th>操作</th>
          </tr></thead>
          <tbody>
            <tr v-if="loading && !rows.length"><td colspan="13" class="table-empty">正在读取供应商密钥</td></tr>
            <tr v-for="row in rows" :key="row.id">
              <td><input type="checkbox" :checked="selectedKeyIds.includes(Number(row.id))" @change="toggleKey(row.id)" /></td>
              <td class="key-name-cell"><strong>{{ row.name || row.maskedKey || `密钥 #${row.id}` }}</strong><small>{{ row.maskedKey || row.externalId || '--' }}</small></td>
              <td class="supplier-cell"><strong>{{ row.supplierName || '--' }}</strong><small>{{ row.connectionName || '--' }} · 余额 {{ supplierBalance(row) }}</small></td>
              <td class="supplier-address"><span class="supplier-cell-text" :title="row.baseUrl">{{ row.baseUrl || '--' }}</span></td>
              <td class="platform-cell"><span class="status-pill">{{ platformText(row.platform) }}</span><small>{{ row.groupName || '未分组' }}</small></td>
              <td class="multiplier-cell"><strong>{{ multiplier(row.rateMultiplier) }}</strong><small>{{ row.groupName || '未分组' }}</small></td>
              <td class="profit-range-cell"><strong>{{ profitRangeText(row) }}</strong><small>{{ row.profitGuardAccountCount ? `${row.profitGuardAccountCount} 个账号已启用自动控制` : '未配置自动归组' }}</small></td>
              <td class="minimum-margin-cell"><strong>{{ minimumMarginText(row) }}</strong><small>{{ row.profitGuardAccountCount ? `${row.profitGuardAccountCount} 个账号已启用` : '未配置' }}</small></td>
              <td class="status-cell"><span class="status-pill" :class="statusClass(row.status)">{{ statusLabel(row.status) }}</span><small><span class="status-pill" :class="statusClass(row.lastCheckStatus)">{{ statusLabel(row.lastCheckStatus) }}</span></small></td>
              <td class="usage-cell"><strong>{{ amountCny(row.usageAmountCny) }}</strong><small>累计消费金额</small></td>
              <td class="account-count-cell"><button class="link-button account-count-button" @click="openDetails(row.id)"><strong>{{ row.accountCount }} 个</strong></button><small>{{ row.profitGuardAccountCount }} 个已启用利润控制</small></td>
              <td class="sync-cell">{{ dateTime(row.lastCheckAt) }}</td>
              <td><div class="row-actions supplier-row-actions"><button class="icon-button mini-action" title="查看详情" aria-label="查看详情" @click="openDetails(row.id)"><Activity :size="16" /></button><button class="icon-button mini-action" title="修改相关利润" aria-label="修改相关利润" @click="openProfitEditor(row.id)"><Pencil :size="16" /></button><button class="icon-button mini-action danger-action" title="删除密钥" aria-label="删除密钥" :disabled="deleting === row.id" @click="deleteKey(row)"><Trash2 :size="16" /></button></div></td>
            </tr>
            <tr v-if="!loading && !rows.length"><td colspan="13" class="table-empty">没有找到供应商密钥</td></tr>
          </tbody>
        </table>
      </div>
      <div v-if="total > pageSize" class="pager"><button class="small-button" :disabled="page <= 1" @click="movePage(-1)">上一页</button><span>第 {{ page }} 页，共 {{ total }} 个密钥</span><button class="small-button" :disabled="page >= pages" @click="movePage(1)">下一页</button></div>
    </section>

    <div v-if="detail || detailLoading" class="modal-layer" @click.self="detail = null">
      <section class="modal supplier-detail-modal">
        <header><div><h2>{{ detail?.key?.name || detail?.key?.maskedKey || '供应商密钥详情' }}</h2><p v-if="detail">{{ detail.key.supplierName }} · {{ detail.key.connectionName }} · {{ detail.key.baseUrl }}</p></div><button class="icon-button" @click="detail = null"><X :size="19" /></button></header>
        <div v-if="detailLoading && !detail" class="table-empty">正在读取密钥详情</div>
        <template v-else-if="detail">
          <div class="supplier-metrics"><div><span>上游倍率</span><strong>{{ multiplier(detail.key.rateMultiplier) }}</strong><small>{{ detail.key.groupName || '未分组' }}</small></div><div><span>额度剩余</span><strong>{{ quota(detail.key) }}</strong><small>{{ detail.key.expiresAt ? `到期 ${dateTime(detail.key.expiresAt)}` : '无到期信息' }}</small></div><div><span>关联账号</span><strong>{{ detail.accounts.length }}</strong><small>{{ selectedEnabledCount }} 个已选账号已启用利润控制</small></div><div><span>最近巡检</span><strong>{{ statusLabel(detail.key.lastCheckStatus) }}</strong><small>{{ dateTime(detail.key.lastCheckAt) }}</small></div></div>
          <div class="detail-actionbar"><div><span class="status-pill" :class="statusClass(detail.key.status)">{{ statusLabel(detail.key.status) }}</span></div><div class="row-actions"><button class="secondary-button" @click="openConnection(detail.key.connectionId)"><ExternalLink :size="16" />打开供应商连接</button><button class="secondary-button" :disabled="!selectedCount" @click="openBatchEditor"><CheckSquare :size="16" />批量利润控制（{{ selectedCount }}）</button><button class="secondary-button danger-action" @click="deleteKey(detail.key)"><Trash2 :size="16" />删除密钥</button></div></div>
          <section class="detail-section"><div class="detail-section-head"><div><h3>关联账号、所有分组与利润控制</h3><p>点击账号名称查看该账号当前所有分组和销售倍率；勾选多个账号可统一配置利润保护和自动归组。</p></div></div><div class="table-wrap compact-table"><table><thead><tr><th><button class="icon-button mini-action" title="全选关联账号" @click="toggleAllAccounts"><CheckSquare v-if="allSelected" :size="16" /><Square v-else :size="16" /></button></th><th>系统账号</th><th>平台</th><th>状态</th><th>利润控制 / 自动归组</th><th>操作</th></tr></thead><tbody><tr v-for="account in detail.accounts" :key="account.id"><td><input type="checkbox" :checked="selectedAccountIds.includes(Number(account.id))" @change="toggleAccount(account.id)" /></td><td><button class="link-button" @click="openAccountGroups(account)">{{ account.name || `账号 #${account.id}` }}</button><small>ID {{ account.id }}</small></td><td>{{ account.platform || '--' }}</td><td><span class="status-pill" :class="statusClass(account.status)">{{ account.status || '--' }}</span></td><td><span :class="{ 'profit-guard-on': account.profitGuard?.enabled }">{{ marginText(account.profitGuard) }}</span><small v-if="account.profitGuard?.lastError" class="error-text">{{ account.profitGuard.lastError }}</small></td><td><button class="small-button" @click="openAccountGroups(account)">查看分组</button></td></tr><tr v-if="!detail.accounts.length"><td colspan="6" class="table-empty">当前没有关联账号</td></tr></tbody></table></div></section>
          <section class="detail-section"><div class="detail-section-head"><div><h3>巡检记录</h3></div></div><div class="table-wrap compact-table"><table><thead><tr><th>时间</th><th>结果</th><th>方式</th><th>HTTP</th><th>错误</th></tr></thead><tbody><tr v-for="item in detail.checks" :key="item.id"><td>{{ dateTime(item.checkedAt) }}</td><td><span class="status-pill" :class="statusClass(item.status)">{{ statusLabel(item.status) }}</span></td><td>{{ item.method || '--' }}</td><td>{{ item.httpStatus || '--' }}</td><td>{{ item.errorMessage || item.errorCode || '--' }}</td></tr><tr v-if="!detail.checks.length"><td colspan="5" class="table-empty">暂无巡检记录</td></tr></tbody></table></div></section>
          <section v-if="detail.alerts.length" class="detail-section"><div class="detail-section-head"><div><h3>相关告警</h3></div></div><div class="alert-detail-list"><article v-for="alert in detail.alerts" :key="alert.id" :class="['alert-detail', alert.severity]"><div><strong>{{ alert.title }}</strong><p>{{ alert.message }}</p><small>{{ dateTime(alert.lastSeenAt) }} · {{ alert.status }}</small></div></article></div></section>
        </template>
      </section>
    </div>

    <div v-if="accountGroups || accountGroupsLoading" class="modal-layer nested-modal" @click.self="accountGroups = null"><section class="modal form-modal"><header><div><h2>{{ accountGroups?.account?.name || '账号分组详情' }}</h2><p v-if="accountGroups">平台：{{ accountGroups.account.platform || '--' }} · ID {{ accountGroups.account.id }}</p></div><button class="icon-button" @click="accountGroups = null"><X :size="19" /></button></header><div v-if="accountGroupsLoading && !accountGroups" class="table-empty">正在读取账号分组</div><template v-else-if="accountGroups"><div class="table-wrap compact-table"><table><thead><tr><th>分组</th><th>平台</th><th>销售倍率</th><th>状态</th></tr></thead><tbody><tr v-for="group in accountGroups.groups" :key="group.id"><td><strong>{{ group.name || `分组 #${group.id}` }}</strong><small>ID {{ group.id }}</small></td><td>{{ group.platform || '--' }}</td><td class="number">{{ multiplier(group.rateMultiplier) }}</td><td><span class="status-pill" :class="statusClass(group.status)">{{ group.status || '--' }}</span></td></tr><tr v-if="!accountGroups.groups.length"><td colspan="4" class="table-empty">该账号当前没有分组</td></tr></tbody></table></div></template></section></div>

    <div v-if="keyBatchEditor" class="modal-layer nested-modal" @click.self="keyBatchEditor = null"><section class="modal form-modal profit-guard-modal"><header><div><h2>统一配置密钥利润控制</h2><p>已选择 {{ selectedKeyCount }} 个供应商密钥，保存后覆盖它们关联账号的策略。</p></div><button class="icon-button" @click="keyBatchEditor = null"><X :size="19" /></button></header><div class="form-grid"><label class="toggle-field full-field"><input v-model="keyBatchEditor.enabled" type="checkbox" /><span><strong>启用利润保护</strong><small>上游成本上涨后，自动移除亏损的销售分组。</small></span></label><label>保护方式<select v-model="keyBatchEditor.thresholdMode" :disabled="!keyBatchEditor.enabled"><option value="margin">最低毛利率</option><option value="minimum_sale_multiplier">上游成本触发倍率</option></select></label><label v-if="keyBatchEditor.thresholdMode === 'margin'">最低毛利率 (%)<input v-model="keyBatchEditor.minimumMarginPercent" type="number" min="0" max="99.99" step="0.1" :disabled="!keyBatchEditor.enabled" /></label><label v-else>成本触发倍率<input v-model="keyBatchEditor.minimumSaleMultiplier" type="number" min="0" step="0.0001" :disabled="!keyBatchEditor.enabled" /></label><label class="toggle-field full-field"><input v-model="keyBatchEditor.allowEmptyGroups" type="checkbox" :disabled="!keyBatchEditor.enabled" /><span><strong>允许移出最后一个分组</strong><small>关闭后只告警，不会让账号失去最后一个销售分组。</small></span></label><label class="toggle-field full-field"><input v-model="keyBatchEditor.autoAssignEnabled" type="checkbox" :disabled="!keyBatchEditor.enabled" /><span><strong>启用自动归组</strong><small>只绑定平台一致、销售毛利率位于区间内的分组。</small></span></label><label v-if="keyBatchEditor.autoAssignEnabled">目标毛利率下限 (%)<input v-model="keyBatchEditor.targetMarginMinPercent" type="number" min="0" max="100" step="0.1" :disabled="!keyBatchEditor.enabled" /></label><label v-if="keyBatchEditor.autoAssignEnabled">目标毛利率上限 (%)<input v-model="keyBatchEditor.targetMarginMaxPercent" type="number" min="0" max="100" step="0.1" :disabled="!keyBatchEditor.enabled" /></label></div><div v-if="keyBatchEditor.thresholdMode === 'margin'" class="form-note">以首个已选密钥的当前上游倍率 {{ keyBatchEditor.upstreamMultiplier == null ? '--' : multiplier(keyBatchEditor.upstreamMultiplier) }} 作为参考，最低售卖倍率约为 <strong>{{ keyBatchMinimumSaleMultiplier === null ? '--' : multiplier(keyBatchMinimumSaleMultiplier) }}</strong>。实际评估会按每个密钥的成本分别执行。</div><footer><button class="secondary-button" @click="keyBatchEditor = null">取消</button><button class="primary-button" :disabled="keyBatchSaving" @click="saveKeyBatchProfitGuard"><Check :size="16" />保存统一配置</button></footer></section></div>

    <div v-if="batchEditor" class="modal-layer nested-modal" @click.self="batchEditor = null"><section class="modal form-modal profit-guard-modal"><header><div><h2>批量利润控制与自动归组</h2><p>已选择 {{ selectedCount }} 个账号，保存后覆盖这些账号的利润策略。</p></div><button class="icon-button" @click="batchEditor = null"><X :size="19" /></button></header><div class="form-grid"><label class="toggle-field full-field"><input v-model="batchEditor.enabled" type="checkbox" /><span><strong>启用利润保护</strong><small>自动移除亏损销售分组。</small></span></label><label>保护方式<select v-model="batchEditor.thresholdMode" :disabled="!batchEditor.enabled"><option value="margin">最低毛利率</option><option value="minimum_sale_multiplier">上游成本触发倍率</option></select></label><label v-if="batchEditor.thresholdMode === 'margin'">最低毛利率 (%)<input v-model="batchEditor.minimumMarginPercent" type="number" min="0" max="99.99" step="0.1" :disabled="!batchEditor.enabled" /></label><label v-else>成本触发倍率<input v-model="batchEditor.minimumSaleMultiplier" type="number" min="0" step="0.0001" :disabled="!batchEditor.enabled" /></label><label class="toggle-field full-field"><input v-model="batchEditor.allowEmptyGroups" type="checkbox" :disabled="!batchEditor.enabled" /><span><strong>允许移出最后一个分组</strong><small>关闭后只告警，不会让账号失去最后一个销售分组。</small></span></label><label class="toggle-field full-field"><input v-model="batchEditor.autoAssignEnabled" type="checkbox" :disabled="!batchEditor.enabled" /><span><strong>启用自动归组</strong><small>只绑定平台一致、销售毛利率位于区间内的分组。</small></span></label><label v-if="batchEditor.autoAssignEnabled">目标毛利率下限 (%)<input v-model="batchEditor.targetMarginMinPercent" type="number" min="0" max="100" step="0.1" :disabled="!batchEditor.enabled" /></label><label v-if="batchEditor.autoAssignEnabled">目标毛利率上限 (%)<input v-model="batchEditor.targetMarginMaxPercent" type="number" min="0" max="100" step="0.1" :disabled="!batchEditor.enabled" /></label></div><div v-if="batchEditor.thresholdMode === 'margin'" class="form-note">按密钥当前上游倍率 {{ detail?.key?.rateMultiplier == null ? '--' : multiplier(detail.key.rateMultiplier) }} 计算，最低售卖倍率约为 <strong>{{ batchMinimumSaleMultiplier === null ? '--' : multiplier(batchMinimumSaleMultiplier) }}</strong>。</div><footer><button class="secondary-button" @click="batchEditor = null">取消</button><button class="primary-button" :disabled="batchSaving" @click="saveBatchProfitGuard"><Check :size="16" />保存批量配置</button></footer></section></div>
  </div>
</template>
