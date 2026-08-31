<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  Activity, AlertTriangle, BarChart3, CheckCircle2, ChevronDown, CircleAlert, Gauge,
  ListOrdered, RefreshCw, UsersRound, X,
} from 'lucide-vue-next';
import { get, query, rangeQuery } from '../api';

type AnyRecord = Record<string, any>;
type DetailType = 'recharge' | 'gift' | 'consumption' | 'tokens' | 'balance' | null;
const props = defineProps<{ refreshToken?: number; range?: string; rangeStart?: string; rangeEnd?: string }>();
const emit = defineEmits<{ toast: [message: string] }>();
const dashboard = ref<AnyRecord>({});
const trend = ref<AnyRecord>({});
const models = ref<AnyRecord>({});
const runtime = ref<AnyRecord>({});
const dashboardLoading = ref(false);
const trendLoading = ref(false);
const modelsLoading = ref(false);
const runtimeLoading = ref(false);
const runtimeError = ref('');
const runtimeFilter = ref<'all' | 'queued' | 'busy'>('all');
const detail = ref<AnyRecord | null>(null);
const detailType = ref<DetailType>(null);
const detailTab = ref<'users' | 'models'>('users');
const detailPage = ref(1);
const detailSort = ref('userChargeCny');
const detailDirection = ref<'asc' | 'desc'>('desc');
const chartCanvas = ref<HTMLCanvasElement | null>(null);
let chart: import('chart.js').Chart | null = null;
let chartConstructor: typeof import('chart.js').Chart | null = null;
let runtimeTimer: number | undefined;
let loadRequestId = 0;

const summary = computed(() => dashboard.value.summary || {});
const operations = computed(() => summary.value.operations || {});
const cash = computed(() => summary.value.cash || {});
const usage = computed(() => summary.value.usage || {});
const runtimeUsers = computed(() => [...(runtime.value.users || [])].sort((a, b) => (
  Number(b.waitingCount || 0) - Number(a.waitingCount || 0)
  || Number(b.currentConcurrency || 0) - Number(a.currentConcurrency || 0)
  || Number(b.usagePercent || 0) - Number(a.usagePercent || 0)
  || Number(a.id || 0) - Number(b.id || 0)
)));
const visibleRuntimeUsers = computed(() => runtimeUsers.value.filter((item) => {
  if (runtimeFilter.value === 'queued') return Number(item.waitingCount || 0) > 0;
  if (runtimeFilter.value === 'busy') return Number(item.currentConcurrency || 0) > 0;
  return true;
}));
const runtimeActiveUsers = computed(() => runtimeUsers.value.filter((item) => Number(item.currentConcurrency || 0) > 0));
const runtimeQueuedUsers = computed(() => runtimeUsers.value.filter((item) => Number(item.waitingCount || 0) > 0));
const runtimeCurrentConcurrency = computed(() => runtimeUsers.value.reduce((total, item) => total + Number(item.currentConcurrency || 0), 0));
const runtimeWaitingCount = computed(() => runtimeUsers.value.reduce((total, item) => total + Number(item.waitingCount || 0), 0));
const runtimeCapacity = computed(() => runtimeUsers.value.reduce((total, item) => total + Number(item.maxConcurrency || 0), 0));
const runtimeUsagePercent = computed(() => runtimeCapacity.value > 0
  ? Math.min(100, runtimeCurrentConcurrency.value * 100 / runtimeCapacity.value)
  : null);
const runtimeMaxUsagePercent = computed(() => runtimeUsers.value.reduce(
  (max, item) => Math.max(max, Number(item.usagePercent || 0)),
  0,
));
const runtimeObservedAt = computed(() => runtime.value.observedAt || null);
const runtimeSource = computed(() => runtime.value.source === 'sub2api_ops_user_concurrency'
  ? 'Sub2API 运维聚合接口'
  : runtime.value.source === 'finops_snapshot' ? 'FinOps 快照' : '等待数据源');
