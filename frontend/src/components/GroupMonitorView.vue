<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { Activity, CircleDot, Cloud, Database, Edit3, ExternalLink, Megaphone, Play, Plus, RefreshCw, RotateCcw, Save, Search, Settings2, Sparkles, Trash2, X } from 'lucide-vue-next';
import { get, send } from '../api';

type AnyRecord = Record<string, any>;

const props = defineProps<{ refreshToken?: number }>();
const emit = defineEmits<{ toast: [message: string] }>();

const groups = ref<AnyRecord[]>([]);
const candidates = ref<AnyRecord[]>([]);
const loading = ref(false);
const saving = ref(false);
const savingAnnouncement = ref(false);
const savingAdjustment = ref(false);
const applyingAdjustment = ref(false);
const undoingAdjustment = ref(false);
const deleting = ref<number | null>(null);
const running = ref<number | null>(null);
const editor = ref<AnyRecord | null>(null);
const monitorSettings = ref<AnyRecord>({ refreshIntervalSeconds: 60, announcementTitle: '', announcementText: '' });
const announcementTitle = ref('');
const announcementText = ref('');
const candidatePlatform = ref('');
const candidateSearch = ref('');
const providerOptions = [
  { value: 'anthropic', label: 'Anthropic', icon: Activity },
  { value: 'openai', label: 'OpenAI', icon: Sparkles },
  { value: 'gemini', label: 'Gemini', icon: Cloud },
  { value: 'grok', label: 'Grok', icon: CircleDot },
];
const providerLabels: Record<string, string> = Object.fromEntries(
  providerOptions.map((provider) => [provider.value, provider.label]),
);
const apiModeOptions = [
  { value: 'chat_completions', label: 'OpenAI Compatible', hint: '使用 /v1/chat/completions，发送 messages，适合大多数兼容接口。' },
  { value: 'responses', label: 'Responses API', hint: '使用 /v1/responses，发送 instructions + input，适合支持 Responses 的接口。' },
];

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
    pending: '待补充配置',
    unknown: '等待数据',
  } as Record<string, string>)[String(value || '')] || '等待数据';
}

function statusClass(value: any) {
  return ['healthy'].includes(String(value)) ? 'success'
    : ['unavailable'].includes(String(value)) ? 'danger' : 'warning';
}

function providerLabel(value: any) {
  const key = String(value || '').trim().toLowerCase();
  return providerLabels[key] || String(value || '').trim() || '未知平台';
}

function providerClass(value: any) {
  const key = String(value || '').trim().toLowerCase();
  return providerLabels[key] ? `is-${key}` : 'is-unknown';
}

function groupStatus(group: AnyRecord) {
  return group.probeConfigured ? group.status : 'pending';
}

function dateTime(value: any) {
  return value
    ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
    : '--';
}

function parseJson(value: any, fallback: AnyRecord) {
  if (!String(value || '').trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    throw new Error('请求头和请求体覆盖必须是合法 JSON');
  }
}

