<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  Activity, AlertTriangle, Bell, Check, Edit3, KeyRound, Link2, Plus, RefreshCw,
  Send, ServerCog, Settings2, ShieldCheck, Trash2, Unlink, X,
} from 'lucide-vue-next';
import { get, query, rangeQuery, send } from '../api';
import { supplierAlertMessage, supplierAlertTitle, supplierMessage } from '../supplier-messages';

type AnyRecord = Record<string, any>;
type DetailTab = 'keys' | 'quality' | 'balances' | 'checks' | 'alerts';

const props = defineProps<{ refreshToken?: number; range?: string; rangeStart?: string; rangeEnd?: string }>();
const emit = defineEmits<{ toast: [message: string] }>();
const route = useRoute();
const router = useRouter();

const search = ref('');
const loading = ref(false);
const connectionItems = ref<AnyRecord[]>([]);
const showUnconfiguredProfitGuard = ref(false);
const editor = ref<AnyRecord | null>(null);
const editorSaving = ref(false);
const detail = ref<AnyRecord | null>(null);
const detailLoading = ref(false);
const detailTab = ref<DetailTab>('keys');
const qualityLoading = ref(false);
const syncingId = ref<number | null>(null);
const linkKey = ref<AnyRecord | null>(null);
const accountSearch = ref('');
const accountCandidates = ref<AnyRecord[]>([]);
const accountCandidatesLoading = ref(false);
const acknowledgingAlertId = ref<number | null>(null);
const targetEditor = ref<AnyRecord | null>(null);
const targetModels = ref<string[]>([]);
const targetModelsLoading = ref(false);
const qqEditor = ref<AnyRecord | null>(null);
const qqSaving = ref(false);
const qqBotStatus = ref<AnyRecord | null>(null);
const qqBotLoading = ref(false);
const qqBotAction = ref(false);
const serviceAuthEditor = ref<AnyRecord | null>(null);
const serviceAuthSaving = ref(false);
const profitGuardEditor = ref<AnyRecord | null>(null);
const profitGuardSaving = ref(false);
const supplierProfitGuardEditor = ref<AnyRecord | null>(null);
const supplierProfitGuardSaving = ref(false);
const deletingResource = ref<string | null>(null);
let searchTimer: number | undefined;
let accountSearchTimer: number | undefined;
let detailRequestToken = 0;
let qualityRequestToken = 0;
let accountRequestToken = 0;
let connectionRequestToken = 0;
let qqBotTimer: number | undefined;

const adapterLabels: Record<string, string> = {
  auto: '自动识别',
  sub2api: 'Sub2API',
  newapi: 'NewAPI',
  openai_compatible: 'OpenAI 兼容',
  custom: '自定义适配器',
};
const authLabels: Record<string, string> = {
  password: '账号密码',
  access_token: '访问令牌',
  token_refresh: '令牌自动续期',
  api_key: 'API 密钥',
};
const statusLabels: Record<string, string> = {
  ok: '正常',
  warning: '需关注',
  failed: '失败',
  pending: '等待同步',
  disabled: '已停用',
  unsupported: '暂不支持',
  active: '可用',
  inactive: '不可用',
  removed: '已移除',
  unknown: '未知',
  skipped: '已跳过',
  open: '待处理',
  acknowledged: '已确认',
  resolved: '已恢复',
  success: '成功',
  degraded: '已降级',
  unavailable: '不可用',
  error: '错误',
};
const qualityModeLabels: Record<string, string> = {
  off: '关闭',
  passive: '仅被动',
  active: '仅主动',
  hybrid: '混合',
};

const visibleKeys = computed(() => (detail.value?.keys || []).filter((item: AnyRecord) => item.status === 'active' && !item.removedAt));
const activeKeys = computed(() => visibleKeys.value);
const openAlerts = computed(() => (detail.value?.alerts || []).filter((item: AnyRecord) => item.status === 'open'));
const unconfiguredProfitGuardCount = computed(() => connectionItems.value
  .filter((item) => !item.profitGuardFullyEnabled).length);
const items = computed(() => showUnconfiguredProfitGuard.value
  ? connectionItems.value.filter((item) => !item.profitGuardFullyEnabled)
  : connectionItems.value);
const connectionSummary = computed(() => ({
  healthy: connectionItems.value.filter((item) => item.connectionStatus === 'ok').length,
  total: connectionItems.value.length,
  activeKeys: connectionItems.value.reduce((sum, item) => sum + Number(item.activeKeyCount || 0), 0),
  totalKeys: connectionItems.value.reduce((sum, item) => sum + Number(item.keyCount || 0), 0),
  alerts: connectionItems.value.reduce((sum, item) => sum + Number(item.openAlertCount || 0), 0),
  lowBalance: connectionItems.value.filter((item) => {
    const balance = Number(item.balance);
    const threshold = Number(item.lowBalanceThreshold);
    return Number.isFinite(balance) && Number.isFinite(threshold) && balance <= threshold;
  }).length,
}));
const calculatedMinimumSaleMultiplier = computed(() => {
  const current = profitGuardEditor.value;
  if (!current || current.thresholdMode !== 'margin') return null;
  const upstream = Number(current.upstreamMultiplier);
  const margin = Number(current.minimumMarginPercent) / 100;
  if (!Number.isFinite(upstream) || upstream < 0 || !Number.isFinite(margin) || margin < 0 || margin >= 1) return null;
  return upstream / (1 - margin);
});
const availableAccounts = computed(() => {
  if (!detail.value || !linkKey.value) return [];
  const currentKeyId = Number(linkKey.value.id);
  const linkedElsewhere = new Set<number>();
  const linkedHere = new Set<number>((linkKey.value.accountLinks || []).map((item: AnyRecord) => Number(item.accountId)));
  for (const key of visibleKeys.value) {
    if (Number(key.id) === currentKeyId) continue;
    for (const link of key.accountLinks || []) linkedElsewhere.add(Number(link.accountId));
  }
  return accountCandidates.value.filter((account: AnyRecord) => {
    if (account.status !== 'active' || linkedElsewhere.has(Number(account.id)) || linkedHere.has(Number(account.id))) return false;
    return true;
  });
});

function notify(message: string) {
  emit('toast', supplierMessage(message));
}

function adapterLabel(value: any) {
  return adapterLabels[String(value || '')] || String(value || '未识别');
}

function authLabel(value: any) {
  return authLabels[String(value || '')] || String(value || '--');
}

function qualityModeLabel(value: any) {
  return qualityModeLabels[String(value || '')] || String(value || '仅被动');
}

function statusLabel(value: any) {
  return statusLabels[String(value || '').toLowerCase()] || String(value || '未知');
}

function statusClass(value: any) {
  const normalized = String(value || '').toLowerCase();
  if (['ok', 'active', 'success', 'resolved'].includes(normalized)) return 'success';
  if (['failed', 'error', 'removed'].includes(normalized)) return 'danger';
  return 'warning';
}

function dateTime(value: any) {
  if (!value) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

function amount(value: any, currency = '') {
  if (value === null || value === undefined || value === '') return currency ? `-- ${currency}` : '--';
  const code = String(currency || '').trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat('zh-CN', {
        style: 'currency', currency: code, maximumFractionDigits: 4,
      }).format(Number(value));
    } catch {}
  }
  const rendered = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(Number(value));
  return code ? `${rendered} ${code}` : rendered;
}

function quotaText(key: AnyRecord) {
  if (key.quotaRemaining !== null && key.quotaRemaining !== undefined && key.quotaTotal !== null && key.quotaTotal !== undefined) {
    return `${amount(key.quotaRemaining, key.quotaCurrency)} / ${amount(key.quotaTotal, key.quotaCurrency)}`;
  }
  if (key.quotaRemaining !== null && key.quotaRemaining !== undefined) return `余 ${amount(key.quotaRemaining, key.quotaCurrency)}`;
  if (key.quotaUsed !== null && key.quotaUsed !== undefined) return `已用 ${amount(key.quotaUsed, key.quotaCurrency)}`;
  return '未提供额度';
}

