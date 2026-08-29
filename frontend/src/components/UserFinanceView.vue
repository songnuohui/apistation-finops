<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ChevronDown, RefreshCw, Search, ShieldCheck, UserRoundCheck, UserRoundX, Users, X } from 'lucide-vue-next';
import { get, query, rangeQuery, send } from '../api';

type AnyRecord = Record<string, any>;
type FinanceDetailType = 'users' | 'balance' | 'cash' | 'consumption' | 'cost' | 'profit';
const financeDetailConfigs: Record<FinanceDetailType, AnyRecord> = {
  users: { title: '统计用户明细', scope: 'included', sort: 'userChargeCny', metricLabel: '用户剩余金额', metricField: 'remainingBalanceCny', note: '列出参与统计的全部用户' },
  balance: { title: '用户剩余金额明细', scope: 'balance', sort: 'balanceCny', metricLabel: '正余额合计', metricField: 'remainingBalanceCny', note: '仅列出当前余额大于 0 的用户' },
  cash: { title: '现金实收明细', scope: 'cash', sort: 'cashPaidCny', metricLabel: '现金实收合计', metricField: 'cashPaidCny', note: '仅列出当前时间范围内产生现金实收的用户' },
  consumption: { title: '实际消费明细', scope: 'consumption', sort: 'userChargeCny', metricLabel: '实际消费合计', metricField: 'userChargeCny', note: '仅列出当前时间范围内产生消费的用户' },
  cost: { title: '总成本明细', scope: 'cost', sort: 'bookedCostCny', metricLabel: '已核算成本合计', metricField: 'bookedCostCny', note: '列出已产生成本或仍有成本待补的用户' },
  profit: { title: '毛利明细', scope: 'profit', sort: 'bookedProfitCny', metricLabel: '毛利合计', metricField: 'bookedProfitCny', note: '列出参与收入、成本或毛利计算的用户' },
};
const props = defineProps<{ refreshToken?: number; range?: string; rangeStart?: string; rangeEnd?: string }>();
const emit = defineEmits<{ toast: [message: string] }>();
const data = ref<AnyRecord>({});
const loading = ref(false);
const search = ref('');
const page = ref(1);
const pageSize = 20;
const sort = ref('userChargeCny');
const direction = ref<'asc' | 'desc'>('desc');
const selected = ref(new Set<number>());
const detail = ref<AnyRecord | null>(null);
const detailTab = ref<'usage' | 'recharges'>('usage');
const detailPage = ref({ usage: 1, recharges: 1 });
const whitelist = ref<AnyRecord | null>(null);
const financeDetail = ref<AnyRecord | null>(null);
let searchTimer: number | undefined;
let loadRequestId = 0;
let financeDetailRequestId = 0;
const rows = computed(() => data.value.items || []);
const summary = computed(() => data.value.summary || {});
const pages = computed(() => Math.max(1, Math.ceil(Number(data.value.total || 0) / pageSize)));
const financeDetailConfig = computed(() => financeDetail.value
  ? financeDetailConfigs[financeDetail.value.type as FinanceDetailType]
  : null);
const financeDetailRows = computed(() => financeDetail.value?.data?.items || []);
const financeDetailPages = computed(() => Math.max(1, Math.ceil(
  Number(financeDetail.value?.data?.total || 0) / Number(financeDetail.value?.data?.pageSize || pageSize),
)));
const money = (value: any) => value === null || value === undefined || value === ''
  ? '--'
  : new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 }).format(Number(value));
const compact = (value: any) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value || 0));
const count = (value: any) => value === null || value === undefined
  ? '--'
  : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(Number(value));
