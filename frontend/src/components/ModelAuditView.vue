<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { Check, CheckSquare, Edit3, Filter, Play, Plus, RefreshCw, Save, Search, ShieldCheck, Trash2, X } from 'lucide-vue-next';
import { get, query, send } from '../api';
import PaginationBar from './PaginationBar.vue';

type AnyRecord = Record<string, any>;
type PageData = { items: AnyRecord[]; total: number; page: number; pageSize: number };

const props = defineProps<{ refreshToken?: number }>();
const emit = defineEmits<{ toast: [message: string] }>();

const loading = ref(false);
const saving = ref(false);
const clearing = ref(false);
const running = ref(false);
const testRunning = ref(false);
const settings = ref<AnyRecord>({});
const mappings = ref<PageData>({ items: [], total: 0, page: 1, pageSize: 20 });
const runs = ref<PageData>({ items: [], total: 0, page: 1, pageSize: 20 });
const events = ref<PageData>({ items: [], total: 0, page: 1, pageSize: 20 });
const notifications = ref<PageData>({ items: [], total: 0, page: 1, pageSize: 20 });

const activeTopTab = ref<'settings' | 'mappings' | 'audit'>('settings');
const activeAuditTab = ref<'events' | 'runs' | 'notifications'>('events');
const mappingPage = ref(1);
const mappingPageSize = ref(20);
const eventPage = ref(1);
const eventPageSize = ref(20);
const runPage = ref(1);
const runPageSize = ref(20);
const notificationPage = ref(1);
const notificationPageSize = ref(20);
const eventSearch = ref('');
const filterStart = ref('');
const filterEnd = ref('');
const appliedStartAt = ref('');
const appliedEndAt = ref('');
const selectedNotification = ref<AnyRecord | null>(null);
const selectedNotificationIds = ref(new Set<number>());
const mappingEditor = ref<AnyRecord | null>(null);
const confirmingNotifications = ref(false);

const form = ref({
  enabled: false,
  scanIntervalMinutes: 5,
  testMode: false,
  notifyUserEmails: true,
  testUserEmails: '',
  testRecipientEmail: '',
  adminEmail: '',
});

