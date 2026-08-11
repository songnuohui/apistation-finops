<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  Activity, AlertTriangle, BarChart3, CalendarDays, ChevronDown, CircleDollarSign, DatabaseZap, Download,
  FileText, LayoutDashboard, LogOut, Menu, RefreshCw, Search, ServerCog, Settings2,
  ShieldCheck, Users, WalletCards, X, KeyRound, PlugZap,
} from 'lucide-vue-next';
import { get, query, rangeQuery, send } from './api';
import SupplierManagementView from './components/SupplierManagementView.vue';
import AccountCostsView from './components/AccountCostsView.vue';
import UsageView from './components/UsageView.vue';
import UserFinanceView from './components/UserFinanceView.vue';
import OverviewView from './components/OverviewView.vue';
import OAuthSupplyView from './components/OAuthSupplyView.vue';
import ReplenishmentView from './components/ReplenishmentView.vue';

type AnyRecord = Record<string, any>;

const route = useRoute();
const router = useRouter();
const page = computed(() => String(route.path.split('/')[1] || 'overview'));
const mobileOpen = ref(false);
const range = ref('7d');
const customStart = ref('');
const customEnd = ref('');
const search = ref('');
const toast = ref('');
const loading = ref(false);
const sessionUser = ref<AnyRecord | null>(null);
const overview = ref<AnyRecord>({});
const trend = ref<AnyRecord>({});
const overviewModels = ref<AnyRecord>({});
const runtime = ref<AnyRecord>({});
const users = ref<AnyRecord>({});
const usage = ref<AnyRecord>({});
const accounts = ref<AnyRecord>({});
const suppliers = ref<AnyRecord>({});
const quality = ref<AnyRecord>({});
const detail = ref<AnyRecord | null>(null);
const accountEditor = ref<AnyRecord | null>(null);
const supplierEditor = ref<AnyRecord | null>(null);
const supplierRefreshToken = ref(0);
const accountRefreshToken = ref(0);
const overviewRefreshToken = ref(0);
const userRefreshToken = ref(0);
const usageRefreshToken = ref(0);
const qualityRefreshToken = ref(0);
const supplierKeyRefreshToken = ref(0);
const oauthSupplyRefreshToken = ref(0);
const replenishmentRefreshToken = ref(0);
const activeUsageTab = ref<'users' | 'models' | 'events'>('users');
const sort = ref('userChargeCny');
const direction = ref<'asc' | 'desc'>('desc');
const qualitySort = ref('riskAdjustedScore');
const qualityDirection = ref<'asc' | 'desc'>('desc');

const nav = [
  { id: 'overview', label: '经营总览', icon: LayoutDashboard, group: '经营分析' },
  { id: 'users', label: '用户财务', icon: Users, group: '经营分析' },
  { id: 'usage', label: '总消耗', icon: BarChart3, group: '经营分析' },
  { id: 'accounts', label: '账号成本', icon: WalletCards, group: '资源与成本' },
  { id: 'suppliers', label: '供应商管理', icon: ServerCog, group: '资源与成本' },
  { id: 'oauth-supply', label: 'OAuth Supply', icon: PlugZap, group: '自动化接入' },
  { id: 'replenishment', label: '自动补号', icon: RefreshCw, group: '自动化接入' },
];
const pageMeta: Record<string, [string, string]> = {
  overview: ['经营总览', '现金、消耗、成本与毛利'],
  users: ['用户财务', '充值、实际消费、余额和用户贡献'],
  usage: ['总消耗', '用户和模型两个维度查看实际消耗、成本与利润'],
  accounts: ['账号成本', '账号采购、成本归属、实时成本和毛利'],
  suppliers: ['供应商管理', '连接、密钥、账号分组和供应商质量统一管理'],
  'oauth-supply': ['OAuth Supply 接入', '独立配置客户账号，登录并安全取得采购 Token'],
  replenishment: ['自动补号', '库存、订单、验号、Sub2API 导入和采购成本统一管理'],
};

const supplierTab = computed(() => String(route.query.tab || 'connections'));
const title = computed(() => pageMeta[page.value]?.[0] || 'FinOps');
const subtitle = computed(() => pageMeta[page.value]?.[1] || '');
const formatCny = (value: any) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 }).format(Number(value || 0));
const formatUsd = (value: any) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(value || 0));
const compact = (value: any) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value || 0));
const percent = (value: any) => value === null || value === undefined ? '--' : `${(Number(value) * 100).toFixed(1)}%`;
const dateTime = (value: any) => value ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '--';
const escape = (value: any) => String(value ?? '');
const statusClass = (value: any) => ['ok', 'healthy', 'active', 'complete', 'priced'].includes(String(value)) ? 'success' : ['error', 'failed', 'missing'].includes(String(value)) ? 'danger' : 'warning';
const showRangeControl = computed(() => page.value !== 'suppliers' || supplierTab.value === 'quality');