function multiplierText(value: any) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${parsed.toFixed(4).replace(/\.?0+$/, '')}x` : '--';
}

function profitGuardHint(policy: AnyRecord | null | undefined) {
  if (!policy?.enabled) return '未启用利润保护';
  if (policy.thresholdMode === 'minimum_sale_multiplier') {
    return `成本触发 ${multiplierText(policy.minimumSaleMultiplier)}`;
  }
  return `最低毛利 ${(Number(policy.minimumMargin || 0) * 100).toFixed(1).replace(/\.0$/, '')}%`;
}

function connectionProfitGuardHint(item: AnyRecord) {
  const linked = Number(item.linkedAccountCount || 0);
  const enabled = Number(item.profitGuardAccountCount || 0);
  if (item.profitGuardFullyEnabled) {
    return linked ? `${enabled}/${linked} 账号已启用` : '统一策略已启用';
  }
  if (enabled) return `${enabled}/${linked} 账号已启用，仍有遗漏`;
  if (item.profitGuardConfigured) return '已配置但未启用';
  return '未配置';
}

function connectionHint(item: AnyRecord) {
  if (item.connectionStatus === 'failed' && item.lastError) return supplierMessage(item.lastError, item.lastErrorCode);
  if (item.consecutiveFailures) return `连续失败 ${item.consecutiveFailures} 次`;
  if (!item.enabled) return '已停用，不参与自动同步';
  return item.detectedAdapterType ? `已识别 ${adapterLabel(item.detectedAdapterType)}` : `配置 ${adapterLabel(item.adapterType)}`;
}

async function loadConnections() {
  const requestToken = ++connectionRequestToken;
  loading.value = true;
  try {
    const result = await get(`/supplier-connections?${query({ search: search.value })}`);
    if (requestToken === connectionRequestToken) connectionItems.value = result.items || [];
  } catch (error: any) {
    if (requestToken === connectionRequestToken) notify(error.message);
  } finally {
    if (requestToken === connectionRequestToken) loading.value = false;
  }
}

function blankEditor(connection: AnyRecord | null = null) {
  const editing = Boolean(connection);
  return {
    id: connection?.id || null,
    editing,
    supplierName: connection?.supplierName || '',
    supplierNotes: connection?.supplierNotes || '',
    name: connection?.name || '主账号',
    adapterType: connection?.adapterType || 'auto',
    baseUrl: connection?.baseUrl || '',
    authMode: connection?.authMode || 'password',
    originalAuthMode: connection?.authMode || 'password',
    credentialLabel: connection?.credentialLabel || '',
    credentialsConfigured: Boolean(connection?.credentialsConfigured),
    enabled: connection?.enabled ?? true,
    inventoryIntervalSeconds: connection?.inventoryIntervalSeconds || 600,
    activeCheckEnabled: connection?.activeCheckEnabled ?? true,
    activeCheckLimit: connection?.activeCheckLimit || 20,
    qualityMonitorMode: connection?.qualityMonitorMode || 'passive',
    lowBalanceThreshold: connection?.lowBalanceThreshold ?? '',
    balanceCurrency: connection?.balanceCurrency || 'USD',
    username: '',
    password: '',
    accessToken: '',
    refreshToken: '',
    apiKey: '',
    totpSecret: '',
    keyName: '',
    rateMultiplier: '',
    balance: '',
    credentialsBalanceCurrency: '',
  };
}

function openCreate() {
  editor.value = blankEditor();
}

function openEdit(connection: AnyRecord) {
  editor.value = blankEditor(connection);
}

function authOptions(adapterType: string) {
  if (adapterType === 'openai_compatible') return [{ value: 'api_key', label: 'API 密钥' }];
  if (adapterType === 'sub2api') {
    return [
      { value: 'password', label: '账号密码' },
      { value: 'token_refresh', label: 'Access Token + Refresh Token' },
      { value: 'access_token', label: '静态访问令牌' },
    ];
  }
  if (['auto', 'newapi'].includes(adapterType)) {
    return [{ value: 'password', label: '账号密码' }, { value: 'access_token', label: '静态访问令牌' }];
  }
  return [
    { value: 'password', label: '账号密码' },
    { value: 'access_token', label: '访问令牌' },
    { value: 'api_key', label: 'API 密钥' },
  ];
}

function syncEditorAuthMode() {
  if (!editor.value) return;
  const current = editor.value;
  const options = authOptions(current.adapterType);
  if (!options.some((item) => item.value === current.authMode)) current.authMode = options[0].value;
}

async function saveConnection() {
  if (!editor.value) return;
  editorSaving.value = true;
  const current = editor.value;
  try {
    const payload = {
      supplierName: current.supplierName,
      supplierNotes: current.supplierNotes || '',
      name: current.name,
      adapterType: current.adapterType,
      baseUrl: current.baseUrl,
      authMode: current.authMode,
      credentialLabel: current.credentialLabel || '',
      enabled: Boolean(current.enabled),
      inventoryIntervalSeconds: Number(current.inventoryIntervalSeconds),
      activeCheckEnabled: Boolean(current.activeCheckEnabled),
      activeCheckLimit: Number(current.activeCheckLimit),
      qualityMonitorMode: current.qualityMonitorMode,
      lowBalanceThreshold: current.lowBalanceThreshold === '' ? null : Number(current.lowBalanceThreshold),
      balanceCurrency: current.balanceCurrency,
      credentials: {
        username: current.username || '',
        password: current.password || '',
        accessToken: current.accessToken || '',
        refreshToken: current.refreshToken || '',
        apiKey: current.apiKey || '',
        totpSecret: current.totpSecret || '',
        keyName: current.keyName || '',
        rateMultiplier: current.rateMultiplier === '' ? null : Number(current.rateMultiplier),
        balance: current.balance === '' ? null : Number(current.balance),
        balanceCurrency: current.credentialsBalanceCurrency || '',
      },
    };
    const result = await send(
      current.editing ? `/supplier-connections/${current.id}` : '/supplier-connections',
      current.editing ? 'PATCH' : 'POST',
      payload,
    );
    editor.value = null;
    notify(result.sync?.ok === false ? '连接已保存，但本次同步未完成' : current.editing ? '供应商连接已更新' : '供应商连接已创建');
    await loadConnections();
    const id = Number(result.connection?.id || current.id);
    if (id) await openDetails(id);
  } catch (error: any) {
    notify(error.message);
  } finally {
    editorSaving.value = false;
  }
}

async function deleteConnection(connection: AnyRecord) {
  const label = connection.supplierName || connection.name || `连接 #${connection.id}`;
  if (!window.confirm(`确定删除供应商连接“${label}”吗？\n将同时删除该连接关联的 Sub2API 账号。\n此操作不可撤销。`)) return;
  deletingResource.value = `connection:${connection.id}`;
  try {
    const result = await send(`/supplier-connections/${connection.id}`, 'DELETE', {});
    notify(`供应商连接已删除，已处理 ${result.deletedAccounts?.length || 0} 个 Sub2API 账号`);
    if (detail.value?.connection?.id === connection.id) await closeDetails();
    await loadConnections();
  } catch (error: any) {
    notify(error.message);
  } finally {
    deletingResource.value = null;
  }
}

async function deleteKey(key: AnyRecord) {
  const label = key.name || key.maskedKey || `密钥 #${key.id}`;
  const accountCount = Number(key.accountLinks?.length || 0);
  if (!window.confirm(`确定删除供应商密钥“${label}”吗？${accountCount ? `\n将同时删除其关联的 ${accountCount} 个 Sub2API 账号。` : ''}\n此操作不可撤销。`)) return;
  deletingResource.value = `key:${key.id}`;
  try {
    const result = await send(`/supplier-keys/${key.id}`, 'DELETE', {});
    notify(`供应商密钥已删除，已处理 ${result.deletedAccounts?.length || 0} 个 Sub2API 账号`);
    if (detail.value) {
      detail.value.keys = detail.value.keys.filter((item: AnyRecord) => Number(item.id) !== Number(key.id));
    }
    void loadConnections();
  } catch (error: any) {
    notify(error.message);
  } finally {
    deletingResource.value = null;
  }
}

async function syncConnection(connectionId: number) {
  syncingId.value = connectionId;
  try {
    const result = await send(`/supplier-connections/${connectionId}/sync`, 'POST', {});
    notify(result.sync?.ok === false ? '同步未完成，请查看连接异常' : '供应商连接已同步');
    await Promise.all([
      loadConnections(),
      detail.value?.connection?.id === connectionId
        ? openDetails(connectionId, detailTab.value)
        : Promise.resolve(),
    ]);
  } catch (error: any) {
    notify(error.message);
  } finally {
    syncingId.value = null;
  }
}

async function loadQuality(connectionId: number) {
  if (!detail.value || Number(detail.value.connection?.id) !== connectionId) return;
  const requestToken = ++qualityRequestToken;
  qualityLoading.value = true;
  try {
    const quality = await get(`/supplier-connections/${connectionId}/quality?${query(rangeQuery(props.range, props.rangeStart, props.rangeEnd))}`);
    if (requestToken === qualityRequestToken && Number(detail.value?.connection?.id) === connectionId) {
      detail.value = { ...detail.value, quality };
    }
  } catch (error: any) {
    if (requestToken === qualityRequestToken) notify(error.message);
  } finally {
    if (requestToken === qualityRequestToken) qualityLoading.value = false;
  }
}

async function selectDetailTab(tab: DetailTab) {
  detailTab.value = tab;
  const connectionId = Number(detail.value?.connection?.id);
  if (tab === 'quality' && connectionId && !detail.value?.quality) await loadQuality(connectionId);
}

async function openDetails(connectionId: number, tab: DetailTab = 'keys') {
  const requestToken = ++detailRequestToken;
  detailLoading.value = true;
  detailTab.value = tab;
  try {
    const connectionDetail = await get(`/supplier-connections/${connectionId}/details`);
    if (requestToken !== detailRequestToken) return;
    detail.value = { ...connectionDetail, quality: null };
    if (String(route.query.connection || '') !== String(connectionId)) {
      await router.replace({ path: '/suppliers', query: { connection: String(connectionId) } });
    }
    if (tab === 'quality') await loadQuality(connectionId);
  } catch (error: any) {
    if (requestToken === detailRequestToken) notify(error.message);
  } finally {
    if (requestToken === detailRequestToken) detailLoading.value = false;
  }
}

async function closeDetails() {
  detailRequestToken += 1;
  qualityRequestToken += 1;
  accountRequestToken += 1;
  detail.value = null;
  qualityLoading.value = false;
  linkKey.value = null;
  accountCandidates.value = [];
  accountCandidatesLoading.value = false;
  targetEditor.value = null;
  supplierProfitGuardEditor.value = null;
  if (route.query.connection) await router.replace('/suppliers');
}

async function loadAccountCandidates() {
  const connectionId = Number(detail.value?.connection?.id);
  if (!connectionId || !linkKey.value) return;
  const requestToken = ++accountRequestToken;
  accountCandidatesLoading.value = true;
  try {
    const result = await get(`/supplier-connections/${connectionId}/account-candidates?${query({ search: accountSearch.value })}`);
    if (requestToken === accountRequestToken && linkKey.value && Number(detail.value?.connection?.id) === connectionId) {
      accountCandidates.value = result.items || [];
    }
  } catch (error: any) {
    if (requestToken === accountRequestToken) notify(error.message);
  } finally {
    if (requestToken === accountRequestToken) accountCandidatesLoading.value = false;
  }
}

async function openLinkPicker(key: AnyRecord) {
  linkKey.value = key;
  accountSearch.value = '';
  accountCandidates.value = [];
  await loadAccountCandidates();
}

function closeLinkPicker() {
  accountRequestToken += 1;
  accountCandidatesLoading.value = false;
  accountCandidates.value = [];
  linkKey.value = null;
}

