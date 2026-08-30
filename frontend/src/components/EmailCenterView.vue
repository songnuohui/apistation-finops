<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { Bold, Image, Italic, Link, List, Mail, RefreshCw, Search, Send, Settings2, Underline, X } from 'lucide-vue-next';
import { get, query, send } from '../api';

type AnyRecord = Record<string, any>;
const props = defineProps<{ refreshToken?: number }>();
const emit = defineEmits<{ toast: [message: string] }>();
const settings = ref<AnyRecord>({});
const campaigns = ref<AnyRecord>({ items: [] });
const preferences = ref<AnyRecord>({ items: [] });
const loading = ref(false);
const savingSettings = ref(false);
const sending = ref(false);
const settingsOpen = ref(false);
const editorOpen = ref(false);
const editor = ref<AnyRecord | null>(null);
const editorElement = ref<HTMLElement | null>(null);
const testEmail = ref('');
const preferenceSearch = ref('');
const preferenceWhitelist = ref('all');
const preferenceSubscribed = ref('all');
const preferencePage = ref(1);
const preferencePageSize = ref(20);
const recipientOptions = ref<AnyRecord>({ items: [], total: 0, page: 1, pageSize: 20 });
const recipientSearch = ref('');
const recipientPage = ref(1);
const recipientPageSize = ref(20);
const recipientLoading = ref(false);
const selectedUsers = ref(new Set<number>());
const detail = ref<AnyRecord | null>(null);
let preferenceSearchTimer: number | undefined;
let recipientSearchTimer: number | undefined;

const settingForm = ref({ enabled: false, smtpHost: '', smtpPort: 587, smtpSecure: false, smtpUsername: '', smtpPassword: '', fromEmail: '', fromName: '', footerText: '', unsubscribeLabel: '', subscribeLabel: '', unsubscribedTitle: '', unsubscribedDescription: '', subscribedTitle: '', subscribedDescription: '', confirmUnsubscribeTitle: '', confirmUnsubscribeDescription: '', confirmUnsubscribeButton: '', confirmSubscribeTitle: '', confirmSubscribeDescription: '', confirmSubscribeButton: '', credentialsConfigured: false, clearCredentials: false });
const preferenceRows = computed(() => preferences.value.items || []);
const campaignRows = computed(() => campaigns.value.items || []);
const isConfigured = computed(() => Boolean(settings.value.configured));
const selectedCount = computed(() => selectedUsers.value.size);
const recipientOptionRows = computed(() => recipientOptions.value.items || []);
const selectableRecipientRows = computed(() => recipientOptionRows.value.filter((row: AnyRecord) => recipientSelectable(row)));
const allRecipientPageSelected = computed(() => selectableRecipientRows.value.length > 0 && selectableRecipientRows.value.every((row: AnyRecord) => selectedUsers.value.has(Number(row.sourceUserId))));
const campaignStatus: Record<string, string> = { draft: '草稿', sending: '发送中', interrupted: '发送中断，待确认', completed: '已完成', partial_failed: '部分失败', failed: '失败' };
const categoryLabels: Record<string, string> = { announcement: '公告', promotion: '活动' };
const recipientRows = computed(() => detail.value?.recipients || []);

function copySettings() {
  settingForm.value = { enabled: Boolean(settings.value.enabled), smtpHost: settings.value.smtpHost || '', smtpPort: Number(settings.value.smtpPort || 587), smtpSecure: Boolean(settings.value.smtpSecure), smtpUsername: settings.value.smtpUsername || '', smtpPassword: '', fromEmail: settings.value.fromEmail || '', fromName: settings.value.fromName || '', footerText: settings.value.footerText || '', unsubscribeLabel: settings.value.unsubscribeLabel || '', subscribeLabel: settings.value.subscribeLabel || '', unsubscribedTitle: settings.value.unsubscribedTitle || '', unsubscribedDescription: settings.value.unsubscribedDescription || '', subscribedTitle: settings.value.subscribedTitle || '', subscribedDescription: settings.value.subscribedDescription || '', confirmUnsubscribeTitle: settings.value.confirmUnsubscribeTitle || '', confirmUnsubscribeDescription: settings.value.confirmUnsubscribeDescription || '', confirmUnsubscribeButton: settings.value.confirmUnsubscribeButton || '', confirmSubscribeTitle: settings.value.confirmSubscribeTitle || '', confirmSubscribeDescription: settings.value.confirmSubscribeDescription || '', confirmSubscribeButton: settings.value.confirmSubscribeButton || '', credentialsConfigured: Boolean(settings.value.credentialsConfigured), clearCredentials: false };
}