const runtimeIsAvailable = computed(() => runtime.value.source === 'sub2api_ops_user_concurrency' && runtime.value.enabled !== false);
const totalTokens = computed(() => Number(usage.value.inputTokens || 0) + Number(usage.value.outputTokens || 0) + Number(usage.value.cacheTokens || 0));
const consumption = computed(() => Number(operations.value.consumptionCny ?? operations.value.userChargeCny ?? 0));
const totalCost = computed(() => Number(operations.value.effectiveCostCny ?? operations.value.bookedCostCny ?? 0));
const grossProfit = computed(() => Number(operations.value.grossProfitCny ?? operations.value.bookedProfitCny ?? consumption.value - totalCost.value));
const grossMargin = computed(() => operations.value.grossMargin ?? (consumption.value ? grossProfit.value / consumption.value : null));
const detailTitle = computed(() => ({
  recharge: '充值与退款明细', gift: '赠送金额明细', consumption: '总消耗明细',
  tokens: '总 Token 明细', balance: '剩余余额明细',
} as Record<string, string>)[String(detailType.value)] || '统计明细');
const detailRows = computed(() => detail.value?.items || []);
const detailPages = computed(() => Math.max(1, Math.ceil(Number(detail.value?.total || 0) / Number(detail.value?.pageSize || 20))));

function money(value: any) {
  if (value === null || value === undefined || value === '') return '--';
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 }).format(Number(value));
}
function compact(value: any) { return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value || 0)); }
function percent(value: any) { return value === null || value === undefined ? '--' : `${(Number(value) * 100).toFixed(1)}%`; }
function dateTime(value: any) { return value ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '--'; }
function dateLabel(value: any) { return String(value || '').slice(5); }
function statusClass(value: any) { return ['priced', 'complete', 'ok'].includes(String(value)) ? 'success' : ['missing', 'failed'].includes(String(value)) ? 'danger' : 'warning'; }
function notify(message: string) { emit('toast', message); }

function integer(value: any) {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(Number(value || 0));
}
function runtimeStatus(item: AnyRecord) {
  if (Number(item.waitingCount || 0) > 0) return '排队中';
  if (Number(item.currentConcurrency || 0) > 0 && Number(item.usagePercent || 0) >= 90) return '接近上限';
  return '执行中';
}
function runtimeStatusClass(item: AnyRecord) {
  if (Number(item.waitingCount || 0) > 0) return 'warning';
  if (Number(item.usagePercent || 0) >= 90) return 'danger';
  return 'success';
}
function runtimeBarWidth(item: AnyRecord) {
  return `${Math.min(100, Math.max(0, Number(item.usagePercent || 0)))}%`;
}
async function loadRuntime() {
  runtimeLoading.value = true;
  runtimeError.value = '';
  try {
    runtime.value = await get('/runtime?live=1');
  } catch (error: any) {
    runtimeError.value = error.message;
  } finally {
    runtimeLoading.value = false;
  }
}
async function load() {
  const requestId = ++loadRequestId;
  dashboardLoading.value = true;
  trendLoading.value = true;
  modelsLoading.value = true;
  const params = query(rangeQuery(props.range, props.rangeStart, props.rangeEnd));
  const assign = async (request: Promise<any>, apply: (value: any) => Promise<void> | void) => {
    try {
      const value = await request;
      if (requestId === loadRequestId) await apply(value);
    } catch (error: any) {
      if (requestId === loadRequestId) notify(error.message);
    }
  };
  await Promise.allSettled([
    assign(get(`/overview-dashboard?${params}`), (value) => { dashboard.value = value; dashboardLoading.value = false; }),
    assign(get(`/trend?${params}`), async (value) => {
      trend.value = value;
      trendLoading.value = false;
      await nextTick();
      await drawChart();
    }),
  ]);
  if (requestId === loadRequestId) {
    await assign(
      get(`/usage/models?${params}&page_size=8&sort=userChargeCny&direction=desc`),
      (value) => { models.value = value; modelsLoading.value = false; },
    );
  }
  if (requestId === loadRequestId) {
    dashboardLoading.value = false;
    trendLoading.value = false;
    modelsLoading.value = false;
  }
}
async function drawChart() {
  if (!chartCanvas.value) return;
  if (!chartConstructor) {
    const chartModule = await import('chart.js');
    chartModule.Chart.register(...chartModule.registerables);
    chartConstructor = chartModule.Chart;
  }
  if (!chartCanvas.value || !chartConstructor) return;
  chart?.destroy();
  const items = trend.value.items || [];
  chart = new chartConstructor(chartCanvas.value, {
    type: 'line',
    data: {
      labels: items.map((item: AnyRecord) => dateLabel(item.day || item.date)),
      datasets: [
        { label: '实际消费', data: items.map((item: AnyRecord) => Number(item.userChargeCny || item.revenueCny || 0)), borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,.08)', fill: true, tension: .28, pointRadius: 3, pointHoverRadius: 5 },
        { label: '总成本', data: items.map((item: AnyRecord) => Number(item.effectiveCostCny ?? item.bookedCostCny ?? 0)), borderColor: '#f08a24', backgroundColor: 'transparent', tension: .28, pointRadius: 3, pointHoverRadius: 5 },
        { label: '毛利', data: items.map((item: AnyRecord) => Number(item.profitCny ?? item.grossProfitCny ?? item.bookedProfitCny ?? 0)), borderColor: '#18a673', backgroundColor: 'transparent', tension: .28, pointRadius: 3, pointHoverRadius: 5 },
        { label: '充值实收', data: items.map((item: AnyRecord) => Number(item.rechargeCny || 0)), borderColor: '#8b5cf6', backgroundColor: 'transparent', borderDash: [5, 4], tension: .28, pointRadius: 2, pointHoverRadius: 4 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', align: 'end', labels: { usePointStyle: true, boxWidth: 8, padding: 16 } }, tooltip: { callbacks: { label: (context) => ` ${context.dataset.label}: ${money(context.parsed.y)}` } } },
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: (value) => `¥${Number(value).toLocaleString('zh-CN')}` } } },
    },
  });
}