function showToast(message: string) {
  toast.value = message;
  window.setTimeout(() => { if (toast.value === message) toast.value = ''; }, 3_000);
}

async function loadSession() {
  try {
    const result = await fetch('/auth/session', { credentials: 'same-origin' });
    if (result.status === 401) { window.location.assign('/login'); return; }
    if (result.ok) sessionUser.value = (await result.json()).user;
  } catch {}
}

async function loadOverview() {
  overview.value = {};
  trend.value = {};
  overviewModels.value = {};
  runtime.value = {};
  const params = query(rangeQuery(range.value, customStart.value, customEnd.value));
  await Promise.all([
    get(`/overview-dashboard?${params}`).then((data) => { overview.value = data; }).catch((error) => showToast(error.message)),
    get(`/trend?${params}`).then((data) => { trend.value = data; }).catch((error) => showToast(error.message)),
    get(`/usage/models?${params}&page_size=8&sort=userChargeCny&direction=desc`).then((data) => { overviewModels.value = data; }).catch((error) => showToast(error.message)),
    loadRuntime(),
  ]);
}

async function loadRuntime() {
  try { runtime.value = await get('/runtime?live=1'); } catch (error: any) { showToast(error.message); }
}

async function loadUsers() {
  users.value = {};
  try {
    users.value = await get(`/users?${query({ ...rangeQuery(range.value, customStart.value, customEnd.value), page: 1, page_size: 20, search: search.value, sort: sort.value, direction: direction.value })}`);
  } catch (error: any) { showToast(error.message); }
}

async function loadUsage() {
  usage.value = {};
  try {
    const endpoint = activeUsageTab.value === 'users' ? '/usage/users' : activeUsageTab.value === 'models' ? '/usage/models' : '/usage/events';
    usage.value = await get(`${endpoint}?${query({ ...rangeQuery(range.value, customStart.value, customEnd.value), page: 1, page_size: 30, search: search.value, sort: sort.value, direction: direction.value })}`);
  } catch (error: any) { showToast(error.message); }
}

async function loadAccounts() {
  accounts.value = {};
  try { accounts.value = await get(`/accounts?${query({ ...rangeQuery(range.value, customStart.value, customEnd.value), page: 1, page_size: 30, search: search.value })}`); } catch (error: any) { showToast(error.message); }
}

async function loadSuppliers() {
  suppliers.value = {};
  try { suppliers.value = await get(`/supplier-connections?${query({ search: search.value })}`); } catch (error: any) { showToast(error.message); }
}

async function loadQuality() {
  quality.value = {};
  try { quality.value = await get('/supplier-quality-overview'); } catch (error: any) { showToast(error.message); }
}

async function loadPage() {
  loading.value = true;
  try {
    if (page.value === 'overview') overviewRefreshToken.value += 1;
    else if (page.value === 'users') userRefreshToken.value += 1;
    else if (page.value === 'usage') usageRefreshToken.value += 1;
    else if (page.value === 'accounts') accountRefreshToken.value += 1;
    else if (page.value === 'suppliers') supplierRefreshToken.value += 1;
    else if (page.value === 'supplier-keys') supplierKeyRefreshToken.value += 1;
    else if (page.value === 'supplier-quality') qualityRefreshToken.value += 1;
    else if (page.value === 'oauth-supply') oauthSupplyRefreshToken.value += 1;
    else if (page.value === 'replenishment') replenishmentRefreshToken.value += 1;
  } finally { loading.value = false; }
}

function navigate(id: string) {
  mobileOpen.value = false;
  router.push(`/${id}`);
}

function toggleSort(field: string) {
  if (sort.value === field) direction.value = direction.value === 'desc' ? 'asc' : 'desc';
  else { sort.value = field; direction.value = 'desc'; }
  page.value === 'users' ? loadUsers() : loadUsage();
}

function toggleQualitySort(field: string) {
  if (qualitySort.value === field) qualityDirection.value = qualityDirection.value === 'desc' ? 'asc' : 'desc';
  else { qualitySort.value = field; qualityDirection.value = 'desc'; }
}

async function refresh() {
  await loadPage();
  showToast('数据已刷新');
}

