<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  Activity, AlertTriangle, Bell, Check, Edit3, KeyRound, Link2, Plus, RefreshCw,
  Send, ServerCog, Settings2, ShieldCheck, Unlink, X,
} from 'lucide-vue-next';
import { get, query, rangeQuery, send } from '../api';

type AnyRecord = Record<string, any>;
type DetailTab = 'keys' | 'quality' | 'balances' | 'checks' | 'alerts';

const props = defineProps<{ refreshToken?: number; range?: string; rangeStart?: string; rangeEnd?: string }>();
const emit = defineEmits<{ toast: [message: string] }>();
const route = useRoute();
const router = useRouter();

const search = ref('');
const loading = ref(false);
const items = ref<AnyRecord[]>([]);
const editor = ref<AnyRecord | null>(null);
const editorSaving = ref(false);
const detail = ref<AnyRecord | null>(null);
const detailLoading = ref(false);
const detailTab = ref<DetailTab>('keys');
const syncingId = ref<number | null>(null);
const linkKey = ref<AnyRecord | null>(null);
const accountSearch = ref('');
const targetEditor = ref<AnyRecord | null>(null);
const targetModels = ref<string[]>([]);
const targetModelsLoading = ref(false);
const qqEditor = ref<AnyRecord | null>(null);
const qqSaving = ref(false);
const serviceAuthEditor = ref<AnyRecord | null>(null);
const serviceAuthSaving = ref(false);
const profitGuardEditor = ref<AnyRecord | null>(null);
const profitGuardSaving = ref(false);
let searchTimer: number | undefined;

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
  const needle = accountSearch.value.trim().toLowerCase();
  return (detail.value.accounts || []).filter((account: AnyRecord) => {
    if (account.status !== 'active' || linkedElsewhere.has(Number(account.id)) || linkedHere.has(Number(account.id))) return false;
    return !needle || `${account.name} ${account.platform} ${account.id}`.toLowerCase().includes(needle);
  }).slice(0, 80);
});

function notify(message: string) {
  emit('toast', message);
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
    return `最低售价 ${multiplierText(policy.minimumSaleMultiplier)}`;
  }
  return `最低毛利 ${(Number(policy.minimumMargin || 0) * 100).toFixed(1).replace(/\.0$/, '')}%`;
}

function connectionHint(item: AnyRecord) {
  if (item.connectionStatus === 'failed' && item.lastError) return item.lastError;
  if (item.consecutiveFailures) return `连续失败 ${item.consecutiveFailures} 次`;
  if (!item.enabled) return '已停用，不参与自动同步';
  return item.detectedAdapterType ? `已识别 ${adapterLabel(item.detectedAdapterType)}` : `配置 ${adapterLabel(item.adapterType)}`;
}

async function loadConnections() {
  loading.value = true;
  try {
    const result = await get(`/supplier-connections?${query({ search: search.value })}`);
    items.value = result.items || [];
  } catch (error: any) {
    notify(error.message);
  } finally {
    loading.value = false;
  }
}