async function openDetail(type: DetailType) {
  if (!type) return;
  detailType.value = type;
  detailTab.value = type === 'tokens' ? 'models' : 'users';
  detailPage.value = 1;
  detailSort.value = type === 'tokens' ? 'tokens' : type === 'balance' ? 'balanceCny' : 'userChargeCny';
  detailDirection.value = 'desc';
  detail.value = null;
  await loadDetail();
}
async function loadDetail() {
  if (!detailType.value) return;
  try {
    const type = detailType.value;
    const params = query({ ...rangeQuery(props.range, props.rangeStart, props.rangeEnd), page: detailPage.value, page_size: 20 });
    let endpoint = '';
    if (type === 'recharge') endpoint = `/funds?scope=recharge&${params}`;
    else if (type === 'gift') endpoint = `/non-cash-balance-credits?${params}`;
    else if (type === 'balance') endpoint = `/users?${query({ ...rangeQuery(props.range, props.rangeStart, props.rangeEnd), page: detailPage.value, page_size: 20, balance_scope: 'reported', sort: 'balanceCny', direction: 'desc' })}`;
    else if (type === 'tokens') endpoint = `/usage/models?${query({ ...rangeQuery(props.range, props.rangeStart, props.rangeEnd), page: detailPage.value, page_size: 20, sort: 'tokens', direction: 'desc' })}`;
    else endpoint = detailTab.value === 'models'
      ? `/usage/models?${query({ ...rangeQuery(props.range, props.rangeStart, props.rangeEnd), page: detailPage.value, page_size: 20, sort: detailSort.value, direction: detailDirection.value })}`
      : `/usage/users?${query({ ...rangeQuery(props.range, props.rangeStart, props.rangeEnd), page: detailPage.value, page_size: 20, sort: detailSort.value, direction: detailDirection.value })}`;
    detail.value = await get(endpoint);
  } catch (error: any) { notify(error.message); }
}
function toggleDetailSort(field: string) {
  if (detailSort.value === field) detailDirection.value = detailDirection.value === 'desc' ? 'asc' : 'desc';
  else { detailSort.value = field; detailDirection.value = 'desc'; }
  detailPage.value = 1;
  loadDetail();
}
function closeDetail() { detailType.value = null; detail.value = null; }
function metricValue(type: DetailType) { openDetail(type); }

