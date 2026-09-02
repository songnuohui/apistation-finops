<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { Edit3, ExternalLink, Plus, RefreshCw, Save, Search, Settings2, Trash2, X } from 'lucide-vue-next';
import { get, send } from '../api';

type AnyRecord = Record<string, any>;

const props = defineProps<{ refreshToken?: number }>();
const emit = defineEmits<{ toast: [message: string] }>();

const groups = ref<AnyRecord[]>([]);
const candidates = ref<AnyRecord[]>([]);
const loading = ref(false);
const saving = ref(false);
const deleting = ref<number | null>(null);
const editor = ref<AnyRecord | null>(null);
const candidatePlatform = ref('');
const candidateSearch = ref('');

const enabledCount = computed(() => groups.value.filter((group) => group.enabled).length);
const platforms = computed(() => [...new Set(candidates.value
  .map((candidate) => String(candidate.platform || '').trim())
  .filter(Boolean))].sort((left, right) => left.localeCompare(right, 'zh-CN')));
const availableCandidates = computed(() => {
  const configured = new Set(groups.value
    .filter((group) => Number(group.id) !== Number(editor.value?.id))
    .map((group) => Number(group.sourceGroupId)));
  const term = candidateSearch.value.trim().toLocaleLowerCase('zh-CN');
  return candidates.value.filter((candidate) => {
    if (String(candidate.status || '').toLowerCase() !== 'active') return false;
    if (configured.has(Number(candidate.sourceGroupId))) return false;
    if (candidatePlatform.value && candidate.platform !== candidatePlatform.value) return false;
    if (!term) return true;
    return [
      candidate.name,
      candidate.platform,
      candidate.defaultModel,
      candidate.latestModel,
      candidate.sourceGroupId,
    ].some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(term));
  });
});

function multiplier(value: any) {
  if (value === null || value === undefined || value === '') return '--';
  return `${Number(value).toFixed(3).replace(/\.?0+$/, '')}x`;
}

function statusLabel(value: any) {
  return ({
    healthy: '运行正常',
    degraded: '部分可用',
    unavailable: '不可用',
    unknown: '等待数据',
  } as Record<string, string>)[String(value || '')] || '等待数据';
}

function statusClass(value: any) {
  return ['healthy'].includes(String(value)) ? 'success'
    : ['unavailable'].includes(String(value)) ? 'danger' : 'warning';
}

function dateTime(value: any) {
  return value
    ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
    : '--';
}

function openEditor(group: AnyRecord | null = null, candidate: AnyRecord | null = null) {
  editor.value = {
    id: group?.id || null,
    name: group?.name || candidate?.name || '',
    sourceGroupId: String(group?.sourceGroupId || candidate?.sourceGroupId || ''),
    modelLabel: group?.modelLabel || candidate?.defaultModel || candidate?.latestModel || '',
    displayMultiplier: group?.displayMultiplier ?? '',
    refreshIntervalSeconds: group?.refreshIntervalSeconds ?? 30,
    displayOrder: group?.displayOrder ?? candidate?.sortOrder ?? 0,
    enabled: group?.enabled ?? true,
    sourceGroupMultiplier: group?.sourceGroupMultiplier ?? candidate?.groupMultiplier ?? null,
  };
}

function syncCandidate() {
  const currentEditor = editor.value;
  if (!currentEditor) return;
  const candidate = candidates.value.find((item) => Number(item.sourceGroupId) === Number(currentEditor.sourceGroupId));
  if (!candidate) return;
  currentEditor.name = candidate.name || currentEditor.name;
  currentEditor.modelLabel = candidate.defaultModel || candidate.latestModel || currentEditor.modelLabel;
  currentEditor.displayOrder = candidate.sortOrder ?? currentEditor.displayOrder;
  currentEditor.sourceGroupMultiplier = candidate.groupMultiplier ?? null;
}

async function load() {
  loading.value = true;
  try {
    const [nextGroups, nextCandidates] = await Promise.all([
      get<AnyRecord[]>('/monitor-groups'),
      get<AnyRecord[]>('/monitor-group-candidates'),
    ]);
    groups.value = Array.isArray(nextGroups) ? nextGroups : [];
    candidates.value = Array.isArray(nextCandidates) ? nextCandidates : [];
  } catch (error: any) {
    emit('toast', error.message);
  } finally {
    loading.value = false;
  }
}

async function saveGroup() {
  if (!editor.value) return;
  saving.value = true;
  try {
    const payload = {
      name: editor.value.name,
      sourceGroupId: Number(editor.value.sourceGroupId),
      modelLabel: editor.value.modelLabel || '',
      displayMultiplier: editor.value.displayMultiplier === '' ? null : editor.value.displayMultiplier,
      refreshIntervalSeconds: Number(editor.value.refreshIntervalSeconds || 30),
      displayOrder: Number(editor.value.displayOrder || 0),
      enabled: Boolean(editor.value.enabled),
    };
    const path = editor.value.id ? `/monitor-groups/${editor.value.id}` : '/monitor-groups';
    await send(path, editor.value.id ? 'PATCH' : 'POST', payload);
    editor.value = null;
    await load();
    emit('toast', '分组监控配置已保存');
  } catch (error: any) {
    emit('toast', error.message);
  } finally {
    saving.value = false;
  }
}