async function openUser(item: AnyRecord) {
  try { detail.value = await get(`/users/${item.id}/details?${query({ ...rangeQuery(range.value, customStart.value, customEnd.value), recharge_page: 1, usage_page: 1, detail_page_size: 10 })}`); } catch (error: any) { showToast(error.message); }
}

function openAccount(item: AnyRecord) {
  accountEditor.value = {
    ...item,
    costMode: item.costMode || 'fixed_purchase',
    basisMode: item.basisMode || 'revenue_backsolve',
    upstreamMultiplier: item.upstreamMultiplier || '',
    cnyPerReferenceUnit: item.cnyPerReferenceUnit || '',
    changeStrategy: 'future_only',
    supplier: item.supplier || '',
    purchaseBatch: item.purchaseBatch || '',
  };
}

async function saveAccount() {
  if (!accountEditor.value) return;
  try {
    await send(`/accounts/${accountEditor.value.id}`, 'PATCH', {
      costMode: accountEditor.value.costMode,
      basisMode: accountEditor.value.basisMode,
      upstreamMultiplier: accountEditor.value.upstreamMultiplier || null,
      cnyPerReferenceUnit: accountEditor.value.cnyPerReferenceUnit || null,
      costProfileId: accountEditor.value.currentCostProfileId || null,
      supplier: accountEditor.value.supplier,
      purchaseBatch: accountEditor.value.purchaseBatch,
      changeStrategy: accountEditor.value.changeStrategy,
      tags: accountEditor.value.tags || [],
    });
    accountEditor.value = null;
    await loadAccounts();
    showToast('账号成本已保存');
  } catch (error: any) { showToast(error.message); }
}

function openSupplier() {
  supplierEditor.value = {
    supplierName: '', supplierNotes: '', name: '', adapterType: 'sub2api', baseUrl: '', authMode: 'password',
    username: '', password: '', accessToken: '', enabled: true, qualityMonitorMode: 'hybrid',
  };
}

async function saveSupplier() {
  if (!supplierEditor.value) return;
  try {
    await send('/supplier-connections', 'POST', {
      supplierName: supplierEditor.value.supplierName,
      supplierNotes: supplierEditor.value.supplierNotes || '',
      name: supplierEditor.value.name,
      adapterType: supplierEditor.value.adapterType,
      baseUrl: supplierEditor.value.baseUrl,
      authMode: supplierEditor.value.authMode,
      enabled: supplierEditor.value.enabled,
      qualityMonitorMode: supplierEditor.value.qualityMonitorMode,
      credentials: {
        username: supplierEditor.value.username,
        password: supplierEditor.value.password,
        accessToken: supplierEditor.value.accessToken,
      },
    });
    supplierEditor.value = null;
    await loadSuppliers();
    showToast('供应商连接已创建');
  } catch (error: any) { showToast(error.message); }
}

async function logout() {
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  window.location.assign('/login');
}

watch(page, () => { search.value = ''; loadPage(); });
watch([range, customStart, customEnd], () => { if (range.value !== 'custom' || (customStart.value && customEnd.value)) loadPage(); });
watch(search, () => {
  const timer = window.setTimeout(() => {
    if (page.value === 'users') loadUsers();
    if (page.value === 'usage') loadUsage();
  }, 280);
  return () => window.clearTimeout(timer);
});
watch([detail, accountEditor, supplierEditor], syncBodyScrollLock);
onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  await loadSession();
  await loadPage();
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  document.body.style.overflow = '';
});

const overviewSummary = computed(() => overview.value.summary || {});
const operations = computed(() => overviewSummary.value.operations || {});
const cash = computed(() => overviewSummary.value.cash || {});
const usageSummary = computed(() => overviewSummary.value.usage || {});
const modelRows = computed(() => overviewModels.value.items || []);
const runtimeUsers = computed(() => runtime.value.users || []);
const userRows = computed(() => users.value.items || []);
const usageRows = computed(() => usage.value.items || []);
const accountRows = computed(() => accounts.value.items || []);
const supplierRows = computed(() => suppliers.value.items || []);
const qualityRows = computed(() => [...(quality.value.items || [])].sort((a, b) => {
  const av = Number(a.score?.[qualitySort.value] ?? a[qualitySort.value] ?? -1);
  const bv = Number(b.score?.[qualitySort.value] ?? b[qualitySort.value] ?? -1);
  return qualityDirection.value === 'desc' ? bv - av : av - bv;
}));

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  mobileOpen.value = false;
  detail.value = null;
  accountEditor.value = null;
  supplierEditor.value = null;
}