function blankEditor(connection: AnyRecord | null = null) {
  const editing = Boolean(connection);
  return {
    id: connection?.id || null,
    editing,
    supplierName: connection?.supplierName || '',
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
  if (['auto', 'sub2api', 'newapi'].includes(adapterType)) {
    return [{ value: 'password', label: '账号密码' }, { value: 'access_token', label: '访问令牌' }];
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

async function syncConnection(connectionId: number) {
  syncingId.value = connectionId;
  try {
    const result = await send(`/supplier-connections/${connectionId}/sync`, 'POST', {});
    notify(result.sync?.ok === false ? '同步未完成，请查看连接异常' : '供应商连接已同步');
    await loadConnections();
    if (detail.value?.connection?.id === connectionId) await openDetails(connectionId, detailTab.value);
  } catch (error: any) {
    notify(error.message);
  } finally {
    syncingId.value = null;
  }
}

async function openDetails(connectionId: number, tab: DetailTab = 'keys') {
  detailLoading.value = true;
  detailTab.value = tab;
  try {
    const [connectionDetail, quality] = await Promise.all([
      get(`/supplier-connections/${connectionId}/details`),
      get(`/supplier-connections/${connectionId}/quality?${query(rangeQuery(props.range, props.rangeStart, props.rangeEnd))}`),
    ]);
    detail.value = { ...connectionDetail, quality };
    if (String(route.query.connection || '') !== String(connectionId)) {
      await router.replace({ path: '/suppliers', query: { connection: String(connectionId) } });
    }
  } catch (error: any) {
    notify(error.message);
  } finally {
    detailLoading.value = false;
  }
}

async function closeDetails() {
  detail.value = null;
  linkKey.value = null;
  targetEditor.value = null;
  if (route.query.connection) await router.replace('/suppliers');
}

function openLinkPicker(key: AnyRecord) {
  linkKey.value = key;
  accountSearch.value = '';
}

async function linkAccount(accountId: number) {
  if (!linkKey.value || !detail.value) return;
  try {
    const result = await send(`/supplier-keys/${linkKey.value.id}/account-link`, 'PATCH', { accountId, linked: true });
    notify(result.sync?.ok === false ? '账号已关联，供应商同步暂未成功' : '账号已关联并切换为供应商密钥自动倍率');
    const connectionId = Number(detail.value.connection.id);
    linkKey.value = null;
    await Promise.all([loadConnections(), openDetails(connectionId, 'keys')]);
  } catch (error: any) {
    notify(error.message);
  }
}

async function unlinkAccount(keyId: number, accountId: number) {
  if (!detail.value) return;
  try {
    await send(`/supplier-keys/${keyId}/account-link`, 'PATCH', { accountId, linked: false });
    notify('已解除本地账号关联');
    const connectionId = Number(detail.value.connection.id);
    await Promise.all([loadConnections(), openDetails(connectionId, 'keys')]);
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
    await send(`/accounts/${current.accountId}/profit-guard`, 'PATCH', {
      enabled: Boolean(current.enabled),
      thresholdMode: current.thresholdMode,
      minimumMargin: Number(current.minimumMarginPercent || 0) / 100,
      minimumSaleMultiplier: current.thresholdMode === 'minimum_sale_multiplier'
        ? Number(current.minimumSaleMultiplier)
        : null,
      allowEmptyGroups: Boolean(current.allowEmptyGroups),
    });
    profitGuardEditor.value = null;
    notify('账号利润保护已保存');
    await openDetails(Number(detail.value.connection.id), 'keys');
  } catch (error: any) {
    notify(error.message);
  } finally {
    profitGuardSaving.value = false;
  }
}

async function acknowledgeAlert(alertId: number) {
  if (!detail.value) return;
  try {
    await send(`/supplier-alerts/${alertId}/acknowledge`, 'POST', {});
    notify('告警已确认');
    const connectionId = Number(detail.value.connection.id);
    await Promise.all([loadConnections(), openDetails(connectionId, 'alerts')]);
  } catch (error: any) {
    notify(error.message);
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
    await openDetails(Number(detail.value.connection.id), 'quality');
  } catch (error: any) {
    notify(error.message);
  }
}

async function runTarget(targetId: number) {
  if (!detail.value) return;
  try {
    const result = await send(`/supplier-quality-targets/${targetId}/run`, 'POST', {});
    notify(result.ok === false ? '主动模型探测失败，已记录失败样本' : '主动模型探测已完成');
    await openDetails(Number(detail.value.connection.id), 'quality');
  } catch (error: any) {
    notify(error.message);
  }
}

async function deleteTarget(targetId: number) {
  if (!detail.value || !window.confirm('确定删除这个主动探测目标吗？')) return;
  try {
    await send(`/supplier-quality-targets/${targetId}`, 'DELETE', {});
    notify('主动探测目标已删除');
    await openDetails(Number(detail.value.connection.id), 'quality');
  } catch (error: any) {
    notify(error.message);
  }
}

async function openQqSettings() {
  try {
    const settings = await get('/alert-notification-settings');
    qqEditor.value = {
      ...settings,
      accessToken: '',
      clearAccessToken: false,
    };
  } catch (error: any) {
    notify(error.message);
  }
}

async function saveQqSettings(closeAfter = true) {
  if (!qqEditor.value) return false;
  qqSaving.value = true;
  try {
    await send('/alert-notification-settings', 'PATCH', {
      enabled: Boolean(qqEditor.value.enabled),
      qqNumber: String(qqEditor.value.qqNumber || '').trim(),
      onebotEndpoint: String(qqEditor.value.onebotEndpoint || '').trim(),
      accessToken: qqEditor.value.accessToken || '',
      clearAccessToken: Boolean(qqEditor.value.clearAccessToken),
    });
    notify('QQ 告警配置已保存');
    if (closeAfter) qqEditor.value = null;
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
      password: '',
      totpSecret: '',
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
      email: String(serviceAuthEditor.value.email || '').trim(),
      password: serviceAuthEditor.value.password || '',
      totpSecret: serviceAuthEditor.value.totpSecret || '',
      clearCredentials: Boolean(serviceAuthEditor.value.clearCredentials),
    });
    serviceAuthEditor.value = {
      ...serviceAuthEditor.value,
      ...result,
      password: '',
      totpSecret: '',
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
watch(() => props.refreshToken, () => loadConnections());
watch([() => props.range, () => props.rangeStart, () => props.rangeEnd], () => {
  if (detail.value?.connection?.id) openDetails(Number(detail.value.connection.id), detailTab.value);
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
</script>

<template>
  <div class="page-view supplier-view">
    <div class="toolbar-row">
      <label class="search-box">
        <ServerCog :size="17" />
        <input v-model="search" placeholder="搜索供应商、连接名称或站点地址" />
      </label>
      <button class="icon-button" title="刷新列表" aria-label="刷新列表" @click="loadConnections"><RefreshCw :size="17" :class="{ spin: loading }" /></button>
      <button class="secondary-button" @click="openServiceAuthSettings"><KeyRound :size="16" />Sub2API 自动认证</button>
      <button class="secondary-button" @click="openQqSettings"><Bell :size="16" />QQ 告警</button>
      <button class="primary-button" @click="openCreate"><Plus :size="16" />添加连接</button>
      <span v-if="loading" class="loading-note"><RefreshCw :size="15" class="spin" />更新中</span>
    </div>

    <section class="panel table-panel">
      <div class="panel-head">
        <div>
          <h2>供应商连接</h2>
          <p>连接凭据仅加密保存在 FinOps；同步、巡检和关联不会修改供应商或 sub2api 数据。</p>
        </div>
        <KeyRound :size="20" class="head-icon" />
      </div>
      <div class="table-wrap">
        <table class="supplier-table">
          <thead><tr><th>供应商 / 连接</th><th>连接状态</th><th class="number">余额</th><th>密钥 / 异常</th><th>告警</th><th>最近同步</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-if="loading && !items.length"><td colspan="7" class="table-empty">正在读取供应商连接</td></tr>
            <tr v-for="item in items" :key="item.id">
              <td>
                <button class="link-button supplier-name-button" @click="openDetails(item.id)">
                  {{ item.supplierName || '未命名供应商' }}
                </button>
                <small>{{ item.name || '默认连接' }} · {{ adapterLabel(item.detectedAdapterType || item.adapterType) }} · {{ authLabel(item.authMode) }}</small>
                <small class="supplier-url">{{ item.baseUrl || '--' }}</small>
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
            <label v-else-if="editor.authMode === 'access_token'" class="full-field">访问令牌<input v-model="editor.accessToken" type="password" autocomplete="off" /></label>
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
            <button :class="{ active: detailTab === 'keys' }" @click="detailTab = 'keys'">API 密钥 <small>{{ visibleKeys.length }}</small></button>
            <button :class="{ active: detailTab === 'quality' }" @click="detailTab = 'quality'">质量评分 <small>{{ detail.quality?.metrics?.sampleCount || 0 }}</small></button>
            <button :class="{ active: detailTab === 'balances' }" @click="detailTab = 'balances'">余额历史 <small>{{ detail.balances.length }}</small></button>
            <button :class="{ active: detailTab === 'checks' }" @click="detailTab = 'checks'">巡检记录 <small>{{ detail.checks.length }}</small></button>
            <button :class="{ active: detailTab === 'alerts' }" @click="detailTab = 'alerts'">告警 <small>{{ openAlerts.length }}</small></button>
          </div>

          <section v-if="detailTab === 'keys'" class="detail-section">
            <div class="detail-section-head"><div><h3>API 密钥库存</h3><p>仅展示上游返回的脱敏标识；账号关联后自动使用该密钥的上游倍率。</p></div></div>
            <div class="table-wrap compact-table">
              <table><thead><tr><th>密钥</th><th>状态</th><th>分组 / 倍率</th><th>额度</th><th>最近巡检</th><th>本地账号</th></tr></thead>
                <tbody>
                  <tr v-for="key in visibleKeys" :key="key.id">
                    <td><strong>{{ key.name || key.maskedKey || `密钥 #${key.id}` }}</strong><small>{{ key.maskedKey || key.externalId || '--' }} · ID {{ key.externalId || '--' }}</small></td>
                    <td><span class="status-pill" :class="statusClass(key.removedAt ? 'removed' : key.status)">{{ statusLabel(key.removedAt ? 'removed' : key.status) }}</span></td>
                    <td><strong>{{ key.groupName || '未分组' }}</strong><small>{{ key.rateMultiplier === null || key.rateMultiplier === undefined ? '未提供倍率' : `${key.rateMultiplier}x` }}</small></td>
                    <td><strong>{{ quotaText(key) }}</strong><small>{{ key.expiresAt ? `到期 ${dateTime(key.expiresAt)}` : key.lastUsedAt ? `最近使用 ${dateTime(key.lastUsedAt)}` : '无到期或使用记录' }}</small></td>
                    <td><span class="status-pill" :class="statusClass(key.lastCheckStatus)">{{ statusLabel(key.lastCheckStatus || 'pending') }}</span><small>{{ key.lastCheckMethod || '等待巡检' }} · {{ dateTime(key.lastCheckAt) }}</small><small v-if="key.lastCheckError" class="error-text">{{ key.lastCheckError }}</small></td>
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
                  </tr>
                  <tr v-if="!visibleKeys.length"><td colspan="6" class="table-empty">本次同步没有返回可用密钥</td></tr>
                </tbody>
              </table>
            </div>
          </section>

          <section v-else-if="detailTab === 'quality'" class="detail-section">
            <div class="detail-section-head"><div><h3>供应商质量评分</h3><p>当前模式：{{ qualityModeLabel(detail.connection.qualityMonitorMode) }}。展示已有质量样本，不新增额外耗时监控。</p></div><button class="primary-button" :disabled="!['active','hybrid'].includes(detail.connection.qualityMonitorMode)" @click="openTargetEditor()"><Plus :size="16" />添加主动目标</button></div>
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
            <div class="table-wrap compact-table"><table><thead><tr><th>时间</th><th>密钥</th><th>结果</th><th>方式</th><th>HTTP</th><th>错误</th></tr></thead><tbody><tr v-for="item in detail.checks" :key="item.id"><td>{{ dateTime(item.checkedAt) }}</td><td>{{ item.keyName || item.maskedKey }}</td><td><span class="status-pill" :class="statusClass(item.status)">{{ statusLabel(item.status) }}</span></td><td>{{ item.method || '--' }}</td><td>{{ item.httpStatus || '--' }}</td><td>{{ item.errorMessage || item.errorCode || '--' }}</td></tr><tr v-if="!detail.checks.length"><td colspan="6" class="table-empty">暂无巡检记录</td></tr></tbody></table></div>
          </section>

          <section v-else class="detail-section">
            <div class="detail-section-head"><div><h3>供应商告警</h3><p>连接失败、密钥异常、低余额和倍率变化会记录在这里。</p></div></div>
            <div class="alert-detail-list">
              <article v-for="alert in detail.alerts" :key="alert.id" :class="['alert-detail', alert.severity]">
                <AlertTriangle :size="18" />
                <div><strong>{{ alert.title }}</strong><p>{{ alert.message }}</p><small>{{ dateTime(alert.lastSeenAt) }} · 出现 {{ alert.occurrenceCount }} 次 · {{ statusLabel(alert.status) }}</small></div>
                <button v-if="alert.status === 'open'" class="small-button" @click="acknowledgeAlert(alert.id)"><Check :size="14" />确认</button>
              </article>
              <div v-if="!detail.alerts.length" class="table-empty">当前没有供应商告警</div>
            </div>
          </section>
        </template>
      </section>
    </div>

    <div v-if="linkKey" class="modal-layer nested-modal" @click.self="linkKey = null">
      <section class="modal link-picker-modal">
        <header><div><h2>关联本地账号</h2><p>{{ linkKey.name || linkKey.maskedKey }} · {{ linkKey.groupName || '未分组' }}</p></div><button class="icon-button" @click="linkKey = null"><X :size="19" /></button></header>
        <label class="search-box full-search"><Link2 :size="17" /><input v-model="accountSearch" placeholder="搜索账号、平台或 ID" /></label>
        <div class="table-wrap compact-table"><table><thead><tr><th>本地账号</th><th>平台</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="account in availableAccounts" :key="account.id"><td><strong>{{ account.name || `账号 #${account.id}` }}</strong><small>ID {{ account.id }}</small></td><td>{{ account.platform || '--' }}</td><td><span class="status-pill success">可用</span></td><td><button class="small-button" @click="linkAccount(account.id)"><Link2 :size="14" />关联</button></td></tr><tr v-if="!availableAccounts.length"><td colspan="4" class="table-empty">没有可关联的本地账号</td></tr></tbody></table></div>
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
              <option value="minimum_sale_multiplier">最低售卖倍率</option>
            </select>
          </label>
          <label>当前上游倍率<input :value="multiplierText(profitGuardEditor.upstreamMultiplier)" readonly /></label>
          <label v-if="profitGuardEditor.thresholdMode === 'margin'">最低毛利率 (%)
            <input v-model="profitGuardEditor.minimumMarginPercent" type="number" min="0" max="99.99" step="0.1" :disabled="!profitGuardEditor.enabled" />
          </label>
          <label v-else>最低售卖倍率
            <input v-model="profitGuardEditor.minimumSaleMultiplier" type="number" min="0" step="0.0001" :disabled="!profitGuardEditor.enabled" />
          </label>
          <label class="toggle-field">
            <input v-model="profitGuardEditor.allowEmptyGroups" type="checkbox" :disabled="!profitGuardEditor.enabled" />
            <span><strong>允许移出最后一个分组</strong><small>关闭时只产生告警，账号仍保留在最后一个分组。</small></span>
          </label>
        </div>
        <div v-if="profitGuardEditor.thresholdMode === 'margin'" class="form-note">
          按当前上游倍率 {{ multiplierText(profitGuardEditor.upstreamMultiplier) }} 和最低毛利率计算，最低售卖倍率为
          <strong>{{ calculatedMinimumSaleMultiplier === null ? '--' : multiplierText(calculatedMinimumSaleMultiplier) }}</strong>。
        </div>
        <div v-else class="form-note">售价倍率低于该值的分组会自动从这个账号移除；售价不高于上游成本的分组始终会被移除。</div>
        <footer>
          <button class="secondary-button" @click="profitGuardEditor = null">取消</button>
          <button class="primary-button" :disabled="profitGuardSaving" @click="saveProfitGuard"><Check :size="16" />保存利润保护</button>
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

    <div v-if="qqEditor" class="modal-layer nested-modal" @click.self="qqEditor = null">
      <section class="modal form-modal qq-modal">
        <header><div><h2>QQ 告警通知</h2><p>通过已登录 QQ 机器人的 OneBot HTTP 网关发送私聊告警。</p></div><button class="icon-button" @click="qqEditor = null"><X :size="19" /></button></header>
        <div class="form-note qq-note">FinOps 不保存 QQ 密码，也不会登录 QQ；必须提供可访问的 OneBot HTTP 网关。</div>
        <div class="form-grid">
          <label class="toggle-field full-field"><input v-model="qqEditor.enabled" type="checkbox" /><span><strong>启用 QQ 告警</strong><small>发送供应商连接、密钥、余额和倍率异常</small></span></label>
          <label>接收 QQ 号<input v-model="qqEditor.qqNumber" inputmode="numeric" placeholder="例如 123456789" /></label>
          <label class="full-field">OneBot HTTP 地址<input v-model="qqEditor.onebotEndpoint" placeholder="http://host.docker.internal:3000" /></label>
          <label class="full-field">OneBot Access Token<input v-model="qqEditor.accessToken" type="password" :placeholder="qqEditor.accessTokenConfigured ? '已配置，留空继续使用' : '网关未启用令牌时可留空'" /></label>
          <label v-if="qqEditor.accessTokenConfigured" class="toggle-field full-field"><input v-model="qqEditor.clearAccessToken" type="checkbox" /><span><strong>清除已保存的 Access Token</strong><small>仅在 OneBot 网关已关闭鉴权时使用</small></span></label>
        </div>
        <footer><button class="secondary-button" :disabled="qqSaving" @click="testQqSettings"><Send :size="16" />发送测试</button><button class="primary-button" :disabled="qqSaving" @click="saveQqSettings(true)"><Check :size="16" />保存配置</button></footer>
      </section>
    </div>

    <div v-if="serviceAuthEditor" class="modal-layer nested-modal" @click.self="serviceAuthEditor = null">
      <section class="modal form-modal sub2api-service-auth-modal">
        <header><div><h2>Sub2API 自动认证</h2><p>后台同步与利润保护使用独立服务账号，不依赖当前网页登录状态。</p></div><button class="icon-button" @click="serviceAuthEditor = null"><X :size="19" /></button></header>
        <div class="supplier-metrics">
          <div><span>认证状态</span><strong :class="{ 'service-auth-ready': serviceAuthEditor.authenticated }">{{ serviceAuthEditor.authenticated ? '已认证' : serviceAuthEditor.enabled ? '待认证' : '未启用' }}</strong><small>{{ serviceAuthEditor.lastError || '访问 Token 仅保存在服务内存中' }}</small></div>
          <div><span>上次认证</span><strong>{{ dateTime(serviceAuthEditor.lastAuthenticatedAt) }}</strong><small>服务重启后会自动重新登录</small></div>
          <div><span>Token 到期</span><strong>{{ dateTime(serviceAuthEditor.tokenExpiresAt) }}</strong><small>到期前自动续期，401/403 自动重试</small></div>
          <div><span>更新人</span><strong>{{ serviceAuthEditor.updatedBy || '--' }}</strong><small>{{ dateTime(serviceAuthEditor.updatedAt) }}</small></div>
        </div>
        <div class="form-grid">
          <label class="toggle-field full-field"><input v-model="serviceAuthEditor.enabled" type="checkbox" /><span><strong>启用独立服务账号</strong><small>供应商同步、分组读取和利润保护均优先使用此账号；前台退出登录不会影响后台任务。</small></span></label>
          <label class="full-field">管理员邮箱<input v-model="serviceAuthEditor.email" type="email" autocomplete="off" placeholder="service-admin@example.com" /></label>
          <label>管理员密码<input v-model="serviceAuthEditor.password" type="password" autocomplete="new-password" :placeholder="serviceAuthEditor.credentialsConfigured ? '已配置，留空保持不变' : '首次配置必填'" /></label>
          <label>TOTP 密钥（可选）<input v-model="serviceAuthEditor.totpSecret" type="password" autocomplete="new-password" :placeholder="serviceAuthEditor.credentialsConfigured ? '留空保持不变' : '账号启用两步验证时填写'" /></label>
          <label v-if="serviceAuthEditor.credentialsConfigured" class="toggle-field full-field"><input v-model="serviceAuthEditor.clearCredentials" type="checkbox" /><span><strong>清除服务账号凭据</strong><small>清除后会立即停止自动认证与后台分组更新。</small></span></label>
        </div>
        <div class="form-note">密码和 TOTP 密钥以 FinOps 的 AES-GCM 密钥加密保存；访问 Token 不写入数据库或 Redis。请使用仅供 FinOps 使用的 Sub2API 管理员账号。</div>
        <footer><button class="secondary-button" :disabled="serviceAuthSaving" @click="testServiceAuthSettings"><ShieldCheck :size="16" />验证连接</button><button class="primary-button" :disabled="serviceAuthSaving" @click="saveServiceAuthSettings(true)"><Check :size="16" />保存自动认证</button></footer>
      </section>
    </div>
  </div>
</template>
