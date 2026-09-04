<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { Edit3, Play, Plus, RefreshCw, Save, Search, ShieldCheck, Trash2, X } from 'lucide-vue-next';
import { get, query, send } from '../api';

type AnyRecord = Record<string, any>;

const props = defineProps<{ refreshToken?: number }>();
const emit = defineEmits<{ toast: [message: string] }>();

const loading = ref(false);
const saving = ref(false);
const running = ref(false);
const settings = ref<AnyRecord>({});
const mappings = ref<AnyRecord[]>([]);
const runs = ref<AnyRecord>({ items: [] });
const events = ref<AnyRecord>({ items: [] });
const notifications = ref<AnyRecord>({ items: [] });
const activeTab = ref<'events' | 'runs' | 'notifications'>('events');
const eventStatus = ref('');
const eventSearch = ref('');
const selectedNotification = ref<AnyRecord | null>(null);
const mappingEditor = ref<AnyRecord | null>(null);

const form = ref({
  enabled: false,
  scanIntervalMinutes: 5,
  testMode: true,
  testUserEmails: '',
  testRecipientEmail: '',
  adminEmail: '',
});

const mismatchRows = computed(() => (events.value.items || []).filter((item: AnyRecord) => item.status === 'mismatch'));
const statusLabels: Record<string, string> = {
  matched: '一致',
  allowed_mapping: '合法映射',
  mismatch: '不一致',
  unknown: '字段缺失',
  never: '未扫描',
  running: '扫描中',
  completed: '已完成',
  failed: '失败',
  pending: '待发送',
  sending: '发送中',
  sent: '已发送',
};
const kindLabels: Record<string, string> = { user: '用户邮件', admin: '管理员汇总', test: '测试邮件' };

function copySettings() {
  form.value = {
    enabled: Boolean(settings.value.enabled),
    scanIntervalMinutes: Number(settings.value.scanIntervalMinutes || 5),
    testMode: Boolean(settings.value.testMode),
    testUserEmails: (settings.value.testUserEmails || []).join('\n'),
    testRecipientEmail: settings.value.testRecipientEmail || '',
    adminEmail: settings.value.adminEmail || '',
  };
}

function dateTime(value: any) {
  return value
    ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value))
    : '--';
}

function statusClass(value: any) {
  return ['matched', 'allowed_mapping', 'completed', 'sent'].includes(String(value))
    ? 'success'
    : ['mismatch', 'failed'].includes(String(value)) ? 'danger' : 'warning';
}

