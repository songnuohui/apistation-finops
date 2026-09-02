<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { Edit3, ExternalLink, Plus, RefreshCw, Save, Settings2, X } from 'lucide-vue-next';
import { get, send } from '../api';

type AnyRecord = Record<string, any>;

const props = defineProps<{ refreshToken?: number }>();
const emit = defineEmits<{ toast: [message: string] }>();

const groups = ref<AnyRecord[]>([]);
const candidates = ref<AnyRecord[]>([]);
const settings = ref<AnyRecord>({ refreshIntervalSeconds: 30 });
const loading = ref(false);
const saving = ref(false);
const savingSettings = ref(false);
const editor = ref<AnyRecord | null>(null);

const enabledCount = computed(() => groups.value.filter((group) => group.enabled).length);
const refreshInterval = ref(30);

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
    displayOrder: group?.displayOrder ?? candidate?.sortOrder ?? 0,
    enabled: group?.enabled ?? true,
    sourceGroupMultiplier: group?.sourceGroupMultiplier ?? candidate?.groupMultiplier ?? null,
  };
}

function syncCandidate() {
  if (!editor.value) return;
  const candidate = candidates.value.find((item) => Number(item.sourceGroupId) === Number(editor.value.sourceGroupId));
  if (!candidate) return;
  editor.value.name = candidate.name || editor.value.name;
  editor.value.modelLabel = candidate.defaultModel || candidate.latestModel || editor.value.modelLabel;
  editor.value.displayOrder = candidate.sortOrder ?? editor.value.displayOrder;
  editor.value.sourceGroupMultiplier = candidate.groupMultiplier ?? null;
}