async function load() {
  loading.value = true;
  try {
      const [nextSettings, nextCampaigns, nextPreferences] = await Promise.all([
      get('/email/settings'), get('/email/campaigns?page=1&page_size=20'), get(`/email/preferences?${query({ page: preferencePage.value, page_size: preferencePageSize.value, search: preferenceSearch.value, whitelist: preferenceWhitelist.value, subscribed: preferenceSubscribed.value })}`),
    ]);
    settings.value = nextSettings; campaigns.value = nextCampaigns; preferences.value = nextPreferences; copySettings();
  } catch (error: any) { emit('toast', error.message); }
  finally { loading.value = false; }
}

async function saveSettings() {
  savingSettings.value = true;
  try { settings.value = await send('/email/settings', 'PATCH', settingForm.value); copySettings(); settingsOpen.value = false; emit('toast', '邮件服务设置已保存'); }
  catch (error: any) { emit('toast', error.message); }
  finally { savingSettings.value = false; }
}

async function testSmtp() {
  if (!testEmail.value) { emit('toast', '请输入测试邮箱'); return; }
  try { await send('/email/settings/test', 'POST', { email: testEmail.value }); emit('toast', '测试邮件已发送'); }
  catch (error: any) { emit('toast', error.message); }
}

function openEditor() {
  editor.value = { subject: '', category: 'announcement', recipientMode: 'all', htmlContent: '<p></p>', textContent: '', userIds: [] };
  selectedUsers.value = new Set(); recipientSearch.value = ''; recipientPage.value = 1; recipientPageSize.value = 20; recipientOptions.value = { items: [], total: 0, page: 1, pageSize: 20 }; editorOpen.value = true;
  nextTick(() => { if (editorElement.value) editorElement.value.innerHTML = editor.value?.htmlContent || ''; });
}
function closeEditor() { editorOpen.value = false; editor.value = null; }
function format(command: string, value?: string) { document.execCommand(command, false, value); editorElement.value?.focus(); if (editor.value && editorElement.value) editor.value.htmlContent = editorElement.value.innerHTML; }
function insertLink() { const url = window.prompt('链接地址'); if (url && /^https?:\/\//i.test(url)) format('createLink', url); }
function insertImage() {
  const url = window.prompt('图片地址（仅支持 http/https）')?.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) { emit('toast', '图片地址必须以 http:// 或 https:// 开头'); return; }
  format('insertImage', url);
}
function syncHtml() { if (editor.value && editorElement.value) editor.value.htmlContent = editorElement.value.innerHTML; }
function recipientSelectable(row: AnyRecord) { return Boolean(row.email && row.active !== false && row.subscribed && !row.excludeFromBalanceStats); }
function recipientAvailability(row: AnyRecord) { return row.excludeFromBalanceStats ? '白名单，不发送' : !row.email ? '无邮箱' : row.active === false ? '用户已停用' : !row.subscribed ? '已退订' : '可发送'; }
function toggleUser(id: number, checked: boolean) { const next = new Set(selectedUsers.value); checked ? next.add(id) : next.delete(id); selectedUsers.value = next; if (editor.value) editor.value.userIds = [...next]; }
function toggleAllUsers(checked: boolean) { const next = new Set(selectedUsers.value); selectableRecipientRows.value.forEach((row: AnyRecord) => { checked ? next.add(Number(row.sourceUserId)) : next.delete(Number(row.sourceUserId)); }); selectedUsers.value = next; if (editor.value) editor.value.userIds = [...next]; }
function clearSelectedUsers() { selectedUsers.value = new Set(); if (editor.value) editor.value.userIds = []; }
async function loadRecipientOptions() {
  if (!editorOpen.value || editor.value?.recipientMode !== 'selected') return;
  recipientLoading.value = true;
  try { recipientOptions.value = await get(`/email/preferences?${query({ page: recipientPage.value, page_size: recipientPageSize.value, search: recipientSearch.value, whitelist: 'all', subscribed: 'all' })}`); }
  catch (error: any) { emit('toast', error.message); }
  finally { recipientLoading.value = false; }
}
function scheduleRecipientSearch() {
  recipientPage.value = 1;
  if (recipientSearchTimer) window.clearTimeout(recipientSearchTimer);
  recipientSearchTimer = window.setTimeout(loadRecipientOptions, 250);
}
async function searchPreferences() { preferencePage.value = 1; await load(); }
function schedulePreferenceSearch() {
  if (preferenceSearchTimer) window.clearTimeout(preferenceSearchTimer);
  preferenceSearchTimer = window.setTimeout(() => { searchPreferences(); }, 250);
}
async function sendCampaign() {
  if (!editor.value) return;
  syncHtml();
  if (editor.value.recipientMode === 'selected' && !selectedUsers.value.size) { emit('toast', '请选择至少一位收件人'); return; }
  if (!editor.value.subject.trim() || !editor.value.htmlContent.replace(/<[^>]+>/g, '').trim()) { emit('toast', '请填写邮件主题和内容'); return; }
  if (!window.confirm(`确认立即发送这封${categoryLabels[editor.value.category]}邮件吗？发送后不能撤回。`)) return;
  sending.value = true;
  try {
    const campaign = await send('/email/campaigns', 'POST', { ...editor.value, userIds: [...selectedUsers.value] });
    const result = await send(`/email/campaigns/${campaign.id}/send`, 'POST', {});
    closeEditor(); await load(); detail.value = { ...result, recipients: [] }; emit('toast', `发送完成：${result.sentCount || 0} 封成功，${result.failedCount || 0} 封失败，${result.skippedCount || 0} 封跳过`);
  } catch (error: any) { emit('toast', error.message); }
  finally { sending.value = false; }
}
async function openDetail(campaign: AnyRecord) { try { detail.value = await get(`/email/campaigns/${campaign.id}`); } catch (error: any) { emit('toast', error.message); } }
async function confirmRecipient(row: AnyRecord) {
  if (!detail.value || !window.confirm(`确认 ${row.email} 已经收到这封邮件吗？此操作不会再次发送邮件。`)) return;
  try { await send(`/email/campaigns/${detail.value.id}/recipients/${row.id}/confirm`, 'POST', {}); detail.value = await get(`/email/campaigns/${detail.value.id}`); campaigns.value = await get('/email/campaigns?page=1&page_size=20'); emit('toast', '已确认送达，没有重复发送邮件'); }
  catch (error: any) { emit('toast', error.message); }
}
async function refreshPreferences() { await load(); }
function dateTime(value: any) { return value ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '--'; }
function statusLabel(value: any) { return campaignStatus[String(value)] || String(value || '--'); }
function recipientStatusLabel(value: any) { const labels: Record<string, string> = { pending: '待发送', needs_review: '送达待确认', sent: '已发送', failed: '发送失败', skipped_whitelist: '跳过：白名单', skipped_unsubscribed: '跳过：已退订', skipped_inactive: '跳过：用户已停用', skipped_invalid: '跳过：邮箱无效' }; return labels[String(value)] || String(value || '--'); }

watch(() => props.refreshToken, load);
watch([preferenceSearch, preferenceWhitelist, preferenceSubscribed], schedulePreferenceSearch);
watch(recipientSearch, scheduleRecipientSearch);
watch(() => editor.value?.recipientMode, (mode) => { if (mode === 'selected') { recipientPage.value = 1; loadRecipientOptions(); } });
onMounted(load);
</script>

<template>
  <div class="page-view email-center-view">
    <div class="email-header-row">
      <div><h2 class="section-title">邮件中心</h2><p class="section-subtitle">FinOps 公告与活动邮件</p></div>
      <div class="email-header-actions"><span class="email-config-status" :class="{ ready: isConfigured }"><span></span>{{ isConfigured ? 'SMTP 已配置' : 'SMTP 未配置' }}</span><button class="secondary-button" type="button" @click="settingsOpen = !settingsOpen"><Settings2 :size="16" />邮件服务设置</button><button class="primary-button" type="button" @click="openEditor"><Mail :size="16" />新建邮件</button></div>
    </div>
    <section v-if="settingsOpen" class="panel email-settings-panel">
      <div class="panel-head"><div><h2>SMTP 设置</h2><p>凭据只保存在 FinOps，和 sub2api 的邮件配置相互独立</p></div><button class="icon-button" title="关闭" aria-label="关闭" @click="settingsOpen = false"><X :size="18" /></button></div>
      <div class="form-grid email-settings-grid"><label>SMTP 主机<input v-model="settingForm.smtpHost" placeholder="smtp.example.com" /></label><label>端口<input v-model.number="settingForm.smtpPort" type="number" min="1" max="65535" /></label><label>SMTP 用户名<input v-model="settingForm.smtpUsername" autocomplete="off" /></label><label>SMTP 密码<input v-model="settingForm.smtpPassword" type="password" autocomplete="new-password" :placeholder="settingForm.credentialsConfigured ? '已保存，留空保持不变' : '请输入密码'" /></label><label>发件人邮箱<input v-model="settingForm.fromEmail" type="email" /></label><label>发件人名称<input v-model="settingForm.fromName" /></label><label class="checkbox-field"><input v-model="settingForm.enabled" type="checkbox" />启用 FinOps 邮件发送</label><label class="checkbox-field"><input v-model="settingForm.smtpSecure" type="checkbox" />使用 SSL/TLS（通常端口 465）</label></div>
      <details class="email-copy-settings"><summary>自定义订阅与退订文案</summary><p class="email-copy-hint">下面的文字会用于邮件页脚、订阅结果页和确认页；退订/订阅链接由系统自动生成。</p><div class="form-grid email-copy-grid"><label>邮件页脚说明<input v-model="settingForm.footerText" maxlength="255" /></label><label>退订链接文字<input v-model="settingForm.unsubscribeLabel" maxlength="80" /></label><label>重新订阅链接文字<input v-model="settingForm.subscribeLabel" maxlength="80" /></label><label>已退订标题<input v-model="settingForm.unsubscribedTitle" maxlength="160" /></label><label class="wide-field">已退订说明<textarea v-model="settingForm.unsubscribedDescription" maxlength="1000" rows="2"></textarea></label><label>已订阅标题<input v-model="settingForm.subscribedTitle" maxlength="160" /></label><label class="wide-field">已订阅说明<textarea v-model="settingForm.subscribedDescription" maxlength="1000" rows="2"></textarea></label><label>确认退订标题<input v-model="settingForm.confirmUnsubscribeTitle" maxlength="160" /></label><label>确认退订按钮<input v-model="settingForm.confirmUnsubscribeButton" maxlength="80" /></label><label class="wide-field">确认退订说明<textarea v-model="settingForm.confirmUnsubscribeDescription" maxlength="1000" rows="2"></textarea></label><label>确认订阅标题<input v-model="settingForm.confirmSubscribeTitle" maxlength="160" /></label><label>确认订阅按钮<input v-model="settingForm.confirmSubscribeButton" maxlength="80" /></label><label class="wide-field">确认订阅说明<textarea v-model="settingForm.confirmSubscribeDescription" maxlength="1000" rows="2"></textarea></label></div></details>
      <div class="email-settings-footer"><label class="test-email"><span>测试收件箱</span><input v-model="testEmail" type="email" placeholder="your@email.com" /></label><button class="secondary-button" type="button" :disabled="!settings.configured" @click="testSmtp"><Send :size="15" />发送测试邮件</button><span class="spacer"></span><button class="primary-button" type="button" :disabled="savingSettings" @click="saveSettings"><RefreshCw v-if="savingSettings" :size="15" class="spin" /><span v-else>保存设置</span></button></div>
    </section>
    <div class="email-metric-grid"><div class="metric-card"><span>邮件活动</span><strong>{{ campaigns.total || 0 }}</strong><small>已保存的公告和活动</small></div><div class="metric-card"><span>订阅用户</span><strong>{{ preferences.summary?.subscribedCount || 0 }}</strong><small>白名单用户不发送</small></div><div class="metric-card"><span>已退订</span><strong>{{ preferences.summary?.unsubscribedCount || 0 }}</strong><small>可通过邮件链接恢复</small></div></div>
    <section class="panel table-panel">
      <div class="panel-head"><div><h2>发送记录</h2><p>发送结果只记录在 FinOps，不会写入 sub2api</p></div><button class="icon-button" title="刷新" aria-label="刷新" @click="load"><RefreshCw :size="17" :class="{ spin: loading }" /></button></div>
      <div class="table-wrap"><table class="email-campaign-table"><thead><tr><th>主题</th><th>类型</th><th>状态</th><th class="number">发送用户</th><th class="number">成功</th><th class="number">失败</th><th class="number">跳过</th><th>创建时间</th><th>操作</th></tr></thead><tbody><tr v-for="campaign in campaignRows" :key="campaign.id"><td><button class="link-button" @click="openDetail(campaign)">{{ campaign.subject }}</button></td><td><span class="status-pill success">{{ categoryLabels[campaign.category] || campaign.category }}</span></td><td><span class="status-pill" :class="campaign.status === 'completed' ? 'success' : campaign.status === 'partial_failed' || campaign.status === 'failed' ? 'danger' : 'warning'">{{ statusLabel(campaign.status) }}</span></td><td class="number">{{ campaign.totalCount || 0 }}</td><td class="number">{{ campaign.sentCount || 0 }}</td><td class="number">{{ campaign.failedCount || 0 }}</td><td class="number">{{ campaign.skippedCount || 0 }}</td><td>{{ dateTime(campaign.createdAt) }}</td><td><button class="small-button" @click="openDetail(campaign)">查看明细</button></td></tr><tr v-if="!loading && !campaignRows.length"><td colspan="9" class="table-empty">暂无邮件活动</td></tr></tbody></table></div>
    </section>
    <section class="panel table-panel">
      <div class="panel-head"><div><h2>用户订阅状态</h2><p>白名单用户始终排除，不受订阅状态影响</p></div><div class="email-preference-actions"><label class="search-box"><Mail :size="16" /><input v-model="preferenceSearch" placeholder="搜索邮箱或用户名" /></label><label class="filter-select"><span>白名单</span><select v-model="preferenceWhitelist"><option value="all">全部</option><option value="included">正常用户</option><option value="excluded">白名单用户</option></select></label><label class="filter-select"><span>订阅</span><select v-model="preferenceSubscribed"><option value="all">全部</option><option value="true">已订阅</option><option value="false">已退订</option></select></label><button class="icon-button" title="刷新订阅状态" aria-label="刷新订阅状态" @click="refreshPreferences"><RefreshCw :size="16" :class="{ spin: loading }" /></button></div></div>
      <div class="table-wrap"><table class="email-preference-table"><thead><tr><th>用户</th><th>白名单</th><th>FinOps 邮件</th><th>更新时间</th><th>管理</th></tr></thead><tbody><tr v-for="row in preferenceRows" :key="row.sourceUserId"><td><strong>{{ row.email || row.username || `用户 #${row.sourceUserId}` }}</strong><small>ID {{ row.sourceUserId }}<template v-if="row.username && row.username !== row.email"> · {{ row.username }}</template></small></td><td><span class="status-pill" :class="row.excludeFromBalanceStats ? 'warning' : 'success'">{{ row.excludeFromBalanceStats ? '排除' : '正常' }}</span></td><td><span class="status-pill" :class="row.subscribed ? 'success' : 'warning'">{{ row.subscribed ? '已订阅' : '已退订' }}</span></td><td>{{ dateTime(row.unsubscribedAt || row.resubscribedAt) }}</td><td><button class="small-button" :disabled="row.excludeFromBalanceStats" @click="send(`/email/preferences/${row.sourceUserId}`, 'PATCH', { subscribed: !row.subscribed }).then(() => load()).then(() => emit('toast', row.subscribed ? '已退订' : '已恢复订阅')).catch((error: any) => emit('toast', error.message))">{{ row.subscribed ? '退订' : '恢复订阅' }}</button></td></tr><tr v-if="!loading && !preferenceRows.length"><td colspan="5" class="table-empty">暂无用户</td></tr></tbody></table></div>
      <div class="pager email-pager"><label>每页<select v-model.number="preferencePageSize" @change="preferencePage = 1; load()"><option :value="20">20</option><option :value="50">50</option><option :value="100">100</option></select>条</label><button class="small-button" :disabled="preferencePage <= 1" @click="preferencePage--; load()">上一页</button><span>第 {{ preferencePage }} 页，共 {{ preferences.total || 0 }} 位</span><button class="small-button" :disabled="preferencePage * (preferences.pageSize || preferencePageSize) >= (preferences.total || 0)" @click="preferencePage++; load()">下一页</button></div>
    </section>

    <div v-if="editorOpen && editor" class="modal-layer" @click.self="closeEditor">
      <section class="modal email-editor-modal">
        <header><div><h2>新建邮件</h2><p>发送后将立即投递，不能撤回</p></div><button class="icon-button" title="关闭" aria-label="关闭" @click="closeEditor"><X :size="19" /></button></header>
        <div class="email-editor-form">
          <label>邮件主题<input v-model="editor.subject" maxlength="255" placeholder="填写邮件主题" /></label>
          <div class="email-editor-options"><label>邮件类型<select v-model="editor.category"><option value="announcement">公告</option><option value="promotion">活动</option></select></label><label>收件人<select v-model="editor.recipientMode"><option value="all">全部用户（自动排除白名单和退订用户）</option><option value="selected">指定用户</option></select></label></div>
          <div v-if="editor.recipientMode === 'selected'" class="recipient-picker">
            <div class="recipient-picker-head"><div><strong>从所有用户中选择</strong><span>已选择 {{ selectedCount }} 位</span></div><button v-if="selectedCount" type="button" class="link-button" @click="clearSelectedUsers">清空已选</button></div>
            <div class="recipient-picker-tools"><label class="recipient-search"><Search :size="15" /><input v-model="recipientSearch" placeholder="搜索邮箱、用户名或用户 ID" /></label><label class="recipient-page-size">每页<select v-model.number="recipientPageSize" @change="recipientPage = 1; loadRecipientOptions()"><option :value="20">20</option><option :value="50">50</option><option :value="100">100</option></select>位</label><label class="recipient-select-page"><input type="checkbox" :checked="allRecipientPageSelected" @change="toggleAllUsers(($event.target as HTMLInputElement).checked)" />选择本页可发送用户</label></div>
            <div class="recipient-picker-list"><label v-for="row in recipientOptionRows" :key="row.sourceUserId" class="recipient-option" :class="{ disabled: !recipientSelectable(row), selected: selectedUsers.has(Number(row.sourceUserId)) }"><input type="checkbox" :checked="selectedUsers.has(Number(row.sourceUserId))" :disabled="!recipientSelectable(row)" @change="toggleUser(Number(row.sourceUserId), ($event.target as HTMLInputElement).checked)" /><span>{{ row.email || row.username || `用户 #${row.sourceUserId}` }}<small>ID {{ row.sourceUserId }}<template v-if="row.username && row.username !== row.email"> · {{ row.username }}</template> · {{ recipientAvailability(row) }}</small></span></label><span v-if="recipientLoading" class="table-empty">正在加载用户...</span><span v-else-if="!recipientOptionRows.length" class="table-empty">没有匹配用户</span></div>
            <div class="recipient-picker-pager"><span>共 {{ recipientOptions.total || 0 }} 位用户</span><button type="button" class="small-button" :disabled="recipientPage <= 1 || recipientLoading" @click="recipientPage--; loadRecipientOptions()">上一页</button><span>第 {{ recipientPage }} 页</span><button type="button" class="small-button" :disabled="recipientPage * recipientPageSize >= (recipientOptions.total || 0) || recipientLoading" @click="recipientPage++; loadRecipientOptions()">下一页</button></div>
          </div>
          <div class="rich-editor"><div class="rich-toolbar"><button type="button" title="粗体" @click="format('bold')"><Bold :size="16" /></button><button type="button" title="斜体" @click="format('italic')"><Italic :size="16" /></button><button type="button" title="下划线" @click="format('underline')"><Underline :size="16" /></button><button type="button" title="项目符号" @click="format('insertUnorderedList')"><List :size="16" /></button><button type="button" title="插入链接" @click="insertLink"><Link :size="16" /></button><button type="button" title="插入图片" @click="insertImage"><Image :size="16" /></button></div><div ref="editorElement" class="rich-editor-content" contenteditable="true" @input="syncHtml"></div></div>
        </div>
        <footer><button class="secondary-button" type="button" @click="closeEditor">取消</button><button class="primary-button" type="button" :disabled="sending" @click="sendCampaign"><RefreshCw v-if="sending" :size="15" class="spin" /><Send v-else :size="15" />{{ sending ? '发送中' : '立即发送' }}</button></footer>
      </section>
    </div>
    <div v-if="detail" class="modal-layer" @click.self="detail = null"><section class="modal email-detail-modal"><header><div><h2>{{ detail.subject }}</h2><p>{{ categoryLabels[detail.category] || detail.category }} · {{ statusLabel(detail.status) }}</p></div><button class="icon-button" title="关闭" aria-label="关闭" @click="detail = null"><X :size="19" /></button></header><div class="supplier-metrics"><div><span>发送用户</span><strong>{{ detail.totalCount || 0 }}</strong><small>本次活动收件人</small></div><div><span>成功</span><strong>{{ detail.sentCount || 0 }}</strong><small>实际发送</small></div><div><span>失败</span><strong>{{ detail.failedCount || 0 }}</strong><small>未自动重试</small></div><div><span>跳过</span><strong>{{ detail.skippedCount || 0 }}</strong><small>白名单或退订</small></div></div><div v-if="detail.reviewCount" class="email-review-notice"><strong>{{ detail.reviewCount }} 位收件人的送达状态待确认</strong><span>发送过程曾被中断，系统没有自动重发。请根据实际收件情况逐一确认，避免重复邮件。</span></div><div class="email-detail-meta">发送时间：{{ dateTime(detail.sentAt || detail.createdAt) }}</div><div class="email-preview" v-html="detail.htmlContent"></div><div class="table-wrap compact-table"><table><thead><tr><th>用户</th><th>状态</th><th>说明</th><th>发送时间</th><th>操作</th></tr></thead><tbody><tr v-for="row in recipientRows" :key="row.id"><td>{{ row.email }}</td><td><span class="status-pill" :class="row.status === 'sent' ? 'success' : row.status?.startsWith('skipped') || row.status === 'needs_review' ? 'warning' : 'danger'">{{ recipientStatusLabel(row.status) }}</span></td><td>{{ row.errorMessage || (row.reviewedAt ? `由 ${row.reviewedBy || '管理员'} 确认` : '--') }}</td><td>{{ dateTime(row.sentAt) }}</td><td><button v-if="row.status === 'needs_review'" type="button" class="small-button" @click="confirmRecipient(row)">确认已送达</button><span v-else>--</span></td></tr><tr v-if="!recipientRows.length"><td colspan="5" class="table-empty">暂无收件人明细</td></tr></tbody></table></div></section></div>
  </div>
</template>

<style>
.email-center-view{gap:18px}.email-header-row{display:flex;align-items:center;justify-content:space-between;gap:16px}.section-title{margin:0;color:var(--ink);font-size:18px}.section-subtitle{margin:4px 0 0;color:var(--muted);font-size:12px}.email-header-actions,.email-preference-actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.email-config-status{display:inline-flex;align-items:center;gap:7px;color:#8b6b24;font-size:12px}.email-config-status span{width:8px;height:8px;border-radius:50%;background:#d69a27}.email-config-status.ready{color:#13734f}.email-config-status.ready span{background:#16a36d}.email-settings-panel{padding-bottom:17px}.email-settings-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.checkbox-field{display:flex!important;align-items:center;gap:8px;align-self:end;height:40px}.checkbox-field input{width:16px!important;height:16px!important}.email-settings-footer{display:flex;align-items:flex-end;gap:10px;margin-top:18px}.test-email{display:grid;gap:4px;color:var(--muted);font-size:11px}.test-email input{height:37px;min-width:230px;padding:0 10px;border:1px solid var(--line);border-radius:7px;background:#fff;color:var(--ink)}.spacer{flex:1}.email-metric-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.email-metric-grid .metric-card{min-height:94px}.email-metric-grid .metric-card strong{font-size:22px}.email-campaign-table{min-width:850px!important}.email-preference-table{min-width:840px!important}.email-preference-actions .search-box{width:260px;height:37px}.email-preview{margin:0 0 18px;padding:18px 20px;border:1px solid var(--line);border-radius:7px;background:#fff;line-height:1.6;overflow:auto}.email-preview img{max-width:100%;height:auto}.email-editor-modal{width:min(960px,calc(100vw - 40px))}.email-editor-form{display:grid;gap:15px}.email-editor-form>label,.email-editor-options label{display:grid;gap:6px;color:#53677f;font-size:11px}.email-editor-form input,.email-editor-form select{height:40px;padding:0 10px;border:1px solid var(--line);border-radius:7px;background:#fff;color:var(--ink);font:inherit}.email-editor-options{display:grid;grid-template-columns:1fr 1fr;gap:13px}.rich-editor{border:1px solid var(--line);border-radius:7px;overflow:hidden;background:#fff}.rich-toolbar{display:flex;gap:3px;padding:7px 8px;border-bottom:1px solid var(--line);background:#f6f9fc}.rich-toolbar button{display:grid;place-items:center;width:32px;height:30px;padding:0;border:1px solid transparent;border-radius:5px;background:transparent;color:#526b87}.rich-toolbar button:hover{border-color:#a9c4e6;background:#edf5ff;color:var(--primary)}.rich-editor-content{min-height:250px;padding:14px 15px;outline:0;color:#273d57;line-height:1.7}.rich-editor-content:focus{box-shadow:inset 0 0 0 2px rgba(23,105,213,.12)}.recipient-picker{padding:12px;border:1px solid var(--line);border-radius:7px;background:#f8fafc}.recipient-picker-head{display:flex;align-items:center;gap:14px;margin-bottom:9px;color:#53677f;font-size:12px}.recipient-picker-head span{color:var(--muted);font-size:11px}.recipient-picker-head label{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:11px}.recipient-picker-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;max-height:210px;overflow:auto}.recipient-option{display:flex;align-items:flex-start;gap:7px;padding:8px;border:1px solid #e3ebf3;border-radius:6px;background:#fff;cursor:pointer}.recipient-option.disabled{opacity:.52;cursor:not-allowed}.recipient-option span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#324a66;font-size:11px}.recipient-option small{display:block;margin-top:2px;color:var(--muted);font-size:10px}.email-detail-modal{width:min(1100px,calc(100vw - 40px))}.email-detail-modal .supplier-metrics{margin-bottom:18px}@media(max-width:1000px){.email-settings-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.recipient-picker-list{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:760px){.email-header-row{align-items:flex-start;flex-direction:column}.email-header-actions{width:100%}.email-header-actions button{flex:1}.email-metric-grid{grid-template-columns:1fr}.email-settings-grid,.email-editor-options{grid-template-columns:1fr}.email-settings-footer{align-items:stretch;flex-wrap:wrap}.test-email{flex:1 1 100%}.test-email input{width:100%;min-width:0}.email-settings-footer .spacer{display:none}.email-settings-footer button{flex:1}.email-preference-actions{width:100%}.email-preference-actions .search-box{width:auto;flex:1}.recipient-picker-list{grid-template-columns:1fr}.recipient-picker-head{align-items:flex-start;flex-wrap:wrap}.recipient-picker-head label{margin-left:0;width:100%}.email-editor-modal,.email-detail-modal{width:100%}}
.email-campaign-table{min-width:950px!important}.filter-select{display:flex;align-items:center;gap:6px;height:37px;color:var(--muted);font-size:11px;white-space:nowrap}.filter-select select{height:37px;padding:0 25px 0 9px;border:1px solid var(--line);border-radius:7px;background:#fff;color:var(--ink);font:inherit}.email-pager{gap:10px}.email-pager label{display:flex;align-items:center;gap:5px;margin-right:auto;color:var(--muted);font-size:11px}.email-pager select{height:30px;padding:0 21px 0 7px;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--ink);font:inherit}.email-detail-meta{margin:-8px 0 16px;color:var(--muted);font-size:11px}.email-copy-settings{margin-top:18px;border-top:1px solid var(--line);padding-top:13px}.email-copy-settings summary{cursor:pointer;color:var(--ink);font-weight:600;font-size:13px}.email-copy-hint{margin:7px 0 12px;color:var(--muted);font-size:11px}.email-copy-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.email-copy-grid label{display:grid;gap:6px;color:#53677f;font-size:11px}.email-copy-grid input,.email-copy-grid textarea{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid var(--line);border-radius:7px;background:#fff;color:var(--ink);font:inherit}.email-copy-grid input{height:38px}.email-copy-grid textarea{resize:vertical;line-height:1.5}.wide-field{grid-column:1 / -1}@media(max-width:760px){.email-preference-actions .search-box{width:100%;flex:1}.filter-select{flex:1}.filter-select select{width:100%}.email-copy-grid{grid-template-columns:1fr}.wide-field{grid-column:auto}}
.recipient-picker-head>div{display:flex;align-items:center;gap:12px}.recipient-picker-head .link-button{margin-left:auto}.recipient-picker-tools{display:flex;align-items:center;gap:9px;margin-bottom:9px;flex-wrap:wrap}.recipient-search{display:flex;align-items:center;gap:7px;flex:1;min-width:220px;height:34px;padding:0 9px;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--muted)}.recipient-search input{width:100%;height:100%;padding:0;border:0;outline:0;background:transparent;color:var(--ink);font:inherit}.recipient-page-size,.recipient-select-page{display:flex;align-items:center;gap:5px;color:var(--muted);font-size:11px;white-space:nowrap}.recipient-page-size select{height:34px;padding:0 20px 0 7px;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--ink);font:inherit}.recipient-select-page{margin-left:auto}.recipient-picker-list{min-height:68px}.recipient-option.selected{border-color:#78a9e2;background:#f1f7ff}.recipient-picker-pager{display:flex;align-items:center;gap:10px;margin-top:10px;color:var(--muted);font-size:11px}.recipient-picker-pager span:first-child{margin-right:auto}.email-review-notice{display:grid;gap:3px;margin:0 0 16px;padding:11px 13px;border:1px solid #efd69b;border-radius:7px;background:#fff9e9;color:#7b5b1d;font-size:12px}.email-review-notice span{color:#92753b;font-size:11px}@media(max-width:760px){.recipient-search{min-width:100%;flex-basis:100%}.recipient-select-page{margin-left:0}.recipient-picker-pager{flex-wrap:wrap}.recipient-picker-pager span:first-child{flex-basis:100%}}
</style>