function openEditor(group: AnyRecord | null = null, candidate: AnyRecord | null = null) {
  const historyAdjustment = group?.historyAdjustment || {};
  editor.value = {
    id: group?.id || null,
    name: group?.name || candidate?.name || '',
    sourceGroupId: String(group?.sourceGroupId || candidate?.sourceGroupId || ''),
    modelLabel: group?.modelLabel || candidate?.defaultModel || candidate?.latestModel || '',
    displayMultiplier: group?.displayMultiplier ?? '',
    refreshIntervalSeconds: group?.refreshIntervalSeconds ?? 60,
    displayOrder: group?.displayOrder ?? candidate?.sortOrder ?? 0,
    enabled: group?.enabled ?? true,
    sourceGroupMultiplier: group?.sourceGroupMultiplier ?? candidate?.groupMultiplier ?? null,
    provider: group?.provider || candidate?.platform || 'openai',
    apiMode: group?.apiMode || 'chat_completions',
    endpoint: group?.endpoint || '',
    apiKey: '',
    apiKeyMasked: group?.apiKeyMasked || '',
    primaryModel: group?.primaryModel || candidate?.defaultModel || candidate?.latestModel || '',
    extraModelsText: Array.isArray(group?.extraModels) ? group.extraModels.join(', ') : '',
    groupName: group?.groupName || candidate?.name || '',
    jitterSeconds: group?.jitterSeconds ?? 0,
    extraHeadersText: JSON.stringify(group?.extraHeaders || {}, null, 2),
    bodyOverrideMode: group?.bodyOverrideMode || 'off',
    bodyOverrideText: JSON.stringify(group?.bodyOverride || {}, null, 2),
    historyAdjustment: {
      availabilityWindow: historyAdjustment.availabilityWindow || '7d',
      targetAvailability: historyAdjustment.targetAvailability ?? '',
      historyGreenifyPercent: historyAdjustment.historyGreenifyPercent ?? 90,
      preserveLatestStatus: historyAdjustment.preserveLatestStatus ?? true,
      reason: '',
      updatedBy: historyAdjustment.updatedBy || '',
      updatedAt: historyAdjustment.updatedAt || null,
      lastBatch: historyAdjustment.lastBatch ? { ...historyAdjustment.lastBatch } : null,
    },
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
  currentEditor.groupName = candidate.name || currentEditor.groupName;
  const provider = String(candidate.platform || '').trim().toLowerCase();
  if (providerOptions.some((item) => item.value === provider)) {
    currentEditor.provider = provider;
    if (provider !== 'openai') currentEditor.apiMode = 'chat_completions';
  }
  if (!currentEditor.primaryModel) currentEditor.primaryModel = candidate.defaultModel || candidate.latestModel || '';
}

function selectProvider(provider: string) {
  if (!editor.value || editor.value.provider === provider) return;
  editor.value.provider = provider;
  if (provider !== 'openai') editor.value.apiMode = 'chat_completions';
}

function providerButtonClass(provider: string) {
  return editor.value?.provider === provider ? 'active' : '';
}

function apiModeButtonClass(mode: string) {
  return editor.value?.apiMode === mode ? 'active' : '';
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
    monitorSettings.value = nextSettings || { refreshIntervalSeconds: 60, announcementTitle: '', announcementText: '' };
    announcementTitle.value = String(monitorSettings.value.announcementTitle || '');
    announcementText.value = String(monitorSettings.value.announcementText || '');
  } catch (error: any) {
    emit('toast', error.message);
  } finally {
    loading.value = false;
  }
}