watch(() => props.refreshToken, () => {
  closeDetail();
  load();
});
watch(detailTab, () => { if (detailType.value === 'consumption') { detailPage.value = 1; loadDetail(); } });
onMounted(() => {
  void load();
  void loadRuntime();
  runtimeTimer = window.setInterval(loadRuntime, 3_000);
});
onUnmounted(() => {
  loadRequestId += 1;
  chart?.destroy();
  if (runtimeTimer) window.clearInterval(runtimeTimer);
});
</script>

<template>
  <div class="page-view overview-view">
    <div class="metric-grid">
      <button class="metric-card metric-action" @click="metricValue('recharge')"><span>充值净额</span><strong>{{ money(Number(cash.rechargeReceived || 0) - Number(cash.refunds || 0)) }}</strong><small>充值 {{ money(cash.rechargeReceived) }} · 退款 {{ money(cash.refunds) }}</small></button>
      <button class="metric-card metric-action good" @click="metricValue('gift')"><span>赠送金额</span><strong>{{ money(dashboard.totals?.giftBalanceCreditCny) }}</strong><small>{{ compact(dashboard.totals?.giftBalanceCreditCount) }} 笔非现金入账</small></button>
      <button class="metric-card metric-action" @click="metricValue('consumption')"><span>总消耗</span><strong>{{ money(consumption) }}</strong><small>{{ compact(usage.requests) }} 次请求 · 点击查看明细</small></button>
      <button class="metric-card metric-action" @click="metricValue('consumption')"><span>总成本</span><strong>{{ money(totalCost) }}</strong><small>{{ operations.unbookedAccountCount || 0 }} 个账号待补成本</small></button>
      <button class="metric-card metric-action good" @click="metricValue('consumption')"><span>毛利</span><strong>{{ money(grossProfit) }}</strong><small>{{ operations.profitBasis || '总消耗减总成本' }}</small></button>
      <button class="metric-card metric-action good" @click="metricValue('consumption')"><span>毛利率</span><strong>{{ percent(grossMargin) }}</strong><small>毛利 ÷ 实际消费</small></button>
    </div>
    <div class="overview-grid">
      <section class="panel runtime-panel runtime-panel-modern">
        <div class="runtime-panel-head">
          <div class="runtime-panel-title">
            <span class="runtime-kicker"><Activity :size="13" /> LIVE / SUB2API</span>
            <h2>实时并发与排队</h2>
            <p>按用户聚合读取 Sub2API 当前执行中的请求与等待队列</p>
          </div>
          <div class="runtime-head-actions">
            <span class="runtime-live-state" :class="{ offline: !runtimeIsAvailable }"><i></i>{{ runtimeIsAvailable ? '实时连接' : '暂不可用' }}</span>
            <button class="icon-button" type="button" title="刷新实时并发" aria-label="刷新实时并发" :disabled="runtimeLoading" @click="loadRuntime"><RefreshCw :size="17" :class="{ spin: runtimeLoading }" /></button>
          </div>
        </div>
        <div v-if="runtimeError" class="runtime-error"><CircleAlert :size="16" /><span>{{ runtimeError }}</span></div>
        <div v-else-if="runtimeLoading && !runtimeUsers.length" class="runtime-empty runtime-loading"><RefreshCw :size="18" class="spin" /><span>正在读取 Sub2API 实时状态</span></div>
        <template v-else>
          <div class="runtime-kpi-grid">
            <div class="runtime-kpi runtime-kpi-blue"><span class="runtime-kpi-label"><Activity :size="14" />当前并发</span><strong>{{ integer(runtimeCurrentConcurrency) }}</strong><small>{{ integer(runtimeActiveUsers.length) }} 个用户正在执行</small></div>
            <div class="runtime-kpi runtime-kpi-amber"><span class="runtime-kpi-label"><ListOrdered :size="14" />排队请求</span><strong>{{ integer(runtimeWaitingCount) }}</strong><small>{{ integer(runtimeQueuedUsers.length) }} 个用户正在等待</small></div>
            <div class="runtime-kpi runtime-kpi-green"><span class="runtime-kpi-label"><UsersRound :size="14" />活跃用户</span><strong>{{ integer(runtimeUsers.length) }}</strong><small>{{ integer(runtimeActiveUsers.length) }} 执行 · {{ integer(runtimeQueuedUsers.length) }} 排队</small></div>
            <div class="runtime-kpi runtime-kpi-violet"><span class="runtime-kpi-label"><Gauge :size="14" />容量占用</span><strong>{{ runtimeUsagePercent === null ? '--' : `${runtimeUsagePercent.toFixed(1)}%` }}</strong><small>{{ integer(runtimeCurrentConcurrency) }} / {{ runtimeCapacity ? integer(runtimeCapacity) : '--' }} 并发槽位</small></div>
          </div>
          <div class="runtime-meta">
            <span><i class="runtime-meta-dot"></i>{{ runtimeSource }}</span>
            <span v-if="runtimeObservedAt">观测于 {{ dateTime(runtimeObservedAt) }}</span>
            <span v-if="runtimeMaxUsagePercent >= 90" class="runtime-meta-alert"><CircleAlert :size="13" />最高用户占用 {{ runtimeMaxUsagePercent.toFixed(1) }}%</span>
          </div>
          <div class="runtime-users-head">
            <div><h3>用户实时负载</h3><p>仅展示当前有并发或排队请求的用户，按排队数优先排序</p></div>
            <div class="runtime-filter" role="group" aria-label="用户实时负载筛选">
              <button type="button" :class="{ active: runtimeFilter === 'all' }" @click="runtimeFilter = 'all'">全部 {{ runtimeUsers.length }}</button>
              <button type="button" :class="{ active: runtimeFilter === 'queued' }" @click="runtimeFilter = 'queued'">排队 {{ runtimeQueuedUsers.length }}</button>
              <button type="button" :class="{ active: runtimeFilter === 'busy' }" @click="runtimeFilter = 'busy'">执行中 {{ runtimeActiveUsers.length }}</button>
            </div>
          </div>
          <div v-if="visibleRuntimeUsers.length" class="runtime-user-viewport">
            <div class="runtime-user-list">
              <div v-for="(item, index) in visibleRuntimeUsers" :key="item.id" class="runtime-user-row">
                <span class="runtime-user-rank">{{ String(index + 1).padStart(2, '0') }}</span>
                <div class="runtime-user-identity">
                  <strong>{{ item.email || item.username || `用户 #${item.id}` }}</strong>
                  <small>{{ item.username && item.username !== item.email ? `${item.username} · ` : '' }}ID {{ item.id }}</small>
                </div>
                <div class="runtime-user-load">
                  <div class="runtime-user-load-head"><span>并发占用</span><strong>{{ integer(item.currentConcurrency) }}<em>/ {{ item.maxConcurrency ? integer(item.maxConcurrency) : '--' }}</em></strong></div>
                  <div class="runtime-load-track"><i :class="runtimeStatusClass(item)" :style="{ width: runtimeBarWidth(item) }"></i></div>
                </div>
                <div class="runtime-user-queue">
                  <span class="runtime-user-queue-label">等待</span>
                  <strong :class="{ active: Number(item.waitingCount || 0) > 0 }">{{ integer(item.waitingCount) }}</strong>
                </div>
                <div class="runtime-user-status"><span class="status-pill" :class="runtimeStatusClass(item)">{{ runtimeStatus(item) }}</span><small>{{ Number(item.usagePercent || 0).toFixed(1) }}% 占用</small></div>
              </div>
            </div>
          </div>
          <div v-else class="runtime-empty"><CheckCircle2 :size="20" /><div><strong>{{ runtimeFilter === 'all' ? '当前没有实时请求' : '没有匹配的用户' }}</strong><span>{{ runtimeFilter === 'all' ? 'Sub2API 当前没有用户并发或排队活动' : '切换筛选条件查看其他用户' }}</span></div></div>
          <div class="runtime-definition">排队请求为 Sub2API 运维接口返回的 <code>waiting_in_queue</code> 汇总，并发占用为 <code>current_in_use</code> 汇总。</div>
        </template>
      </section>
      <section class="panel"><div class="panel-head"><div><h2>待处理事项</h2><p>需要关注的经营和成本问题</p></div><AlertTriangle :size="20" class="head-icon warning-icon" /></div><div class="alert-list"><div v-for="alert in summary.alerts || []" :key="alert.title" class="alert-row" :class="alert.severity"><span></span><div><strong>{{ alert.title }}</strong><p>{{ alert.detail }}</p></div></div><div v-if="!(summary.alerts || []).length" class="empty">没有待处理事项</div></div></section>
    </div>
    <section class="panel chart-panel"><div class="panel-head"><div><h2>经营趋势</h2><p>实际消费、总成本、毛利和充值实收按日汇总</p></div><BarChart3 :size="20" class="head-icon" /></div><div class="trend-chart"><canvas ref="chartCanvas"></canvas><div v-if="trendLoading && !(trend.items || []).length" class="chart-empty">正在加载趋势数据</div><div v-if="!trendLoading && !(trend.items || []).length" class="chart-empty">暂无趋势数据</div></div></section>
    <section class="panel table-panel"><div class="panel-head"><div><h2>模型单位经济性</h2><p>销售额、成本、毛利和成本覆盖情况</p></div><button class="icon-button" title="刷新模型统计" @click="load"><RefreshCw :size="17" :class="{ spin: modelsLoading }" /></button></div><div class="table-wrap"><table><thead><tr><th>模型</th><th class="number">请求</th><th class="number">Token</th><th class="number">销售额</th><th class="number">总成本</th><th class="number">毛利</th><th class="number">毛利率</th></tr></thead><tbody><tr v-for="row in models.items || []" :key="row.name || row.model"><td><strong>{{ row.name || row.model || '未标注模型' }}</strong></td><td class="number">{{ compact(row.requests) }}</td><td class="number">{{ compact(row.tokens) }}</td><td class="number">{{ money(row.userChargeCny) }}</td><td class="number">{{ money(row.bookedCostCny ?? row.effectiveCostCny) }}</td><td class="number positive">{{ money(row.bookedProfitCny ?? row.profitCny) }}</td><td class="number">{{ percent(row.grossMargin ?? row.margin) }}</td></tr><tr v-if="!modelsLoading && !(models.items || []).length"><td colspan="7" class="table-empty">暂无模型数据</td></tr></tbody></table></div></section>

    <div v-if="detailType" class="modal-layer" @click.self="closeDetail"><section class="modal overview-detail-modal"><header><div><h2>{{ detailTitle }}</h2><p>统计口径与当前顶部时间范围一致</p></div><button class="icon-button" @click="closeDetail"><X :size="19" /></button></header>
      <div v-if="detailType === 'consumption'" class="detail-tabs"><button :class="{ active: detailTab === 'users' }" @click="detailTab = 'users'">用户消费汇总</button><button :class="{ active: detailTab === 'models' }" @click="detailTab = 'models'">模型消费汇总</button></div>
      <div class="detail-metrics"><div><span>总消耗</span><strong>{{ money(consumption) }}</strong></div><div><span>总成本</span><strong>{{ money(totalCost) }}</strong></div><div><span>毛利</span><strong>{{ money(grossProfit) }}</strong></div><div><span>毛利率</span><strong>{{ percent(grossMargin) }}</strong></div></div>
      <div v-if="!detail" class="table-empty">正在读取明细</div>
      <template v-else>
        <div v-if="detailType === 'recharge'" class="detail-summary-note">充值净额 = 充值实收 {{ money(detail.summary?.rechargeReceived) }} - 退款 {{ money(detail.summary?.refunds) }}。</div>
        <div v-else-if="detailType === 'gift'" class="detail-summary-note">包含赠送、兑换和返利等零现金基础的余额入账。</div>
        <div v-else-if="detailType === 'balance'" class="detail-summary-note">仅包含未加入自用账号白名单的正余额用户。</div>
        <div class="table-wrap compact-table">
          <table v-if="detailType === 'recharge'"><thead><tr><th>时间</th><th>流水 / 用户</th><th>类型</th><th>支付方式</th><th class="number">现金金额</th><th class="number">入账余额</th><th>状态</th></tr></thead><tbody><tr v-for="row in detailRows" :key="row.id"><td>{{ dateTime(row.occurredAt) }}</td><td>{{ row.reference || '--' }}<small>{{ row.party || '--' }}</small></td><td>{{ row.type || '--' }}</td><td>{{ row.method || '--' }}</td><td class="number">{{ money(row.baseAmountCny ?? row.amount) }}</td><td class="number">{{ money(row.creditedAmountCny ?? row.creditedAmount) }}</td><td>{{ row.status || '--' }}</td></tr></tbody></table>
          <table v-else-if="detailType === 'gift'"><thead><tr><th>时间</th><th>用户</th><th>入账类型</th><th>来源</th><th class="number">金额</th></tr></thead><tbody><tr v-for="row in detailRows" :key="row.id"><td>{{ dateTime(row.occurredAt) }}</td><td>{{ row.email || row.username || '--' }}</td><td>{{ row.type || '--' }}</td><td>{{ row.action || row.redeemType || row.sourceId || '--' }}</td><td class="number">{{ money(row.amountCny) }}</td></tr></tbody></table>
          <table v-else-if="detailType === 'balance'"><thead><tr><th>用户</th><th class="number">当前余额</th><th class="number">实际消费</th><th class="number">请求</th><th class="number">Token</th><th class="number">成本</th></tr></thead><tbody><tr v-for="row in detailRows" :key="row.id"><td>{{ row.email || row.username || `用户 #${row.id}` }}<small>ID {{ row.id }}</small></td><td class="number">{{ money(row.balanceCny) }}</td><td class="number">{{ money(row.userChargeCny) }}</td><td class="number">{{ compact(row.requests) }}</td><td class="number">{{ compact(row.tokens) }}</td><td class="number">{{ money(row.bookedCostCny ?? row.effectiveCostCny) }}</td></tr></tbody></table>
          <table v-else><thead><tr><th>{{ detailTab === 'users' ? '用户' : '模型' }}</th><th class="number">请求</th><th class="number">Token</th><th class="number"><button class="column-sort" @click="toggleDetailSort('userChargeCny')">实际消费 <ChevronDown :size="13" /></button></th><th class="number">成本</th><th class="number">毛利</th><th class="number">毛利率</th></tr></thead><tbody><tr v-for="row in detailRows" :key="row.id || row.name"><td>{{ row.email || row.username || row.name || row.model || `用户 #${row.id}` }}<small v-if="row.id">ID {{ row.id }}</small></td><td class="number">{{ compact(row.requests) }}</td><td class="number">{{ compact(row.tokens) }}</td><td class="number">{{ money(row.userChargeCny) }}</td><td class="number">{{ money(row.bookedCostCny ?? row.effectiveCostCny) }}</td><td class="number positive">{{ money(row.bookedProfitCny ?? row.profitCny) }}</td><td class="number">{{ percent(row.grossMargin ?? row.margin) }}</td></tr></tbody></table>
        </div>
        <div v-if="!detailRows.length" class="table-empty">暂无明细</div>
        <div v-if="detailPages > 1" class="pager"><button class="small-button" :disabled="detailPage <= 1" @click="detailPage--; loadDetail()">上一页</button><span>第 {{ detailPage }} / {{ detailPages }} 页，共 {{ detail.total }} 条</span><button class="small-button" :disabled="detailPage >= detailPages" @click="detailPage++; loadDetail()">下一页</button></div>
      </template>
    </section></div>
  </div>
</template>
