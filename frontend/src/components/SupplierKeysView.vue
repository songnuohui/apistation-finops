<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { Activity, ExternalLink, KeyRound, RefreshCw, Search, Trash2, X } from 'lucide-vue-next';
import { get, query, send } from '../api';

type AnyRecord = Record<string, any>;
const props = defineProps<{ refreshToken?: number }>();
const emit = defineEmits<{ toast: [message: string] }>();

const search = ref('');
const loading = ref(false);
const rows = ref<AnyRecord[]>([]);
const detail = ref<AnyRecord | null>(null);
const detailLoading = ref(false);
const deleting = ref<number | null>(null);
let timer: number | undefined;

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
function quota(row: AnyRecord) {
  if (row.quotaRemaining !== null && row.quotaRemaining !== undefined) {
    return `${Number(row.quotaRemaining).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${row.quotaCurrency || ''}`;
  }
  return '--';
}
function statusClass(value: any) {
  const normalized = String(value || '').toLowerCase();
  if (['active', 'ok', 'success', 'resolved'].includes(normalized)) return 'success';
  if (['failed', 'error', 'removed'].includes(normalized)) return 'danger';
  return 'warning';
}
function statusLabel(value: any) {
  return ({ active: '可用', ok: '正常', failed: '失败', pending: '待检查', removed: '已移除', warning: '需关注' } as AnyRecord)[String(value || '').toLowerCase()] || String(value || '--');
}
function marginText(policy: AnyRecord | null) {
  if (!policy) return '未配置';
  const min = policy.targetMarginMin === null || policy.targetMarginMin === undefined ? null : Number(policy.targetMarginMin) * 100;
  const max = policy.targetMarginMax === null || policy.targetMarginMax === undefined ? null : Number(policy.targetMarginMax) * 100;
  if (policy.autoAssignEnabled && min !== null && max !== null) return `自动归组 ${min.toFixed(1)}% - ${max.toFixed(1)}%`;
  return policy.enabled ? `保护 ${Number(policy.minimumMargin || 0) * 100}%` : '已关闭';
}