async function saveAnnouncement() {
  savingAnnouncement.value = true;
  try {
    const saved = await send('/monitor-settings', 'PATCH', {
      refreshIntervalSeconds: Number(monitorSettings.value.refreshIntervalSeconds || 60),
      announcementTitle: announcementTitle.value,
      announcementText: announcementText.value,
    });
    monitorSettings.value = saved || monitorSettings.value;
    announcementTitle.value = String(monitorSettings.value.announcementTitle || '');
    announcementText.value = String(monitorSettings.value.announcementText || '');
    emit('toast', announcementText.value ? '运行公告已保存' : '运行公告已清空');
  } catch (error: any) {
    emit('toast', error.message);
  } finally {
    savingAnnouncement.value = false;
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
      provider: editor.value.provider || 'openai',
      apiMode: editor.value.provider === 'openai' ? (editor.value.apiMode || 'chat_completions') : 'chat_completions',
      endpoint: editor.value.endpoint,
      apiKey: editor.value.apiKey || '',
      primaryModel: editor.value.primaryModel,
      extraModels: String(editor.value.extraModelsText || '').split(',').map((item) => item.trim()).filter(Boolean),
      groupName: editor.value.groupName || '',
      jitterSeconds: Number(editor.value.jitterSeconds || 0),
      extraHeaders: parseJson(editor.value.extraHeadersText, {}),
      bodyOverrideMode: editor.value.bodyOverrideMode || 'off',
      bodyOverride: parseJson(editor.value.bodyOverrideText, {}),
      displayMultiplier: editor.value.displayMultiplier === '' ? null : editor.value.displayMultiplier,
      refreshIntervalSeconds: Number(editor.value.refreshIntervalSeconds || 60),
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

function historyAdjustmentPayload() {
  if (!editor.value?.historyAdjustment) return null;
  const adjustment = editor.value.historyAdjustment;
  const targetAvailability = adjustment.targetAvailability === ''
    || adjustment.targetAvailability === null
    || adjustment.targetAvailability === undefined
    ? null
    : Number(adjustment.targetAvailability);
  return {
    availabilityWindow: adjustment.availabilityWindow || '7d',
    targetAvailability,
    historyGreenifyPercent: Number(adjustment.historyGreenifyPercent),
    preserveLatestStatus: Boolean(adjustment.preserveLatestStatus),
    reason: String(adjustment.reason || '').trim(),
  };
}

function syncEditorAdjustment() {
  if (!editor.value?.id) return;
  const refreshed = groups.value.find((item) => Number(item.id) === Number(editor.value?.id));
  if (!refreshed) return;
  const reason = editor.value.historyAdjustment?.reason || '';
  editor.value.historyAdjustment = {
    availabilityWindow: refreshed.historyAdjustment?.availabilityWindow || '7d',
    targetAvailability: refreshed.historyAdjustment?.targetAvailability ?? '',
    historyGreenifyPercent: refreshed.historyAdjustment?.historyGreenifyPercent ?? 90,
    preserveLatestStatus: refreshed.historyAdjustment?.preserveLatestStatus ?? true,
    reason,
    updatedBy: refreshed.historyAdjustment?.updatedBy || '',
    updatedAt: refreshed.historyAdjustment?.updatedAt || null,
    lastBatch: refreshed.historyAdjustment?.lastBatch
      ? { ...refreshed.historyAdjustment.lastBatch }
      : null,
  };
}

async function saveHistoryAdjustmentSettings() {
  if (!editor.value?.id) return;
  const payload = historyAdjustmentPayload();
  if (!payload) return;
  savingAdjustment.value = true;
  try {
    await send(`/monitor-groups/${editor.value.id}/history-adjustment-settings`, 'PATCH', payload);
    await load();
    syncEditorAdjustment();
    emit('toast', '历史调整参数已保存，尚未修改历史数据');
  } catch (error: any) {
    emit('toast', error.message);
  } finally {
    savingAdjustment.value = false;
  }
}

async function applyHistoryAdjustment() {
  if (!editor.value?.id) return;
  const payload = historyAdjustmentPayload();
  if (!payload || payload.targetAvailability === null || !Number.isFinite(payload.targetAvailability)) {
    emit('toast', '请填写目标可用性');
    return;
  }
  const label = editor.value.name || `分组 #${editor.value.id}`;
  const confirmed = window.confirm(
    `确定对“${label}”执行一次历史调整吗？\n\n`
    + `统计窗口：${payload.availabilityWindow}\n`
    + `目标可用性：${payload.targetAvailability}%\n`
    + `异常状态柱转绿：${payload.historyGreenifyPercent}%\n\n`
    + '本次会直接修改 FinOps 历史记录和日报汇总，后续探针仍会继续自然改变结果。',
  );
  if (!confirmed) return;
  applyingAdjustment.value = true;
  try {
    const result = await send<AnyRecord>(
      `/monitor-groups/${editor.value.id}/history-adjustment/apply`,
      'POST',
      payload,
    );
    await load();
    syncEditorAdjustment();
    const availability = result.resultingAvailability === null
      || result.resultingAvailability === undefined
      ? '暂无日报样本'
      : `${Number(result.resultingAvailability).toFixed(2)}%`;
    emit(
      'toast',
      `历史调整已应用：${result.batch?.changedHistoryCount || 0} 条状态、${result.batch?.changedRollupCount || 0} 条日报，结果 ${availability}`,
    );
  } catch (error: any) {
    emit('toast', error.message);
  } finally {
    applyingAdjustment.value = false;
  }
}

async function undoHistoryAdjustment() {
  if (!editor.value?.id || !editor.value.historyAdjustment?.lastBatch
    || editor.value.historyAdjustment.lastBatch.revertedAt) return;
  if (!window.confirm('确定撤销最近一次历史调整吗？如果后续探针已经改动相关数据，系统会拒绝撤销。')) return;
  undoingAdjustment.value = true;
  try {
    await send(`/monitor-groups/${editor.value.id}/history-adjustment/undo`, 'POST', {});
    await load();
    syncEditorAdjustment();
    emit('toast', '最近一次历史调整已撤销');
  } catch (error: any) {
    emit('toast', error.message);
  } finally {
    undoingAdjustment.value = false;
  }
}

async function runGroup(group: AnyRecord) {
  running.value = Number(group.id);
  try {
    await send(`/monitor-groups/${group.id}/run`, 'POST', {});
    await load();
    emit('toast', '监控检测已完成');
  } catch (error: any) {
    emit('toast', error.message);
  } finally {
    running.value = null;
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

    <section class="panel monitor-announcement-panel">
      <div class="panel-head">
        <div><h2>运行公告</h2><p>显示在公开监控页顶部，留空后不展示公告栏。</p></div>
        <Megaphone :size="20" class="head-icon" />
      </div>
      <label class="monitor-announcement-field">
        <span>公告标题</span>
        <input v-model="announcementTitle" maxlength="200" placeholder="例如：部分分组正在进行例行维护" />
      </label>
      <label class="monitor-announcement-field">
        <span>公告内容</span>
        <textarea v-model="announcementText" maxlength="2000" rows="4" placeholder="例如：GPT Plus 分组正在进行例行维护，预计 10 分钟内恢复。"></textarea>
        <small>支持换行，公开页面按纯文本展示。</small>
      </label>
      <div class="monitor-announcement-footer">
        <span>{{ announcementText.length }}/2000</span>
        <button class="primary-button" type="button" :disabled="savingAnnouncement" @click="saveAnnouncement">
          <RefreshCw v-if="savingAnnouncement" :size="15" class="spin" />
          <Save v-else :size="15" />
          保存公告
        </button>
      </div>
    </section>

    <section class="panel table-panel">
      <div class="panel-head">
        <div><h2>已配置监控分组</h2><p>当前倍率优先使用 FinOps 自定义值，否则跟随 Sub2API 分组倍率。</p></div>
        <Settings2 :size="20" class="head-icon" />
      </div>
      <div class="table-wrap">
        <table class="group-monitor-table">
          <thead><tr><th>分组</th><th>状态</th><th>当前展示倍率</th><th>Sub2API 倍率</th><th>探测</th><th>记录</th><th>启用</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="group in groups" :key="group.id">
              <td><strong>{{ group.name }}</strong><small class="monitor-group-meta"><span class="monitor-provider-tag" :class="providerClass(group.provider)">{{ providerLabel(group.provider) }}</span><span>ID {{ group.sourceGroupId }}</span><template v-if="group.modelLabel"> · {{ group.modelLabel }}</template></small></td>
              <td><span class="status-pill" :class="statusClass(groupStatus(group))">{{ statusLabel(groupStatus(group)) }}</span><small>{{ group.probeConfigured ? dateTime(group.lastObservedAt) : '请补充 Endpoint、API Key 和主模型' }}</small></td>
              <td><strong class="group-current-multiplier">{{ multiplier(group.currentMultiplier) }}</strong><small>仅展示当前值</small></td>
              <td><strong>{{ multiplier(group.sourceGroupMultiplier) }}</strong><small>Sub2API 当前值</small></td>
              <td><strong>{{ group.refreshIntervalSeconds }} 秒</strong><small>{{ group.provider }} · {{ group.primaryModel || '未配置模型' }}</small></td>
              <td><strong>{{ group.history?.length || 0 }} / 60</strong><small>{{ dateTime(group.historyStartedAt) }} 起</small></td>
              <td><span class="status-pill" :class="group.enabled ? 'success' : 'warning'">{{ group.enabled ? '已启用' : '已停用' }}</span></td>
              <td><div class="row-actions"><button class="icon-button mini" type="button" :title="group.probeConfigured ? '立即检测' : '请先补充监控配置'" aria-label="立即检测" :disabled="running === Number(group.id) || !group.enabled || !group.probeConfigured" @click="runGroup(group)"><RefreshCw v-if="running === Number(group.id)" :size="15" class="spin" /><Play v-else :size="15" /></button><button class="icon-button mini" type="button" title="编辑分组监控" aria-label="编辑分组监控" @click="openEditor(group)"><Edit3 :size="15" /></button><button class="icon-button mini danger-action" type="button" title="删除监控分组" aria-label="删除监控分组" :disabled="deleting === Number(group.id)" @click="deleteGroup(group)"><RefreshCw v-if="deleting === Number(group.id)" :size="15" class="spin" /><Trash2 v-else :size="15" /></button></div></td>
            </tr>
            <tr v-if="!loading && !groups.length"><td colspan="8" class="table-empty">暂无已配置监控分组，请点击右上角新增监控分组。</td></tr>
            <tr v-if="loading"><td colspan="8" class="table-empty">正在读取分组监控配置</td></tr>
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
          <label class="full-field">监控平台
            <div class="provider-picker">
              <button
                v-for="provider in providerOptions"
                :key="provider.value"
                type="button"
                :class="['provider-option', providerClass(provider.value), providerButtonClass(provider.value)]"
                :aria-pressed="editor.provider === provider.value"
                @click="selectProvider(provider.value)"
              >
                <component :is="provider.icon" :size="17" />
                <span>{{ provider.label }}</span>
              </button>
            </div>
          </label>
          <label v-if="editor.provider === 'openai'" class="full-field api-mode-field">OpenAI 协议
            <div class="api-mode-picker">
              <button
                v-for="mode in apiModeOptions"
                :key="mode.value"
                type="button"
                :class="['api-mode-option', apiModeButtonClass(mode.value)]"
                :aria-pressed="editor.apiMode === mode.value"
                @click="editor.apiMode = mode.value"
              >
                <strong>{{ mode.label }}</strong>
                <small>{{ mode.hint }}</small>
              </button>
            </div>
          </label>
          <label>探测 Endpoint<input v-model="editor.endpoint" maxlength="500" placeholder="https://api.example.com" /><small>必须是 HTTPS 根地址，不包含路径、查询参数或密钥。</small></label>
          <label>API Key<input v-model="editor.apiKey" type="password" maxlength="2000" autocomplete="new-password" :placeholder="editor.id && editor.apiKeyMasked ? `留空继续使用 ${editor.apiKeyMasked}` : '创建时必填'" /><small>仅加密保存在 FinOps，不会写入 Sub2API。</small></label>
          <label>主模型<input v-model="editor.primaryModel" maxlength="200" placeholder="例如 gpt-5.4" /></label>
          <label>附加模型<input v-model="editor.extraModelsText" maxlength="2000" placeholder="用逗号分隔，可选" /></label>
          <label>分组标识<input v-model="editor.groupName" maxlength="120" placeholder="用于记录和识别，可选" /></label>
          <label>刷新间隔（秒）<input v-model.number="editor.refreshIntervalSeconds" type="number" min="15" max="3600" step="1" /><small>FinOps 独立探测间隔：15 - 3600 秒，默认与 Sub2API 一致为 60 秒。</small></label>
          <label>抖动（秒）<input v-model.number="editor.jitterSeconds" type="number" min="0" :max="Math.max(0, Number(editor.refreshIntervalSeconds || 60) - 15)" step="1" /><small>避免多个分组同时发起探测。</small></label>
          <label>展示顺序<input v-model.number="editor.displayOrder" type="number" min="0" max="100000" step="1" /></label>
          <label>自定义展示倍率
            <input v-model="editor.displayMultiplier" type="number" min="0.0001" step="0.0001" placeholder="留空则跟随 Sub2API" />
          </label>
          <label>自定义请求头 JSON<textarea v-model="editor.extraHeadersText" rows="4" spellcheck="false" placeholder='{"User-Agent":"ApiStation-FinOps"}'></textarea></label>
          <label>请求体覆盖模式<select v-model="editor.bodyOverrideMode"><option value="off">关闭</option><option value="merge">合并默认请求体</option><option value="replace">完全替换请求体</option></select></label>
          <label class="full-field">请求体覆盖 JSON<textarea v-model="editor.bodyOverrideText" rows="5" spellcheck="false" placeholder='{"temperature":0}'></textarea><small>合并模式保护模型、消息和 challenge 字段；替换模式按 Sub2API 规则使用非空响应判定。</small></label>
          <label class="toggle-field"><input v-model="editor.enabled" type="checkbox" /><span><strong>在公开监控页显示</strong><small>停用后保留配置，但不会展示给用户。</small></span></label>
        </div>
        <section v-if="editor.id" class="history-adjustment-section">
          <div class="history-adjustment-head">
            <div>
              <strong>历史数据调整</strong>
              <small>参数按当前监控分组独立保存。</small>
            </div>
            <Database :size="19" />
          </div>
          <div class="form-grid history-adjustment-grid">
            <label>统计窗口
              <select v-model="editor.historyAdjustment.availabilityWindow">
                <option value="7d">最近 7 天</option>
                <option value="15d">最近 15 天</option>
                <option value="30d">最近 30 天</option>
              </select>
            </label>
            <label>目标可用性（%）
              <input v-model.number="editor.historyAdjustment.targetAvailability" type="number" min="0" max="100" step="0.01" placeholder="例如 98.55" />
            </label>
            <label>异常状态柱转绿（%）
              <input v-model.number="editor.historyAdjustment.historyGreenifyPercent" type="number" min="0" max="100" step="0.01" />
            </label>
            <label class="toggle-field">
              <input v-model="editor.historyAdjustment.preserveLatestStatus" type="checkbox" />
              <span><strong>保留最新状态柱</strong><small>不修改当前最新一次探针状态。</small></span>
            </label>
            <label class="full-field">调整原因
              <textarea v-model="editor.historyAdjustment.reason" maxlength="500" rows="3" placeholder="填写本次调整原因，便于审计追溯。"></textarea>
            </label>
          </div>
          <div v-if="editor.historyAdjustment.lastBatch" class="history-adjustment-last">
            <span>最近执行：{{ dateTime(editor.historyAdjustment.lastBatch.createdAt) }}</span>
            <span>状态 {{ editor.historyAdjustment.lastBatch.changedHistoryCount || 0 }} 条</span>
            <span>日报 {{ editor.historyAdjustment.lastBatch.changedRollupCount || 0 }} 条</span>
            <span :class="{ reverted: editor.historyAdjustment.lastBatch.revertedAt }">
              {{ editor.historyAdjustment.lastBatch.revertedAt ? '已撤销' : '已生效' }}
            </span>
          </div>
          <div class="history-adjustment-actions">
            <button class="secondary-button" type="button" :disabled="savingAdjustment || applyingAdjustment || undoingAdjustment" @click="saveHistoryAdjustmentSettings">
              <RefreshCw v-if="savingAdjustment" :size="15" class="spin" />
              <Save v-else :size="15" />
              保存参数
            </button>
            <button
              class="secondary-button danger-action"
              type="button"
              :disabled="undoingAdjustment || applyingAdjustment || !editor.historyAdjustment.lastBatch || editor.historyAdjustment.lastBatch.revertedAt"
              @click="undoHistoryAdjustment"
            >
              <RefreshCw v-if="undoingAdjustment" :size="15" class="spin" />
              <RotateCcw v-else :size="15" />
              撤销最近调整
            </button>
            <button class="primary-button" type="button" :disabled="applyingAdjustment || savingAdjustment || undoingAdjustment" @click="applyHistoryAdjustment">
              <RefreshCw v-if="applyingAdjustment" :size="15" class="spin" />
              <Database v-else :size="15" />
              应用历史调整
            </button>
          </div>
        </section>
        <div class="form-note">Sub2API 当前倍率：<strong>{{ multiplier(editor.sourceGroupMultiplier) }}</strong>。自定义值只覆盖 FinOps 页面展示；清空后恢复自动跟随。修改探测配置或更换分组后，历史从本次配置时间开始计算。</div>
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
.group-monitor-table{min-width:1180px!important}
.group-monitor-table td small{display:block;margin-top:4px;color:var(--muted);font-size:11px}
.group-monitor-table td small.monitor-group-meta{display:flex;align-items:center;flex-wrap:wrap;gap:5px}
.monitor-provider-tag{display:inline-flex;max-width:none;padding:3px 6px;border:1px solid #d1d5db;border-radius:4px;background:#f3f4f6;color:#4b5563;font-size:9px;font-weight:800;line-height:1.1}
.monitor-provider-tag.is-openai{border-color:#b9e8d2;background:#e5f8ef;color:#047857}
.monitor-provider-tag.is-anthropic{border-color:#f4c7ab;background:#fff1e8;color:#c2410c}
.monitor-provider-tag.is-gemini{border-color:#b7dff2;background:#e3f5fd;color:#0369a1}
.monitor-provider-tag.is-grok{border-color:#d4d4d8;background:#f0f0f1;color:#3f3f46}
.group-current-multiplier{color:var(--primary-dark)}
.monitor-announcement-field{display:grid;gap:7px;color:#53677f;font-size:11px}
.monitor-announcement-field textarea{width:100%;padding:10px 11px;border:1px solid var(--line);border-radius:7px;resize:vertical;background:#fbfdff;color:var(--ink);font:inherit;line-height:1.6}
.monitor-announcement-field textarea:focus{border-color:#8eb5ea;background:#fff;box-shadow:0 0 0 3px rgba(49,119,219,.1);outline:0}
.monitor-announcement-field small{color:var(--muted);font-size:11px}
.monitor-announcement-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:13px;color:var(--muted);font-size:11px}
.monitor-source-label{display:inline-flex;padding:4px 8px;border-radius:999px;color:#63758b;background:#eef3f8;font-size:11px}
.monitor-source-label.custom{color:#1658ae;background:#eaf2ff}
.group-monitor-editor-modal{width:min(920px,100%)}
.provider-picker{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}
.provider-option{min-width:0;min-height:42px;display:flex;align-items:center;justify-content:center;gap:7px;padding:0 10px;border:1px solid var(--line);border-radius:7px;background:#fff;color:#52657c;font-size:12px;transition:border-color .16s ease,background-color .16s ease,color .16s ease,box-shadow .16s ease}
.provider-option:hover{background:#f7faff}
.provider-option.active{box-shadow:0 0 0 1px currentColor}
.provider-option.is-openai:hover,.provider-option.is-openai.active{border-color:#059669;background:#effcf8;color:#047857}
.provider-option.is-anthropic:hover,.provider-option.is-anthropic.active{border-color:#ea580c;background:#fff4ec;color:#c2410c}
.provider-option.is-gemini:hover,.provider-option.is-gemini.active{border-color:#0284c7;background:#edf9fe;color:#0369a1}
.provider-option.is-grok:hover,.provider-option.is-grok.active{border-color:#71717a;background:#f4f4f5;color:#3f3f46}
.api-mode-field{padding:12px;border:1px solid #cfe0fa;border-radius:7px;background:#f5f9ff}
.api-mode-picker{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}
.api-mode-option{display:grid;gap:4px;padding:11px 12px;border:1px solid #cfe0fa;border-radius:7px;background:#fff;color:#53657a;text-align:left}
.api-mode-option:hover{border-color:#8db3e8}
.api-mode-option.active{border-color:#11a78e;background:#effcf8;color:#087d68;box-shadow:0 0 0 1px #11a78e}
.api-mode-option strong{font-size:12px}
.api-mode-option small{color:inherit;font-size:10px;line-height:15px}
.candidate-filterbar{display:grid;grid-template-columns:160px minmax(0,1fr);gap:9px}
.candidate-search{height:39px;display:flex;align-items:center;gap:8px;padding:0 10px;border:1px solid var(--line);border-radius:7px;background:#fbfdff;color:var(--muted)}
.candidate-search input{width:100%;height:auto;padding:0;border:0;background:transparent;outline:0}
.candidate-select{width:100%}
.candidate-empty{color:var(--muted);font-size:11px}
.form-grid label>small{color:var(--muted);font-size:11px;line-height:16px}
.history-adjustment-section{margin-top:20px;padding-top:18px;border-top:1px solid var(--line)}
.history-adjustment-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:14px;color:#526b87}
.history-adjustment-head strong,.history-adjustment-head small{display:block}
.history-adjustment-head strong{color:var(--ink);font-size:14px}
.history-adjustment-head small{margin-top:4px;color:var(--muted);font-size:11px}
.history-adjustment-grid{gap:12px}
.history-adjustment-last{display:flex;align-items:center;flex-wrap:wrap;gap:7px 13px;margin-top:13px;color:#63758b;font-size:11px}
.history-adjustment-last span:last-child{color:#08734d;font-weight:700}
.history-adjustment-last span.reverted{color:#a63443}
.history-adjustment-actions{display:flex;align-items:center;justify-content:flex-end;gap:9px;flex-wrap:wrap;margin-top:15px}
@media(max-width:760px){
  .group-monitor-header{align-items:flex-start;flex-direction:column}
  .group-monitor-actions{width:100%}
  .group-monitor-actions .primary-button{flex:1}
  .group-monitor-metrics{grid-template-columns:1fr}
  .monitor-announcement-footer{align-items:stretch;flex-direction:column}
  .monitor-announcement-footer .primary-button{width:100%}
  .candidate-filterbar{grid-template-columns:1fr}
  .provider-picker,.api-mode-picker{grid-template-columns:repeat(2,minmax(0,1fr))}
  .history-adjustment-actions{align-items:stretch;flex-direction:column}
  .history-adjustment-actions button{width:100%}
}
</style>