const percent = (value: any) => value === null || value === undefined ? '--' : `${(Number(value) * 100).toFixed(1)}%`;
const dateTime = (value: any) => value ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '--';
async function load() {
  const requestId = ++loadRequestId;
  loading.value = true;
  try {
    const result = await get(`/users?${query({ ...rangeQuery(props.range, props.rangeStart, props.rangeEnd), page: page.value, page_size: pageSize, search: search.value, sort: sort.value, direction: direction.value })}`);
    if (requestId === loadRequestId) data.value = result;
  } catch (error: any) {
    if (requestId === loadRequestId) emit('toast', error.message);
  } finally {
    if (requestId === loadRequestId) loading.value = false;
  }
}
function toggleSort(field: string) {
  if (sort.value === field) direction.value = direction.value === 'desc' ? 'asc' : 'desc';
  else { sort.value = field; direction.value = 'desc'; }
  page.value = 1;
  load();
}
function togglePageSelection(checked: boolean) {
  const next = new Set(selected.value);
  rows.value.forEach((item: AnyRecord) => checked ? next.add(Number(item.id)) : next.delete(Number(item.id)));
  selected.value = next;
}
function toggleSelection(id: number, checked: boolean) {
  const next = new Set(selected.value);
  checked ? next.add(id) : next.delete(id);
  selected.value = next;
}
async function updateSelected(excludeFromBalanceStats: boolean) {
  if (!selected.value.size) return;
  try {
    await send('/users/balance-statistics-whitelist', 'POST', { userIds: [...selected.value], excludeFromBalanceStats });
    selected.value = new Set();
    emit('toast', excludeFromBalanceStats ? '已加入自用账号白名单' : '已恢复汇总统计');
    await load();
  } catch (error: any) { emit('toast', error.message); }
}
async function loadDetail(user: AnyRecord, reset = true) {
  if (reset) detailPage.value = { usage: 1, recharges: 1 };
  try {
    detail.value = await get(`/users/${user.id}/details?${query({ ...rangeQuery(props.range, props.rangeStart, props.rangeEnd), recharge_page: detailPage.value.recharges, usage_page: detailPage.value.usage, detail_page_size: 10 })}`);
  } catch (error: any) { emit('toast', error.message); }
}
async function moveDetailPage(kind: 'usage' | 'recharges', delta: number) {
  if (!detail.value?.user) return;
  detailPage.value[kind] += delta;
  await loadDetail(detail.value.user, false);
}
async function openWhitelist() {
  whitelist.value = { scope: 'whitelist', search: '', page: 1, data: {}, loading: true };
  await loadWhitelist();
}
async function loadWhitelist() {
  if (!whitelist.value) return;
  whitelist.value.loading = true;
  try { whitelist.value.data = await get(`/users?${query({ ...rangeQuery(props.range, props.rangeStart, props.rangeEnd), page: whitelist.value.page, page_size: 20, search: whitelist.value.search, balance_scope: whitelist.value.scope })}`); }
  catch (error: any) { emit('toast', error.message); }
  finally { if (whitelist.value) whitelist.value.loading = false; }
}
async function toggleWhitelistUser(user: AnyRecord) {
  try {
    await send(`/users/${user.id}/balance-statistics-whitelist`, 'PATCH', { excludeFromBalanceStats: !user.excludeFromBalanceStats });
    emit('toast', user.excludeFromBalanceStats ? '已恢复汇总统计' : '已加入自用账号白名单');
    await Promise.all([load(), loadWhitelist()]);
  } catch (error: any) { emit('toast', error.message); }
}
async function openFinanceDetail(type: FinanceDetailType) {
  const config = financeDetailConfigs[type];
  financeDetail.value = {
    type, page: 1, sort: config.sort, direction: 'desc', data: null, loading: true,
  };
  await loadFinanceDetail();
}
async function loadFinanceDetail() {
  const state = financeDetail.value;
  const config = financeDetailConfig.value;
  if (!state || !config) return;
  const requestId = ++financeDetailRequestId;
  state.loading = true;
  try {
    const result = await get(`/users?${query({
      ...rangeQuery(props.range, props.rangeStart, props.rangeEnd),
      page: state.page, page_size: pageSize, search: search.value,
      sort: state.sort, direction: state.direction, finance_scope: config.scope,
    })}`);
    if (requestId === financeDetailRequestId && financeDetail.value === state) state.data = result;
  } catch (error: any) {
    if (requestId === financeDetailRequestId) emit('toast', error.message);
  } finally {
    if (requestId === financeDetailRequestId && financeDetail.value === state) state.loading = false;
  }
}
function toggleFinanceDetailSort(field: string) {
  if (!financeDetail.value) return;
  if (financeDetail.value.sort === field) financeDetail.value.direction = financeDetail.value.direction === 'desc' ? 'asc' : 'desc';
  else { financeDetail.value.sort = field; financeDetail.value.direction = 'desc'; }
  financeDetail.value.page = 1;
  loadFinanceDetail();
}
function moveFinanceDetailPage(delta: number) {
  if (!financeDetail.value) return;
  financeDetail.value.page += delta;
  loadFinanceDetail();
}
function closeFinanceDetail() {
  financeDetailRequestId += 1;
  financeDetail.value = null;
}
watch(search, () => { window.clearTimeout(searchTimer); searchTimer = window.setTimeout(() => { page.value = 1; load(); }, 250); });
watch(() => props.refreshToken, () => {
  page.value = 1;
  detail.value = null;
  closeFinanceDetail();
  load();
});
onMounted(load);
</script>