async function deleteGroup(group: AnyRecord) {
  const label = group.name || `分组 #${group.sourceGroupId}`;
  if (!window.confirm(`确定删除监控分组“${label}”吗？\n\n只会删除 FinOps 中的展示配置，不会修改 Sub2API。再次新增同一分组时，将从新的配置时间开始记录。`)) return;
  deleting.value = Number(group.id);
  try {
    await send(`/monitor-groups/${group.id}`, 'DELETE', {});
    if (editor.value?.id === group.id) editor.value = null;
    await load();
    emit('toast', '监控分组已删除');
  } catch (error: any) {
    emit('toast', error.message);
  } finally {
    deleting.value = null;
  }
}

watch(() => props.refreshToken, load);
onMounted(load);
</script>

<template>
  <div class="page-view group-monitor-view">
    <div class="group-monitor-header">
      <div>
        <h2 class="section-title">分组监控</h2>
        <p class="section-subtitle">维护公开监控分组，并为用户显示当前计费倍率</p>
      </div>
      <div class="group-monitor-actions">
        <button class="icon-button" type="button" title="刷新监控配置" aria-label="刷新监控配置" :disabled="loading" @click="load">
          <RefreshCw :size="17" :class="{ spin: loading }" />
        </button>
        <a class="secondary-button monitor-preview-link" href="/monitor" target="_blank" rel="noreferrer"><ExternalLink :size="16" />打开公开监控页</a>
        <button class="primary-button" type="button" @click="openEditor()"><Plus :size="16" />新增监控分组</button>
      </div>
    </div>

    <div class="metric-grid group-monitor-metrics">
      <div class="metric-card"><span>已配置分组</span><strong>{{ groups.length }}</strong><small>仅保留仍处于启用状态的 Sub2API 分组</small></div>
      <div class="metric-card good"><span>当前启用</span><strong>{{ enabledCount }}</strong><small>会出现在公开监控页</small></div>
    </div>

    <section class="panel table-panel">
      <div class="panel-head">
        <div><h2>已配置监控分组</h2><p>当前倍率优先使用 FinOps 自定义值，否则跟随 Sub2API 分组倍率。</p></div>
        <Settings2 :size="20" class="head-icon" />
      </div>
      <div class="table-wrap">
        <table class="group-monitor-table">
          <thead><tr><th>分组</th><th>状态</th><th>当前展示倍率</th><th>Sub2API 倍率</th><th>刷新</th><th>采样起点</th><th>配置方式</th><th>启用</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="group in groups" :key="group.id">
              <td><strong>{{ group.name }}</strong><small>ID {{ group.sourceGroupId }}<template v-if="group.modelLabel"> · {{ group.modelLabel }}</template></small></td>
              <td><span class="status-pill" :class="statusClass(group.status)">{{ statusLabel(group.status) }}</span><small>{{ dateTime(group.lastObservedAt) }}</small></td>
              <td><strong class="group-current-multiplier">{{ multiplier(group.currentMultiplier) }}</strong><small>仅展示当前值</small></td>
              <td><strong>{{ multiplier(group.sourceGroupMultiplier) }}</strong><small>Sub2API 当前值</small></td>
              <td><strong>{{ group.refreshIntervalSeconds }} 秒</strong><small>每组公开页刷新节奏</small></td>
              <td><strong>{{ dateTime(group.historyStartedAt) }}</strong><small>此前数据不会显示</small></td>
              <td><span class="monitor-source-label" :class="{ custom: group.displayMultiplier !== null && group.displayMultiplier !== undefined }">{{ group.displayMultiplier === null || group.displayMultiplier === undefined ? '跟随 Sub2API' : 'FinOps 自定义' }}</span></td>
              <td><span class="status-pill" :class="group.enabled ? 'success' : 'warning'">{{ group.enabled ? '已启用' : '已停用' }}</span></td>
              <td><div class="row-actions"><button class="icon-button mini" type="button" title="编辑分组监控" aria-label="编辑分组监控" @click="openEditor(group)"><Edit3 :size="15" /></button><button class="icon-button mini danger-action" type="button" title="删除监控分组" aria-label="删除监控分组" :disabled="deleting === Number(group.id)" @click="deleteGroup(group)"><RefreshCw v-if="deleting === Number(group.id)" :size="15" class="spin" /><Trash2 v-else :size="15" /></button></div></td>
            </tr>
            <tr v-if="!loading && !groups.length"><td colspan="9" class="table-empty">暂无已配置监控分组，请点击右上角新增监控分组。</td></tr>
            <tr v-if="loading"><td colspan="9" class="table-empty">正在读取分组监控配置</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <div v-if="editor" class="modal-layer" @click.self="editor = null">
      <section class="modal group-monitor-editor-modal">
        <header>
          <div><h2>{{ editor.id ? '编辑监控分组' : '新增监控分组' }}</h2><p>只影响 FinOps 展示与读取节奏，不改变 Sub2API 的探测任务、计费倍率或数据。</p></div>
          <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="editor = null"><X :size="19" /></button>
        </header>
        <div class="form-grid">
          <label class="full-field">Sub2API 分组
            <div class="candidate-filterbar">
              <select v-model="candidatePlatform" aria-label="按平台筛选分组">
                <option value="">全部平台</option>
                <option v-for="platform in platforms" :key="platform" :value="platform">{{ platform }}</option>
              </select>
              <span class="candidate-search"><Search :size="15" /><input v-model="candidateSearch" type="search" placeholder="搜索分组、模型或 ID" /></span>
            </div>
            <select v-model="editor.sourceGroupId" class="candidate-select" @change="syncCandidate">
              <option value="" disabled>请选择分组</option>
              <option v-for="candidate in availableCandidates" :key="candidate.sourceGroupId" :value="String(candidate.sourceGroupId)">
                {{ candidate.name || `分组 #${candidate.sourceGroupId}` }} · {{ candidate.platform || '未知平台' }} · {{ multiplier(candidate.groupMultiplier) }} · ID {{ candidate.sourceGroupId }}
              </option>
            </select>
            <small v-if="!availableCandidates.length" class="candidate-empty">没有可配置的启用分组，请调整筛选或同步 Sub2API 分组目录。</small>
          </label>
          <label>公开显示名称<input v-model="editor.name" maxlength="120" placeholder="例如 GPT Plus 稳定池" /></label>
          <label>模型标签<input v-model="editor.modelLabel" maxlength="120" placeholder="可选" /></label>
          <label>刷新间隔（秒）<input v-model.number="editor.refreshIntervalSeconds" type="number" min="15" max="3600" step="1" /><small>15 - 3600 秒；只控制此分组的页面读取节奏。</small></label>
          <label>展示顺序<input v-model.number="editor.displayOrder" type="number" min="0" max="100000" step="1" /></label>
          <label>自定义展示倍率
            <input v-model="editor.displayMultiplier" type="number" min="0.0001" step="0.0001" placeholder="留空则跟随 Sub2API" />
          </label>
          <label class="toggle-field"><input v-model="editor.enabled" type="checkbox" /><span><strong>在公开监控页显示</strong><small>停用后保留配置，但不会展示给用户。</small></span></label>
        </div>
        <div class="form-note">Sub2API 当前倍率：<strong>{{ multiplier(editor.sourceGroupMultiplier) }}</strong>。自定义值只覆盖 FinOps 页面展示；清空后恢复自动跟随。新建或更换分组后，历史从本次配置时间开始计算。</div>
        <footer><button class="secondary-button" type="button" @click="editor = null">取消</button><button class="primary-button" type="button" :disabled="saving" @click="saveGroup"><RefreshCw v-if="saving" :size="15" class="spin" /><Save v-else :size="15" />保存配置</button></footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