async function linkAccount(accountId: number) {
  if (!linkKey.value || !detail.value) return;
  const selectedKey = linkKey.value;
  const account = accountCandidates.value.find((item) => Number(item.id) === accountId);
  try {
    const result = await send(`/supplier-keys/${selectedKey.id}/account-link`, 'PATCH', { accountId, linked: true });
    notify(result.sync?.ok === false ? '账号已关联，供应商同步暂未成功' : '账号已关联并切换为供应商密钥自动倍率');
    const key = detail.value.keys.find((item: AnyRecord) => Number(item.id) === Number(selectedKey.id));
    if (key && !key.accountLinks.some((item: AnyRecord) => Number(item.accountId) === accountId)) {
      key.accountLinks.push({
        accountId,
        accountName: account?.name || `账号 #${accountId}`,
        profitGuard: null,
      });
    }
    closeLinkPicker();
    void loadConnections();
  } catch (error: any) {
    notify(error.message);
  }
}

async function unlinkAccount(keyId: number, accountId: number) {
  if (!detail.value) return;
  try {
    await send(`/supplier-keys/${keyId}/account-link`, 'PATCH', { accountId, linked: false });
    notify('已解除本地账号关联');
    const key = detail.value.keys.find((item: AnyRecord) => Number(item.id) === keyId);
    if (key) key.accountLinks = key.accountLinks.filter((item: AnyRecord) => Number(item.accountId) !== accountId);
    void loadConnections();
  } catch (error: any) {
    notify(error.message);
  }
}

async function openProfitGuardEditor(key: AnyRecord, link: AnyRecord) {
  profitGuardSaving.value = true;
  try {
    const result = await get(`/accounts/${link.accountId}/profit-guard`);
    const policy = result.policy || {};
    const supplier = result.supplier || {};
    profitGuardEditor.value = {
      keyId: Number(key.id),
      keyName: key.name || key.maskedKey || `密钥 #${key.id}`,
      accountId: Number(link.accountId),
      accountName: link.accountName || `账号 #${link.accountId}`,
      upstreamMultiplier: supplier.upstreamMultiplier ?? key.rateMultiplier ?? null,
      enabled: Boolean(policy.enabled),
      thresholdMode: policy.thresholdMode || 'margin',
      minimumMarginPercent: Number(policy.minimumMargin || 0) * 100,
      minimumSaleMultiplier: policy.minimumSaleMultiplier ?? '',
      allowEmptyGroups: policy.allowEmptyGroups ?? true,
      autoAssignEnabled: Boolean(policy.autoAssignEnabled),
      targetMarginMinPercent: policy.targetMarginMin === null || policy.targetMarginMin === undefined ? '' : Number(policy.targetMarginMin) * 100,
      targetMarginMaxPercent: policy.targetMarginMax === null || policy.targetMarginMax === undefined ? '' : Number(policy.targetMarginMax) * 100,
    };
  } catch (error: any) {
    notify(error.message);
  } finally {
    profitGuardSaving.value = false;
  }
}

async function saveProfitGuard() {
  if (!profitGuardEditor.value || !detail.value) return;
  const current = profitGuardEditor.value;
  profitGuardSaving.value = true;
  try {
    const result = await send(`/accounts/${current.accountId}/profit-guard`, 'PATCH', {
      enabled: Boolean(current.enabled),
      thresholdMode: current.thresholdMode,
      minimumMargin: Number(current.minimumMarginPercent || 0) / 100,
      minimumSaleMultiplier: current.thresholdMode === 'minimum_sale_multiplier'
        ? Number(current.minimumSaleMultiplier)
        : null,
      allowEmptyGroups: Boolean(current.allowEmptyGroups),
      autoAssignEnabled: Boolean(current.autoAssignEnabled),
      targetMarginMin: current.autoAssignEnabled && current.targetMarginMinPercent !== '' ? Number(current.targetMarginMinPercent) / 100 : null,
      targetMarginMax: current.autoAssignEnabled && current.targetMarginMaxPercent !== '' ? Number(current.targetMarginMaxPercent) / 100 : null,
    });
    profitGuardEditor.value = null;
    if (result.evaluation?.error || result.policy?.lastError) {
      notify(`利润保护已保存，但立即评估失败：${result.evaluation?.error || result.policy.lastError}`);
    } else if (result.evaluation?.changed) {
      notify(`利润保护已保存并立即执行，已调整 ${result.evaluation.changed} 个账号的销售分组`);
    } else {
      notify('利润保护已保存并立即检查，当前销售分组均满足保护条件');
    }
    const key = detail.value.keys.find((item: AnyRecord) => Number(item.id) === Number(current.keyId));
    const link = key?.accountLinks.find((item: AnyRecord) => Number(item.accountId) === Number(current.accountId));
    if (link) link.profitGuard = result.policy || link.profitGuard;
    void loadConnections();
  } catch (error: any) {
    notify(error.message);
  } finally {
    profitGuardSaving.value = false;
  }
}

async function openSupplierProfitGuardEditor() {
  if (!detail.value) return;
  supplierProfitGuardSaving.value = true;
  try {
    const policy = await get(`/supplier-connections/${detail.value.connection.id}/profit-guard-default`);
    supplierProfitGuardEditor.value = {
      ...policy,
      minimumMarginPercent: Number(policy.minimumMargin || 0) * 100,
      minimumSaleMultiplier: policy.minimumSaleMultiplier ?? '',
      autoAssignEnabled: Boolean(policy.autoAssignEnabled),
      targetMarginMinPercent: policy.targetMarginMin === null || policy.targetMarginMin === undefined ? '' : Number(policy.targetMarginMin) * 100,
      targetMarginMaxPercent: policy.targetMarginMax === null || policy.targetMarginMax === undefined ? '' : Number(policy.targetMarginMax) * 100,
    };
  } catch (error: any) {
    notify(error.message);
  } finally {
    supplierProfitGuardSaving.value = false;
  }
}

async function saveSupplierProfitGuard() {
  if (!detail.value || !supplierProfitGuardEditor.value) return;
  const current = supplierProfitGuardEditor.value;
  supplierProfitGuardSaving.value = true;
  try {
    const result = await send(`/supplier-connections/${detail.value.connection.id}/profit-guard-default`, 'PATCH', {
      enabled: Boolean(current.enabled),
      thresholdMode: current.thresholdMode,
      minimumMargin: Number(current.minimumMarginPercent || 0) / 100,
      minimumSaleMultiplier: current.thresholdMode === 'minimum_sale_multiplier'
        ? Number(current.minimumSaleMultiplier)
        : null,
      allowEmptyGroups: Boolean(current.allowEmptyGroups),
      autoAssignEnabled: Boolean(current.autoAssignEnabled),
      targetMarginMin: current.autoAssignEnabled && current.targetMarginMinPercent !== '' ? Number(current.targetMarginMinPercent) / 100 : null,
      targetMarginMax: current.autoAssignEnabled && current.targetMarginMaxPercent !== '' ? Number(current.targetMarginMaxPercent) / 100 : null,
    });
    supplierProfitGuardEditor.value = null;
    const evaluationNote = result.evaluation?.error
      ? '；规则已保存，等待管理员认证后自动执行'
      : result.evaluation?.changed
        ? `；已移除 ${result.evaluation.changed} 个账号中的亏损分组`
        : '';
    notify(`统一利润保护已应用到 ${result.appliedAccountCount || 0} 个关联账号${evaluationNote}`);
    const policy = {
      enabled: Boolean(current.enabled),
      minimumMargin: Number(current.minimumMarginPercent || 0) / 100,
      thresholdMode: current.thresholdMode,
      minimumSaleMultiplier: current.thresholdMode === 'minimum_sale_multiplier'
        ? Number(current.minimumSaleMultiplier)
        : null,
      allowEmptyGroups: Boolean(current.allowEmptyGroups),
      lastEvaluatedAt: null,
      lastActionAt: null,
      lastError: result.evaluation?.error || '',
    };
    for (const key of detail.value.keys) {
      for (const link of key.accountLinks || []) link.profitGuard = { ...policy };
    }
    void loadConnections();
  } catch (error: any) {
    notify(error.message);
  } finally {
    supplierProfitGuardSaving.value = false;
  }
}

async function acknowledgeAlert(alertId: number) {
  const connectionId = Number(detail.value?.connection?.id);
  if (!connectionId) return;
  try {
    acknowledgingAlertId.value = alertId;
    const result = await send(`/supplier-alerts/${alertId}/acknowledge`, 'POST', {});
    if (Number(detail.value?.connection?.id) === connectionId) {
      const alert = detail.value?.alerts.find((item: AnyRecord) => Number(item.id) === alertId);
      if (alert) Object.assign(alert, result);
      if (detail.value) {
        detail.value.connection.openAlertCount = Math.max(0, Number(detail.value.connection.openAlertCount || 0) - 1);
      }
    }
    const connection = connectionItems.value.find((item) => Number(item.id) === connectionId);
    if (connection) connection.openAlertCount = Math.max(0, Number(connection.openAlertCount || 0) - 1);
    notify('告警已确认');
  } catch (error: any) {
    notify(error.message);
  } finally {
    acknowledgingAlertId.value = null;
  }
}

async function loadTargetModels(keyId: number, selectedModel = '') {
  targetModelsLoading.value = true;
  targetModels.value = [];
  try {
    const result = await get(`/supplier-keys/${keyId}/models`);
    targetModels.value = result.models || [];
    if (targetEditor.value && selectedModel && !targetModels.value.includes(selectedModel)) {
      targetModels.value.unshift(selectedModel);
    }
    if (targetEditor.value && !targetEditor.value.model && targetModels.value.length) targetEditor.value.model = targetModels.value[0];
  } catch (error: any) {
    notify(error.message);
  } finally {
    targetModelsLoading.value = false;
  }
}

async function openTargetEditor(target: AnyRecord | null = null) {
  if (!detail.value || !activeKeys.value.length) {
    notify('当前连接没有可用于主动探测的密钥');
    return;
  }
  const keyId = Number(target?.keyId || activeKeys.value[0].id);
  targetEditor.value = {
    id: target?.id || null,
    editing: Boolean(target),
    keyId,
    model: target?.model || '',
    intervalSeconds: target?.intervalSeconds || 1800,
    maxOutputTokens: target?.maxOutputTokens || 1,
    enabled: target?.enabled ?? true,
  };
  await loadTargetModels(keyId, target?.model || '');
}