async function load() {
  loading.value = true;
  try {
    const [nextGroups, nextCandidates, nextSettings] = await Promise.all([
      get<AnyRecord[]>('/monitor-groups'),
      get<AnyRecord[]>('/monitor-group-candidates'),
      get<AnyRecord>('/monitor-settings'),
    ]);
    groups.value = Array.isArray(nextGroups) ? nextGroups : [];
    candidates.value = Array.isArray(nextCandidates) ? nextCandidates : [];
    settings.value = nextSettings || { refreshIntervalSeconds: 30 };
    refreshInterval.value = Number(settings.value.refreshIntervalSeconds || 30);
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

async function saveMonitorSettings() {
  savingSettings.value = true;
  try {
    const result = await send('/monitor-settings', 'PATCH', { refreshIntervalSeconds: refreshInterval.value });
    settings.value = result;
    refreshInterval.value = Number(result.refreshIntervalSeconds || refreshInterval.value);
    emit('toast', '监控刷新设置已保存');
  } catch (error: any) {
    emit('toast', error.message);
  } finally {
    savingSettings.value = false;
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

    <section class="panel monitor-settings-panel">
      <div class="panel-head"><div><h2>公开页刷新</h2><p>公开页由 FinOps 服务端只读查询 Sub2API，并使用短时缓存控制访问频率。</p></div><Settings2 :size="20" class="head-icon" /></div>
      <div class="monitor-settings-row">
        <label>自动刷新间隔（秒）<input v-model.number="refreshInterval" type="number" min="5" max="3600" step="1" /></label>
        <button class="secondary-button" type="button" :disabled="savingSettings" @click="saveMonitorSettings"><Save :size="15" />保存刷新设置</button>
      </div>
    </section>

    <div class="metric-grid group-monitor-metrics">
      <div class="metric-card"><span>已配置分组</span><strong>{{ groups.length }}</strong><small>FinOps 手动维护的监控清单</small></div>
      <div class="metric-card good"><span>当前启用</span><strong>{{ enabledCount }}</strong><small>会出现在公开监控页</small></div>
    </div>

    <section class="panel table-panel">
      <div class="panel-head">
        <div><h2>已配置监控分组</h2><p>当前倍率优先使用 FinOps 自定义值，否则跟随 Sub2API 分组倍率。</p></div>
        <Settings2 :size="20" class="head-icon" />
      </div>
      <div class="table-wrap">
        <table class="group-monitor-table">
          <thead><tr><th>分组</th><th>状态</th><th>当前展示倍率</th><th>Sub2API 倍率</th><th>配置方式</th><th>启用</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="group in groups" :key="group.id">
              <td><strong>{{ group.name }}</strong><small>ID {{ group.sourceGroupId }}<template v-if="group.modelLabel"> · {{ group.modelLabel }}</template></small></td>
              <td><span class="status-pill" :class="statusClass(group.status)">{{ statusLabel(group.status) }}</span><small>{{ dateTime(group.lastObservedAt) }}</small></td>
              <td><strong class="group-current-multiplier">{{ multiplier(group.currentMultiplier) }}</strong><small>仅展示当前值</small></td>
              <td><strong>{{ multiplier(group.sourceGroupMultiplier) }}</strong><small>Sub2API 当前值</small></td>
              <td><span class="monitor-source-label" :class="{ custom: group.displayMultiplier !== null && group.displayMultiplier !== undefined }">{{ group.displayMultiplier === null || group.displayMultiplier === undefined ? '跟随 Sub2API' : 'FinOps 自定义' }}</span></td>
              <td><span class="status-pill" :class="group.enabled ? 'success' : 'warning'">{{ group.enabled ? '已启用' : '已停用' }}</span></td>
              <td><button class="icon-button mini" type="button" title="编辑分组监控" aria-label="编辑分组监控" @click="openEditor(group)"><Edit3 :size="15" /></button></td>
            </tr>
            <tr v-if="!loading && !groups.length"><td colspan="7" class="table-empty">暂无已配置监控分组，请点击右上角新增监控分组。</td></tr>
            <tr v-if="loading"><td colspan="7" class="table-empty">正在读取分组监控配置</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <div v-if="editor" class="modal-layer" @click.self="editor = null">
      <section class="modal group-monitor-editor-modal">
        <header>
          <div><h2>{{ editor.id ? '编辑监控分组' : '新增监控分组' }}</h2><p>只影响 FinOps 监控展示，不改变 Sub2API 真实计费倍率。</p></div>
          <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="editor = null"><X :size="19" /></button>
        </header>
        <div class="form-grid">
          <label>Sub2API 分组
            <select v-model="editor.sourceGroupId" @change="syncCandidate">
              <option value="" disabled>请选择分组</option>
              <option v-for="candidate in candidates" :key="candidate.sourceGroupId" :value="String(candidate.sourceGroupId)">{{ candidate.name || `分组 #${candidate.sourceGroupId}` }} · {{ multiplier(candidate.groupMultiplier) }}</option>
            </select>
          </label>
          <label>公开显示名称<input v-model="editor.name" maxlength="120" placeholder="例如 GPT Plus 稳定池" /></label>
          <label>模型标签<input v-model="editor.modelLabel" maxlength="120" placeholder="可选" /></label>
          <label>展示顺序<input v-model.number="editor.displayOrder" type="number" min="0" max="100000" step="1" /></label>
          <label>自定义展示倍率
            <input v-model="editor.displayMultiplier" type="number" min="0.0001" step="0.0001" placeholder="留空则跟随 Sub2API" />
          </label>
          <label class="toggle-field"><input v-model="editor.enabled" type="checkbox" /><span><strong>在公开监控页显示</strong><small>停用后保留配置，但不会展示给用户。</small></span></label>
        </div>
        <div class="form-note">Sub2API 当前倍率：<strong>{{ multiplier(editor.sourceGroupMultiplier) }}</strong>。自定义值只覆盖 FinOps 页面展示；清空后恢复自动跟随。</div>
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
.group-monitor-table{min-width:980px!important}
.group-monitor-table td small{display:block;margin-top:4px;color:var(--muted);font-size:11px}
.group-current-multiplier{color:var(--primary-dark)}
.monitor-source-label{display:inline-flex;padding:4px 8px;border-radius:999px;color:#63758b;background:#eef3f8;font-size:11px}
.monitor-source-label.custom{color:#1658ae;background:#eaf2ff}
.monitor-settings-panel{padding-bottom:18px}
.monitor-settings-row{display:flex;align-items:flex-end;gap:12px}
.monitor-settings-row label{display:grid;gap:6px;color:var(--muted);font-size:11px}
.monitor-settings-row input{width:150px;height:38px;padding:0 10px;border:1px solid var(--line);border-radius:7px;background:#fff;color:var(--ink)}
.group-monitor-editor-modal{width:min(760px,100%)}
@media(max-width:760px){
  .group-monitor-header{align-items:flex-start;flex-direction:column}
  .group-monitor-actions{width:100%}
  .group-monitor-actions .primary-button{flex:1}
  .group-monitor-metrics{grid-template-columns:1fr}
  .monitor-settings-row{align-items:stretch;flex-direction:column}
  .monitor-settings-row input{width:100%}
}
</style>
