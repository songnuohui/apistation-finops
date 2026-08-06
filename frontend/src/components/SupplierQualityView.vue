<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ChevronDown, FileText, RefreshCw, Search, ShieldCheck } from 'lucide-vue-next';
import { useRouter } from 'vue-router';
import { get } from '../api';

type AnyRecord = Record<string, any>;
const props = defineProps<{ refreshToken?: number }>();
const emit = defineEmits<{ toast: [message: string] }>();
const router = useRouter();
const source = ref<AnyRecord[]>([]);
const loading = ref(false);
const search = ref('');
const mode = ref('all');
const status = ref('all');
const scoreScope = ref('all');
const sort = ref('riskAdjustedScore');
const direction = ref<'asc' | 'desc'>('desc');
const page = ref(1);
const pageSize = 20;
const explanations: Record<string, string> = {
  supplier: '供应商连接是评分汇总入口；评分最小单元实际为连接、密钥和模型。',
  adapter: '供应商系统类型和监控模式。被动监控不额外请求模型，主动探测会按目标发起受控请求。',
  status: '供应商最近一次同步后的连接状态。',
  riskAdjustedScore: '原始综合分乘以可信度修正，并受可用性、连续失败和数据新鲜度限制。',
  rawOverallScore: '价格、可用性、首字延迟和稳定性的加权综合分，尚未应用可信度修正。',
  priceScore: '只比较相同模型；市场最低有效倍率除以当前倍率后换算为 0 到 100 分。',
  availabilityScore: '基于最近 7 天成功样本的 Wilson 置信下界，少量成功样本不会直接得到高分。',
  ttftP50Ms: '首字延迟中位数，代表典型请求体验，越低越好。',
  ttftP95Ms: '首字延迟第 95 百分位，用于观察少量特别慢的长尾请求。',
  stabilityScore: '综合失败比例以及 TTFT P95 与 P50 的长尾差距，越稳定分数越高。',
  confidence: '由样本量、最近成功时间、评分维度覆盖和数据来源质量共同计算。',
  modelCount: '最近 7 天有数据的模型数与纳入评分的模型总数。',
  dataStatus: '说明当前评分是否可推荐、样本不足、可用性不足、连续失败或数据过期。',
  sampleCount: '最近 7 天纳入计算的被动用量、被动监控和主动探测样本总数。',
  lastObservedAt: '该供应商连接最近一条质量观测的时间，不一定是最近一次成功请求。',
};
function notify(message: string) { emit('toast', message); }
function adapterLabel(value: any) { return ({ sub2api: 'Sub2API', newapi: 'NewAPI', openai_compatible: 'OpenAI 兼容', auto: '自动识别' } as Record<string, string>)[String(value || '')] || value || '--'; }
function modeLabel(value: any) { return ({ off: '关闭', passive: '被动监控', active: '主动探测', hybrid: '混合监控' } as Record<string, string>)[String(value || '')] || value || '--'; }
function statusLabel(value: any) { return ({ ok: '正常', warning: '需关注', pending: '待同步', failed: '失败', disabled: '已停用', unsupported: '不支持' } as Record<string, string>)[String(value || '')] || value || '--'; }
function scoreStatusLabel(value: any) { return ({ healthy: '可推荐', ready: '可推荐', insufficient_samples: '样本不足', low_availability: '可用性不足', consecutive_failures: '连续失败', stale: '数据过期', unscored: '暂无评分' } as Record<string, string>)[String(value || '')] || value || '--'; }
function statusClass(value: any) { return ['ok', 'healthy', 'ready'].includes(String(value)) ? 'success' : ['failed', 'consecutive_failures', 'low_availability'].includes(String(value)) ? 'danger' : 'warning'; }
function scoreText(value: any, suffix = '') { return value === null || value === undefined ? '--' : `${Number(value).toFixed(1)}${suffix}`; }
function ms(value: any) { return value === null || value === undefined ? '--' : `${Math.round(Number(value))} ms`; }
function dateTime(value: any) { return value ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '--'; }
function sortValue(item: AnyRecord, key: string): any {
  const connection = item.connection || {};
  const score = item.score || {};
  const metrics = item.metrics || {};
  if (key === 'supplier') return `${connection.supplierName || ''} ${connection.name || ''}`.toLowerCase();
  if (key === 'adapter') return `${adapterLabel(connection.detectedAdapterType || connection.adapterType)} ${modeLabel(connection.qualityMonitorMode)}`.toLowerCase();
  if (key === 'status') return connection.connectionStatus || '';
  if (key === 'dataStatus') return score.dataStatus || '';
  if (key === 'lastObservedAt') return metrics.lastObservedAt ? new Date(metrics.lastObservedAt).getTime() : null;
  if (key in metrics) return metrics[key];
  return score[key];
}
const filtered = computed(() => {
  const needle = search.value.trim().toLowerCase();
  const items = source.value.filter((item) => {
    const connection = item.connection || {};
    const haystack = [connection.supplierName, connection.name, connection.baseUrl, ...(item.models || [])].join(' ').toLowerCase();
    if (needle && !haystack.includes(needle)) return false;
    if (mode.value !== 'all' && connection.qualityMonitorMode !== mode.value) return false;
    if (status.value !== 'all' && connection.connectionStatus !== status.value) return false;
    const scored = item.score?.riskAdjustedScore !== null && item.score?.riskAdjustedScore !== undefined;
    if (scoreScope.value === 'scored' && !scored) return false;
    if (scoreScope.value === 'unscored' && scored) return false;
    return true;
  });
  const sign = direction.value === 'asc' ? 1 : -1;
  return items.sort((a, b) => {
    const left = sortValue(a, sort.value);
    const right = sortValue(b, sort.value);
    if (left === null || left === undefined || left === '') return right === null || right === undefined || right === '' ? 0 : 1;
    if (right === null || right === undefined || right === '') return -1;
    return (typeof left === 'string' ? left.localeCompare(String(right), 'zh-CN') : Number(left) - Number(right)) * sign;
  });
});
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)));
const rows = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize));
function toggleSort(key: string) {
  if (sort.value === key) direction.value = direction.value === 'desc' ? 'asc' : 'desc';
  else { sort.value = key; direction.value = ['supplier', 'adapter', 'status', 'dataStatus'].includes(key) ? 'asc' : 'desc'; }
  page.value = 1;
}
async function load() {
  loading.value = true;
  try { source.value = (await get('/supplier-quality-overview')).items || []; }
  catch (error: any) { notify(error.message); }
  finally { loading.value = false; }
}
function openDetail(id: number) { router.push({ path: '/suppliers', query: { connection: String(id) } }); }
watch([search, mode, status, scoreScope], () => { page.value = 1; });
watch(() => props.refreshToken, load);
onMounted(load);
</script>