async function saveTarget() {
  if (!detail.value || !targetEditor.value) return;
  const current = targetEditor.value;
  try {
    const payload = {
      keyId: Number(current.keyId),
      model: current.model,
      intervalSeconds: Number(current.intervalSeconds),
      maxOutputTokens: Number(current.maxOutputTokens),
      enabled: Boolean(current.enabled),
    };
    await send(
      current.editing ? `/supplier-quality-targets/${current.id}` : `/supplier-connections/${detail.value.connection.id}/quality-targets`,
      current.editing ? 'PATCH' : 'POST',
      payload,
    );
    targetEditor.value = null;
    notify('主动探测目标已保存');
    await loadQuality(Number(detail.value.connection.id));
  } catch (error: any) {
    notify(error.message);
  }
}

async function runTarget(targetId: number) {
  if (!detail.value) return;
  try {
    const result = await send(`/supplier-quality-targets/${targetId}/run`, 'POST', {});
    notify(result.ok === false ? '主动模型探测失败，已记录失败样本' : '主动模型探测已完成');
    await loadQuality(Number(detail.value.connection.id));
  } catch (error: any) {
    notify(error.message);
  }
}

async function deleteTarget(targetId: number) {
  if (!detail.value || !window.confirm('确定删除这个主动探测目标吗？')) return;
  try {
    await send(`/supplier-quality-targets/${targetId}`, 'DELETE', {});
    notify('主动探测目标已删除');
    await loadQuality(Number(detail.value.connection.id));
  } catch (error: any) {
    notify(error.message);
  }
}

async function openQqSettings() {
  try {
    const [settings, botStatus] = await Promise.all([
      get('/alert-notification-settings'),
      get('/qq-bot/status'),
    ]);
    qqEditor.value = {
      ...settings,
    };
    qqBotStatus.value = botStatus;
    startQqBotPolling();
  } catch (error: any) {
    notify(error.message);
  }
}

function closeQqSettings() {
  qqEditor.value = null;
  qqBotStatus.value = null;
  window.clearInterval(qqBotTimer);
  qqBotTimer = undefined;
}

async function loadQqBotStatus(quiet = false) {
  if (!qqEditor.value) return;
  if (!quiet) qqBotLoading.value = true;
  try {
    qqBotStatus.value = await get('/qq-bot/status');
  } catch (error: any) {
    if (!quiet) notify(error.message);
  } finally {
    if (!quiet) qqBotLoading.value = false;
  }
}

function startQqBotPolling() {
  window.clearInterval(qqBotTimer);
  qqBotTimer = window.setInterval(() => {
    if (qqEditor.value && !qqBotStatus.value?.loggedIn) void loadQqBotStatus(true);
  }, 3_000);
}

async function refreshQqBotQr() {
  qqBotAction.value = true;
  qqBotStatus.value = {
    ...(qqBotStatus.value || {}),
    qrcode: '',
    error: '正在生成新的 QQ 登录二维码，请稍候。',
  };
  try {
    qqBotStatus.value = await send('/qq-bot/refresh', 'POST', {});
    notify('已生成新的 QQ 登录二维码');
  } catch (error: any) {
    const message = error.message || '新的 QQ 登录二维码暂时生成失败，请稍候重试';
    qqBotStatus.value = {
      ...(qqBotStatus.value || {}),
      qrcode: '',
      error: message,
    };
    notify(message);
  } finally {
    qqBotAction.value = false;
  }
}

async function logoutQqBot() {
  if (!window.confirm('将退出当前 QQ 并重新启动登录流程，需要重新扫码确认。是否继续？')) return;
  qqBotAction.value = true;
  try {
    await send('/qq-bot/logout', 'POST', {});
    qqBotStatus.value = {
      ...(qqBotStatus.value || {}),
      loggedIn: false,
      onebotReady: false,
      qrcode: '',
    };
    notify('当前 QQ 已退出，正在准备新的登录二维码');
    window.setTimeout(() => void loadQqBotStatus(true), 2_000);
  } catch (error: any) {
    notify(error.message);
  } finally {
    qqBotAction.value = false;
  }
}

async function saveQqSettings(closeAfter = true) {
  if (!qqEditor.value) return false;
  qqSaving.value = true;
  try {
    await send('/alert-notification-settings', 'PATCH', {
      enabled: Boolean(qqEditor.value.enabled),
      qqNumber: String(qqEditor.value.qqNumber || '').trim(),
    });
    notify('QQ 告警配置已保存');
    if (closeAfter) closeQqSettings();
    return true;
  } catch (error: any) {
    notify(error.message);
    return false;
  } finally {
    qqSaving.value = false;
  }
}

async function testQqSettings() {
  if (!await saveQqSettings(false)) return;
  try {
    await send('/alert-notification-settings/test', 'POST', {});
    notify('QQ 测试消息已发送');
  } catch (error: any) {
    notify(error.message);
  }
}

async function openServiceAuthSettings() {
  try {
    const settings = await get('/sub2api-service-auth');
    serviceAuthEditor.value = {
      ...settings,
      authMode: settings.authMode || 'api_key',
      password: '',
      totpSecret: '',
      apiKey: '',
      clearCredentials: false,
    };
  } catch (error: any) {
    notify(error.message);
  }
}

async function saveServiceAuthSettings(closeAfter = true) {
  if (!serviceAuthEditor.value) return false;
  serviceAuthSaving.value = true;
  try {
    const result = await send('/sub2api-service-auth', 'PATCH', {
      enabled: Boolean(serviceAuthEditor.value.enabled),
      authMode: serviceAuthEditor.value.authMode || 'api_key',
      email: String(serviceAuthEditor.value.email || '').trim(),
      password: serviceAuthEditor.value.password || '',
      totpSecret: serviceAuthEditor.value.totpSecret || '',
      apiKey: serviceAuthEditor.value.apiKey || '',
      clearCredentials: Boolean(serviceAuthEditor.value.clearCredentials),
    });
    serviceAuthEditor.value = {
      ...serviceAuthEditor.value,
      ...result,
      password: '',
      totpSecret: '',
      apiKey: '',
      clearCredentials: false,
    };
    notify(result.authenticated ? 'Sub2API 服务账号已验证' : 'Sub2API 服务账号已保存');
    if (closeAfter) serviceAuthEditor.value = null;
    return true;
  } catch (error: any) {
    notify(error.message);
    return false;
  } finally {
    serviceAuthSaving.value = false;
  }
}

async function testServiceAuthSettings() {
  if (!await saveServiceAuthSettings(false)) return;
  try {
    const result = await send('/sub2api-service-auth/test', 'POST', {});
    if (serviceAuthEditor.value) serviceAuthEditor.value = {
      ...serviceAuthEditor.value,
      ...result,
      password: '',
      totpSecret: '',
      apiKey: '',
      clearCredentials: false,
    };
    notify('Sub2API 服务账号已验证');
  } catch (error: any) {
    notify(error.message);
  }
}

watch(search, () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(loadConnections, 250);
});
watch(accountSearch, () => {
  if (!linkKey.value) return;
  window.clearTimeout(accountSearchTimer);
  accountSearchTimer = window.setTimeout(loadAccountCandidates, 250);
});
watch(() => props.refreshToken, () => loadConnections());
watch([() => props.range, () => props.rangeStart, () => props.rangeEnd], () => {
  if (!detail.value?.connection?.id) return;
  detail.value = { ...detail.value, quality: null };
  if (detailTab.value === 'quality') void loadQuality(Number(detail.value.connection.id));
});
watch(() => editor.value?.adapterType, () => syncEditorAuthMode());
watch(() => targetEditor.value?.keyId, (value, previous) => {
  if (value && value !== previous && targetEditor.value) {
    targetEditor.value.model = '';
    loadTargetModels(Number(value));
  }
});

onMounted(async () => {
  await loadConnections();
  const connectionId = Number(route.query.connection || 0);
  if (connectionId) await openDetails(connectionId);
});

onBeforeUnmount(() => {
  window.clearTimeout(searchTimer);
  window.clearTimeout(accountSearchTimer);
  window.clearInterval(qqBotTimer);
});
</script>