<template>
  <div class="page-view user-finance-view">
    <div class="metric-grid user-finance-metrics">
      <button type="button" class="metric-card metric-action" @click="openFinanceDetail('users')"><span>统计用户</span><strong>{{ count(summary.userCount) }}</strong><small>已剔除 {{ count(summary.excludedUserCount) }} 位白名单用户</small></button>
      <button type="button" class="metric-card metric-action" @click="openFinanceDetail('balance')"><span>用户剩余金额</span><strong>{{ money(summary.remainingBalanceCny) }}</strong><small>{{ count(summary.positiveBalanceUserCount) }} 位用户有正余额</small></button>
      <button type="button" class="metric-card metric-action" @click="openFinanceDetail('cash')"><span>现金实收</span><strong>{{ money(summary.cashPaidCny) }}</strong><small>{{ count(summary.cashPayingUserCount) }} 位用户产生实收</small></button>
      <button type="button" class="metric-card metric-action" @click="openFinanceDetail('consumption')"><span>实际消费</span><strong>{{ money(summary.userChargeCny) }}</strong><small>{{ compact(summary.requests) }} 次请求</small></button>
      <button type="button" class="metric-card metric-action" @click="openFinanceDetail('cost')"><span>总成本</span><strong>{{ money(summary.bookedCostCny) }}</strong><small>{{ count(summary.partialCostUserCount) }} 位用户成本待补</small></button>
      <button type="button" class="metric-card metric-action" :class="{ good: Number(summary.bookedProfitCny || 0) >= 0, bad: Number(summary.bookedProfitCny || 0) < 0 }" @click="openFinanceDetail('profit')"><span>毛利</span><strong>{{ money(summary.bookedProfitCny) }}</strong><small>毛利率 {{ percent(summary.grossMargin) }}</small></button>
    </div>
    <div class="user-toolbar"><label class="search-box"><Search :size="17" /><input v-model="search" placeholder="搜索邮箱或用户名" /></label><button class="icon-button" title="刷新列表" aria-label="刷新列表" @click="load"><RefreshCw :size="17" :class="{ spin: loading }" /></button><button class="secondary-button" @click="openWhitelist"><ShieldCheck :size="16" />自用账号白名单</button><span class="selection-text">已选择 {{ selected.size }} 位</span><button class="secondary-button" :disabled="!selected.size" @click="updateSelected(true)"><UserRoundX :size="16" />加入白名单</button><button class="secondary-button" :disabled="!selected.size" @click="updateSelected(false)"><UserRoundCheck :size="16" />恢复汇总统计</button><span v-if="loading" class="loading-note"><RefreshCw :size="15" class="spin" />更新中</span></div>
    <section class="panel table-panel">
      <div class="panel-head"><div><h2>用户核算</h2><p>顶部汇总统一剔除白名单；点击用户查看充值和消费明细</p></div><Users :size="20" class="head-icon" /></div>
      <div class="table-wrap"><table class="user-table"><thead><tr><th><input type="checkbox" title="选择当前页" @change="togglePageSelection(($event.target as HTMLInputElement).checked)" /></th><th>用户</th><th v-for="column in [['cashPaidCny','现金实收'],['adminCreditCny','管理员加款'],['adminDeductionCny','管理员扣款'],['balanceCny','当前余额'],['userChargeCny','实际消费'],['requests','请求'],['tokens','Token'],['bookedCostCny','总成本'],['bookedProfitCny','毛利']]" :key="column[0]" class="number"><button class="column-sort" @click="toggleSort(column[0])">{{ column[1] }} <ChevronDown :size="13" /></button></th><th class="number">毛利率</th><th>成本覆盖</th></tr></thead><tbody>
        <tr v-if="loading && !rows.length"><td colspan="13" class="table-empty">正在读取用户数据</td></tr>
        <tr v-for="user in rows" :key="user.id"><td><input type="checkbox" :checked="selected.has(Number(user.id))" @change="toggleSelection(Number(user.id), ($event.target as HTMLInputElement).checked)" /></td><td><button class="link-button" @click="loadDetail(user)">{{ user.email || user.username || `用户 #${user.id}` }}</button><small>ID {{ user.id }}<template v-if="user.username && user.username !== user.email"> · {{ user.username }}</template><template v-if="user.excludeFromBalanceStats"> · 自用账号白名单</template></small></td><td class="number">{{ money(user.cashPaidCny) }}</td><td class="number">{{ money(user.adminCreditCny) }}</td><td class="number">{{ money(user.adminDeductionCny) }}</td><td class="number">{{ money(user.balanceCny) }}</td><td class="number">{{ money(user.userChargeCny) }}</td><td class="number">{{ compact(user.requests) }}</td><td class="number">{{ compact(user.tokens) }}</td><td class="number">{{ money(user.bookedCostCny ?? user.effectiveCostCny) }}</td><td class="number positive">{{ money(user.bookedProfitCny) }}</td><td class="number">{{ percent(user.grossMargin) }}</td><td><span class="status-pill" :class="user.costCoverageStatus === 'complete' ? 'success' : 'warning'">{{ user.costCoverageStatus === 'complete' ? '已覆盖' : '部分覆盖' }}</span></td></tr>
        <tr v-if="!loading && !rows.length"><td colspan="13" class="table-empty">没有找到用户</td></tr>
      </tbody></table></div>
      <div v-if="pages > 1" class="pager"><button class="small-button" :disabled="page <= 1" @click="page--; load()">上一页</button><span>第 {{ page }} / {{ pages }} 页，共 {{ data.total }} 位用户</span><button class="small-button" :disabled="page >= pages" @click="page++; load()">下一页</button></div>
    </section>

    <div v-if="financeDetail" class="modal-layer" @click.self="closeFinanceDetail"><section class="modal user-finance-detail-modal"><header><div><h2>{{ financeDetailConfig?.title }}</h2><p>{{ financeDetailConfig?.note }}；统计口径与当前日期范围和搜索条件一致，白名单用户已剔除</p></div><button class="icon-button" title="关闭" aria-label="关闭" @click="closeFinanceDetail"><X :size="19" /></button></header>
      <div class="supplier-metrics user-finance-detail-metrics"><div><span>明细用户</span><strong>{{ count(financeDetail.data?.total) }}</strong><small>当前指标涉及的用户</small></div><div><span>{{ financeDetailConfig?.metricLabel }}</span><strong>{{ money(financeDetail.data?.summary?.[financeDetailConfig?.metricField]) }}</strong><small>当前筛选范围合计</small></div><div><span>请求数</span><strong>{{ financeDetail.data ? compact(financeDetail.data.summary?.requests) : '--' }}</strong><small>明细用户请求合计</small></div><div><span>成本待补</span><strong>{{ count(financeDetail.data?.summary?.partialCostUserCount) }}</strong><small>已剔除 {{ count(summary.excludedUserCount) }} 位白名单用户</small></div></div>
      <div v-if="financeDetail.loading && !financeDetail.data" class="table-empty">正在读取统计明细</div>
      <template v-else><div class="table-wrap compact-table"><table class="user-finance-detail-table"><thead><tr><th>用户</th><th class="number"><button class="column-sort" @click="toggleFinanceDetailSort('balanceCny')">当前余额 <ChevronDown :size="13" /></button></th><th class="number"><button class="column-sort" @click="toggleFinanceDetailSort('cashPaidCny')">现金实收 <ChevronDown :size="13" /></button></th><th class="number"><button class="column-sort" @click="toggleFinanceDetailSort('userChargeCny')">实际消费 <ChevronDown :size="13" /></button></th><th class="number"><button class="column-sort" @click="toggleFinanceDetailSort('bookedCostCny')">总成本 <ChevronDown :size="13" /></button></th><th class="number"><button class="column-sort" @click="toggleFinanceDetailSort('bookedProfitCny')">毛利 <ChevronDown :size="13" /></button></th><th class="number">毛利率</th><th>成本覆盖</th></tr></thead><tbody>
        <tr v-for="user in financeDetailRows" :key="user.id"><td><button class="link-button" @click="loadDetail(user)">{{ user.email || user.username || `用户 #${user.id}` }}</button><small>ID {{ user.id }}<template v-if="user.username && user.username !== user.email"> · {{ user.username }}</template></small></td><td class="number">{{ money(user.balanceCny) }}</td><td class="number">{{ money(user.cashPaidCny) }}</td><td class="number">{{ money(user.userChargeCny) }}</td><td class="number">{{ money(user.bookedCostCny ?? user.effectiveCostCny) }}</td><td class="number" :class="Number(user.bookedProfitCny || 0) >= 0 ? 'positive' : 'negative'">{{ money(user.bookedProfitCny) }}</td><td class="number">{{ percent(user.grossMargin) }}</td><td><span class="status-pill" :class="user.costCoverageStatus === 'complete' ? 'success' : 'warning'">{{ user.costCoverageStatus === 'complete' ? '已覆盖' : '部分覆盖' }}</span></td></tr>
        <tr v-if="!financeDetail.loading && !financeDetailRows.length"><td colspan="8" class="table-empty">当前指标没有明细</td></tr>
      </tbody></table></div><div v-if="financeDetailPages > 1" class="pager"><button class="small-button" :disabled="financeDetail.page <= 1" @click="moveFinanceDetailPage(-1)">上一页</button><span>第 {{ financeDetail.page }} / {{ financeDetailPages }} 页，共 {{ financeDetail.data?.total }} 位用户</span><button class="small-button" :disabled="financeDetail.page >= financeDetailPages" @click="moveFinanceDetailPage(1)">下一页</button></div></template>
    </section></div>

    <div v-if="detail" class="modal-layer" :class="{ 'nested-modal': financeDetail }" @click.self="detail = null"><section class="modal user-detail-modal"><header><div><h2>{{ detail.user?.email || detail.user?.username || '用户详情' }}</h2><p>ID {{ detail.user?.id }} · {{ detail.user?.status || 'active' }}</p></div><button class="icon-button" @click="detail = null"><X :size="19" /></button></header><div class="supplier-metrics user-detail-metrics"><div><span>充值实收</span><strong>{{ money(detail.user?.rechargeCny) }}</strong><small>到账额度 {{ money(detail.user?.creditedCny) }}</small></div><div><span>实际消费</span><strong>{{ money(detail.user?.consumptionCny) }}</strong><small>{{ compact(detail.user?.requests) }} 次请求</small></div><div><span>当前余额</span><strong>{{ money(detail.user?.balanceCny) }}</strong><small>{{ detail.user?.excludeFromBalanceStats ? '已排除汇总统计' : '参与汇总统计' }}</small></div><div><span>管理员调整</span><strong>{{ money(Number(detail.user?.adminCreditCny || 0) - Number(detail.user?.adminDeductionCny || 0)) }}</strong><small>加款 {{ money(detail.user?.adminCreditCny) }} · 扣款 {{ money(detail.user?.adminDeductionCny) }}</small></div></div><div class="detail-tabs"><button :class="{ active: detailTab === 'usage' }" @click="detailTab = 'usage'">消费明细 <small>{{ detail.usage?.total || 0 }}</small></button><button :class="{ active: detailTab === 'recharges' }" @click="detailTab = 'recharges'">充值明细 <small>{{ detail.recharges?.total || 0 }}</small></button></div>
      <div v-if="detailTab === 'usage'" class="table-wrap compact-table"><table><thead><tr><th>时间</th><th>模型</th><th>账号</th><th class="number">Token</th><th class="number">实际消费</th><th class="number">耗时</th></tr></thead><tbody><tr v-for="item in detail.usage?.items || []" :key="item.sourceUsageId"><td>{{ dateTime(item.occurredAt) }}</td><td>{{ item.model || '--' }}</td><td>#{{ item.accountId || item.sourceAccountId || '--' }}</td><td class="number">{{ compact(item.tokens || Number(item.inputTokens || 0) + Number(item.outputTokens || 0)) }}</td><td class="number">{{ money(item.userChargeCny) }}</td><td class="number">{{ item.durationMs ? `${Math.round(item.durationMs / 1000)} 秒` : '--' }}</td></tr><tr v-if="!detail.usage?.items?.length"><td colspan="6" class="table-empty">暂无消费明细</td></tr></tbody></table><div v-if="detail.usage?.total > detail.usage?.pageSize" class="pager"><button class="small-button" :disabled="detailPage.usage <= 1" @click="moveDetailPage('usage', -1)">上一页</button><span>第 {{ detailPage.usage }} 页</span><button class="small-button" :disabled="detailPage.usage * detail.usage.pageSize >= detail.usage.total" @click="moveDetailPage('usage', 1)">下一页</button></div></div>
      <div v-else class="table-wrap compact-table"><table><thead><tr><th>时间</th><th class="number">实收金额</th><th class="number">到账额度</th><th>支付方式</th><th>参考号</th><th>状态</th></tr></thead><tbody><tr v-for="item in detail.recharges?.items || []" :key="item.id"><td>{{ dateTime(item.occurredAt) }}</td><td class="number">{{ money(item.amountCny ?? item.baseAmount) }}</td><td class="number">{{ money(item.creditedCny ?? item.creditedAmount) }}</td><td>{{ item.paymentMethod || '--' }}</td><td>{{ item.reference || '--' }}</td><td>{{ item.status || '--' }}</td></tr><tr v-if="!detail.recharges?.items?.length"><td colspan="6" class="table-empty">暂无充值明细</td></tr></tbody></table><div v-if="detail.recharges?.total > detail.recharges?.pageSize" class="pager"><button class="small-button" :disabled="detailPage.recharges <= 1" @click="moveDetailPage('recharges', -1)">上一页</button><span>第 {{ detailPage.recharges }} 页</span><button class="small-button" :disabled="detailPage.recharges * detail.recharges.pageSize >= detail.recharges.total" @click="moveDetailPage('recharges', 1)">下一页</button></div></div>
    </section></div>

    <div v-if="whitelist" class="modal-layer nested-modal" @click.self="whitelist = null"><section class="modal whitelist-modal"><header><div><h2>自用账号白名单</h2><p>顶部全部汇总和统计明细均剔除白名单用户，用户核算列表仍保留展示</p></div><button class="icon-button" @click="whitelist = null"><X :size="19" /></button></header><div class="whitelist-toolbar"><div class="tabs compact-tabs"><button :class="{ active: whitelist.scope === 'whitelist' }" @click="whitelist.scope = 'whitelist'; whitelist.page = 1; loadWhitelist()">当前白名单</button><button :class="{ active: whitelist.scope === 'all' }" @click="whitelist.scope = 'all'; whitelist.page = 1; loadWhitelist()">搜索全部用户</button></div><label class="search-box"><Search :size="16" /><input v-model="whitelist.search" placeholder="搜索邮箱或用户名" @input="whitelist.page = 1; loadWhitelist()" /></label></div><div class="table-wrap compact-table"><table><thead><tr><th>用户</th><th class="number">当前余额</th><th class="number">实际消费</th><th>汇总统计</th><th>操作</th></tr></thead><tbody><tr v-for="user in whitelist.data.items || []" :key="user.id"><td>{{ user.email || user.username || `用户 #${user.id}` }}<small>ID {{ user.id }}</small></td><td class="number">{{ money(user.balanceCny) }}</td><td class="number">{{ money(user.userChargeCny) }}</td><td><span class="status-pill" :class="user.excludeFromBalanceStats ? 'warning' : 'success'">{{ user.excludeFromBalanceStats ? '已排除' : '参与统计' }}</span></td><td><button class="small-button" @click="toggleWhitelistUser(user)">{{ user.excludeFromBalanceStats ? '恢复统计' : '加入白名单' }}</button></td></tr><tr v-if="!whitelist.loading && !(whitelist.data.items || []).length"><td colspan="5" class="table-empty">暂无用户</td></tr></tbody></table></div><div v-if="whitelist.data.total > whitelist.data.pageSize" class="pager"><button class="small-button" :disabled="whitelist.page <= 1" @click="whitelist.page--; loadWhitelist()">上一页</button><span>第 {{ whitelist.page }} 页，共 {{ whitelist.data.total }} 位</span><button class="small-button" :disabled="whitelist.page * whitelist.data.pageSize >= whitelist.data.total" @click="whitelist.page++; loadWhitelist()">下一页</button></div></section></div>
  </div>
</template>
