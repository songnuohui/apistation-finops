<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { ChevronDown, FileText, RefreshCw, Search } from 'lucide-vue-next';
import { get, query, rangeQuery } from '../api';

type AnyRecord = Record<string, any>;
const props = defineProps<{ refreshToken?: number; range?: string; rangeStart?: string; rangeEnd?: string }>();
const emit = defineEmits<{ toast: [message: string] }>();
const tab = ref<'users' | 'models' | 'events'>('users');
const search = ref('');
const page = ref(1);
const pageSize = 30;
const sort = ref('userChargeCny');
const direction = ref<'asc' | 'desc'>('desc');
const data = ref<AnyRecord>({});
const loading = ref(false);
let searchTimer: number | undefined;
let loadRequestId = 0;
const money = (value: any) => value === null || value === undefined || value === ''
  ? '--'
  : new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 }).format(Number(value));
const usd = (value: any) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(value || 0));
const compact = (value: any) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value || 0));
const percent = (value: any) => value === null || value === undefined ? '--' : `${(Number(value) * 100).toFixed(1)}%`;
const dateTime = (value: any) => value ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '--';
function statusClass(value: any) { return ['priced', 'complete', 'ok'].includes(String(value)) ? 'success' : ['missing', 'failed'].includes(String(value)) ? 'danger' : 'warning'; }
function pages() { return Math.max(1, Math.ceil(Number(data.value.total || 0) / pageSize)); }
function toggleSort(field: string) {
  if (sort.value === field) direction.value = direction.value === 'desc' ? 'asc' : 'desc';
  else { sort.value = field; direction.value = 'desc'; }
  page.value = 1;
  load();
}
async function load() {
  const requestId = ++loadRequestId;
  loading.value = true;
  try {
    const endpoint = tab.value === 'users' ? '/usage/users' : tab.value === 'models' ? '/usage/models' : '/usage/events';
    const result = await get(`${endpoint}?${query({ ...rangeQuery(props.range, props.rangeStart, props.rangeEnd), page: page.value, page_size: pageSize, search: search.value, sort: sort.value, direction: direction.value })}`);
    if (requestId === loadRequestId) data.value = result;
  } catch (error: any) {
    if (requestId === loadRequestId) emit('toast', error.message);
  } finally {
    if (requestId === loadRequestId) loading.value = false;
  }
}
watch(search, () => { window.clearTimeout(searchTimer); searchTimer = window.setTimeout(() => { page.value = 1; load(); }, 250); });
watch(tab, () => { page.value = 1; sort.value = 'userChargeCny'; direction.value = 'desc'; load(); });
watch(() => props.refreshToken, () => {
  page.value = 1;
  load();
});
onMounted(load);
</script>

<template>
  <div class="page-view usage-view">
    <div class="toolbar-row"><label class="search-box"><Search :size="17" /><input v-model="search" :placeholder="tab === 'events' ? '搜索请求 ID、用户、账号或模型' : '搜索用户或模型'" /></label><button class="icon-button" title="刷新列表" aria-label="刷新列表" @click="load"><RefreshCw :size="17" :class="{ spin: loading }" /></button><span v-if="loading" class="loading-note"><RefreshCw :size="15" class="spin" />更新中</span></div>
    <div class="tabs"><button :class="{ active: tab === 'users' }" @click="tab = 'users'">用户消费汇总</button><button :class="{ active: tab === 'models' }" @click="tab = 'models'">模型消费汇总</button><button :class="{ active: tab === 'events' }" @click="tab = 'events'">请求明细</button></div>
    <section class="panel table-panel">
      <div class="panel-head"><div><h2>{{ tab === 'users' ? '用户消费汇总' : tab === 'models' ? '模型消费汇总' : '请求明细' }}</h2><p>销售额来自实际消费记录，成本使用 FinOps 成本快照</p></div><FileText :size="20" class="head-icon" /></div>
      <div class="table-wrap"><table><thead>
        <tr v-if="tab !== 'events'"><th>{{ tab === 'users' ? '用户' : '模型' }}</th><th class="number"><button class="column-sort" @click="toggleSort('requests')">请求 <ChevronDown :size="13" /></button></th><th class="number"><button class="column-sort" @click="toggleSort('tokens')">Token <ChevronDown :size="13" /></button></th><th class="number"><button class="column-sort" @click="toggleSort('userChargeCny')">销售额 <ChevronDown :size="13" /></button></th><th class="number"><button class="column-sort" @click="toggleSort('bookedCostCny')">总成本 <ChevronDown :size="13" /></button></th><th class="number"><button class="column-sort" @click="toggleSort('bookedProfitCny')">毛利 <ChevronDown :size="13" /></button></th><th class="number">毛利率</th></tr>
        <tr v-else><th>时间</th><th>请求 / 用户</th><th>模型</th><th>上游账号</th><th class="number">Token</th><th class="number">实际扣费</th><th class="number">计算成本</th><th>计价状态</th></tr>
      </thead><tbody>
        <tr v-if="loading && !(data.items || []).length"><td :colspan="tab === 'events' ? 8 : 7" class="table-empty">正在读取消费数据</td></tr>
        <tr v-for="row in data.items || []" :key="row.sourceUsageId || row.id || row.name">
          <template v-if="tab !== 'events'"><td><strong>{{ row.name || row.email || row.username || `用户 #${row.id}` }}</strong><small v-if="row.id">ID {{ row.id }}</small></td><td class="number">{{ compact(row.requests) }}</td><td class="number">{{ compact(row.tokens) }}</td><td class="number">{{ money(row.userChargeCny) }}</td><td class="number">{{ money(row.bookedCostCny ?? row.effectiveCostCny) }}</td><td class="number positive">{{ money(row.bookedProfitCny ?? row.profitCny) }}</td><td class="number">{{ percent(row.grossMargin ?? row.margin) }}</td></template>
          <template v-else><td>{{ dateTime(row.occurredAt) }}</td><td><strong>{{ row.requestId || `#${row.sourceUsageId}` }}</strong><small>{{ row.email || row.username || `用户 #${row.userId}` }}</small></td><td>{{ row.model || row.requestedModel || '未标注模型' }}<small v-if="row.upstreamModel && row.upstreamModel !== row.model">上游 {{ row.upstreamModel }}</small></td><td>{{ row.accountName || `#${row.accountId || '--'}` }}<small>组 #{{ row.groupId || '--' }} · 渠道 #{{ row.channelId || '--' }}</small></td><td class="number">{{ compact(row.totalTokens ?? row.tokens) }}</td><td class="number">{{ money(row.userChargeCny ?? row.actualCostCny) }}<small>{{ usd(row.standardCostUsdReference) }} 目录价</small></td><td class="number">{{ money(row.calculatedCostCny ?? row.bookedCostCny) }}</td><td><span class="status-pill" :class="statusClass(row.costStatus)">{{ row.costStatus || '已同步' }}</span></td></template>
        </tr>
        <tr v-if="!loading && !(data.items || []).length"><td :colspan="tab === 'events' ? 8 : 7" class="table-empty">暂无消费数据</td></tr>
      </tbody></table></div>
      <div v-if="pages() > 1" class="pager"><button class="small-button" :disabled="page <= 1" @click="page--; load()">上一页</button><span>第 {{ page }} / {{ pages() }} 页，共 {{ data.total }} 条</span><button class="small-button" :disabled="page >= pages()" @click="page++; load()">下一页</button></div>
    </section>
  </div>
</template>