<template>
  <div class="page-view supplier-view">
    <div class="toolbar-row">
      <label class="search-box">
        <ServerCog :size="17" />
        <input v-model="search" placeholder="搜索供应商、连接名称或站点地址" />
      </label>
      <button class="secondary-button profit-guard-filter" :class="{ active: showUnconfiguredProfitGuard }" title="显示仍有账号未启用利润保护的供应商连接" @click="showUnconfiguredProfitGuard = !showUnconfiguredProfitGuard"><AlertTriangle :size="16" />利润保护未覆盖 <span v-if="unconfiguredProfitGuardCount" class="filter-count">{{ unconfiguredProfitGuardCount }}</span></button>
      <details class="supplier-settings-menu">
        <summary class="secondary-button"><Settings2 :size="16" />供应商设置<ChevronDown :size="14" /></summary>
        <div class="supplier-settings-popover">
          <button @click="openServiceAuthSettings"><KeyRound :size="16" /><span><strong>Sub2API 自动认证</strong><small>后台同步与利润保护凭据</small></span></button>
        </div>
      </details>
      <button class="secondary-button" title="配置连接、余额和密钥异常通知" @click="openQqSettings"><Bell :size="16" />QQ 告警</button>
      <button class="primary-button" @click="openCreate"><Plus :size="16" />添加连接</button>
      <button class="icon-button" title="刷新列表" aria-label="刷新列表" @click="loadConnections"><RefreshCw :size="17" :class="{ spin: loading }" /></button>
    </div>

    <div class="supplier-summary-grid">
      <div><span>正常连接</span><strong>{{ connectionSummary.healthy }} / {{ connectionSummary.total }}</strong><small>当前供应商连接</small></div>
      <div><span>可用密钥</span><strong>{{ connectionSummary.activeKeys }} / {{ connectionSummary.totalKeys }}</strong><small>上游库存状态</small></div>
      <div :class="{ attention: connectionSummary.alerts }"><span>待处理告警</span><strong>{{ connectionSummary.alerts }}</strong><small>连接、密钥与倍率</small></div>
      <div :class="{ attention: connectionSummary.lowBalance }"><span>低余额连接</span><strong>{{ connectionSummary.lowBalance }}</strong><small>已达到告警阈值</small></div>
    </div>

    <section class="panel table-panel supplier-resource-panel">
      <div class="panel-head">
        <div>
          <h2>连接运行状态</h2>
          <p>主表聚焦余额、密钥健康、告警和同步状态；地址、备注及认证配置在详情中查看。</p>
        </div>
        <ServerCog :size="20" class="head-icon" />
      </div>
      <div class="table-wrap">
        <table class="supplier-table">
          <thead><tr><th>供应商 / 连接</th><th>连接状态</th><th class="number">余额</th><th>密钥健康</th><th>告警</th><th>最近同步</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-if="loading && !items.length"><td colspan="7" class="table-empty">正在读取供应商连接</td></tr>
            <tr v-for="item in items" :key="item.id">
              <td>
                <button class="link-button supplier-name-button" @click="openDetails(item.id)">
                  {{ item.supplierName || '未命名供应商' }}
                </button>
                <small>{{ item.name || '默认连接' }} · {{ adapterLabel(item.detectedAdapterType || item.adapterType) }} · {{ authLabel(item.authMode) }}</small>
                <small :class="{ 'profit-guard-on': item.profitGuardFullyEnabled, 'profit-guard-missing': !item.profitGuardFullyEnabled }">利润保护：{{ connectionProfitGuardHint(item) }}</small>
              </td>
              <td>
                <span class="status-pill" :class="statusClass(item.connectionStatus)">{{ statusLabel(item.connectionStatus) }}</span>
                <small>{{ connectionHint(item) }}</small>
              </td>
              <td class="number">
                <strong>{{ amount(item.balance, item.balanceCurrency) }}</strong>
                <small>{{ item.lowBalanceThreshold === null || item.lowBalanceThreshold === undefined ? `币种 ${item.balanceCurrency || '--'} · 未设阈值` : `阈值 ${amount(item.lowBalanceThreshold, item.balanceCurrency)}` }}</small>
              </td>
              <td>
                <strong>{{ item.activeKeyCount }} / {{ item.keyCount }} 可用</strong>
                <small>{{ item.failedKeyCount ? `${item.failedKeyCount} 个巡检失败` : '没有巡检失败' }}</small>
              </td>
              <td>
                <span v-if="item.openAlertCount" class="alert-count">{{ item.openAlertCount }} 待处理</span>
                <span v-else class="muted-text">没有开放告警</span>
              </td>
              <td>
                <strong>{{ dateTime(item.lastSuccessAt) }}</strong>
                <small>{{ item.nextSyncAt ? `下次 ${dateTime(item.nextSyncAt)}` : item.enabled ? '等待排程' : '连接已停用' }}</small>
              </td>
              <td>
                <div class="row-actions">
                  <button class="icon-button mini-action" title="查看详情" @click="openDetails(item.id)"><Activity :size="16" /></button>
                  <button class="icon-button mini-action" title="编辑连接" @click="openEdit(item)"><Edit3 :size="16" /></button>
                  <button class="icon-button mini-action" title="立即同步" :disabled="!item.enabled || syncingId === item.id" @click="syncConnection(item.id)"><RefreshCw :size="16" :class="{ spin: syncingId === item.id }" /></button>
                  <button class="icon-button mini-action danger-action" title="删除供应商连接" :disabled="deletingResource === `connection:${item.id}`" @click="deleteConnection(item)"><Trash2 :size="16" /></button>
                </div>
              </td>
            </tr>
            <tr v-if="!loading && !items.length"><td colspan="7" class="table-empty">没有找到供应商连接</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <div v-if="editor" class="modal-layer" @click.self="editor = null">
      <section class="modal form-modal supplier-editor-modal">
        <header>
          <div><h2>{{ editor.editing ? '编辑供应商连接' : '添加供应商连接' }}</h2><p>凭据不会回显，只会加密保存在 FinOps 自己的数据库。</p></div>
          <button class="icon-button" @click="editor = null"><X :size="19" /></button>
        </header>
        <div class="form-grid">
          <label>供应商名称<input v-model="editor.supplierName" required placeholder="例如 Sub2API 主站" /></label>
          <label>连接名称<input v-model="editor.name" required placeholder="例如 主账号" /></label>
          <label>系统类型<select v-model="editor.adapterType"><option v-for="(label, value) in adapterLabels" :key="value" :value="value">{{ label }}</option></select></label>
          <label>认证方式<select v-model="editor.authMode"><option v-for="option in authOptions(editor.adapterType)" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
          <label class="full-field">站点地址<input v-model="editor.baseUrl" required type="url" placeholder="https://supplier.example.com" /></label>
          <label>凭据标识<input v-model="editor.credentialLabel" placeholder="采购邮箱或负责人，可选" /></label>
          <label>余额币种<input v-model="editor.balanceCurrency" required /></label>
          <label>质量监控模式<select v-model="editor.qualityMonitorMode"><option value="off">关闭</option><option value="passive">仅被动上游数据</option><option value="active">仅主动探测</option><option value="hybrid">混合模式</option></select></label>
          <label>库存同步间隔（秒）<input v-model.number="editor.inventoryIntervalSeconds" type="number" min="3" max="86400" /></label>
          <label>单次巡检上限<input v-model.number="editor.activeCheckLimit" type="number" min="1" max="100" /></label>
          <label>低余额告警阈值<input v-model="editor.lowBalanceThreshold" type="number" min="0" step="any" placeholder="不设置则不告警" /></label>
          <label class="toggle-field"><input v-model="editor.enabled" type="checkbox" /><span><strong>启用连接</strong><small>纳入定时读取</small></span></label>
          <label class="toggle-field"><input v-model="editor.activeCheckEnabled" type="checkbox" /><span><strong>巡检可用密钥</strong><small>只检测，不写入上游</small></span></label>
        </div>
        <div class="form-note supplier-note-editor">
          供应商备注
          <textarea v-model="editor.supplierNotes" rows="3" maxlength="2000" placeholder="记录采购联系人、价格说明或其他内部备注"></textarea>
        </div>
        <div class="form-section">
          <div class="form-section-head">
            <div><strong>访问凭据</strong><small v-if="editor.editing && editor.credentialsConfigured">已配置加密凭据；留空表示继续使用原凭据。</small></div>
          </div>
          <div class="form-grid">
            <template v-if="editor.authMode === 'password'">
              <label>登录账号<input v-model="editor.username" autocomplete="username" /></label>
              <label>登录密码<input v-model="editor.password" type="password" autocomplete="new-password" /></label>
              <label v-if="editor.adapterType === 'sub2api'" class="full-field">TOTP 密钥（可选）<input v-model="editor.totpSecret" type="password" autocomplete="off" /></label>
            </template>
            <template v-else-if="editor.authMode === 'token_refresh'">
              <label>Access Token<input v-model="editor.accessToken" type="password" autocomplete="off" :placeholder="editor.editing && editor.credentialsConfigured ? '留空继续使用当前 Token' : '建议与 Refresh Token 一起填写'" /></label>
              <label>Refresh Token<input v-model="editor.refreshToken" type="password" autocomplete="off" :placeholder="editor.editing && editor.credentialsConfigured ? '留空继续使用当前 Refresh Token' : '必填，用于自动续期'" /></label>
              <div class="token-refresh-note full-field">
                <ShieldCheck :size="18" />
                <div><strong>自动续期已开启</strong><small>Token 会加密保存。Access Token 临近过期或请求返回 401 时，FinOps 会刷新并保存服务端返回的新 Token 对。</small></div>
              </div>
            </template>
            <label v-else-if="editor.authMode === 'access_token'" class="full-field">静态访问令牌<input v-model="editor.accessToken" type="password" autocomplete="off" /></label>
            <label v-else class="full-field">API 密钥<input v-model="editor.apiKey" type="password" autocomplete="off" /></label>
            <template v-if="editor.adapterType === 'openai_compatible'">
              <label>密钥显示名<input v-model="editor.keyName" /></label>
              <label>上游倍率<input v-model="editor.rateMultiplier" type="number" min="0" step="any" /></label>
              <label>手工余额<input v-model="editor.balance" type="number" min="0" step="any" /></label>
              <label>手工余额币种<input v-model="editor.credentialsBalanceCurrency" /></label>
            </template>
          </div>
        </div>
        <div class="form-note">主动模式只会使用你配置的密钥和模型发起受控请求；本次没有新增额外耗时监控。</div>
        <footer><button class="secondary-button" @click="editor = null">取消</button><button class="primary-button" :disabled="editorSaving" @click="saveConnection"><RefreshCw v-if="editorSaving" :size="16" class="spin" /><Check v-else :size="16" />{{ editor.editing ? '保存连接' : '创建并同步' }}</button></footer>
      </section>
    </div>

    <div v-if="detail || detailLoading" class="modal-layer" @click.self="closeDetails">
      <section class="modal supplier-detail-modal">
        <header>
          <div><h2>{{ detail?.connection?.supplierName || '供应商连接详情' }} · {{ detail?.connection?.name || '' }}</h2><p v-if="detail">{{ detail.connection.baseUrl }} · {{ adapterLabel(detail.connection.detectedAdapterType || detail.connection.adapterType) }} · {{ authLabel(detail.connection.authMode) }}</p></div>
          <button class="icon-button" @click="closeDetails"><X :size="19" /></button>
        </header>
        <div v-if="detailLoading && !detail" class="table-empty">正在读取供应商连接详情</div>
        <template v-else-if="detail">
          <div class="detail-actionbar">
            <div><span class="status-pill" :class="statusClass(detail.connection.connectionStatus)">{{ statusLabel(detail.connection.connectionStatus) }}</span><span>{{ connectionHint(detail.connection) }}</span></div>
            <div class="row-actions">
              <button class="secondary-button danger-action" :disabled="deletingResource === `connection:${detail.connection.id}`" @click="deleteConnection(detail.connection)"><Trash2 :size="16" />删除供应商</button>
              <button class="secondary-button" @click="openEdit(detail.connection)"><Settings2 :size="16" />编辑连接</button>
              <button class="primary-button" :disabled="!detail.connection.enabled || syncingId === detail.connection.id" @click="syncConnection(detail.connection.id)"><RefreshCw :size="16" :class="{ spin: syncingId === detail.connection.id }" />立即同步</button>
            </div>
          </div>
          <div class="supplier-metrics">
            <div><span>当前余额</span><strong>{{ amount(detail.connection.balance, detail.connection.balanceCurrency) }}</strong><small>{{ detail.connection.lowBalanceThreshold === null ? '未设置低余额阈值' : `阈值 ${amount(detail.connection.lowBalanceThreshold, detail.connection.balanceCurrency)}` }}</small></div>
            <div><span>可用密钥</span><strong>{{ activeKeys.length }} / {{ visibleKeys.length }}</strong><small>{{ detail.connection.failedKeyCount ? `${detail.connection.failedKeyCount} 个巡检失败` : '未发现巡检异常' }}</small></div>
            <div><span>待处理告警</span><strong>{{ openAlerts.length }}</strong><small>{{ openAlerts.length ? '请查看并处理告警' : '当前没有开放告警' }}</small></div>
            <div><span>下次同步</span><strong>{{ detail.connection.enabled ? dateTime(detail.connection.nextSyncAt) : '已停用' }}</strong><small>每 {{ detail.connection.inventoryIntervalSeconds }} 秒读取一次</small></div>
          </div>
          <div class="detail-tabs">
            <button :class="{ active: detailTab === 'keys' }" @click="selectDetailTab('keys')">API 密钥 <small>{{ visibleKeys.length }}</small></button>
            <button :class="{ active: detailTab === 'quality' }" @click="selectDetailTab('quality')">质量评分 <small>{{ detail.quality?.metrics?.sampleCount || 0 }}</small></button>
            <button :class="{ active: detailTab === 'balances' }" @click="selectDetailTab('balances')">余额历史 <small>{{ detail.balances.length }}</small></button>
            <button :class="{ active: detailTab === 'checks' }" @click="selectDetailTab('checks')">巡检记录 <small>{{ detail.checks.length }}</small></button>
            <button :class="{ active: detailTab === 'alerts' }" @click="selectDetailTab('alerts')">告警 <small>{{ openAlerts.length }}</small></button>
          </div>

          <section v-if="detailTab === 'keys'" class="detail-section">
            <div class="detail-section-head"><div><h3>API 密钥库存</h3><p>仅展示上游返回的脱敏标识；账号关联后自动使用该密钥的上游倍率。</p></div><button class="secondary-button" @click="openSupplierProfitGuardEditor"><Settings2 :size="16" />统一利润保护</button></div>
            <div class="table-wrap compact-table">
              <table><thead><tr><th>密钥</th><th>状态</th><th>分组 / 倍率</th><th>额度</th><th>最近巡检</th><th>本地账号</th><th>操作</th></tr></thead>
                <tbody>
                  <tr v-for="key in visibleKeys" :key="key.id">
                    <td><strong>{{ key.name || key.maskedKey || `密钥 #${key.id}` }}</strong><small>{{ key.maskedKey || key.externalId || '--' }} · ID {{ key.externalId || '--' }}</small></td>
                    <td><span class="status-pill" :class="statusClass(key.removedAt ? 'removed' : key.status)">{{ statusLabel(key.removedAt ? 'removed' : key.status) }}</span></td>
                    <td><strong>{{ key.groupName || '未分组' }}</strong><small>{{ key.rateMultiplier === null || key.rateMultiplier === undefined ? '未提供倍率' : `${key.rateMultiplier}x` }}</small></td>
                    <td><strong>{{ quotaText(key) }}</strong><small>{{ key.expiresAt ? `到期 ${dateTime(key.expiresAt)}` : key.lastUsedAt ? `最近使用 ${dateTime(key.lastUsedAt)}` : '无到期或使用记录' }}</small></td>
                    <td><span class="status-pill" :class="statusClass(key.lastCheckStatus)">{{ statusLabel(key.lastCheckStatus || 'pending') }}</span><small>{{ key.lastCheckMethod || '等待巡检' }} · {{ dateTime(key.lastCheckAt) }}</small><small v-if="key.lastCheckError" class="error-text">{{ supplierMessage(key.lastCheckError) }}</small></td>
                    <td>
                      <div class="account-links">
                        <span v-for="link in key.accountLinks" :key="link.accountId">
                          {{ link.accountName || `账号 #${link.accountId}` }}
                          <small :class="{ 'profit-guard-on': link.profitGuard?.enabled }">{{ profitGuardHint(link.profitGuard) }}</small>
                          <button title="配置账号利润保护" @click="openProfitGuardEditor(key, link)"><Settings2 :size="13" /></button>
                          <button title="解除关联" @click="unlinkAccount(key.id, link.accountId)"><X :size="13" /></button>
                        </span>
                        <small v-if="!key.accountLinks?.length">尚未关联本地账号</small>
                      </div>
                      <button v-if="!key.removedAt" class="small-button link-account-button" @click="openLinkPicker(key)"><Link2 :size="14" />关联账号</button>
                    </td>
                    <td>
                      <button class="icon-button mini-action danger-action" title="删除供应商密钥" :disabled="deletingResource === `key:${key.id}`" @click="deleteKey(key)"><Trash2 :size="15" /></button>
                    </td>
                  </tr>
                  <tr v-if="!visibleKeys.length"><td colspan="7" class="table-empty">本次同步没有返回可用密钥</td></tr>
                </tbody>
              </table>
            </div>
          </section>

          <section v-else-if="detailTab === 'quality'" class="detail-section">
            <div class="detail-section-head"><div><h3>供应商质量评分</h3><p>当前模式：{{ qualityModeLabel(detail.connection.qualityMonitorMode) }}。展示已有质量样本，不新增额外耗时监控。</p></div><button class="primary-button" :disabled="!['active','hybrid'].includes(detail.connection.qualityMonitorMode)" @click="openTargetEditor()"><Plus :size="16" />添加主动目标</button></div>
            <div v-if="qualityLoading && !detail.quality" class="table-empty"><RefreshCw :size="16" class="spin" />正在读取质量评分</div>
            <div class="supplier-metrics quality-metrics">
              <div><span>风险调整分</span><strong>{{ detail.quality?.score?.riskAdjustedScore == null ? '--' : Number(detail.quality.score.riskAdjustedScore).toFixed(1) }}</strong><small>{{ detail.quality?.score?.dataStatus || '暂无评分' }}</small></div>
              <div><span>价格分</span><strong>{{ detail.quality?.score?.priceScore == null ? '--' : Number(detail.quality.score.priceScore).toFixed(1) }}</strong><small>同模型供应商间比较</small></div>
              <div><span>可用性分</span><strong>{{ detail.quality?.score?.availabilityScore == null ? '--' : Number(detail.quality.score.availabilityScore).toFixed(1) }}</strong><small>{{ detail.quality?.metrics?.sampleCount || 0 }} 个样本</small></div>
              <div><span>稳定性分</span><strong>{{ detail.quality?.score?.stabilityScore == null ? '--' : Number(detail.quality.score.stabilityScore).toFixed(1) }}</strong><small>可信度 {{ detail.quality?.score?.confidence == null ? '--' : Number(detail.quality.score.confidence).toFixed(1) }}</small></div>
            </div>
            <h3 class="subsection-title">主动探测目标</h3>
            <div class="table-wrap compact-table"><table><thead><tr><th>密钥</th><th>模型</th><th>间隔</th><th>状态</th><th>最近探测</th><th>操作</th></tr></thead>
              <tbody>
                <tr v-for="target in detail.quality?.targets || []" :key="target.id"><td>{{ target.keyName || target.maskedKey || `密钥 #${target.keyId}` }}<small>{{ target.groupName || '未分组' }}</small></td><td>{{ target.model }}</td><td>{{ target.intervalSeconds }} 秒<small>最多 {{ target.maxOutputTokens }} Token</small></td><td><span class="status-pill" :class="statusClass(target.lastStatus)">{{ statusLabel(target.enabled ? target.lastStatus : 'disabled') }}</span></td><td>{{ dateTime(target.lastProbeAt) }}</td><td><div class="row-actions"><button class="icon-button mini-action" title="编辑" @click="openTargetEditor(target)"><Edit3 :size="15" /></button><button class="icon-button mini-action" title="立即探测" :disabled="!target.enabled" @click="runTarget(target.id)"><Activity :size="15" /></button><button class="icon-button mini-action danger-action" title="删除" @click="deleteTarget(target.id)"><X :size="15" /></button></div></td></tr>
                <tr v-if="!(detail.quality?.targets || []).length"><td colspan="6" class="table-empty">尚未配置主动探测目标</td></tr>
              </tbody>
            </table></div>
            <h3 class="subsection-title">最近质量样本</h3>
            <div class="table-wrap compact-table"><table><thead><tr><th>时间</th><th>来源</th><th>模型</th><th>状态</th><th>首字延迟</th><th>完整耗时</th></tr></thead>
              <tbody>
                <tr v-for="sample in (detail.quality?.observations || []).slice(0, 40)" :key="sample.id"><td>{{ dateTime(sample.observedAt) }}</td><td>{{ sample.sourceKind || '--' }}</td><td>{{ sample.model || '--' }}</td><td><span class="status-pill" :class="statusClass(sample.status)">{{ statusLabel(sample.status) }}</span></td><td>{{ sample.ttftMs == null ? '--' : `${sample.ttftMs} ms` }}</td><td>{{ sample.durationMs == null ? '--' : `${sample.durationMs} ms` }}</td></tr>
                <tr v-if="!(detail.quality?.observations || []).length"><td colspan="6" class="table-empty">暂无质量样本</td></tr>
              </tbody>
            </table></div>
          </section>

          <section v-else-if="detailTab === 'balances'" class="detail-section">
            <div class="detail-section-head"><div><h3>余额历史</h3><p>余额仅用于供应商资金监控，不会自动推导采购成本。</p></div></div>
            <div class="table-wrap compact-table"><table><thead><tr><th>采样时间</th><th class="number">余额</th><th>币种</th></tr></thead><tbody><tr v-for="(item, index) in detail.balances" :key="index"><td>{{ dateTime(item.observedAt) }}</td><td class="number">{{ amount(item.balance, item.currency) }}</td><td>{{ item.currency }}</td></tr><tr v-if="!detail.balances.length"><td colspan="3" class="table-empty">暂无余额快照</td></tr></tbody></table></div>
          </section>

          <section v-else-if="detailTab === 'checks'" class="detail-section">
            <div class="detail-section-head"><div><h3>密钥巡检记录</h3><p>巡检只验证密钥状态，不会修改上游配置。</p></div></div>
             <div class="table-wrap compact-table"><table><thead><tr><th>时间</th><th>密钥</th><th>结果</th><th>方式</th><th>HTTP</th><th>错误</th></tr></thead><tbody><tr v-for="item in detail.checks" :key="item.id"><td>{{ dateTime(item.checkedAt) }}</td><td>{{ item.keyName || item.maskedKey }}</td><td><span class="status-pill" :class="statusClass(item.status)">{{ statusLabel(item.status) }}</span></td><td>{{ item.method || '--' }}</td><td>{{ item.httpStatus || '--' }}</td><td>{{ supplierMessage(item.errorMessage || item.errorCode, item.errorCode) }}</td></tr><tr v-if="!detail.checks.length"><td colspan="6" class="table-empty">暂无巡检记录</td></tr></tbody></table></div>
          </section>

          <section v-else class="detail-section">
            <div class="detail-section-head"><div><h3>供应商告警</h3><p>连接失败、密钥异常、低余额和倍率变化会记录在这里。</p></div></div>
            <div class="alert-detail-list">
              <article v-for="alert in detail.alerts" :key="alert.id" :class="['alert-detail', alert.severity]">
                <AlertTriangle :size="18" />
                <div><strong>{{ supplierAlertTitle(alert) }}</strong><p>{{ supplierAlertMessage(alert) }}</p><small>{{ dateTime(alert.lastSeenAt) }} · 出现 {{ alert.occurrenceCount }} 次 · {{ statusLabel(alert.status) }}</small></div>
                <button v-if="alert.status === 'open'" class="small-button" :disabled="acknowledgingAlertId === alert.id" @click="acknowledgeAlert(alert.id)"><RefreshCw v-if="acknowledgingAlertId === alert.id" :size="14" class="spin" /><Check v-else :size="14" />确认</button>
              </article>
              <div v-if="!detail.alerts.length" class="table-empty">当前没有供应商告警</div>
            </div>
          </section>
        </template>
      </section>
    </div>

    <div v-if="linkKey" class="modal-layer nested-modal" @click.self="closeLinkPicker">
      <section class="modal link-picker-modal">
        <header><div><h2>关联本地账号</h2><p>{{ linkKey.name || linkKey.maskedKey }} · {{ linkKey.groupName || '未分组' }}</p></div><button class="icon-button" @click="closeLinkPicker"><X :size="19" /></button></header>
        <label class="search-box full-search"><Link2 :size="17" /><input v-model="accountSearch" placeholder="搜索账号、平台或 ID" /></label>
        <div class="table-wrap compact-table"><table><thead><tr><th>本地账号</th><th>平台</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="account in availableAccounts" :key="account.id"><td><strong>{{ account.name || `账号 #${account.id}` }}</strong><small>ID {{ account.id }}</small></td><td>{{ account.platform || '--' }}</td><td><span class="status-pill success">可用</span></td><td><button class="small-button" @click="linkAccount(account.id)"><Link2 :size="14" />关联</button></td></tr><tr v-if="accountCandidatesLoading"><td colspan="4" class="table-empty"><RefreshCw :size="15" class="spin" />正在读取账号</td></tr><tr v-else-if="!availableAccounts.length"><td colspan="4" class="table-empty">没有可关联的本地账号</td></tr></tbody></table></div>
      </section>
    </div>

    <div v-if="profitGuardEditor" class="modal-layer nested-modal" @click.self="profitGuardEditor = null">
      <section class="modal form-modal profit-guard-modal">
        <header>
          <div>
            <h2>账号利润保护</h2>
            <p>{{ profitGuardEditor.keyName }} · {{ profitGuardEditor.accountName }}</p>
          </div>
          <button class="icon-button" @click="profitGuardEditor = null"><X :size="19" /></button>
        </header>
        <div class="form-grid">
          <label class="toggle-field full-field">
            <input v-model="profitGuardEditor.enabled" type="checkbox" />
            <span><strong>自动将账号移出亏损分组</strong><small>只更新该账号的分组归属，不会删除分组或影响其他账号。</small></span>
          </label>
          <label>保护方式
            <select v-model="profitGuardEditor.thresholdMode" :disabled="!profitGuardEditor.enabled">
              <option value="margin">最低毛利率</option>
              <option value="minimum_sale_multiplier">上游成本触发倍率</option>
            </select>
          </label>
          <label>当前上游倍率<input :value="multiplierText(profitGuardEditor.upstreamMultiplier)" readonly /></label>
          <label v-if="profitGuardEditor.thresholdMode === 'margin'">最低毛利率 (%)
            <input v-model="profitGuardEditor.minimumMarginPercent" type="number" min="0" max="99.99" step="0.1" :disabled="!profitGuardEditor.enabled" />
          </label>
          <label v-else>上游成本触发倍率
            <input v-model="profitGuardEditor.minimumSaleMultiplier" type="number" min="0" step="0.0001" :disabled="!profitGuardEditor.enabled" />
          </label>
          <label class="toggle-field">
            <input v-model="profitGuardEditor.allowEmptyGroups" type="checkbox" :disabled="!profitGuardEditor.enabled" />
            <span><strong>允许移出最后一个分组</strong><small>关闭时只产生告警，账号仍保留在最后一个分组。</small></span>
          </label>
          <label class="toggle-field full-field">
            <input v-model="profitGuardEditor.autoAssignEnabled" type="checkbox" :disabled="!profitGuardEditor.enabled" />
            <span><strong>自动归组</strong><small>只添加与账号平台一致、且销售毛利率落在区间内的分组。</small></span>
          </label>
          <label v-if="profitGuardEditor.autoAssignEnabled">目标毛利率下限 (%)
            <input v-model="profitGuardEditor.targetMarginMinPercent" type="number" min="0" max="100" step="0.1" :disabled="!profitGuardEditor.enabled" />
          </label>
          <label v-if="profitGuardEditor.autoAssignEnabled">目标毛利率上限 (%)
            <input v-model="profitGuardEditor.targetMarginMaxPercent" type="number" min="0" max="100" step="0.1" :disabled="!profitGuardEditor.enabled" />
          </label>
        </div>
        <div v-if="profitGuardEditor.thresholdMode === 'margin'" class="form-note">
          按当前上游倍率 {{ multiplierText(profitGuardEditor.upstreamMultiplier) }} 和最低毛利率计算，最低售卖倍率为
          <strong>{{ calculatedMinimumSaleMultiplier === null ? '--' : multiplierText(calculatedMinimumSaleMultiplier) }}</strong>。
        </div>
        <div v-else class="form-note">上游成本达到此倍率后，售价倍率不高于该值的分组会自动移除；售价不高于上游成本的分组始终会被移除。</div>
        <footer>
          <button class="secondary-button" @click="profitGuardEditor = null">取消</button>
          <button class="primary-button" :disabled="profitGuardSaving" @click="saveProfitGuard"><Check :size="16" />保存利润保护</button>
        </footer>
      </section>
    </div>

    <div v-if="supplierProfitGuardEditor" class="modal-layer nested-modal" @click.self="supplierProfitGuardEditor = null">
      <section class="modal form-modal profit-guard-modal">
        <header>
          <div>
            <h2>供应商统一利润保护</h2>
            <p>{{ detail?.connection?.supplierName }} · {{ detail?.connection?.name }}</p>
          </div>
          <button class="icon-button" @click="supplierProfitGuardEditor = null"><X :size="19" /></button>
        </header>
        <div class="form-grid">
          <label class="toggle-field full-field">
            <input v-model="supplierProfitGuardEditor.enabled" type="checkbox" />
            <span><strong>统一启用利润保护</strong><small>保存后覆盖该供应商当前所有已关联账号；以后新关联账号也会自动继承。</small></span>
          </label>
          <label>保护方式
            <select v-model="supplierProfitGuardEditor.thresholdMode" :disabled="!supplierProfitGuardEditor.enabled">
              <option value="margin">最低毛利率</option>
              <option value="minimum_sale_multiplier">上游成本触发倍率</option>
            </select>
          </label>
          <label v-if="supplierProfitGuardEditor.thresholdMode === 'margin'">最低毛利率 (%)
            <input v-model="supplierProfitGuardEditor.minimumMarginPercent" type="number" min="0" max="99.99" step="0.1" :disabled="!supplierProfitGuardEditor.enabled" />
          </label>
          <label v-else>上游成本触发倍率
            <input v-model="supplierProfitGuardEditor.minimumSaleMultiplier" type="number" min="0" step="0.0001" :disabled="!supplierProfitGuardEditor.enabled" />
          </label>
          <label class="toggle-field full-field">
            <input v-model="supplierProfitGuardEditor.allowEmptyGroups" type="checkbox" :disabled="!supplierProfitGuardEditor.enabled" />
            <span><strong>允许移出最后一个分组</strong><small>关闭时，账号只会告警并保留最后一个亏损分组。</small></span>
          </label>
          <label class="toggle-field full-field">
            <input v-model="supplierProfitGuardEditor.autoAssignEnabled" type="checkbox" :disabled="!supplierProfitGuardEditor.enabled" />
            <span><strong>自动归组</strong><small>统一为关联账号补充同平台且落在毛利率区间内的销售分组。</small></span>
          </label>
          <label v-if="supplierProfitGuardEditor.autoAssignEnabled">目标毛利率下限 (%)
            <input v-model="supplierProfitGuardEditor.targetMarginMinPercent" type="number" min="0" max="100" step="0.1" :disabled="!supplierProfitGuardEditor.enabled" />
          </label>
          <label v-if="supplierProfitGuardEditor.autoAssignEnabled">目标毛利率上限 (%)
            <input v-model="supplierProfitGuardEditor.targetMarginMaxPercent" type="number" min="0" max="100" step="0.1" :disabled="!supplierProfitGuardEditor.enabled" />
          </label>
        </div>
        <div v-if="supplierProfitGuardEditor.thresholdMode === 'margin'" class="form-note">
          该规则会按每个密钥各自的当前上游倍率计算最低售卖倍率；保存时立即覆盖当前关联账号。
        </div>
        <div v-else class="form-note">上游成本达到此倍率后，售价倍率不高于该值的分组会从对应账号移除；售价不高于上游成本的分组始终会被移除。</div>
        <footer>
          <button class="secondary-button" @click="supplierProfitGuardEditor = null">取消</button>
          <button class="primary-button" :disabled="supplierProfitGuardSaving" @click="saveSupplierProfitGuard"><Check :size="16" />保存并批量应用</button>
        </footer>
      </section>
    </div>

    <div v-if="targetEditor" class="modal-layer nested-modal" @click.self="targetEditor = null">
      <section class="modal form-modal target-modal">
        <header><div><h2>{{ targetEditor.editing ? '编辑主动探测目标' : '添加主动探测目标' }}</h2><p>只对选择的密钥和模型发起最小流式请求。</p></div><button class="icon-button" @click="targetEditor = null"><X :size="19" /></button></header>
        <div class="form-grid">
          <label>供应商密钥<select v-model.number="targetEditor.keyId"><option v-for="key in activeKeys" :key="key.id" :value="key.id">{{ key.name || key.maskedKey }} · {{ key.groupName || '未分组' }}</option></select></label>
          <label>探测模型<select v-model="targetEditor.model" :disabled="targetModelsLoading"><option value="">{{ targetModelsLoading ? '正在读取模型' : '请选择模型' }}</option><option v-for="model in targetModels" :key="model" :value="model">{{ model }}</option></select></label>
          <label>探测间隔（秒）<input v-model.number="targetEditor.intervalSeconds" type="number" min="60" max="86400" /></label>
          <label>最大输出 Token<input v-model.number="targetEditor.maxOutputTokens" type="number" min="1" max="32" /></label>
          <label class="toggle-field full-field"><input v-model="targetEditor.enabled" type="checkbox" /><span><strong>启用此目标</strong><small>到期后自动发起受控探测</small></span></label>
        </div>
        <footer><button class="secondary-button" @click="targetEditor = null">取消</button><button class="primary-button" :disabled="!targetEditor.model" @click="saveTarget"><ShieldCheck :size="16" />保存目标</button></footer>
      </section>
    </div>

    <div v-if="qqEditor" class="modal-layer nested-modal" @click.self="closeQqSettings">
      <section class="modal form-modal qq-modal">
        <header><div><h2>QQ 告警通知</h2><p>在此扫码登录 QQ 机器人，并设置接收供应商异常告警的 QQ 号。</p></div><button class="icon-button" title="关闭" aria-label="关闭" @click="closeQqSettings"><X :size="19" /></button></header>
        <section class="qq-bot-panel">
          <div class="qq-bot-head">
            <div><span>QQ 机器人</span><strong>{{ qqBotStatus?.loggedIn ? '已登录' : qqBotStatus?.available ? '等待扫码' : '暂不可用' }}</strong><small>{{ qqBotStatus?.loggedIn ? '机器人已可发送私聊消息' : qqBotStatus?.error || '请使用手机 QQ 扫描下方二维码' }}</small></div>
            <span class="status-pill" :class="qqBotStatus?.loggedIn ? 'success' : qqBotStatus?.available ? 'warning' : 'danger'">{{ qqBotStatus?.loggedIn ? '已登录' : qqBotStatus?.available ? '待登录' : '未就绪' }}</span>
          </div>
          <div v-if="qqBotLoading && !qqBotStatus" class="loading-note"><RefreshCw :size="15" class="spin" />正在读取 QQ 机器人状态</div>
          <template v-else-if="qqBotStatus?.configured">
            <div v-if="qqBotStatus.loggedIn" class="qq-bot-account">
              <div><span>机器人 QQ</span><strong>{{ qqBotStatus.qqNumber || '--' }}</strong></div>
              <div><span>昵称</span><strong>{{ qqBotStatus.nickname || '--' }}</strong></div>
              <div><span>消息通道</span><strong :class="{ 'qq-bot-ready': qqBotStatus.onebotReady }">{{ qqBotStatus.onebotReady ? '可用' : '启动中' }}</strong></div>
              <button class="secondary-button danger-action" :disabled="qqBotAction" @click="logoutQqBot"><RefreshCw :size="16" :class="{ spin: qqBotAction }" />退出并重新登录</button>
            </div>
            <div v-else class="qq-qr-layout">
              <div v-if="qqBotStatus.qrcode" class="qq-qr-wrap"><img class="qq-qr-image" :src="qqBotStatus.qrcode" alt="QQ 登录二维码" /></div>
              <div v-else class="qq-qr-placeholder">登录二维码正在生成，请稍候刷新。</div>
              <div class="qq-qr-actions"><small>请在手机 QQ 中扫一扫确认登录。二维码失效后可刷新。</small><button class="secondary-button" :disabled="qqBotAction" @click="refreshQqBotQr"><RefreshCw :size="16" :class="{ spin: qqBotAction }" />刷新二维码</button></div>
            </div>
          </template>
          <div v-else class="form-note">QQ 机器人服务尚未部署完成，请联系管理员检查 FinOps 的服务配置。</div>
        </section>
        <div class="form-grid">
          <label class="toggle-field full-field"><input v-model="qqEditor.enabled" type="checkbox" /><span><strong>启用 QQ 告警</strong><small>发送供应商连接、密钥、余额和倍率异常</small></span></label>
          <label>接收 QQ 号<input v-model="qqEditor.qqNumber" inputmode="numeric" placeholder="例如 123456789" /></label>
          <div class="form-note qq-managed-note">QQ 机器人通道由 FinOps 自动管理，地址和令牌不会显示或发送到浏览器。</div>
        </div>
        <footer><button class="secondary-button" :disabled="qqSaving" @click="testQqSettings"><Send :size="16" />发送测试</button><button class="primary-button" :disabled="qqSaving" @click="saveQqSettings(true)"><Check :size="16" />保存配置</button></footer>
      </section>
    </div>

    <div v-if="serviceAuthEditor" class="modal-layer nested-modal" @click.self="serviceAuthEditor = null">
      <section class="modal form-modal sub2api-service-auth-modal">
        <header><div><h2>Sub2API 自动认证</h2><p>后台同步与利润保护使用独立服务账号，不依赖当前网页登录状态。</p></div><button class="icon-button" @click="serviceAuthEditor = null"><X :size="19" /></button></header>
        <div class="supplier-metrics">
           <div><span>认证状态</span><strong :class="{ 'service-auth-ready': serviceAuthEditor.authenticated }">{{ serviceAuthEditor.authenticated ? '已认证' : serviceAuthEditor.enabled ? '待认证' : '未启用' }}</strong><small>{{ serviceAuthEditor.lastError ? supplierMessage(serviceAuthEditor.lastError) : '访问 Token 仅保存在服务内存中' }}</small></div>
          <div><span>上次认证</span><strong>{{ dateTime(serviceAuthEditor.lastAuthenticatedAt) }}</strong><small>服务重启后会自动重新登录</small></div>
          <div><span>Token 到期</span><strong>{{ dateTime(serviceAuthEditor.tokenExpiresAt) }}</strong><small>到期前自动续期，401/403 自动重试</small></div>
          <div><span>更新人</span><strong>{{ serviceAuthEditor.updatedBy || '--' }}</strong><small>{{ dateTime(serviceAuthEditor.updatedAt) }}</small></div>
        </div>
        <div class="form-grid">
          <label class="toggle-field full-field"><input v-model="serviceAuthEditor.enabled" type="checkbox" /><span><strong>启用独立服务认证</strong><small>供应商同步、分组读取和利润保护均优先使用此认证；前台退出登录不会影响后台任务。</small></span></label>
          <label class="full-field">认证方式<select v-model="serviceAuthEditor.authMode"><option value="api_key">管理员 API Key（推荐）</option><option value="password">独立管理员账号</option></select></label>
          <label v-if="serviceAuthEditor.authMode === 'api_key'" class="full-field">管理员 API Key<input v-model="serviceAuthEditor.apiKey" type="password" autocomplete="new-password" :placeholder="serviceAuthEditor.credentialsConfigured ? '已配置，留空保持不变' : '粘贴 admin- 开头的管理员 Key'" /></label>
          <label v-if="serviceAuthEditor.authMode === 'password'" class="full-field">管理员邮箱<input v-model="serviceAuthEditor.email" type="email" autocomplete="off" placeholder="service-admin@example.com" /></label>
          <label v-if="serviceAuthEditor.authMode === 'password'">管理员密码<input v-model="serviceAuthEditor.password" type="password" autocomplete="new-password" :placeholder="serviceAuthEditor.credentialsConfigured ? '已配置，留空保持不变' : '首次配置必填'" /></label>
          <label v-if="serviceAuthEditor.authMode === 'password'">TOTP 密钥（可选）<input v-model="serviceAuthEditor.totpSecret" type="password" autocomplete="new-password" :placeholder="serviceAuthEditor.credentialsConfigured ? '留空保持不变' : '账号启用两步验证时填写'" /></label>
          <label v-if="serviceAuthEditor.credentialsConfigured" class="toggle-field full-field"><input v-model="serviceAuthEditor.clearCredentials" type="checkbox" /><span><strong>清除服务账号凭据</strong><small>清除后会立即停止自动认证与后台分组更新。</small></span></label>
        </div>
        <div class="form-note">管理员 API Key、密码和 TOTP 密钥均以 FinOps 的 AES-GCM 密钥加密保存；访问 Token 不写入数据库或 Redis。管理员 API Key 具有完整权限，请仅用于 FinOps 并妥善保管。</div>
        <footer><button class="secondary-button" :disabled="serviceAuthSaving" @click="testServiceAuthSettings"><ShieldCheck :size="16" />验证连接</button><button class="primary-button" :disabled="serviceAuthSaving" @click="saveServiceAuthSettings(true)"><Check :size="16" />保存自动认证</button></footer>
      </section>
    </div>
  </div>
</template>