function parseEmails(value: string) {
  return [...new Set(value.split(/[,\n]/).map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

async function load() {
  loading.value = true;
  try {
    const [nextSettings, nextMappings, nextRuns, nextEvents, nextNotifications] = await Promise.all([
      get('/model-audit/settings'),
      get('/model-audit/mappings'),
      get('/model-audit/scan-runs?page=1&page_size=20'),
      get(`/model-audit/events?${query({ page: 1, page_size: 50, status: eventStatus.value, search: eventSearch.value })}`),
      get('/model-audit/notifications?page=1&page_size=50'),
    ]);
    settings.value = nextSettings;
    mappings.value = Array.isArray(nextMappings) ? nextMappings : [];
    runs.value = nextRuns || { items: [] };
    events.value = nextEvents || { items: [] };
    notifications.value = nextNotifications || { items: [] };
    copySettings();
  } catch (error: any) {
    emit('toast', error.message);
  } finally {
    loading.value = false;
  }
}

async function saveSettings() {
  saving.value = true;
  try {
    settings.value = await send('/model-audit/settings', 'PATCH', {
      enabled: form.value.enabled,
      scanIntervalMinutes: Number(form.value.scanIntervalMinutes),
      testMode: form.value.testMode,
      testUserEmails: parseEmails(form.value.testUserEmails),
      testRecipientEmail: form.value.testRecipientEmail,
      adminEmail: form.value.adminEmail,
    });
    copySettings();
    emit('toast', '模型审计设置已保存');
  } catch (error: any) {
    emit('toast', error.message);
  } finally {
    saving.value = false;
  }
}

function openMapping(item: AnyRecord | null = null) {
  mappingEditor.value = {
    id: item?.id || null,
    sourceModel: item?.sourceModel || '',
    allowedResponseModel: item?.allowedResponseModel || '',
  };
}

async function saveMapping() {
  if (!mappingEditor.value) return;
  saving.value = true;
  try {
    const path = mappingEditor.value.id
      ? `/model-audit/mappings/${mappingEditor.value.id}`
      : '/model-audit/mappings';
    await send(path, mappingEditor.value.id ? 'PATCH' : 'POST', {
      sourceModel: mappingEditor.value.sourceModel,
      allowedResponseModel: mappingEditor.value.allowedResponseModel,
    });
    mappingEditor.value = null;
    await load();
    emit('toast', '合法模型映射已保存');
  } catch (error: any) {
    emit('toast', error.message);
  } finally {
    saving.value = false;
  }
}

async function deleteMapping(item: AnyRecord) {
  if (!window.confirm(`确定删除“${item.sourceModel}”的合法映射吗？删除后只有完全相同的模型名才会被视为合法。`)) return;
  try {
    await send(`/model-audit/mappings/${item.id}`, 'DELETE', {});
    await load();
    emit('toast', '合法模型映射已删除');
  } catch (error: any) {
    emit('toast', error.message);
  }
}

async function runScan() {
  running.value = true;
  try {
    await send('/model-audit/run', 'POST', {});
    await load();
    emit('toast', '模型审计扫描已完成');
  } catch (error: any) {
    emit('toast', error.message);
  } finally {
    running.value = false;
  }
}

watch(() => props.refreshToken, load);
watch([eventStatus, eventSearch], () => {
  window.setTimeout(() => {
    if (!loading.value) load();
  }, 200);
});
onMounted(load);
</script>

<template>
  <div class="page-view model-audit-view">
    <div class="model-audit-header">
      <div>
        <h2 class="section-title">模型一致性审计</h2>
        <p class="section-subtitle">只读扫描 Sub2API 使用记录，识别上游响应模型与发送模型的不一致。</p>
      </div>
      <div class="model-audit-actions">
        <button class="icon-button" type="button" title="刷新审计数据" aria-label="刷新审计数据" :disabled="loading" @click="load">
          <RefreshCw :size="17" :class="{ spin: loading }" />
        </button>
        <button class="primary-button" type="button" :disabled="running || !settings.enabled" @click="runScan">
          <RefreshCw v-if="running" :size="16" class="spin" /><Play v-else :size="16" />立即扫描
        </button>
      </div>
    </div>

    <div class="metric-grid model-audit-metrics">
      <div class="metric-card" :class="{ good: settings.enabled }"><span>审计开关</span><strong>{{ settings.enabled ? '已启用' : '已停用' }}</strong><small>停用期间不追扫，重新启用从当前时间前 5 分钟开始</small></div>
      <div class="metric-card"><span>扫描间隔</span><strong>{{ settings.scanIntervalMinutes || 5 }} 分钟</strong><small>最低 5 分钟，窗口严格连续不重叠</small></div>
      <div class="metric-card bad"><span>当前异常记录</span><strong>{{ mismatchRows.length }}</strong><small>当前页面显示的最新异常记录</small></div>
      <div class="metric-card"><span>上次扫描</span><strong>{{ dateTime(settings.lastScanCompletedAt) }}</strong><small>{{ statusLabels[settings.lastScanStatus] || settings.lastScanStatus || '未扫描' }}</small></div>
    </div>

    <section class="panel">
      <div class="panel-head"><div><h2>扫描与邮件设置</h2><p>邮件投递复用邮件中心的 SMTP 配置；本功能只保存模型审计自己的扫描和投递记录。</p></div><ShieldCheck :size="20" class="head-icon" /></div>
      <div class="form-grid model-audit-settings-grid">
        <label class="toggle-field"><input v-model="form.enabled" type="checkbox" /><span><strong>启用模型一致性审计</strong><small>后台按配置间隔自动执行扫描。</small></span></label>
        <label class="toggle-field"><input v-model="form.testMode" type="checkbox" /><span><strong>测试模式</strong><small>只对指定用户生成告警，所有邮件只发送到测试收件箱。</small></span></label>
        <label>扫描间隔（分钟）<input v-model.number="form.scanIntervalMinutes" type="number" min="5" max="1440" step="1" /></label>
        <label>管理员汇总邮箱<input v-model="form.adminEmail" type="email" placeholder="admin@example.com" /></label>
        <label v-if="form.testMode" class="wide-field">测试用户邮箱（每行一个）<textarea v-model="form.testUserEmails" rows="3" placeholder="只扫描这些用户的记录"></textarea></label>
        <label v-if="form.testMode">测试收件邮箱<input v-model="form.testRecipientEmail" type="email" placeholder="test@example.com" /></label>
      </div>
      <div class="model-audit-form-footer"><span class="field-hint">严格游标：上次窗口完成后保存的最大（created_at, id）到本次当前时间；没有记录也会推进高水位。</span><button class="primary-button" type="button" :disabled="saving" @click="saveSettings"><RefreshCw v-if="saving" :size="15" class="spin" /><Save v-else :size="15" />保存设置</button></div>
      <div v-if="settings.lastError" class="model-audit-error">{{ settings.lastError }}</div>
    </section>

    <section class="panel table-panel">
      <div class="panel-head"><div><h2>全局合法映射</h2><p>默认只有上游发送模型与上游响应模型完全一致才合法；这里可添加明确的精确映射，不支持正则。</p></div><button class="secondary-button" type="button" @click="openMapping()"><Plus :size="15" />新增映射</button></div>
      <div class="table-wrap">
        <table class="model-audit-table mapping-table"><thead><tr><th>上游发送模型</th><th>允许的响应模型</th><th>更新时间</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="item in mappings" :key="item.id"><td><strong>{{ item.sourceModel }}</strong><small>实际发送给上游</small></td><td><strong>{{ item.allowedResponseModel }}</strong><small>命中后记录为合法映射</small></td><td>{{ dateTime(item.updatedAt) }}</td><td><div class="row-actions"><button class="icon-button mini" type="button" title="编辑映射" aria-label="编辑映射" @click="openMapping(item)"><Edit3 :size="15" /></button><button class="icon-button mini danger-action" type="button" title="删除映射" aria-label="删除映射" @click="deleteMapping(item)"><Trash2 :size="15" /></button></div></td></tr>
            <tr v-if="!loading && !mappings.length"><td colspan="4" class="table-empty">暂无自定义映射，完全相同的模型名默认自动合法。</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel table-panel">
      <div class="panel-head"><div><h2>审计记录</h2><p>异常按扫描窗口记录；用户邮件按邮箱聚合，每个窗口每个用户最多一封。</p></div><div class="model-audit-filterbar"><label class="search-box"><Search :size="16" /><input v-model="eventSearch" placeholder="搜索用户或模型" /></label><select v-model="eventStatus"><option value="">全部状态</option><option value="mismatch">不一致</option><option value="allowed_mapping">合法映射</option><option value="matched">一致</option><option value="unknown">字段缺失</option></select></div></div>
      <div class="compact-tabs model-audit-tabs"><button :class="{ active: activeTab === 'events' }" type="button" @click="activeTab = 'events'">使用记录 <small>{{ events.total || 0 }}</small></button><button :class="{ active: activeTab === 'runs' }" type="button" @click="activeTab = 'runs'">扫描窗口 <small>{{ runs.total || 0 }}</small></button><button :class="{ active: activeTab === 'notifications' }" type="button" @click="activeTab = 'notifications'">邮件记录 <small>{{ notifications.total || 0 }}</small></button></div>
      <div v-if="activeTab === 'events'" class="table-wrap"><table class="model-audit-table"><thead><tr><th>记录时间</th><th>用户邮箱</th><th>请求模型</th><th>上游发送模型</th><th>上游响应模型</th><th>判定</th></tr></thead><tbody><tr v-for="item in events.items || []" :key="item.id"><td>{{ dateTime(item.createdAt) }}</td><td>{{ item.userEmail || `用户 #${item.sourceUserId}` }}</td><td>{{ item.requestedModel || '--' }}</td><td>{{ item.upstreamModel || '--' }}</td><td>{{ item.upstreamResponseModel || '--' }}</td><td><span class="status-pill" :class="statusClass(item.status)">{{ statusLabels[item.status] || item.status }}</span></td></tr><tr v-if="!loading && !(events.items || []).length"><td colspan="6" class="table-empty">暂无审计记录</td></tr></tbody></table></div>
      <div v-else-if="activeTab === 'runs'" class="table-wrap"><table class="model-audit-table"><thead><tr><th>扫描窗口</th><th>状态</th><th>读取</th><th>一致</th><th>合法映射</th><th>异常</th><th>字段缺失</th><th>邮件</th></tr></thead><tbody><tr v-for="item in runs.items || []" :key="item.id"><td>{{ dateTime(item.periodStart) }}<small>至 {{ dateTime(item.periodEnd) }}</small></td><td><span class="status-pill" :class="statusClass(item.status)">{{ statusLabels[item.status] || item.status }}</span><small v-if="item.errorMessage" class="error-text">{{ item.errorMessage }}</small></td><td>{{ item.scannedCount }}</td><td>{{ item.matchedCount }}</td><td>{{ item.allowedMappingCount }}</td><td>{{ item.mismatchCount }}</td><td>{{ item.unknownCount }}</td><td>{{ item.notificationCount }}</td></tr><tr v-if="!loading && !(runs.items || []).length"><td colspan="8" class="table-empty">暂无扫描窗口</td></tr></tbody></table></div>
      <div v-else class="table-wrap"><table class="model-audit-table"><thead><tr><th>时间</th><th>类型</th><th>收件人</th><th>主题</th><th>记录数</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="item in notifications.items || []" :key="item.id"><td>{{ dateTime(item.createdAt) }}</td><td>{{ kindLabels[item.kind] || item.kind }}</td><td>{{ item.recipientEmail || '--' }}</td><td>{{ item.subject }}</td><td>{{ item.eventCount }}</td><td><span class="status-pill" :class="statusClass(item.status)">{{ statusLabels[item.status] || item.status }}</span><small v-if="item.errorMessage" class="error-text">{{ item.errorMessage }}</small></td><td><button class="small-button" type="button" @click="selectedNotification = item">查看正文</button></td></tr><tr v-if="!loading && !(notifications.items || []).length"><td colspan="7" class="table-empty">暂无邮件记录</td></tr></tbody></table></div>
    </section>

    <div v-if="mappingEditor" class="modal-layer" @click.self="mappingEditor = null"><section class="modal form-modal model-audit-modal"><header><div><h2>{{ mappingEditor.id ? '编辑合法映射' : '新增合法映射' }}</h2><p>精确匹配，比较时忽略首尾空格和大小写。</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="mappingEditor = null"><X :size="19" /></button></header><div class="form-grid"><label>上游发送模型<input v-model="mappingEditor.sourceModel" maxlength="200" placeholder="例如 claude-3-7-sonnet" /></label><label>允许的响应模型<input v-model="mappingEditor.allowedResponseModel" maxlength="200" placeholder="例如 claude-3-7-sonnet-20250219" /></label></div><div class="form-note">只有该上游发送模型返回这里配置的响应模型时，才会记录为“合法映射”；完全一致的模型不需要配置。</div><footer><button class="secondary-button" type="button" @click="mappingEditor = null">取消</button><button class="primary-button" type="button" :disabled="saving" @click="saveMapping"><RefreshCw v-if="saving" :size="15" class="spin" /><Save v-else :size="15" />保存映射</button></footer></section></div>
    <div v-if="selectedNotification" class="modal-layer" @click.self="selectedNotification = null"><section class="modal model-audit-notification-modal"><header><div><h2>{{ selectedNotification.subject }}</h2><p>{{ selectedNotification.recipientEmail }} · {{ dateTime(selectedNotification.createdAt) }}</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="selectedNotification = null"><X :size="19" /></button></header><div class="notification-preview"><strong>纯文本正文</strong><pre>{{ selectedNotification.textContent }}</pre><strong>HTML 正文</strong><pre>{{ selectedNotification.htmlContent }}</pre></div></section></div>
  </div>
</template>