function syncBodyScrollLock() {
  document.body.style.overflow = detail.value || accountEditor.value || supplierEditor.value ? 'hidden' : '';
}
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar" :class="{ open: mobileOpen }" aria-label="主导航">
      <div class="brand">
        <div class="brand-mark">AF</div>
        <div><strong>ApiStation FinOps</strong><small>成本与用量中心</small></div>
      </div>
      <nav class="nav">
        <template v-for="group in ['经营分析', '资源与成本', '自动化接入']" :key="group">
          <p class="nav-label">{{ group }}</p>
          <button v-for="item in nav.filter((navItem) => navItem.group === group)" :key="item.id" class="nav-item" :class="{ active: page === item.id }" :aria-current="page === item.id ? 'page' : undefined" @click="navigate(item.id)">
            <component :is="item.icon" :size="18" stroke-width="1.8" /><span>{{ item.label }}</span>
          </button>
        </template>
      </nav>
      <div class="sidebar-bottom">
        <div class="sync-state"><span class="online-dot"></span><div><strong>FinOps 已连接</strong><small>数据独立存储</small></div></div>
        <button class="secondary-button full" type="button" @click="refresh"><RefreshCw :size="16" :class="{ spin: loading }" />刷新数据</button>
      </div>
    </aside>
    <div v-if="mobileOpen" class="mobile-backdrop" @click="mobileOpen = false"></div>
    <main class="main">
      <header class="topbar">
        <div class="heading">
          <button class="icon-button mobile-menu" type="button" title="打开菜单" aria-label="打开菜单" @click="mobileOpen = true"><Menu :size="20" /></button>
          <div><span class="eyebrow">管理控制台 · 财务核算</span><h1>{{ title }}</h1><p>{{ subtitle }}</p></div>
        </div>
        <div class="toolbar">
          <div v-if="showRangeControl" class="range-control">
            <span class="toolbar-label">数据范围</span>
            <div class="range-picker" role="group" aria-label="数据范围">
              <button v-for="item in [['today','今天'],['7d','近 7 天'],['30d','近 30 天'],['month','本月']]" :key="item[0]" type="button" :class="{ active: range === item[0] }" @click="range = item[0]">{{ item[1] }}</button>
              <button class="custom-range-trigger" type="button" :class="{ active: range === 'custom' }" title="自定义时间" @click="range = 'custom'"><CalendarDays :size="14" />自定义</button>
            </div>
          </div>
          <div v-if="range === 'custom'" class="custom-range-fields">
            <label><span>开始</span><input v-model="customStart" type="date" /></label>
            <span class="custom-range-separator">至</span>
            <label><span>结束</span><input v-model="customEnd" type="date" /></label>
          </div>
          <button class="icon-button" type="button" title="刷新" aria-label="刷新" @click="refresh"><RefreshCw :size="18" :class="{ spin: loading }" /></button>
          <div class="user-chip">
            <span class="avatar"><Users :size="17" /></span>
            <span><strong>{{ sessionUser?.username || sessionUser?.email || '财务管理员' }}</strong><small>{{ sessionUser?.email || 'admin' }}</small></span>
            <button class="icon-button mini" type="button" title="退出登录" aria-label="退出登录" @click="logout"><LogOut :size="16" /></button>
          </div>
        </div>
      </header>
      <section class="page-content">
        <div v-if="toast" class="toast" role="status" aria-live="polite">{{ toast }}</div>
        <OverviewView v-if="page === 'overview'" :refresh-token="overviewRefreshToken" :range="range" :range-start="customStart" :range-end="customEnd" @toast="showToast" />
        <div v-else-if="false" class="page-view">
          <div class="metric-grid">
            <Metric title="充值净额" :value="formatCny(Number(cash.rechargeReceived || 0) - Number(cash.refunds || 0))" :hint="`充值 ${formatCny(cash.rechargeReceived)} · 退款 ${formatCny(cash.refunds)}`" />
            <Metric title="赠送金额" :value="formatCny(overview.totals?.giftBalanceCreditCny)" :hint="`${compact(overview.totals?.giftBalanceCreditCount)} 笔非现金入账`" tone="good" />
            <Metric title="总消耗" :value="formatCny(operations.consumptionCny || operations.userChargeCny)" :hint="`${compact(usageSummary.requests)} 次请求`" />
            <Metric title="总成本" :value="formatCny(operations.effectiveCostCny || operations.bookedCostCny)" :hint="`${operations.unbookedAccountCount || 0} 个账号待补成本`" />
            <Metric title="毛利" :value="formatCny(operations.grossProfitCny || operations.bookedProfitCny)" :hint="operations.profitBasis || '按已登记成本计算'" tone="good" />
            <Metric title="毛利率" :value="percent(operations.grossMargin)" hint="毛利 ÷ 实际消耗" tone="good" />
          </div>
          <div class="overview-grid">
            <section class="panel runtime-panel">
              <div class="panel-head"><div><h2>实时并发与排队</h2><p>直接读取 sub2api 实时状态，用户身份来自 FinOps 资料</p></div><Activity :size="20" class="head-icon" /></div>
              <div class="runtime-summary">
                <div><span>队列长度</span><strong>{{ compact(runtime.queue?.queueLength) }}</strong></div>
                <div><span>活动工作线程</span><strong>{{ runtime.queue?.activeWorkers ?? '--' }} / {{ runtime.queue?.workerCount ?? '--' }}</strong></div>
                <div><span>当前用户</span><strong>{{ runtimeUsers.length }}</strong></div>
              </div>
              <div v-if="runtimeUsers.length" class="runtime-list">
                <div v-for="item in runtimeUsers.slice(0, 8)" :key="item.id" class="runtime-row">
                  <div><span class="identity">{{ item.email || item.username || `用户 #${item.id}` }}</span><small>{{ item.username && item.username !== item.email ? item.username : `ID ${item.id}` }}</small></div>
                  <span v-if="item.waitingCount" class="queue-badge">{{ item.waitingCount }} 排队</span>
                  <strong>{{ item.currentConcurrency }} 并发</strong>
                </div>
              </div>
              <div v-else class="empty">当前没有执行中的用户请求</div>
            </section>
            <section class="panel">
              <div class="panel-head"><div><h2>待处理事项</h2><p>需要关注的经营和成本问题</p></div><AlertTriangle :size="20" class="head-icon warning-icon" /></div>
              <div class="alert-list"><div v-for="alert in overviewSummary.alerts || []" :key="alert.title" class="alert-row" :class="alert.severity"><span></span><div><strong>{{ alert.title }}</strong><p>{{ alert.detail }}</p></div></div><div v-if="!(overviewSummary.alerts || []).length" class="empty">没有待处理事项</div></div>
            </section>
          </div>
          <section class="panel">
            <div class="panel-head"><div><h2>经营趋势</h2><p>实际消耗、成本和毛利按日汇总</p></div><BarChart3 :size="20" class="head-icon" /></div>
            <div class="trend-list">
              <div v-for="item in (trend.items || []).slice(-14)" :key="item.day || item.date" class="trend-row">
                <span>{{ item.day || item.date }}</span><div class="trend-bar"><i :style="{ width: `${Math.min(100, Number(item.userChargeCny || 0) / Math.max(1, Number(operations.consumptionCny || 1)) * 100 * 3)}%` }"></i></div><strong>{{ formatCny(item.userChargeCny) }}</strong><small>成本 {{ formatCny(item.bookedCostCny || item.effectiveCostCny) }}</small>
              </div>
              <div v-if="!(trend.items || []).length" class="empty">暂无趋势数据</div>
            </div>
          </section>
          <section class="panel table-panel">
            <div class="panel-head"><div><h2>模型单位经济性</h2><p>销售额、成本、毛利和成本覆盖率</p></div></div>
            <DataTable :columns="['模型','请求','Token','销售额','总成本','毛利','毛利率']" :rows="modelRows" :empty="loading">
              <template #row="{ row }"><td><strong>{{ row.name || row.model || '未标注模型' }}</strong></td><td class="number">{{ compact(row.requests) }}</td><td class="number">{{ compact(row.tokens) }}</td><td class="number">{{ formatCny(row.userChargeCny) }}</td><td class="number">{{ formatCny(row.bookedCostCny || row.effectiveCostCny) }}</td><td class="number positive">{{ formatCny(row.bookedProfitCny || row.profitCny) }}</td><td class="number">{{ percent(row.grossMargin || row.margin) }}</td></template>
            </DataTable>
          </section>
        </div>
        <UserFinanceView v-else-if="page === 'users'" :refresh-token="userRefreshToken" :range="range" :range-start="customStart" :range-end="customEnd" @toast="showToast" />
        <div v-else-if="false" class="page-view">
          <Toolbar v-model="search" placeholder="搜索邮箱、用户名或标签" :loading="loading" />
          <section class="panel table-panel">
            <div class="panel-head"><div><h2>用户消费汇总</h2><p>支持按照实际消费、成本和毛利排序</p></div><Users :size="20" class="head-icon" /></div>
            <DataTable :columns="['用户','实际消耗','请求','Token','总成本','毛利','毛利率','余额']" :rows="userRows" :empty="loading">
              <template #header="{ index }"><button v-if="index > 0" class="column-sort" @click="toggleSort(['userChargeCny','requests','tokens','bookedCostCny','bookedProfitCny','grossMargin','balanceCny'][index - 1])">{{ ['实际消耗','请求','Token','总成本','毛利','毛利率','余额'][index - 1] }} <ChevronDown :size="13" /></button></template>
              <template #row="{ row }"><td><button class="link-button" @click="openUser(row)">{{ row.email || row.username || `用户 #${row.id}` }}</button><small>{{ row.username && row.username !== row.email ? row.username : `ID ${row.id}` }}</small></td><td class="number">{{ formatCny(row.userChargeCny) }}</td><td class="number">{{ compact(row.requests) }}</td><td class="number">{{ compact(row.tokens) }}</td><td class="number">{{ formatCny(row.bookedCostCny || row.effectiveCostCny) }}</td><td class="number positive">{{ formatCny(row.bookedProfitCny || row.grossProfitCny) }}</td><td class="number">{{ percent(row.grossMargin) }}</td><td class="number">{{ formatCny(row.balanceCny) }}</td></template>
            </DataTable>
          </section>
        </div>
        <UsageView v-else-if="page === 'usage'" :refresh-token="usageRefreshToken" :range="range" :range-start="customStart" :range-end="customEnd" @toast="showToast" />
        <div v-else-if="false" class="page-view">
          <Toolbar v-model="search" placeholder="搜索模型或消费记录" :loading="loading" />
          <div class="tabs"><button v-for="tab in [['users','用户消费汇总'],['models','模型消费汇总'],['events','请求明细']]" :key="tab[0]" :class="{ active: activeUsageTab === tab[0] }" @click="activeUsageTab = tab[0]">{{ tab[1] }}</button></div>
          <section class="panel table-panel">
            <div class="panel-head"><div><h2>{{ activeUsageTab === 'users' ? '用户消费汇总' : activeUsageTab === 'models' ? '模型消费汇总' : '请求明细' }}</h2><p>费用列支持排序，成本取 FinOps 成本快照</p></div><FileText :size="20" class="head-icon" /></div>
            <DataTable :columns="activeUsageTab === 'events' ? ['时间','用户','模型','请求费用','成本','状态'] : activeUsageTab === 'models' ? ['模型','请求','Token','销售额','总成本','毛利','毛利率'] : ['用户','请求','Token','销售额','总成本','毛利','毛利率']" :rows="usageRows" :empty="loading">
              <template #header="{ index }"><button v-if="index > 0 && index !== 1" class="column-sort" @click="toggleSort(index === 4 ? 'bookedCostCny' : index === 5 ? 'bookedProfitCny' : 'userChargeCny')">费用排序 <ChevronDown :size="13" /></button></template>
              <template #row="{ row }">
                <template v-if="activeUsageTab === 'events'"><td>{{ dateTime(row.occurredAt || row.createdAt) }}</td><td>{{ row.email || row.username || row.userId || '--' }}</td><td>{{ row.model || '--' }}</td><td class="number">{{ formatCny(row.userChargeCny || row.actualCostCny) }}</td><td class="number">{{ formatCny(row.calculatedCostCny || row.bookedCostCny) }}</td><td><span class="status-pill" :class="statusClass(row.costStatus)">{{ row.costStatus || '已同步' }}</span></td></template>
                <template v-else><td><strong>{{ row.name || row.email || row.username || `用户 #${row.id}` }}</strong></td><td class="number">{{ compact(row.requests) }}</td><td class="number">{{ compact(row.tokens) }}</td><td class="number">{{ formatCny(row.userChargeCny) }}</td><td class="number">{{ formatCny(row.bookedCostCny || row.effectiveCostCny) }}</td><td class="number positive">{{ formatCny(row.bookedProfitCny || row.profitCny) }}</td><td class="number">{{ percent(row.grossMargin || row.margin) }}</td></template>
              </template>
            </DataTable>
          </section>
        </div>
        <AccountCostsView v-else-if="page === 'accounts'" :refresh-token="accountRefreshToken" :range="range" :range-start="customStart" :range-end="customEnd" @toast="showToast" />
        <SupplierManagementView v-else-if="page === 'suppliers'" :refresh-token="supplierRefreshToken + supplierKeyRefreshToken + qualityRefreshToken" :range="range" :range-start="customStart" :range-end="customEnd" @toast="showToast" />
        <OAuthSupplyView v-else-if="page === 'oauth-supply'" :refresh-token="oauthSupplyRefreshToken" @toast="showToast" />
        <ReplenishmentView v-else-if="page === 'replenishment'" :refresh-token="replenishmentRefreshToken" @toast="showToast" />
        <div v-else-if="false" class="page-view">
          <Toolbar v-model="search" placeholder="搜索供应商、模型或密钥" :loading="loading" />
          <section class="panel table-panel">
            <div class="panel-head"><div><h2>供应商质量评分</h2><p>鼠标停在列名旁的问号上查看评分含义；点击列名排序</p></div><ShieldCheck :size="20" class="head-icon" /></div>
            <div class="quality-toolbar"><button v-for="item in [['riskAdjustedScore','综合评分','可靠性、速度、可用性和数据置信度的综合结果'],['priceScore','价格','相同模型和分组下的上游倍率相对价格'],['availabilityScore','可用性','成功请求或监控探测占比'],['latencyScore','首字延迟','TTFT 越低，分数越高'],['stabilityScore','稳定性','连续成功、失败和波动情况']]" :key="item[0]" class="quality-sort" :class="{ active: qualitySort === item[0] }" :title="item[2]" @click="toggleQualitySort(item[0])">{{ item[1] }} <span>?</span><ChevronDown :size="13" /></button></div>
            <DataTable :columns="['供应商','综合评分','价格','可用性','首字延迟','稳定性','置信度','数据状态']" :rows="qualityRows" :empty="loading">
              <template #row="{ row }"><td><strong>{{ row.connection?.supplierName || row.connection?.name || '--' }}</strong><small>{{ row.connection?.name || '' }}</small></td><td class="number score">{{ Number(row.score?.riskAdjustedScore ?? 0).toFixed(1) }}</td><td class="number">{{ row.score?.priceScore === null ? '--' : Number(row.score?.priceScore).toFixed(1) }}</td><td class="number">{{ Number(row.score?.availabilityScore ?? 0).toFixed(1) }}</td><td class="number">{{ row.metrics?.ttftP50Ms ? `${row.metrics.ttftP50Ms} ms` : '--' }}</td><td class="number">{{ Number(row.score?.stabilityScore ?? 0).toFixed(1) }}</td><td class="number">{{ Number(row.score?.confidence ?? 0).toFixed(1) }}</td><td><span class="status-pill" :class="statusClass(row.score?.dataStatus)">{{ row.score?.dataStatus || '--' }}</span></td></template>
            </DataTable>
          </section>
        </div>
      </section>
    </main>
    <div v-if="detail" class="modal-layer" @click.self="detail = null"><section class="modal"><header><div><h2>{{ detail.user?.email || detail.email || '用户详情' }}</h2><p>用户消费和充值明细</p></div><button class="icon-button" @click="detail = null"><X :size="19" /></button></header><div class="detail-metrics"><Metric title="实际消耗" :value="formatCny(detail.summary?.userChargeCny || detail.userChargeCny)" /><Metric title="毛利" :value="formatCny(detail.summary?.bookedProfitCny || detail.bookedProfitCny)" tone="good" /></div><DataTable :columns="['时间','模型','费用','成本']" :rows="detail.usage?.items || detail.usage || []"><template #row="{ row }"><td>{{ dateTime(row.occurredAt || row.createdAt) }}</td><td>{{ row.model || '--' }}</td><td class="number">{{ formatCny(row.userChargeCny || row.actualCostCny) }}</td><td class="number">{{ formatCny(row.calculatedCostCny || row.bookedCostCny) }}</td></template></DataTable></section></div>
    <div v-if="accountEditor" class="modal-layer" @click.self="accountEditor = null"><section class="modal form-modal"><header><div><h2>编辑账号成本</h2><p>{{ accountEditor.name }}</p></div><button class="icon-button" @click="accountEditor = null"><X :size="19" /></button></header><div class="form-grid"><label>成本模式<select v-model="accountEditor.costMode"><option value="probe_multiplier">供应商密钥倍率（自动）</option><option value="manual_multiplier">手动填写倍率</option><option value="fixed_purchase">固定采购成本</option><option value="free">免费账号</option></select></label><label>变更范围<select v-model="accountEditor.changeStrategy"><option value="future_only">仅未来消费</option><option value="current_day">从今天开始</option></select></label><label v-if="accountEditor.costMode === 'manual_multiplier'">进货倍率<input v-model="accountEditor.upstreamMultiplier" type="number" min="0" step="0.0001" placeholder="例如 0.5" /></label><label>成本供应商<input v-model="accountEditor.supplier" placeholder="可选" /></label><label>采购批次 / 密钥<input v-model="accountEditor.purchaseBatch" placeholder="关联供应商密钥或采购批次" /></label><label v-if="accountEditor.costMode === 'fixed_purchase'">说明<input v-model="accountEditor.currentCostNotes" placeholder="固定成本请在成本期间中维护" /></label></div><div class="form-note">供应商密钥关联后直接使用密钥倍率自动计算成本；这里不填写销售倍率。</div><footer><button class="secondary-button" @click="accountEditor = null">取消</button><button class="primary-button" @click="saveAccount">保存成本规则</button></footer></section></div>
    <div v-if="supplierEditor" class="modal-layer" @click.self="supplierEditor = null"><section class="modal form-modal"><header><div><h2>添加供应商连接</h2><p>凭据只会加密保存在 FinOps 自己的数据库</p></div><button class="icon-button" @click="supplierEditor = null"><X :size="19" /></button></header><div class="form-grid"><label>供应商名称<input v-model="supplierEditor.supplierName" placeholder="例如 Sub2API 主站" /></label><label>连接名称<input v-model="supplierEditor.name" placeholder="例如 主账号" /></label><label>类型<select v-model="supplierEditor.adapterType"><option value="sub2api">Sub2API</option><option value="newapi">NewAPI</option><option value="auto">自动识别</option></select></label><label>上游地址<input v-model="supplierEditor.baseUrl" placeholder="https://..." /></label><label>认证方式<select v-model="supplierEditor.authMode"><option value="password">账号密码</option><option value="access_token">访问令牌</option></select></label><label v-if="supplierEditor.authMode === 'password'">管理员账号<input v-model="supplierEditor.username" autocomplete="off" /></label><label v-if="supplierEditor.authMode === 'password'">管理员密码<input v-model="supplierEditor.password" type="password" autocomplete="new-password" /></label><label v-else>访问令牌<input v-model="supplierEditor.accessToken" type="password" autocomplete="new-password" /></label><label>评分模式<select v-model="supplierEditor.qualityMonitorMode"><option value="hybrid">被动 + 主动探测</option><option value="passive">只使用真实消费</option><option value="active">只使用主动探测</option></select></label><label>供应商备注<textarea v-model="supplierEditor.supplierNotes" rows="3" maxlength="2000" placeholder="采购联系人、价格说明或其他内部备注"></textarea></label></div><div class="form-note">FinOps 只读取供应商接口和 sub2api Redis 的实时数据，不会修改上游系统。</div><footer><button class="secondary-button" @click="supplierEditor = null">取消</button><button class="primary-button" @click="saveSupplier">创建连接</button></footer></section></div>
  </div>