.group-monitor-view{gap:18px}
.group-monitor-header{display:flex;align-items:center;justify-content:space-between;gap:16px}
.section-title{margin:0;color:var(--ink);font-size:18px}
.section-subtitle{margin:4px 0 0;color:var(--muted);font-size:12px}
.group-monitor-actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.monitor-preview-link{display:inline-flex;align-items:center;text-decoration:none}
.group-monitor-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}
.group-monitor-table{min-width:1260px!important}
.group-monitor-table td small{display:block;margin-top:4px;color:var(--muted);font-size:11px}
.group-current-multiplier{color:var(--primary-dark)}
.monitor-source-label{display:inline-flex;padding:4px 8px;border-radius:999px;color:#63758b;background:#eef3f8;font-size:11px}
.monitor-source-label.custom{color:#1658ae;background:#eaf2ff}
.group-monitor-editor-modal{width:min(760px,100%)}
.candidate-filterbar{display:grid;grid-template-columns:160px minmax(0,1fr);gap:9px}
.candidate-search{height:39px;display:flex;align-items:center;gap:8px;padding:0 10px;border:1px solid var(--line);border-radius:7px;background:#fbfdff;color:var(--muted)}
.candidate-search input{width:100%;height:auto;padding:0;border:0;background:transparent;outline:0}
.candidate-select{width:100%}
.candidate-empty{color:var(--muted);font-size:11px}
.form-grid label>small{color:var(--muted);font-size:11px;line-height:16px}
@media(max-width:760px){
  .group-monitor-header{align-items:flex-start;flex-direction:column}
  .group-monitor-actions{width:100%}
  .group-monitor-actions .primary-button{flex:1}
  .group-monitor-metrics{grid-template-columns:1fr}
  .candidate-filterbar{grid-template-columns:1fr}
}
</style>
