<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ChevronDown, RefreshCw, Search, ShieldCheck, UserRoundCheck, UserRoundX, Users, X } from 'lucide-vue-next';
import { get, query, rangeQuery, send } from '../api';

type AnyRecord = Record<string, any>;
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
let searchTimer: number | undefined;
let loadRequestId = 0;
const rows = computed(() => data.value.items || []);
const pages = computed(() => Math.max(1, Math.ceil(Number(data.value.total || 0) / pageSize)));
const money = (value: any) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 }).format(Number(value || 0));
const compact = (value: any) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value || 0));
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
    emit('toast', excludeFromBalanceStats ? '已加入自用账号白名单' : '已恢复余额统计');
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
    emit('toast', user.excludeFromBalanceStats ? '已恢复余额统计' : '已加入自用账号白名单');
    await Promise.all([load(), loadWhitelist()]);
  } catch (error: any) { emit('toast', error.message); }
}
watch(search, () => { window.clearTimeout(searchTimer); searchTimer = window.setTimeout(() => { page.value = 1; load(); }, 250); });
watch(() => props.refreshToken, () => {
  page.value = 1;
  detail.value = null;
  load();
});
onMounted(load);
</script>

<template>
  <div class="page-view user-finance-view">
    <div class="user-toolbar"><label class="search-box"><Search :size="17" /><input v-model="search" placeholder="搜索邮箱或用户名" /></label><button class="icon-button" title="刷新列表" aria-label="刷新列表" @click="load"><RefreshCw :size="17" :class="{ spin: loading }" /></button><button class="secondary-button" @click="openWhitelist"><ShieldCheck :size="16" />自用账号白名单</button><span class="selection-text">已选择 {{ selected.size }} 位</span><button class="secondary-button" :disabled="!selected.size" @click="updateSelected(true)"><UserRoundX :size="16" />加入白名单</button><button class="secondary-button" :disabled="!selected.size" @click="updateSelected(false)"><UserRoundCheck :size="16" />恢复余额统计</button><span v-if="loading" class="loading-note"><RefreshCw :size="15" class="spin" />更新中</span></div>
    <section class="panel table-panel">
      <div class="panel-head"><div><h2>用户核算</h2><p>点击用户查看充值和消费明细；白名单只排除余额统计，不影响消费与成本</p></div><Users :size="20" class="head-icon" /></div>
      <div class="table-wrap"><table class="user-table"><thead><tr><th><input type="checkbox" title="选择当前页" @change="togglePageSelection(($event.target as HTMLInputElement).checked)" /></th><th>用户</th><th v-for="column in [['cashPaidCny','现金实收'],['adminCreditCny','管理员加款'],['adminDeductionCny','管理员扣款'],['balanceCny','当前余额'],['userChargeCny','实际消费'],['requests','请求'],['tokens','Token'],['bookedCostCny','总成本'],['bookedProfitCny','毛利']]" :key="column[0]" class="number"><button class="column-sort" @click="toggleSort(column[0])">{{ column[1] }} <ChevronDown :size="13" /></button></th><th class="number">毛利率</th><th>成本覆盖</th></tr></thead><tbody>
        <tr v-if="loading && !rows.length"><td colspan="13" class="table-empty">正在读取用户数据</td></tr>
        <tr v-for="user in rows" :key="user.id"><td><input type="checkbox" :checked="selected.has(Number(user.id))" @change="toggleSelection(Number(user.id), ($event.target as HTMLInputElement).checked)" /></td><td><button class="link-button" @click="loadDetail(user)">{{ user.email || user.username || `用户 #${user.id}` }}</button><small>ID {{ user.id }}<template v-if="user.username && user.username !== user.email"> · {{ user.username }}</template><template v-if="user.excludeFromBalanceStats"> · 自用账号白名单</template></small></td><td class="number">{{ money(user.cashPaidCny) }}</td><td class="number">{{ money(user.adminCreditCny) }}</td><td class="number">{{ money(user.adminDeductionCny) }}</td><td class="number">{{ money(user.balanceCny) }}</td><td class="number">{{ money(user.userChargeCny) }}</td><td class="number">{{ compact(user.requests) }}</td><td class="number">{{ compact(user.tokens) }}</td><td class="number">{{ money(user.bookedCostCny || user.effectiveCostCny) }}</td><td class="number positive">{{ money(user.bookedProfitCny) }}</td><td class="number">{{ percent(user.grossMargin) }}</td><td><span class="status-pill" :class="user.costCoverageStatus === 'complete' ? 'success' : 'warning'">{{ user.costCoverageStatus === 'complete' ? '已覆盖' : '部分覆盖' }}</span></td></tr>
        <tr v-if="!loading && !rows.length"><td colspan="13" class="table-empty">没有找到用户</td></tr>
      </tbody></table></div>
      <div v-if="pages > 1" class="pager"><button class="small-button" :disabled="page <= 1" @click="page--; load()">上一页</button><span>第 {{ page }} / {{ pages }} 页，共 {{ data.total }} 位用户</span><button class="small-button" :disabled="page >= pages" @click="page++; load()">下一页</button></div>
    </section>

    <div v-if="detail" class="modal-layer" @click.self="detail = null"><section class="modal user-detail-modal"><header><div><h2>{{ detail.user?.email || detail.user?.username || '用户详情' }}</h2><p>ID {{ detail.user?.id }} · {{ detail.user?.status || 'active' }}</p></div><button class="icon-button" @click="detail = null"><X :size="19" /></button></header><div class="supplier-metrics user-detail-metrics"><div><span>充值实收</span><strong>{{ money(detail.user?.rechargeCny) }}</strong><small>到账额度 {{ money(detail.user?.creditedCny) }}</small></div><div><span>实际消费</span><strong>{{ money(detail.user?.consumptionCny) }}</strong><small>{{ compact(detail.user?.requests) }} 次请求</small></div><div><span>当前余额</span><strong>{{ money(detail.user?.balanceCny) }}</strong><small>{{ detail.user?.excludeFromBalanceStats ? '已排除余额统计' : '参与余额统计' }}</small></div><div><span>管理员调整</span><strong>{{ money(Number(detail.user?.adminCreditCny || 0) - Number(detail.user?.adminDeductionCny || 0)) }}</strong><small>加款 {{ money(detail.user?.adminCreditCny) }} · 扣款 {{ money(detail.user?.adminDeductionCny) }}</small></div></div><div class="detail-tabs"><button :class="{ active: detailTab === 'usage' }" @click="detailTab = 'usage'">消费明细 <small>{{ detail.usage?.total || 0 }}</small></button><button :class="{ active: detailTab === 'recharges' }" @click="detailTab = 'recharges'">充值明细 <small>{{ detail.recharges?.total || 0 }}</small></button></div>
      <div v-if="detailTab === 'usage'" class="table-wrap compact-table"><table><thead><tr><th>时间</th><th>模型</th><th>账号</th><th class="number">Token</th><th class="number">实际消费</th><th class="number">耗时</th></tr></thead><tbody><tr v-for="item in detail.usage?.items || []" :key="item.sourceUsageId"><td>{{ dateTime(item.occurredAt) }}</td><td>{{ item.model || '--' }}</td><td>#{{ item.accountId || item.sourceAccountId || '--' }}</td><td class="number">{{ compact(item.tokens || Number(item.inputTokens || 0) + Number(item.outputTokens || 0)) }}</td><td class="number">{{ money(item.userChargeCny) }}</td><td class="number">{{ item.durationMs ? `${Math.round(item.durationMs / 1000)} 秒` : '--' }}</td></tr><tr v-if="!detail.usage?.items?.length"><td colspan="6" class="table-empty">暂无消费明细</td></tr></tbody></table><div v-if="detail.usage?.total > detail.usage?.pageSize" class="pager"><button class="small-button" :disabled="detailPage.usage <= 1" @click="moveDetailPage('usage', -1)">上一页</button><span>第 {{ detailPage.usage }} 页</span><button class="small-button" :disabled="detailPage.usage * detail.usage.pageSize >= detail.usage.total" @click="moveDetailPage('usage', 1)">下一页</button></div></div>
      <div v-else class="table-wrap compact-table"><table><thead><tr><th>时间</th><th class="number">实收金额</th><th class="number">到账额度</th><th>支付方式</th><th>参考号</th><th>状态</th></tr></thead><tbody><tr v-for="item in detail.recharges?.items || []" :key="item.id"><td>{{ dateTime(item.occurredAt) }}</td><td class="number">{{ money(item.amountCny ?? item.baseAmount) }}</td><td class="number">{{ money(item.creditedCny ?? item.creditedAmount) }}</td><td>{{ item.paymentMethod || '--' }}</td><td>{{ item.reference || '--' }}</td><td>{{ item.status || '--' }}</td></tr><tr v-if="!detail.recharges?.items?.length"><td colspan="6" class="table-empty">暂无充值明细</td></tr></tbody></table><div v-if="detail.recharges?.total > detail.recharges?.pageSize" class="pager"><button class="small-button" :disabled="detailPage.recharges <= 1" @click="moveDetailPage('recharges', -1)">上一页</button><span>第 {{ detailPage.recharges }} 页</span><button class="small-button" :disabled="detailPage.recharges * detail.recharges.pageSize >= detail.recharges.total" @click="moveDetailPage('recharges', 1)">下一页</button></div></div>
    </section></div>

    <div v-if="whitelist" class="modal-layer nested-modal" @click.self="whitelist = null"><section class="modal whitelist-modal"><header><div><h2>自用账号白名单</h2><p>仅从剩余余额统计中排除，消费、成本和利润仍正常计入</p></div><button class="icon-button" @click="whitelist = null"><X :size="19" /></button></header><div class="whitelist-toolbar"><div class="tabs compact-tabs"><button :class="{ active: whitelist.scope === 'whitelist' }" @click="whitelist.scope = 'whitelist'; whitelist.page = 1; loadWhitelist()">当前白名单</button><button :class="{ active: whitelist.scope === 'all' }" @click="whitelist.scope = 'all'; whitelist.page = 1; loadWhitelist()">搜索全部用户</button></div><label class="search-box"><Search :size="16" /><input v-model="whitelist.search" placeholder="搜索邮箱或用户名" @input="whitelist.page = 1; loadWhitelist()" /></label></div><div class="table-wrap compact-table"><table><thead><tr><th>用户</th><th class="number">当前余额</th><th class="number">实际消费</th><th>余额统计</th><th>操作</th></tr></thead><tbody><tr v-for="user in whitelist.data.items || []" :key="user.id"><td>{{ user.email || user.username || `用户 #${user.id}` }}<small>ID {{ user.id }}</small></td><td class="number">{{ money(user.balanceCny) }}</td><td class="number">{{ money(user.userChargeCny) }}</td><td><span class="status-pill" :class="user.excludeFromBalanceStats ? 'warning' : 'success'">{{ user.excludeFromBalanceStats ? '已排除' : '参与统计' }}</span></td><td><button class="small-button" @click="toggleWhitelistUser(user)">{{ user.excludeFromBalanceStats ? '恢复统计' : '加入白名单' }}</button></td></tr><tr v-if="!whitelist.loading && !(whitelist.data.items || []).length"><td colspan="5" class="table-empty">暂无用户</td></tr></tbody></table></div><div v-if="whitelist.data.total > whitelist.data.pageSize" class="pager"><button class="small-button" :disabled="whitelist.page <= 1" @click="whitelist.page--; loadWhitelist()">上一页</button><span>第 {{ whitelist.page }} 页，共 {{ whitelist.data.total }} 位</span><button class="small-button" :disabled="whitelist.page * whitelist.data.pageSize >= whitelist.data.total" @click="whitelist.page++; loadWhitelist()">下一页</button></div></section></div>
  </div>
</template>