</template>

<script lang="ts">
import { defineComponent, h } from 'vue';

const Metric = defineComponent({
  props: { title: String, value: String, hint: String, tone: String },
  setup(props) { return () => h('div', { class: ['metric-card', props.tone] }, [h('span', props.title), h('strong', props.value), h('small', props.hint)]); },
});
const Toolbar = defineComponent({
  props: { modelValue: String, placeholder: String, loading: Boolean },
  emits: ['update:modelValue'],
  setup(props, { emit, slots }) { return () => h('div', { class: 'toolbar-row' }, [
    h('label', { class: 'search-box' }, [h(Search, { size: 17 }), h('input', { value: props.modelValue, placeholder: props.placeholder, onInput: (event: any) => emit('update:modelValue', event.target.value) })]),
    slots.actions?.(),
    props.loading ? h('span', { class: 'loading-note' }, [h(RefreshCw, { size: 15, class: 'spin' }), '更新中']) : null,
  ]); },
});
const DataTable = defineComponent({
  props: { columns: Array, rows: Array, empty: Boolean },
  setup(props, { slots }) { return () => h('div', { class: 'table-wrap' }, [
    h('table', [h('thead', [h('tr', (props.columns || []).map((column: any, index: number) => h('th', { key: column }, slots.header ? slots.header({ index, column }) : column)))]),
      h('tbody', props.empty ? [h('tr', [h('td', { colSpan: props.columns?.length || 1, class: 'table-empty' }, '正在加载数据')])]
        : (props.rows || []).length ? (props.rows || []).map((row: any, index: number) => h('tr', { key: row.id || row.sourceUsageId || row.name || index }, slots.row?.({ row, index })))
          : [h('tr', [h('td', { colSpan: props.columns?.length || 1, class: 'table-empty' }, '暂无数据')])]),
    ]),
  ]); },
});
export default { components: { Metric, Toolbar, DataTable } };
</script>