function toDateInput(value: Date) {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

const testPeriodStart = ref(toDateInput(new Date(Date.now() - 5 * 60_000)));
const testPeriodEnd = ref(toDateInput(new Date()));

const statusLabels: Record<string, string> = {
  never: '未扫描',
  running: '扫描中',
  completed: '已完成',
  failed: '失败',
  pending: '待发送',
  sending: '发送中',
  needs_confirmation: '待人工确认',
  sent: '已发送',
};
const kindLabels: Record<string, string> = { user: '用户邮件', admin: '管理员汇总', test: '测试邮件' };

function copySettings() {
  form.value = {
    enabled: Boolean(settings.value.enabled),
    scanIntervalMinutes: Number(settings.value.scanIntervalMinutes || 5),
    testMode: Boolean(settings.value.testMode),
    notifyUserEmails: settings.value.notifyUserEmails !== false,
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
  return ['completed', 'sent'].includes(String(value))
    ? 'success'
    : ['failed'].includes(String(value)) ? 'danger' : 'warning';
}

function canConfirmNotification(item: AnyRecord) {
  return ['pending', 'sending', 'needs_confirmation'].includes(String(item.status));
}

const selectableNotificationItems = computed(() => notifications.value.items.filter(canConfirmNotification));
const selectedNotificationCount = computed(() => selectedNotificationIds.value.size);
const allNotificationPageSelected = computed(() => (
  selectableNotificationItems.value.length > 0
  && selectableNotificationItems.value.every((item) => selectedNotificationIds.value.has(Number(item.id)))
));

function parseEmails(value: string) {
  return [...new Set(value.split(/[,\n]/).map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

function safePageData(value: any): PageData {
  return {
    items: Array.isArray(value?.items) ? value.items : [],
    total: Number(value?.total || 0),
    page: Number(value?.page || 1),
    pageSize: Number(value?.pageSize || 20),
  };
}

function auditTimeQuery() {
  return {
    start_at: appliedStartAt.value,
    end_at: appliedEndAt.value,
  };
}

function resetAuditPages() {
  eventPage.value = 1;
  runPage.value = 1;
  notificationPage.value = 1;
  selectedNotificationIds.value = new Set();
}

async function loadSettings() {
  settings.value = await get('/model-audit/settings');
  copySettings();
}

async function loadMappings() {
  mappings.value = safePageData(await get(`/model-audit/mappings?${query({
    page: mappingPage.value,
    page_size: mappingPageSize.value,
  })}`));
  if (mappings.value.page !== mappingPage.value) mappingPage.value = mappings.value.page;
}

async function loadEvents() {
  events.value = safePageData(await get(`/model-audit/events?${query({
    page: eventPage.value,
    page_size: eventPageSize.value,
    search: eventSearch.value,
    ...auditTimeQuery(),
  })}`));
  if (events.value.page !== eventPage.value) eventPage.value = events.value.page;
}

async function loadRuns() {
  runs.value = safePageData(await get(`/model-audit/scan-runs?${query({
    page: runPage.value,
    page_size: runPageSize.value,
    ...auditTimeQuery(),
  })}`));
  if (runs.value.page !== runPage.value) runPage.value = runs.value.page;
}

async function loadNotifications() {
  notifications.value = safePageData(await get(`/model-audit/notifications?${query({
    page: notificationPage.value,
    page_size: notificationPageSize.value,
    ...auditTimeQuery(),
  })}`));
  if (notifications.value.page !== notificationPage.value) notificationPage.value = notifications.value.page;
}

async function loadAuditLists() {
  await Promise.all([loadEvents(), loadRuns(), loadNotifications()]);
}

async function load() {
  loading.value = true;
  try {
    await Promise.all([loadSettings(), loadMappings(), loadEvents(), loadRuns(), loadNotifications()]);
  } catch (error: any) {
    emit('toast', error.message);
  } finally {
    loading.value = false;
  }
}

function applyAuditFilters() {
  if (Boolean(filterStart.value) !== Boolean(filterEnd.value)) {
    emit('toast', '开始时间和结束时间需要同时填写');
    return;
  }
  const start = filterStart.value ? new Date(filterStart.value) : null;
  const end = filterEnd.value ? new Date(filterEnd.value) : null;
  if ((start && !Number.isFinite(start.getTime())) || (end && !Number.isFinite(end.getTime()))) {
    emit('toast', '时间范围无效');
    return;
  }
  if (start && end && start >= end) {
    emit('toast', '开始时间必须早于结束时间');
    return;
  }
  appliedStartAt.value = start ? start.toISOString() : '';
  appliedEndAt.value = end ? end.toISOString() : '';
  resetAuditPages();
  void loadAuditLists().catch((error: any) => emit('toast', error.message));
}

function clearAuditFilters() {
  filterStart.value = '';
  filterEnd.value = '';
  appliedStartAt.value = '';
  appliedEndAt.value = '';
  resetAuditPages();
  void loadAuditLists().catch((error: any) => emit('toast', error.message));
}

const auditScopeLabels: Record<string, string> = {
  events: '不一致记录',
  runs: '扫描窗口',
  notifications: '邮件记录',
};

const activeAuditTotal = computed(() => ({
  events: events.value.total,
  runs: runs.value.total,
  notifications: notifications.value.total,
}[activeAuditTab.value] || 0));

async function clearCurrentAuditList() {
  const scope = activeAuditTab.value;
  const rangeText = appliedStartAt.value && appliedEndAt.value
    ? `时间范围 ${dateTime(appliedStartAt.value)} 至 ${dateTime(appliedEndAt.value)} 内`
    : '全部时间范围内';
  const relationText = scope === 'runs'
    ? '，并同步删除这些扫描窗口关联的不一致记录和邮件记录'
    : '';
  if (!window.confirm(`确定清空${rangeText}的${auditScopeLabels[scope]}吗？${relationText}。此操作不可恢复。`)) return;
  clearing.value = true;
  try {
    const result = await send('/model-audit/clear', 'POST', {
      scope,
      search: scope === 'events' ? eventSearch.value : '',
      startAt: appliedStartAt.value || null,
      endAt: appliedEndAt.value || null,
    });
    resetAuditPages();
    await loadAuditLists();
    emit('toast', `已清空 ${result.totalDeleted || 0} 条审计数据`);
  } catch (error: any) {
    emit('toast', error.message);
  } finally {
    clearing.value = false;
  }
}

function toggleNotificationSelection(id: number, checked: boolean) {
  const next = new Set(selectedNotificationIds.value);
  if (checked) next.add(Number(id));
  else next.delete(Number(id));
  selectedNotificationIds.value = next;
}

function toggleNotificationPageSelection(checked: boolean) {
  const next = new Set(selectedNotificationIds.value);
  selectableNotificationItems.value.forEach((item) => {
    if (checked) next.add(Number(item.id));
    else next.delete(Number(item.id));
  });
  selectedNotificationIds.value = next;
}

async function confirmNotification(item: AnyRecord) {
  confirmingNotifications.value = true;
  try {
    await send(`/model-audit/notifications/${item.id}/confirm`, 'POST', {});
    selectedNotificationIds.value.delete(Number(item.id));
    selectedNotificationIds.value = new Set(selectedNotificationIds.value);
    await loadNotifications();
    emit('toast', '邮件记录已确认发送');
  } catch (error: any) {
    emit('toast', error.message);
  } finally {
    confirmingNotifications.value = false;
  }
}

async function confirmSelectedNotifications() {
  if (!selectedNotificationIds.value.size) return;
  confirmingNotifications.value = true;
  try {
    const result = await send('/model-audit/notifications/confirm', 'POST', {
      ids: [...selectedNotificationIds.value],
    });
    selectedNotificationIds.value = new Set();
    await loadNotifications();
    emit('toast', `已确认 ${result.updated || 0} 条邮件记录`);
  } catch (error: any) {
    emit('toast', error.message);
  } finally {
    confirmingNotifications.value = false;
  }
}

async function confirmAllNotifications() {
  const rangeText = appliedStartAt.value && appliedEndAt.value
    ? `时间范围 ${dateTime(appliedStartAt.value)} 至 ${dateTime(appliedEndAt.value)} 内`
    : '全部时间范围内';
  if (!window.confirm(`确定将${rangeText}所有待确认邮件标记为已发送吗？不会重新发送邮件。`)) return;
  confirmingNotifications.value = true;
  try {
    const result = await send('/model-audit/notifications/confirm-all', 'POST', {
      startAt: appliedStartAt.value || null,
      endAt: appliedEndAt.value || null,
    });
    selectedNotificationIds.value = new Set();
    await loadNotifications();
    emit('toast', `已确认 ${result.updated || 0} 条邮件记录`);
  } catch (error: any) {
    emit('toast', error.message);
  } finally {
    confirmingNotifications.value = false;
  }
}

async function saveSettings() {
  saving.value = true;
  try {
    settings.value = await send('/model-audit/settings', 'PATCH', {
      enabled: form.value.enabled,
      scanIntervalMinutes: Number(form.value.scanIntervalMinutes),
      testMode: form.value.testMode,
      notifyUserEmails: form.value.notifyUserEmails,
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
    mappingPage.value = 1;
    await loadMappings();
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
    await loadMappings();
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

async function runTestScan() {
  testRunning.value = true;
  try {
    await send('/model-audit/test-run', 'POST', {
      periodStart: new Date(testPeriodStart.value).toISOString(),
      periodEnd: new Date(testPeriodEnd.value).toISOString(),
    });
    await load();
    activeTopTab.value = 'audit';
    activeAuditTab.value = 'events';
    emit('toast', '测试扫描已完成，结果已写入审计记录');
  } catch (error: any) {
    emit('toast', error.message);
  } finally {
    testRunning.value = false;
  }
}

async function changeMappingsPage(page: number) {
  mappingPage.value = page;
  await loadMappings();
}

async function changeMappingsPageSize(pageSize: number) {
  mappingPageSize.value = pageSize;
  mappingPage.value = 1;
  await loadMappings();
}

async function changeEventsPage(page: number) {
  eventPage.value = page;
  await loadEvents();
}

async function changeEventsPageSize(pageSize: number) {
  eventPageSize.value = pageSize;
  eventPage.value = 1;
  await loadEvents();
}

async function changeRunsPage(page: number) {
  runPage.value = page;
  await loadRuns();
}

async function changeRunsPageSize(pageSize: number) {
  runPageSize.value = pageSize;
  runPage.value = 1;
  await loadRuns();
}

async function changeNotificationsPage(page: number) {
  notificationPage.value = page;
  await loadNotifications();
}

async function changeNotificationsPageSize(pageSize: number) {
  notificationPageSize.value = pageSize;
  notificationPage.value = 1;
  await loadNotifications();
}

watch(() => props.refreshToken, load);
let searchTimer: number | undefined;
watch(eventSearch, () => {
  window.clearTimeout(searchTimer);
  eventPage.value = 1;
  searchTimer = window.setTimeout(() => { void loadEvents(); }, 250);
});
onMounted(load);

const currentMismatchCount = computed(() => events.value.total || 0);
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
      <div class="metric-card" :class="{ good: settings.enabled }"><span>审计开关</span><strong>{{ settings.enabled ? '已启用' : '已停用' }}</strong><small>重新启用从当前时间前 5 分钟开始</small></div>
      <div class="metric-card"><span>扫描间隔</span><strong>{{ settings.scanIntervalMinutes || 5 }} 分钟</strong><small>最低 1 分钟，窗口严格连续不重叠</small></div>
      <div class="metric-card bad"><span>当前不一致记录</span><strong>{{ currentMismatchCount }}</strong><small>仅保存模型不一致项</small></div>
      <div class="metric-card"><span>上次正式扫描</span><strong>{{ dateTime(settings.lastScanCompletedAt) }}</strong><small>{{ statusLabels[settings.lastScanStatus] || settings.lastScanStatus || '未扫描' }}</small></div>
    </div>

    <nav class="model-audit-top-tabs" aria-label="模型审计功能">
      <button type="button" :class="{ active: activeTopTab === 'settings' }" @click="activeTopTab = 'settings'"><ShieldCheck :size="16" />扫描设置</button>
      <button type="button" :class="{ active: activeTopTab === 'mappings' }" @click="activeTopTab = 'mappings'"><Edit3 :size="16" />全局合法映射 <small>{{ mappings.total }}</small></button>
      <button type="button" :class="{ active: activeTopTab === 'audit' }" @click="activeTopTab = 'audit'"><Search :size="16" />审计记录 <small>{{ events.total }}</small></button>
    </nav>

    <section v-if="activeTopTab === 'settings'" class="panel">
      <div class="panel-head"><div><h2>扫描与邮件设置</h2><p>邮件投递复用邮件中心的 SMTP 配置。</p></div><ShieldCheck :size="20" class="head-icon" /></div>
      <div class="form-grid model-audit-settings-grid">
        <label class="toggle-field"><input v-model="form.enabled" type="checkbox" /><span><strong>启用模型一致性审计</strong><small>后台按配置间隔自动执行扫描。</small></span></label>
        <label class="toggle-field"><input v-model="form.testMode" type="checkbox" /><span><strong>测试模式</strong><small>正式扫描只对指定用户生成测试告警，并发送到测试收件邮箱。</small></span></label>
        <label class="toggle-field"><input v-model="form.notifyUserEmails" type="checkbox" /><span><strong>通知对应用户邮箱</strong><small>开启后向发生模型不一致的用户发送邮件；关闭后只通知管理员。</small></span></label>
        <label>扫描间隔（分钟）<input v-model.number="form.scanIntervalMinutes" type="number" min="1" max="1440" step="1" /></label>
        <label>管理员汇总邮箱<input v-model="form.adminEmail" type="email" placeholder="admin@example.com" /></label>
        <label v-if="form.testMode" class="wide-field">测试用户邮箱（每行一个）<textarea v-model="form.testUserEmails" rows="3" placeholder="只扫描这些用户的记录"></textarea></label>
        <label v-if="form.testMode">测试收件邮箱<input v-model="form.testRecipientEmail" type="email" placeholder="test@example.com" /></label>
      </div>
      <div class="model-audit-form-footer"><span class="field-hint">正式扫描游标保存最大（created_at, id），下一窗口从该位置严格向后扫描。</span><button class="primary-button" type="button" :disabled="saving" @click="saveSettings"><RefreshCw v-if="saving" :size="15" class="spin" /><Save v-else :size="15" />保存设置</button></div>
      <div v-if="settings.lastError" class="model-audit-error">{{ settings.lastError }}</div>

      <div v-if="form.testMode" class="test-scan-panel">
        <div><h3>历史测试扫描</h3><p>自定义历史窗口，只读取测试用户，不推进正式扫描游标。</p></div>
        <div class="test-scan-fields">
          <label>开始时间<input v-model="testPeriodStart" type="datetime-local" /></label>
          <span class="test-scan-arrow">至</span>
          <label>结束时间<input v-model="testPeriodEnd" type="datetime-local" /></label>
          <button class="secondary-button" type="button" :disabled="testRunning || !settings.testMode" @click="runTestScan"><RefreshCw v-if="testRunning" :size="15" class="spin" /><Play v-else :size="15" />测试扫描</button>
        </div>
      </div>
    </section>

    <section v-else-if="activeTopTab === 'mappings'" class="panel table-panel">
      <div class="panel-head"><div><h2>全局合法映射</h2><p>默认只有上游发送模型与响应模型完全一致才合法；这里可添加精确映射。</p></div><button class="secondary-button" type="button" @click="openMapping()"><Plus :size="15" />新增映射</button></div>
      <div class="table-wrap">
        <table class="model-audit-table mapping-table"><thead><tr><th>上游发送模型</th><th>允许的响应模型</th><th>更新时间</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="item in mappings.items" :key="item.id"><td><strong>{{ item.sourceModel }}</strong><small>实际发送给上游</small></td><td><strong>{{ item.allowedResponseModel }}</strong><small>命中后记录为合法映射</small></td><td>{{ dateTime(item.updatedAt) }}</td><td><div class="row-actions"><button class="icon-button mini" type="button" title="编辑映射" aria-label="编辑映射" @click="openMapping(item)"><Edit3 :size="15" /></button><button class="icon-button mini danger-action" type="button" title="删除映射" aria-label="删除映射" @click="deleteMapping(item)"><Trash2 :size="15" /></button></div></td></tr>
            <tr v-if="!loading && !mappings.items.length"><td colspan="4" class="table-empty">暂无自定义映射，完全相同的模型名默认自动合法。</td></tr>
          </tbody>
        </table>
      </div>
      <PaginationBar v-if="mappings.total" :page="mappingPage" :page-size="mappingPageSize" :total="mappings.total" @update:page="changeMappingsPage" @update:page-size="changeMappingsPageSize" />
    </section>

    <section v-else class="panel table-panel">
      <div class="panel-head model-audit-record-head">
        <div><h2>审计记录</h2><p>只显示审计出来的模型不一致记录；用户邮件按邮箱聚合。</p></div>
        <div class="model-audit-filterbar">
          <label>开始时间<input v-model="filterStart" type="datetime-local" /></label>
          <span class="model-audit-filter-separator">至</span>
          <label>结束时间（不含）<input v-model="filterEnd" type="datetime-local" /></label>
          <button class="secondary-button" type="button" title="应用时间筛选" @click="applyAuditFilters"><Filter :size="15" />筛选</button>
          <button class="icon-button" type="button" title="清除时间筛选" aria-label="清除时间筛选" :disabled="!appliedStartAt && !appliedEndAt" @click="clearAuditFilters"><X :size="16" /></button>
          <label class="search-box"><Search :size="16" /><input v-model="eventSearch" placeholder="搜索用户或模型" /></label>
        </div>
      </div>
      <div class="model-audit-tab-toolbar">
        <div class="compact-tabs model-audit-tabs"><button :class="{ active: activeAuditTab === 'events' }" type="button" @click="activeAuditTab = 'events'">不一致记录 <small>{{ events.total }}</small></button><button :class="{ active: activeAuditTab === 'runs' }" type="button" @click="activeAuditTab = 'runs'">扫描窗口 <small>{{ runs.total }}</small></button><button :class="{ active: activeAuditTab === 'notifications' }" type="button" @click="activeAuditTab = 'notifications'">邮件记录 <small>{{ notifications.total }}</small></button></div>
        <div v-if="activeAuditTab === 'notifications'" class="model-audit-notification-actions">
          <span class="selection-text">已选择 {{ selectedNotificationCount }} 条</span>
          <button class="secondary-button" type="button" :disabled="confirmingNotifications || !selectedNotificationCount" @click="confirmSelectedNotifications"><Check :size="15" />确认已发送</button>
          <button class="secondary-button" type="button" :disabled="confirmingNotifications || !notifications.total" @click="confirmAllNotifications"><CheckSquare :size="15" />一键确认所有</button>
        </div>
        <button class="secondary-button danger-action" type="button" :disabled="clearing || !activeAuditTotal" @click="clearCurrentAuditList"><RefreshCw v-if="clearing" :size="15" class="spin" /><Trash2 v-else :size="15" />清空当前列表</button>
      </div>

      <div v-if="activeAuditTab === 'events'" class="table-wrap"><table class="model-audit-table"><thead><tr><th>记录时间</th><th>用户邮箱</th><th>请求模型</th><th>上游发送模型</th><th>上游响应模型</th><th>判定</th></tr></thead><tbody><tr v-for="item in events.items" :key="item.id"><td>{{ dateTime(item.createdAt) }}</td><td>{{ item.userEmail || `用户 #${item.sourceUserId}` }}</td><td>{{ item.requestedModel || '--' }}</td><td>{{ item.upstreamModel || '--' }}</td><td>{{ item.upstreamResponseModel || '--' }}</td><td><span class="status-pill danger">不一致</span></td></tr><tr v-if="!loading && !events.items.length"><td colspan="6" class="table-empty">暂无模型不一致记录</td></tr></tbody></table></div>
      <PaginationBar v-if="events.total" v-show="activeAuditTab === 'events'" :page="eventPage" :page-size="eventPageSize" :total="events.total" @update:page="changeEventsPage" @update:page-size="changeEventsPageSize" />

      <div v-if="activeAuditTab === 'runs'" class="table-wrap"><table class="model-audit-table"><thead><tr><th>扫描类型</th><th>扫描窗口</th><th>状态</th><th>读取</th><th>一致</th><th>合法映射</th><th>异常</th><th>字段缺失</th><th>邮件</th></tr></thead><tbody><tr v-for="item in runs.items" :key="item.id"><td><span class="status-pill" :class="item.runType === 'test' ? 'warning' : 'success'">{{ item.runType === 'test' ? '测试' : '正式' }}</span></td><td>{{ dateTime(item.periodStart) }}<small>至 {{ dateTime(item.periodEnd) }}</small></td><td><span class="status-pill" :class="statusClass(item.status)">{{ statusLabels[item.status] || item.status }}</span><small v-if="item.errorMessage" class="error-text">{{ item.errorMessage }}</small></td><td>{{ item.scannedCount }}</td><td>{{ item.matchedCount }}</td><td>{{ item.allowedMappingCount }}</td><td>{{ item.mismatchCount }}</td><td>{{ item.unknownCount }}</td><td>{{ item.notificationCount }}</td></tr><tr v-if="!loading && !runs.items.length"><td colspan="9" class="table-empty">暂无扫描窗口</td></tr></tbody></table></div>
      <PaginationBar v-if="runs.total" v-show="activeAuditTab === 'runs'" :page="runPage" :page-size="runPageSize" :total="runs.total" @update:page="changeRunsPage" @update:page-size="changeRunsPageSize" />

      <div v-if="activeAuditTab === 'notifications'" class="table-wrap"><table class="model-audit-table model-audit-notification-table"><thead><tr><th><input type="checkbox" title="选择当前页待确认邮件" :checked="allNotificationPageSelected" :disabled="!selectableNotificationItems.length" @change="toggleNotificationPageSelection(($event.target as HTMLInputElement).checked)" /></th><th>时间</th><th>类型</th><th>收件人</th><th>主题</th><th>记录数</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="item in notifications.items" :key="item.id"><td><input type="checkbox" :checked="selectedNotificationIds.has(Number(item.id))" :disabled="!canConfirmNotification(item) || confirmingNotifications" @change="toggleNotificationSelection(Number(item.id), ($event.target as HTMLInputElement).checked)" /></td><td>{{ dateTime(item.createdAt) }}</td><td>{{ kindLabels[item.kind] || item.kind }}</td><td>{{ item.recipientEmail || '--' }}</td><td>{{ item.subject }}</td><td>{{ item.eventCount }}</td><td><span class="status-pill" :class="statusClass(item.status)">{{ statusLabels[item.status] || item.status }}</span><small v-if="item.confirmedBy">人工确认：{{ item.confirmedBy }} · {{ dateTime(item.confirmedAt) }}</small><small v-if="item.errorMessage" class="error-text">{{ item.errorMessage }}</small></td><td><div class="row-actions"><button v-if="canConfirmNotification(item)" class="small-button" type="button" :disabled="confirmingNotifications" @click="confirmNotification(item)"><Check :size="14" />确认已发送</button><button class="small-button" type="button" @click="selectedNotification = item">查看正文</button></div></td></tr><tr v-if="!loading && !notifications.items.length"><td colspan="8" class="table-empty">暂无邮件记录</td></tr></tbody></table></div>
      <PaginationBar v-if="notifications.total" v-show="activeAuditTab === 'notifications'" :page="notificationPage" :page-size="notificationPageSize" :total="notifications.total" @update:page="changeNotificationsPage" @update:page-size="changeNotificationsPageSize" />
    </section>

    <div v-if="mappingEditor" class="modal-layer" @click.self="mappingEditor = null"><section class="modal form-modal model-audit-modal"><header><div><h2>{{ mappingEditor.id ? '编辑合法映射' : '新增合法映射' }}</h2><p>精确匹配，比较时忽略首尾空格和大小写。</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="mappingEditor = null"><X :size="19" /></button></header><div class="form-grid"><label>上游发送模型<input v-model="mappingEditor.sourceModel" maxlength="200" placeholder="例如 claude-3-7-sonnet" /></label><label>允许的响应模型<input v-model="mappingEditor.allowedResponseModel" maxlength="200" placeholder="例如 claude-3-7-sonnet-20250219" /></label></div><div class="form-note">只有该上游发送模型返回这里配置的响应模型时，才会记录为“合法映射”；完全一致的模型不需要配置。</div><footer><button class="secondary-button" type="button" @click="mappingEditor = null">取消</button><button class="primary-button" type="button" :disabled="saving" @click="saveMapping"><RefreshCw v-if="saving" :size="15" class="spin" /><Save v-else :size="15" />保存映射</button></footer></section></div>
    <div v-if="selectedNotification" class="modal-layer" @click.self="selectedNotification = null"><section class="modal model-audit-notification-modal"><header><div><h2>{{ selectedNotification.subject }}</h2><p>{{ selectedNotification.recipientEmail }} · {{ dateTime(selectedNotification.createdAt) }}</p><p v-if="selectedNotification.confirmedBy">人工确认：{{ selectedNotification.confirmedBy }} · {{ dateTime(selectedNotification.confirmedAt) }}</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="selectedNotification = null"><X :size="19" /></button></header><div class="notification-preview"><strong>纯文本正文</strong><pre>{{ selectedNotification.textContent }}</pre><strong>HTML 正文</strong><pre>{{ selectedNotification.htmlContent }}</pre></div></section></div>
  </div>
</template>