<template>
  <div class="page-view supplier-quality-view">
    <div class="quality-filterbar">
      <label class="search-box"><Search :size="17" /><input v-model="search" placeholder="搜索供应商、连接、站点或模型" /></label>
      <label><span>监控模式</span><select v-model="mode"><option value="all">全部模式</option><option value="off">关闭</option><option value="passive">被动监控</option><option value="active">主动探测</option><option value="hybrid">混合监控</option></select></label>
      <label><span>连接状态</span><select v-model="status"><option value="all">全部状态</option><option value="ok">正常</option><option value="warning">需关注</option><option value="pending">待同步</option><option value="failed">失败</option><option value="disabled">已停用</option><option value="unsupported">不支持</option></select></label>
      <label><span>评分状态</span><select v-model="scoreScope"><option value="all">全部评分</option><option value="scored">已有评分</option><option value="unscored">暂无评分</option></select></label>
      <button class="icon-button" title="刷新列表" aria-label="刷新列表" @click="load"><RefreshCw :size="17" :class="{ spin: loading }" /></button>
      <span v-if="loading" class="loading-note"><RefreshCw :size="15" class="spin" />更新中</span>
    </div>
    <section class="panel table-panel">
      <div class="panel-head"><div><h2>供应商质量评分</h2><p>最近 7 天的价格、可用性、首字延迟、稳定性和数据可信度</p></div><ShieldCheck :size="20" class="head-icon" /></div>
      <div class="table-wrap"><table class="quality-table"><thead><tr>
        <th v-for="column in [['supplier','供应商 / 连接'],['adapter','系统 / 模式'],['status','连接状态'],['riskAdjustedScore','风险调整分'],['rawOverallScore','原始分'],['priceScore','价格'],['availabilityScore','可用性'],['ttftP50Ms','TTFT P50'],['ttftP95Ms','TTFT P95'],['stabilityScore','稳定性'],['confidence','可信度'],['modelCount','模型覆盖'],['dataStatus','数据状态'],['sampleCount','样本'],['lastObservedAt','最近采样']]" :key="column[0]"><button class="column-sort" :title="explanations[column[0]]" @click="toggleSort(column[0])">{{ column[1] }} <span class="quality-help">?</span><ChevronDown :size="13" /></button></th><th>操作</th>
      </tr></thead><tbody>
        <tr v-if="loading && !rows.length"><td colspan="16" class="table-empty">正在读取评分数据</td></tr>
        <tr v-for="item in rows" :key="item.connection?.id">
          <td><button class="link-button" @click="openDetail(item.connection.id)">{{ item.connection?.supplierName || '未命名供应商' }}</button><small>{{ item.connection?.name || '默认连接' }}</small><small>{{ (item.models || []).join('、') || '暂无模型样本' }}</small></td>
          <td>{{ adapterLabel(item.connection?.detectedAdapterType || item.connection?.adapterType) }}<small>{{ modeLabel(item.connection?.qualityMonitorMode) }}</small></td>
          <td><span class="status-pill" :class="statusClass(item.connection?.connectionStatus)">{{ statusLabel(item.connection?.connectionStatus) }}</span><small>{{ item.connection?.lastError || '' }}</small></td>
          <td class="number score">{{ scoreText(item.score?.riskAdjustedScore) }}</td><td class="number">{{ scoreText(item.score?.rawOverallScore) }}</td><td class="number">{{ scoreText(item.score?.priceScore) }}<small>{{ item.metrics?.rateMultiplier == null ? '无倍率' : `${Number(item.metrics.rateMultiplier).toFixed(4)}x` }}</small></td><td class="number">{{ scoreText(item.score?.availabilityScore, '%') }}<small>{{ item.metrics?.successSamples || 0 }} / {{ item.metrics?.availabilitySamples || 0 }}</small></td><td class="number">{{ ms(item.metrics?.ttftP50Ms) }}</td><td class="number">{{ ms(item.metrics?.ttftP95Ms) }}</td><td class="number">{{ scoreText(item.score?.stabilityScore) }}<small>{{ item.metrics?.failureCount || 0 }} 次失败</small></td><td class="number">{{ scoreText(item.score?.confidence, '%') }}</td><td class="number">{{ item.metrics?.modelsWithData || 0 }} / {{ item.metrics?.modelCount || 0 }}</td><td><span class="status-pill" :class="statusClass(item.score?.dataStatus)">{{ scoreStatusLabel(item.score?.dataStatus) }}</span></td><td class="number">{{ item.metrics?.sampleCount || 0 }}<small>被动 {{ Number(item.metrics?.passiveUsageSamples || 0) + Number(item.metrics?.passiveMonitorSamples || 0) }} · 主动 {{ item.metrics?.activeProbeSamples || 0 }}</small></td><td>{{ dateTime(item.metrics?.lastObservedAt) }}</td><td><button class="icon-button mini-action" title="查看连接与评分详情" @click="openDetail(item.connection.id)"><FileText :size="15" /></button></td>
        </tr>
        <tr v-if="!loading && !rows.length"><td colspan="16" class="table-empty">没有符合条件的供应商评分</td></tr>
      </tbody></table></div>
      <div v-if="pages > 1" class="pager"><button class="small-button" :disabled="page <= 1" @click="page--">上一页</button><span>第 {{ page }} / {{ pages }} 页，共 {{ filtered.length }} 个连接</span><button class="small-button" :disabled="page >= pages" @click="page++">下一页</button></div>
    </section>
  </div>
</template>