async function load() {
  loading.value = true;
  try {
    const result = await get(`/supplier-keys?${query({ search: search.value, status: 'active' })}`);
    rows.value = result.items || [];
  } catch (error: any) { notify(error.message); }
  finally { loading.value = false; }
}
async function openDetails(id: number) {
  detailLoading.value = true;
  try { detail.value = await get(`/supplier-keys/${id}/details`); }
  catch (error: any) { notify(error.message); }
  finally { detailLoading.value = false; }
}
function openConnection(id: number) {
  window.history.pushState({}, '', `/suppliers?connection=${id}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
async function deleteKey(row: AnyRecord) {
  if (!window.confirm(`确定删除供应商密钥“${row.name || row.maskedKey || row.id}”吗？关联的 Sub2API 账号也会通过管理接口删除。`)) return;
  deleting.value = Number(row.id);
  try {
    const result = await send(`/supplier-keys/${row.id}`, 'DELETE', {});
    notify(`密钥已删除，已处理 ${result.deletedAccounts?.length || 0} 个关联账号`);
    detail.value = null;
    await load();
  } catch (error: any) { notify(error.message); }
  finally { deleting.value = null; }
}

watch(() => props.refreshToken, () => load());
watch(search, () => {
  window.clearTimeout(timer);
  timer = window.setTimeout(load, 250);
});
onMounted(load);
</script>

<template>
  <div class="page-view supplier-view">
    <div class="toolbar-row">
      <label class="search-box"><Search :size="17" /><input v-model="search" placeholder="搜索供应商、密钥名称、连接或地址" /></label>
      <button class="icon-button" title="刷新密钥列表" aria-label="刷新密钥列表" @click="load"><RefreshCw :size="17" :class="{ spin: loading }" /></button>
      <span v-if="loading" class="loading-note"><RefreshCw :size="15" class="spin" />更新中</span>
    </div>
    <section class="panel table-panel">
      <div class="panel-head">
        <div><h2>上游供应商密钥</h2><p>集中查看密钥倍率、额度、账号关联和利润控制状态。</p></div>
        <KeyRound :size="20" class="head-icon" />
      </div>
      <div class="table-wrap">
        <table class="supplier-table">
          <thead><tr><th>密钥 / 供应商</th><th>上游地址</th><th>上游分组 / 倍率</th><th>状态 / 巡检</th><th>额度</th><th>关联账号</th><th>最近同步</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-if="loading && !rows.length"><td colspan="8" class="table-empty">正在读取供应商密钥</td></tr>
            <tr v-for="row in rows" :key="row.id">
              <td><button class="link-button supplier-name-button" @click="openDetails(row.id)">{{ row.name || row.maskedKey || `密钥 #${row.id}` }}</button><small>{{ row.supplierName }} · {{ row.connectionName }}</small><small>{{ row.maskedKey || row.externalId || '--' }}</small></td>
              <td class="supplier-address"><span class="supplier-cell-text" :title="row.baseUrl">{{ row.baseUrl || '--' }}</span></td>
              <td><strong>{{ row.groupName || '未分组' }}</strong><small>{{ multiplier(row.rateMultiplier) }}</small></td>
              <td><span class="status-pill" :class="statusClass(row.status)">{{ statusLabel(row.status) }}</span><small><span class="status-pill" :class="statusClass(row.lastCheckStatus)">{{ statusLabel(row.lastCheckStatus) }}</span> {{ dateTime(row.lastCheckAt) }}</small></td>
              <td><strong>{{ quota(row) }}</strong><small>{{ row.expiresAt ? `到期 ${dateTime(row.expiresAt)}` : '无到期信息' }}</small></td>
              <td><strong>{{ row.accountCount }} 个</strong><small>{{ row.profitGuardAccountCount }} 个已启用利润控制</small></td>
              <td>{{ dateTime(row.lastCheckAt) }}</td>
              <td><div class="row-actions"><button class="icon-button mini-action" title="查看密钥详情" @click="openDetails(row.id)"><Activity :size="16" /></button><button class="icon-button mini-action danger-action" title="删除供应商密钥" :disabled="deleting === row.id" @click="deleteKey(row)"><Trash2 :size="16" /></button></div></td>
            </tr>
            <tr v-if="!loading && !rows.length"><td colspan="8" class="table-empty">没有找到供应商密钥</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <div v-if="detail || detailLoading" class="modal-layer" @click.self="detail = null">
      <section class="modal supplier-detail-modal">
        <header><div><h2>{{ detail?.key?.name || detail?.key?.maskedKey || '供应商密钥详情' }}</h2><p v-if="detail">{{ detail.key.supplierName }} · {{ detail.key.connectionName }} · {{ detail.key.baseUrl }}</p></div><button class="icon-button" @click="detail = null"><X :size="19" /></button></header>
        <div v-if="detailLoading && !detail" class="table-empty">正在读取密钥详情</div>
        <template v-else-if="detail">
          <div class="supplier-metrics">
            <div><span>上游倍率</span><strong>{{ multiplier(detail.key.rateMultiplier) }}</strong><small>{{ detail.key.groupName || '未分组' }}</small></div>
            <div><span>额度剩余</span><strong>{{ quota(detail.key) }}</strong><small>{{ detail.key.expiresAt ? `到期 ${dateTime(detail.key.expiresAt)}` : '无到期信息' }}</small></div>
            <div><span>关联账号</span><strong>{{ detail.accounts.length }}</strong><small>{{ detail.accounts.filter((item: AnyRecord) => item.profitGuard?.enabled).length }} 个已启用利润控制</small></div>
            <div><span>最近巡检</span><strong>{{ statusLabel(detail.key.lastCheckStatus) }}</strong><small>{{ dateTime(detail.key.lastCheckAt) }}</small></div>
          </div>
          <div class="detail-actionbar"><div><span class="status-pill" :class="statusClass(detail.key.status)">{{ statusLabel(detail.key.status) }}</span></div><div class="row-actions"><button class="secondary-button" @click="openConnection(detail.key.connectionId)"><ExternalLink :size="16" />打开供应商连接</button><button class="secondary-button danger-action" @click="deleteKey(detail.key)"><Trash2 :size="16" />删除密钥</button></div></div>
          <section class="detail-section"><div class="detail-section-head"><div><h3>关联账号与利润控制</h3><p>这里只展示当前密钥关联的账号。</p></div></div><div class="table-wrap compact-table"><table><thead><tr><th>账号</th><th>平台</th><th>状态</th><th>利润控制</th></tr></thead><tbody><tr v-for="account in detail.accounts" :key="account.id"><td><strong>{{ account.name || `账号 #${account.id}` }}</strong><small>ID {{ account.id }}</small></td><td>{{ account.platform || '--' }}</td><td><span class="status-pill" :class="statusClass(account.status)">{{ account.status || '--' }}</span></td><td>{{ marginText(account.profitGuard) }}</td></tr><tr v-if="!detail.accounts.length"><td colspan="4" class="table-empty">当前没有关联账号</td></tr></tbody></table></div></section>
          <section class="detail-section"><div class="detail-section-head"><div><h3>巡检记录</h3></div></div><div class="table-wrap compact-table"><table><thead><tr><th>时间</th><th>结果</th><th>方式</th><th>HTTP</th><th>错误</th></tr></thead><tbody><tr v-for="item in detail.checks" :key="item.id"><td>{{ dateTime(item.checkedAt) }}</td><td><span class="status-pill" :class="statusClass(item.status)">{{ statusLabel(item.status) }}</span></td><td>{{ item.method || '--' }}</td><td>{{ item.httpStatus || '--' }}</td><td>{{ item.errorMessage || item.errorCode || '--' }}</td></tr><tr v-if="!detail.checks.length"><td colspan="5" class="table-empty">暂无巡检记录</td></tr></tbody></table></div></section>
          <section v-if="detail.alerts.length" class="detail-section"><div class="detail-section-head"><div><h3>相关告警</h3></div></div><div class="alert-detail-list"><article v-for="alert in detail.alerts" :key="alert.id" :class="['alert-detail', alert.severity]"><div><strong>{{ alert.title }}</strong><p>{{ alert.message }}</p><small>{{ dateTime(alert.lastSeenAt) }} · {{ alert.status }}</small></div></article></div></section>
        </template>
      </section>
    </div>
  </div>
</template>
