import { SupplierCredentialVault } from './supplier-credentials.mjs';
import {
  deriveAdaptiveForecastParameters,
  estimateFiniteQuotaCapacity,
  forecastHourlyDemand,
} from './replenishment-forecast.mjs';

const ACTIVE_STATUSES = new Set(['ordering', 'queued', 'processing', 'ready_to_collect', 'importing']);

function errorWithStatus(message, statusCode = 502) {
  return Object.assign(new Error(message), { statusCode });
}

function isMissingSub2ApiAccount(error) {
  if (Number(error?.statusCode ?? error?.httpStatus) !== 404) return false;
  const message = String(error?.message || '').toLowerCase();
  return /(?:account|账号).*(?:not found|不存在)|(?:not found|不存在).*(?:account|账号)/i.test(message);
}

function isBlockedRecoveryConfiguration(error) {
  return Number(error?.statusCode ?? error?.httpStatus) === 409
    && /^自动修复配置包含不可用的 Sub2API 分组：/.test(String(error?.message || ''));
}

function payloadOf(response) {
  const payload = response?.payload;
  return payload?.data && typeof payload.data === 'object' ? payload.data : payload;
}

function numeric(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function centsToCny(value) {
  const parsed = numeric(value);
  return parsed === null ? null : parsed / 100;
}

function orderPayload(payload) {
  return payload?.order || payload?.data?.order || payload || {};
}

function accountsPayload(payload) {
  const value = payload?.accounts || payload?.payload?.accounts || payload?.data?.accounts;
  return Array.isArray(value) ? value : [];
}

function orderItemsPayload(payload) {
  const value = orderPayload(payload)?.items || payload?.items;
  return Array.isArray(value) ? value : [];
}

function accountCredential(raw) {
  const source = raw?.credentials && typeof raw.credentials === 'object'
    ? raw.credentials
    : raw?.account?.credentials && typeof raw.account.credentials === 'object'
      ? raw.account.credentials
      : raw;
  const credentials = { ...(source || {}) };
  for (const key of [
    'email', 'name', 'id', 'platform', 'type', 'remaining_seconds', 'remainingSeconds',
    'charged_fen', 'chargedFen', 'base_price_fen', 'basePriceFen', 'credentials',
  ]) {
    delete credentials[key];
  }
  if (!credentials.access_token && raw?.access_token) credentials.access_token = raw.access_token;
  if (!credentials.refresh_token && raw?.refresh_token) credentials.refresh_token = raw.refresh_token;
  if (!credentials.account_uuid && raw?.account_uuid) credentials.account_uuid = raw.account_uuid;
  if (!credentials.org_uuid && raw?.org_uuid) credentials.org_uuid = raw.org_uuid;
  if (!credentials.email && raw?.email) credentials.email = raw.email;
  return credentials;
}

function accountName(raw, index) {
  return String(
    raw?.email || raw?.name || raw?.account_email || raw?.account?.email
    || raw?.account_id || `oauth-supply-${index + 1}`,
  ).trim();
}

function matchingOrderItem(raw, index, items) {
  const identifiers = new Set([
    raw?.id,
    raw?.account_id,
    raw?.accountId,
    raw?.inventory_account_id,
    raw?.email,
    raw?.account_email,
  ].filter((value) => value !== null && value !== undefined && value !== '').map(String));
  return items.find((item) => [
    item?.id,
    item?.account_id,
    item?.accountId,
    item?.inventory_account_id,
    item?.email,
    item?.account_email,
  ].some((value) => value !== null && value !== undefined && identifiers.has(String(value)))) || items[index] || {};
}

function epochSeconds(value) {
  if (value === null || value === undefined || value === '') return null;
  const direct = numeric(value);
  if (direct !== null) return Math.floor(direct > 10_000_000_000 ? direct / 1000 : direct);
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function accountExpiresAt(raw, orderItem) {
  for (const value of [
    raw?.expires_at,
    raw?.expiresAt,
    orderItem?.expires_at,
    orderItem?.expiresAt,
  ]) {
    const expiresAt = epochSeconds(value);
    if (expiresAt !== null) return expiresAt;
  }
  return null;
}

const OPEN_RECOVERY_STATUSES = new Set([
  'detected', 'waiting_supplier', 'claimable', 'credentials_saved',
  'updating_sub2api', 'verifying', 'retry_wait', 'manual_required',
]);

function latestRecoveryByItem(entries, predicate = () => true) {
  const result = new Map();
  for (const entry of entries) {
    if (predicate(entry) && !result.has(entry.orderItemId)) result.set(entry.orderItemId, entry);
  }
  return result;
}

function textIncludesAuthFailure(...values) {
  return values.some((value) => /(?:^|\D)401(?:\D|$)|unauth|invalid[_ -]?token|token[_ -]?invalidated|token.*expired|needs[_ -]?reauth/i.test(String(value || '')));
}

function allocateOrderCosts(items, totalCny) {
  const resolved = items.map((entry) => entry.individualCostCny);
  if (totalCny === null || !items.length) return resolved;
  const totalFen = Math.round(Number(totalCny) * 100);
  const weights = items.map((entry) => {
    const chargedFen = Math.round(Number(entry.individualCostCny) * 100);
    if (Number.isFinite(chargedFen) && chargedFen > 0) return chargedFen;
    const originalFen = Math.round(Number(entry.originalPriceCny) * 100);
    return Number.isFinite(originalFen) && originalFen > 0 ? originalFen : 1;
  });
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const allocations = weights.map((weight, index) => {
    const exact = totalFen * weight / totalWeight;
    return { index, fen: Math.floor(exact), fraction: exact - Math.floor(exact) };
  });
  let remainder = totalFen - allocations.reduce((sum, entry) => sum + entry.fen, 0);
  for (const entry of [...allocations].sort((left, right) => (
    right.fraction - left.fraction || left.index - right.index
  ))) {
    if (remainder <= 0) break;
    entry.fen += 1;
    remainder -= 1;
  }
  return allocations.sort((left, right) => left.index - right.index)
    .map((entry) => entry.fen / 100);
}

function replacementFilesPayload(payload) {
  const remote = orderPayload(payload);
  const value = remote?.replacement_files || remote?.replacementFiles
    || payload?.replacement_files || payload?.replacementFiles
    || payload?.payload?.replacement_files || payload?.payload?.replacementFiles;
  return Array.isArray(value) ? value : [];
}

function supplierAccountKey(raw) {
  return String(
    raw?.email || raw?.account_email || raw?.accountEmail
    || raw?.account_id || raw?.accountId || raw?.inventory_account_id || '',
  ).trim();
}

function supplierOrderId(raw) {
  return String(
    raw?.order_id || raw?.orderId || raw?.pickup_order_id || raw?.pickupOrderId
    || raw?.order?.id || raw?.order?.order_id || raw?.order?.orderId
    || raw?.replacement?.order_id || raw?.replacement?.orderId || '',
  ).trim();
}

function replacementStatus(raw) {
  return String(raw?.delivery_status || raw?.deliveryStatus || raw?.status || '').trim().toLowerCase();
}

function replacementClaimUrl(raw) {
  return String(raw?.claim_url || raw?.claimUrl || '').trim();
}

function replacementStatusUrl(raw) {
  return String(raw?.status_url || raw?.statusUrl || '').trim();
}

function claimedReplacement(raw) {
  return Boolean(raw?.claimed_at || raw?.claimedAt || raw?.taken_at || raw?.takenAt)
    || /claimed|taken|downloaded|consumed|picked[_ -]?up/.test(replacementStatus(raw));
}

function replacementMatchesItem(raw, item) {
  const values = [
    supplierAccountKey(raw), raw?.external_item_id, raw?.externalItemId,
    raw?.inventory_account_id, raw?.inventoryAccountId, raw?.item_id, raw?.itemId,
  ].filter((value) => value !== null && value !== undefined && value !== '')
    .map((value) => String(value).trim().toLowerCase());
  return [item?.externalAccountKey, item?.accountName, item?.externalItemId]
    .filter(Boolean).some((value) => values.includes(String(value).trim().toLowerCase()));
}

function credentialsFromRecoveryPayload(payload, accountKey) {
  const accounts = accountsPayload(payload);
  if (accounts.length) {
    const selected = accounts.find((entry) => supplierAccountKey(entry) === String(accountKey || '').trim())
      || (accounts.length === 1 ? accounts[0] : null);
    return selected ? accountCredential(selected) : null;
  }
  const value = payload?.credentials || payload?.account?.credentials
    || payload?.payload?.credentials || payload?.payload;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function quotaNumber(...values) {
  for (const value of values) {
    const parsed = numeric(value);
    if (parsed !== null && parsed >= 0 && parsed <= 100) return parsed;
  }
  return null;
}

function quotaSnapshot(account, usage) {
  const extra = account?.extra || {};
  const short = quotaNumber(
    usage?.codex_5h_used_percent,
    usage?.five_hour?.utilization,
    usage?.fiveHour?.utilization,
    extra.codex_5h_used_percent,
    extra.codex_secondary_used_percent,
  );
  const long = quotaNumber(
    usage?.codex_7d_used_percent,
    usage?.seven_day?.utilization,
    usage?.sevenDay?.utilization,
    extra.codex_7d_used_percent,
    extra.codex_primary_used_percent,
  );
  return { short, long };
}

function selectedQuota(quota, window) {
  if (window === 'short') return { value: quota.short, window: 'short' };
  if (window === 'long') return { value: quota.long, window: 'long' };
  const values = [
    { value: quota.short, window: 'short' },
    { value: quota.long, window: 'long' },
  ].filter((entry) => entry.value !== null);
  return values.sort((left, right) => right.value - left.value)[0] || { value: null, window: '' };
}

function accountGroupIds(account) {
  return (account?.group_ids || account?.groups || account?.account_groups || [])
    .map((entry) => Number(entry?.group_id ?? entry?.id ?? entry))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

function accountMatchesRule(account, rule) {
  const groups = accountGroupIds(account);
  return String(account?.platform || '').trim().toLowerCase()
      === String(rule.platform || '').trim().toLowerCase()
    && (rule.targetGroupIds || []).every((id) => groups.includes(Number(id)));
}

function bounded(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value)));
}

function rounded(value, digits = 6) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const scale = 10 ** digits;
  return Math.round(parsed * scale) / scale;
}

function retryDelayMs(attempt) {
  return Math.min(15 * 60_000, 15_000 * (2 ** Math.max(0, attempt - 1)));
}

function inventoryEventSummary(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const { accounts: _accounts, ...summary } = snapshot;
  return summary;
}

function metadataWithoutExpiration(metadata) {
  const { expiresAt: _expiresAt, ...rest } = metadata || {};
  return rest;
}

function scheduleSnapshot(account, {
  readError = '',
  expired = false,
  repairing = false,
  status = '',
  authFailed = false,
  platformMatched = true,
  groupMatched = true,
  nowMs = Date.now(),
} = {}) {
  const sourceSchedulable = typeof account?.schedulable === 'boolean' ? account.schedulable : null;
  const tempUnschedulableUntil = account?.temp_unschedulable_until
    || account?.tempUnschedulableUntil
    || null;
  const tempUnschedulableReason = String(
    account?.temp_unschedulable_reason
    || account?.tempUnschedulableReason
    || '',
  );
  const rateLimitResetAt = account?.rate_limit_reset_at
    || account?.rateLimitResetAt
    || null;
  const rateLimitResetMs = rateLimitResetAt ? Date.parse(rateLimitResetAt) : Number.NaN;
  const rateLimited = Number.isFinite(rateLimitResetMs) && rateLimitResetMs > nowMs;
  const tempUntilMs = tempUnschedulableUntil ? Date.parse(tempUnschedulableUntil) : Number.NaN;
  const temporarilyUnschedulable = Number.isFinite(tempUntilMs) && tempUntilMs > nowMs;
  if (readError) return {
    sourceSchedulable,
    state: 'read_error',
    reason: readError,
    tempUnschedulableUntil,
    tempUnschedulableReason,
  };
  if (repairing) return {
    sourceSchedulable,
    state: 'repairing',
    reason: '账号正在修复',
    tempUnschedulableUntil,
    tempUnschedulableReason,
  };
  if (authFailed) return {
    sourceSchedulable,
    state: 'authentication_failed',
    reason: '账号凭据失效或需要重新认证',
    tempUnschedulableUntil,
    tempUnschedulableReason,
  };
  if (expired) return {
    sourceSchedulable,
    state: 'expired',
    reason: 'Sub2API 账号到期时间已到',
    tempUnschedulableUntil,
    tempUnschedulableReason,
  };
  if (!platformMatched) return {
    sourceSchedulable,
    state: 'platform_mismatch',
    reason: '账号平台与补号策略不一致',
    tempUnschedulableUntil,
    tempUnschedulableReason,
  };
  if (!groupMatched) return {
    sourceSchedulable,
    state: 'group_mismatch',
    reason: '账号未加入策略要求的正式分组',
    tempUnschedulableUntil,
    tempUnschedulableReason,
  };
  if (String(status).toLowerCase() !== 'active') return {
    sourceSchedulable,
    state: 'account_status',
    reason: `账号状态为 ${status || 'unknown'}`,
    tempUnschedulableUntil,
    tempUnschedulableReason,
  };
  if (temporarilyUnschedulable) return {
    sourceSchedulable,
    state: 'temporarily_disabled',
    reason: tempUnschedulableReason || 'Sub2API 临时停止调度',
    tempUnschedulableUntil,
    tempUnschedulableReason,
  };
  if (rateLimited) return {
    sourceSchedulable,
    state: 'rate_limited',
    reason: `Sub2API rate limited until ${rateLimitResetAt}`,
    tempUnschedulableUntil,
    tempUnschedulableReason,
    rateLimitResetAt,
  };
  if (sourceSchedulable === false) return {
    sourceSchedulable,
    state: 'persistently_disabled',
    reason: 'Sub2API 调度开关已关闭',
    tempUnschedulableUntil,
    tempUnschedulableReason,
  };
  if (sourceSchedulable === null) return {
    sourceSchedulable,
    state: 'unknown',
    reason: 'Sub2API 未返回调度状态',
    tempUnschedulableUntil,
    tempUnschedulableReason,
  };
  return {
    sourceSchedulable,
    state: 'schedulable',
    reason: '',
    tempUnschedulableUntil,
    tempUnschedulableReason,
  };
}

function localMinutes(at, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const values = Object.fromEntries(parts.map((entry) => [entry.type, entry.value]));
  return Number(values.hour) * 60 + Number(values.minute);
}

function clockMinutes(value) {
  const [hour, minute] = String(value || '00:00').split(':').map(Number);
  return hour * 60 + minute;
}

function insideSchedule(rule, nowMs, timezone) {
  const start = clockMinutes(rule.scheduleStartTime);
  const end = clockMinutes(rule.scheduleEndTime);
  if (start === end) return true;
  const current = localMinutes(nowMs, timezone);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function intervalElapsed(lastAt, seconds, nowMs) {
  return !lastAt || !Number.isFinite(Date.parse(lastAt))
    || nowMs - Date.parse(lastAt) >= Number(seconds || 0) * 1000;
}

function recentlyHealthyAfterReadError(tracked, rule, nowMs) {
  if (!tracked || !['healthy', 'quota_unknown'].includes(tracked.healthStatus)) return false;
  const lastHealthAt = Date.parse(String(tracked.lastHealthAt || ''));
  if (!Number.isFinite(lastHealthAt) || nowMs < lastHealthAt) return false;
  // Do not turn a transient upstream/API failure into an apparent shortage.
  const graceSeconds = Math.max(30, Number(rule.scheduleIntervalSeconds || 0) * 2);
  return nowMs - lastHealthAt <= graceSeconds * 1000;
}

export class ReplenishmentService {
  constructor(repository, oauthSupplyAuthService, sub2ApiGateway, config, logger = console, {
    client,
    ledgerRepository = null,
    sourceUsageRepository = null,
    accountReader = null,
    now = () => Date.now(),
  } = {}) {
    this.repository = repository;
    this.oauthSupplyAuthService = oauthSupplyAuthService;
    this.sub2ApiGateway = sub2ApiGateway;
    this.config = config;
    this.logger = logger;
    this.client = client;
    this.ledgerRepository = ledgerRepository;
    this.sourceUsageRepository = sourceUsageRepository;
    this.accountReader = accountReader;
    this.now = now;
    this.vault = new SupplierCredentialVault(config.supplierCredentialsKey);
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer || this.config.demoMode) return;
    const intervalMs = Math.max(3_000, Number(this.config.replenishmentTickSeconds || 3) * 1000);
    this.timer = setInterval(() => this.tick().catch((error) => {
      this.logger.warn('[replenishment] tick failed', error?.message || error);
    }), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async assertActiveTargetGroups(rule) {
    const targetGroupIds = [...new Set((rule?.targetGroupIds || []).map(Number))]
      .filter((id) => Number.isSafeInteger(id) && id > 0);
    if (!rule || !targetGroupIds.length) {
      throw errorWithStatus('自动修复配置包含不可用的 Sub2API 分组：未配置正式分组', 409);
    }
    const catalog = await this.sub2ApiGateway.listGroups({ includeInactive: true });
    const groupsById = new Map(catalog.map((group) => [Number(group.id), group]));
    const unavailable = targetGroupIds.filter((id) => {
      const group = groupsById.get(id);
      return !group || String(group.status || '').toLowerCase() !== 'active';
    });
    if (unavailable.length) {
      throw errorWithStatus(`自动修复配置包含不可用的 Sub2API 分组：${unavailable.join(', ')}`, 409);
    }
  }

  async customerSettings() {
    await this.oauthSupplyAuthService.loadSettings();
    const settings = this.oauthSupplyAuthService.status();
    if (!settings.enabled || !settings.credentialsConfigured) {
      throw errorWithStatus('OAuth Supply 尚未启用或未配置账号密码', 400);
    }
    return settings;
  }

  async customerRequest(operation) {
    const settings = await this.customerSettings();
    let token = await this.oauthSupplyAuthService.getAccessToken();
    try {
      return await operation({ settings, token });
    } catch (error) {
      if (error?.statusCode !== 401) throw error;
      await this.oauthSupplyAuthService.invalidateAccessToken(token);
      token = await this.oauthSupplyAuthService.getAccessToken({ force: true });
      return operation({ settings, token });
    }
  }

  async inventory(product, quantity = 1) {
    return this.customerRequest(({ settings, token }) => this.client.inventory({
      baseUrl: settings.baseUrl,
      token,
      product,
      quantity,
    }));
  }

  async products() {
    const response = await this.customerRequest(
      ({ settings, token }) => this.client.products({ baseUrl: settings.baseUrl, token }),
    );
    return payloadOf(response) || [];
  }

  async balance() {
    const response = await this.customerRequest(
      ({ settings, token }) => this.client.balance({ baseUrl: settings.baseUrl, token }),
    );
    return payloadOf(response) || {};
  }

  async recoveries({
    scope = 'pending', page = 1, pageSize = 20, offset = 0,
    search = '', filters = {}, start = null, end = null,
    sortBy = 'created_at', sortOrder = 'desc',
  } = {}) {
    return this.repository.listRecoveryFeed({
      scope, page, pageSize, offset, search, filters, start, end, sortBy, sortOrder,
    });
  }

  async refreshOrderCompletion(orderId) {
    const order = await this.repository.getOrder(orderId);
    if (!order) return null;
    const validQuantity = order.items
      .filter((entry) => ['passed', 'repaired'].includes(entry.verificationStatus)).length;
    const failedQuantity = Math.max(0, order.requestedQuantity - validQuantity);
    const status = failedQuantity === 0 ? 'completed' : 'import_retry';
    const lastError = failedQuantity ? `${failedQuantity} 个账号等待修复` : '';
    await this.repository.updateOrder(order.id, { status, validQuantity, lastError });
    await this.repository.finishRun(order.runId, {
      status,
      actualPaidAmountCny: order.actualPaidAmountCny,
      deliveredQuantity: order.deliveredQuantity,
      validQuantity,
      failedQuantity,
      errorMessage: lastError,
    });
    return { ...order, status, validQuantity, failedQuantity, lastError };
  }

  async completeRecoveryManually(recoveryId, actor = 'system') {
    const job = await this.repository.getRecovery(recoveryId);
    if (!job) throw errorWithStatus('修复任务不存在', 404);
    if (job.status === 'recovered') return { ok: true, recoveryId: job.id, alreadyCompleted: true };
    const orderItem = await this.repository.getOrderItem(job.orderItemId);
    if (!orderItem) throw errorWithStatus('修复任务关联账号不存在', 404);
    const completedAt = new Date(this.now()).toISOString();
    await this.repository.updateOrderItem(orderItem.id, {
      status: 'imported',
      verificationStatus: 'repaired',
      healthStatus: 'unknown',
      nextImportRetryAt: null,
      errorMessage: '',
      repairCompletionSource: 'manual_compensation',
      capacityStartedAt: completedAt,
      metadata: metadataWithoutExpiration(orderItem.metadata),
    });
    const completed = await this.repository.completeRecovery(job.id, {
      completionSource: 'manual_compensation',
      deliveryStatus: 'manual compensation',
      recoveredAt: completedAt,
    });
    const order = await this.refreshOrderCompletion(orderItem.orderId);
    await this.repository.addEvent({
      ruleId: job.ruleId,
      runId: order?.runId || null,
      orderId: orderItem.orderId,
      itemId: orderItem.id,
      eventType: 'recovery_manual_compensated',
      message: `账号 ${job.accountName || job.accountKey || orderItem.accountName} 已人工标记为修复完成`,
      details: {
        recoveryId: job.id,
        targetAccountId: job.sub2apiAccountId,
        finopsOnly: true,
      },
      actor,
    });
    return { ok: true, recoveryId: completed.id, itemId: orderItem.id, completedAt };
  }

  async completeImportRetryManually(itemId, actor = 'system') {
    const orderItem = await this.repository.getOrderItem(itemId);
    if (!orderItem) throw errorWithStatus('导入修复任务不存在', 404);
    if (orderItem.status === 'imported' && ['passed', 'repaired'].includes(orderItem.verificationStatus)) {
      return { ok: true, itemId: orderItem.id, alreadyCompleted: true };
    }
    if (!['retry_wait', 'manual_required'].includes(orderItem.status)) {
      throw errorWithStatus('当前账号不在可人工补偿的修复状态', 409);
    }
    const completedAt = new Date(this.now()).toISOString();
    await this.repository.updateOrderItem(orderItem.id, {
      status: 'imported',
      verificationStatus: 'repaired',
      healthStatus: 'unknown',
      nextImportRetryAt: null,
      errorMessage: '',
      repairCompletionSource: 'manual_compensation',
      capacityStartedAt: completedAt,
      metadata: metadataWithoutExpiration(orderItem.metadata),
    });
    const order = await this.refreshOrderCompletion(orderItem.orderId);
    await this.repository.addEvent({
      ruleId: order?.ruleId || null,
      runId: order?.runId || null,
      orderId: orderItem.orderId,
      itemId: orderItem.id,
      eventType: 'import_retry_manual_compensated',
      message: `账号 ${orderItem.accountName || `#${orderItem.id}`} 已人工标记为修复完成`,
      details: {
        targetAccountId: orderItem.sub2apiAccountId,
        finopsOnly: true,
      },
      actor,
    });
    return { ok: true, itemId: orderItem.id, completedAt };
  }

  async retryImportItem(itemId) {
    const item = (await this.repository.listImportRetryItems({ limit: 500, dueOnly: false, includeManual: true }))
      .find((entry) => Number(entry.id) === Number(itemId));
    if (!item) throw errorWithStatus('导入重试任务不存在', 404);
    const policy = item.recoveryPolicy || await this.repository.getRecoveryPolicyByRule(item.order?.ruleId);
    if (!policy?.enabled) throw errorWithStatus('修复策略已停用', 409);
    try {
      if (!item.credentialCiphertext) throw errorWithStatus('已保存的账号凭据不存在', 409);
      const saved = this.vault.decrypt(item.credentialCiphertext);
      const credentials = saved.credentials || saved.raw?.credentials || saved;
      const configuration = {
        groupIds: item.rule.targetGroupIds,
        concurrency: item.rule.concurrency,
        loadFactor: item.rule.loadFactor,
        proxyId: item.rule.proxyId,
        priority: item.rule.priority,
        rateMultiplier: item.rule.rateMultiplier,
        autoPauseOnExpired: item.rule.autoPauseOnExpired,
        modelId: item.rule.verificationModel,
        prompt: item.rule.verificationPrompt,
        modelWhitelist: item.rule.modelWhitelist,
      };
      await this.assertActiveTargetGroups(item.rule);
      const importAccount = () => this.sub2ApiGateway.importAndVerify({
        name: item.accountName,
        platform: item.rule.platform,
        credentials,
        expiresAt: null,
        ...configuration,
        onCreated: async (accountId) => this.repository.updateOrderItem(item.id, {
          status: 'importing', sub2apiAccountId: accountId,
        }),
      });
      let account;
      if (!item.sub2apiAccountId) {
        account = await importAccount();
      } else {
        try {
          await this.sub2ApiGateway.applyOAuthCredentials(
            item.sub2apiAccountId, credentials, item.rule.modelWhitelist,
          );
          account = await this.sub2ApiGateway.configureAndVerify({
            accountId: item.sub2apiAccountId,
            ...configuration,
          });
        } catch (error) {
          if (!isMissingSub2ApiAccount(error)) throw error;
          account = await importAccount();
          await this.repository.addEvent({
            ruleId: item.order.ruleId, runId: item.order.runId, orderId: item.order.id, itemId: item.id,
            eventType: 'import_retry_reimported',
            message: '原 Sub2API 账号不存在，已重新导入并验号',
            details: { previousAccountId: item.sub2apiAccountId, accountId: account?.id || null },
          });
        }
      }
      await this.repository.updateOrderItem(item.id, {
        status: 'imported', verificationStatus: 'passed', sub2apiAccountId: account?.id || item.sub2apiAccountId,
        importAttemptCount: Number(item.importAttemptCount || 0) + 1, nextImportRetryAt: null, errorMessage: '',
        capacityStartedAt: new Date(this.now()).toISOString(),
        metadata: metadataWithoutExpiration(item.metadata),
      });
      const order = await this.repository.getOrder(item.order.id);
      const validQuantity = order.items.filter((entry) => ['passed', 'repaired'].includes(entry.verificationStatus)).length;
      const failedQuantity = Math.max(0, order.requestedQuantity - validQuantity);
      const status = failedQuantity === 0 ? 'completed' : 'import_retry';
      await this.repository.updateOrder(order.id, { status, validQuantity, lastError: failedQuantity ? `${failedQuantity} 个账号等待重新导入` : '' });
      await this.repository.finishRun(order.runId, {
        status, actualPaidAmountCny: order.actualPaidAmountCny, deliveredQuantity: order.deliveredQuantity,
        validQuantity, failedQuantity, errorMessage: failedQuantity ? `${failedQuantity} 个账号等待重新导入` : '',
      });
      await this.repository.addEvent({
        ruleId: item.order.ruleId, runId: item.order.runId, orderId: item.order.id, itemId: item.id,
        eventType: 'import_retry_succeeded', message: '失败账号已重新导入并验号成功',
        details: { attempts: Number(item.importAttemptCount || 0) + 1 },
      });
      await this.reconcileCostLedgers();
      return { ok: true, itemId: item.id, accountId: account?.id || item.sub2apiAccountId };
    } catch (error) {
      if (await this.waitForSupplierRecovery({ item, rule: item.rule, order: item.order, error })) {
        return { ok: false, itemId: item.id, status: 'waiting_supplier_recovery' };
      }
      const attempts = Number(item.importAttemptCount || 0) + 1;
      const retryLimit = policy?.retryLimit === null || policy?.retryLimit === undefined ? null : Number(policy.retryLimit);
      const exhausted = isBlockedRecoveryConfiguration(error)
        || (retryLimit !== null && attempts > retryLimit);
      await this.repository.updateOrderItem(item.id, {
        status: exhausted ? 'manual_required' : 'retry_wait', verificationStatus: 'failed',
        importAttemptCount: attempts,
        nextImportRetryAt: exhausted ? null : new Date(this.now() + Number(policy?.retryIntervalSeconds || 60) * 1000).toISOString(),
        errorMessage: String(error?.message || error),
      });
      await this.repository.updateOrder(item.order.id, { status: 'import_retry', lastError: String(error?.message || error) });
      await this.repository.addEvent({
        ruleId: item.order.ruleId, runId: item.order.runId, orderId: item.order.id, itemId: item.id,
        eventType: exhausted ? 'import_retry_manual_required' : 'import_retry_scheduled',
        message: String(error?.message || error), details: { attempts, retryLimit, exhausted },
      });
      throw error;
    }
  }

  async rawRecoveries({ beforeId = 0 } = {}) {
    const response = await this.customerRequest(({ settings, token }) => this.client.recoveries({
      baseUrl: settings.baseUrl,
      token,
      beforeId,
      limit: 100,
    }));
    return payloadOf(response) || {};
  }

  async syncSupplierRecoveries() {
    const existing = await this.repository.listRecoveries({ limit: 500 });
    const currentByItem = latestRecoveryByItem(existing);
    const activeByItem = latestRecoveryByItem(existing, (entry) => OPEN_RECOVERY_STATUSES.has(entry.status));
    const mergeRecovery = async (entry, { externalOrderId = '', fallbackItem = null } = {}) => {
      const accountKey = supplierAccountKey(entry) || fallbackItem?.externalAccountKey || fallbackItem?.accountName || '';
      const supplierOrder = supplierOrderId(entry) || externalOrderId;
      const matchingItem = fallbackItem
        || (supplierOrder
          ? await this.repository.findOrderItemByExternalOrderAndAccountKey(supplierOrder, accountKey)
          : await this.repository.findOrderItemByAccountKey(accountKey));
      if (!matchingItem?.sub2apiAccountId) return null;
      const order = await this.repository.getOrder(matchingItem.orderId);
      const current = currentByItem.get(matchingItem.id);
      if (matchingItem.repairCompletionSource === 'manual_compensation') {
        const completedAt = current?.recoveredAt || matchingItem.updatedAt || new Date(this.now()).toISOString();
        const completed = current?.status === 'recovered'
          && current?.completionSource === 'manual_compensation'
          ? current
          : current
            ? await this.repository.completeRecovery(current.id, {
              completionSource: 'manual_compensation',
              deliveryStatus: current.deliveryStatus || replacementStatus(entry) || 'manual compensation',
              recoveredAt: completedAt,
            })
            : await this.repository.upsertRecovery({
              recoveryKey: `item:${matchingItem.id}:manual-compensation`,
              supplierRecoveryId: entry.id || entry.recovery_id || entry.replacement_id || '',
              orderItemId: matchingItem.id,
              ruleId: order?.ruleId,
              sub2apiAccountId: matchingItem.sub2apiAccountId,
              accountKey,
              status: 'recovered',
              deliveryStatus: replacementStatus(entry) || 'manual compensation',
              credentialVersion: matchingItem.credentialVersion || '',
              recoveredAt: completedAt,
              completionSource: 'manual_compensation',
            });
        if (completed) {
          currentByItem.set(matchingItem.id, completed);
          activeByItem.delete(matchingItem.id);
          return {
            ...completed,
            orderId: order?.id || matchingItem.orderId,
            externalOrderId: order?.externalOrderId || externalOrderId,
          };
        }
      }
      if (current?.status === 'recovered') {
        const remoteRecoveryId = String(entry.id || entry.recovery_id || entry.replacement_id || '');
        const remoteVersion = String(entry.credential_version || entry.credentialVersion || '');
        const reopened = replacementClaimUrl(entry) && (
          (remoteRecoveryId && remoteRecoveryId !== String(current.supplierRecoveryId || ''))
          || (remoteVersion && remoteVersion !== String(current.credentialVersion || ''))
        );
        if (reopened) {
          currentByItem.delete(matchingItem.id);
        } else {
          return {
            ...current,
            orderId: order?.id || matchingItem.orderId,
            externalOrderId: order?.externalOrderId || externalOrderId,
          };
        }
      }
      const activeCurrent = currentByItem.get(matchingItem.id);
      if (activeCurrent?.status === 'recovered') {
        return {
          ...activeCurrent,
          orderId: order?.id || matchingItem.orderId,
          externalOrderId: order?.externalOrderId || externalOrderId,
        };
      }
      const claimUrl = replacementClaimUrl(entry);
      const deliveryStatus = replacementStatus(entry);
      const ready = Boolean(entry.ready || deliveryStatus === 'claimable' || claimUrl);
      const supplierClaimed = !claimUrl && claimedReplacement(entry);
      const recoveryKey = activeCurrent?.recoveryKey
        || `item:${matchingItem.id}:credential:${matchingItem.credentialVersion || 'initial'}`;
      let status = ready ? 'claimable' : 'waiting_supplier';
      if (activeCurrent && ['credentials_saved', 'retry_wait'].includes(activeCurrent.status)) status = activeCurrent.status;
      if (activeCurrent?.status === 'manual_required' && !claimUrl && !supplierClaimed) status = activeCurrent.status;
      const claimedMessage = supplierClaimed && !activeCurrent?.credentialCiphertext
        ? 'OAuth Supply 显示补发文件已领取，但 FinOps 没有保存到本次凭据；等待供应商重新提供可领取文件。'
        : '';
      let saved = await this.repository.upsertRecovery({
        ...(activeCurrent || {}),
        recoveryKey,
        supplierRecoveryId: entry.id || entry.recovery_id || entry.replacement_id || activeCurrent?.supplierRecoveryId,
        orderItemId: matchingItem.id,
        ruleId: order?.ruleId,
        sub2apiAccountId: matchingItem.sub2apiAccountId,
        accountKey,
        status,
        deliveryStatus: deliveryStatus || activeCurrent?.deliveryStatus || '',
        credentialVersion: entry.credential_version || entry.credentialVersion || activeCurrent?.credentialVersion || '',
        claimUrlCiphertext: claimUrl && this.vault.available
          ? this.vault.encrypt({ claimUrl })
          : activeCurrent?.claimUrlCiphertext || '',
        lastError: claimedMessage || (ready ? '' : activeCurrent?.lastError || ''),
        nextRetryAt: ready ? null : activeCurrent?.nextRetryAt || null,
      });
      if (supplierClaimed && !activeCurrent?.credentialCiphertext) {
        await this.repository.addEvent({
          ruleId: order?.ruleId,
          runId: order?.runId || null,
          orderId: matchingItem.orderId,
          itemId: matchingItem.id,
          eventType: 'recovery_supplier_claim_observed',
          message: claimedMessage,
          details: { recoveryId: saved.id, supplierRecoveryId: saved.supplierRecoveryId || '' },
        });
      }
      if (matchingItem.verificationStatus === 'failed'
        && matchingItem.status !== 'waiting_supplier_recovery') {
        await this.repository.updateOrderItem(matchingItem.id, {
          status: 'waiting_supplier_recovery',
          nextImportRetryAt: null,
        });
        await this.repository.addEvent({
          ruleId: order?.ruleId,
          runId: order?.runId || null,
          orderId: matchingItem.orderId,
          itemId: matchingItem.id,
          eventType: 'import_recovery_waiting_supplier',
          message: '账号凭据失效，已转入供应商恢复认领队列',
          details: { recoveryId: saved.id, supplierRecoveryId: saved.supplierRecoveryId || '' },
        });
      }
      saved = { ...saved, orderId: order?.id || matchingItem.orderId, externalOrderId: order?.externalOrderId || externalOrderId };
      currentByItem.set(matchingItem.id, saved);
      if (OPEN_RECOVERY_STATUSES.has(saved.status)) activeByItem.set(matchingItem.id, saved);
      else activeByItem.delete(matchingItem.id);
      return saved;
    };
    let beforeId = 0;
    for (let page = 0; page < 10; page += 1) {
      let payload;
      try {
        payload = await this.rawRecoveries({ beforeId });
      } catch (error) {
        this.logger.warn('[replenishment] supplier recovery queue lookup failed', error?.message || error);
        break;
      }
      const entries = Array.isArray(payload) ? payload : payload.items || payload.recoveries || [];
      for (const entry of entries) {
        await mergeRecovery(entry);
      }
      const next = numeric(payload.next_before_id ?? payload.nextBeforeId, 0);
      if (!entries.length || !next || next === beforeId) break;
      beforeId = next;
    }

    const orders = new Map();
    for (const current of activeByItem.values()) {
      if (!current.orderId || !current.externalOrderId || current.status === 'recovered') continue;
      orders.set(current.orderId, current.externalOrderId);
    }
    for (const [orderId, externalOrderId] of orders) {
      try {
        const response = await this.customerRequest(({ settings, token }) => this.client.getOrder({
          baseUrl: settings.baseUrl,
          token,
          orderId: externalOrderId,
        }));
        const payload = payloadOf(response) || {};
        const order = await this.repository.getOrder(orderId);
        const replacements = replacementFilesPayload(payload);
        for (let entry of replacements) {
          const matchingItem = order?.items?.find((item) => replacementMatchesItem(entry, item))
            || (order?.items?.length === 1 && replacements.length === 1 ? order.items[0] : null);
          if (!matchingItem) continue;
          const statusUrl = replacementStatusUrl(entry);
          if (statusUrl && !replacementClaimUrl(entry)) {
            try {
              const statusResponse = await this.customerRequest(({ settings, token }) => this.client.getRecoveryStatus({
                baseUrl: settings.baseUrl,
                token,
                statusUrl,
              }));
              const latest = payloadOf(statusResponse) || {};
              entry = { ...entry, ...(latest.replacement_file || latest.replacementFile || latest) };
            } catch (error) {
              this.logger.warn('[replenishment] replacement status refresh failed', error?.message || error);
            }
          }
          await mergeRecovery(entry, { externalOrderId, fallbackItem: matchingItem });
        }
      } catch (error) {
        this.logger.warn(`[replenishment] replacement lookup failed for order ${externalOrderId}`, error?.message || error);
      }
    }
  }

  async claimRecovery(recoveryId) {
    let job = await this.repository.getRecovery(recoveryId);
    if (!job) throw errorWithStatus('修复任务不存在', 404);
    if (job.status === 'recovered') return { ok: true, recoveryId: job.id, targetAccountId: job.sub2apiAccountId };
    if (!job.recoveryEnabled) throw errorWithStatus('修复策略已停用', 409);
    try {
      let credentials;
      let credentialVersion = job.credentialVersion;
      if (job.credentialCiphertext) {
        const saved = this.vault.decrypt(job.credentialCiphertext);
        credentials = saved.credentials || saved;
      } else {
        if (!job.claimUrlCiphertext) throw errorWithStatus('供应商尚未准备好认领链接', 409);
        const { claimUrl } = this.vault.decrypt(job.claimUrlCiphertext);
        const claimed = await this.customerRequest(({ settings, token }) => this.client.claimRecovery({
          baseUrl: settings.baseUrl,
          token,
          claimUrl,
        }));
        const claimedPayload = payloadOf(claimed) || {};
        credentials = credentialsFromRecoveryPayload(claimedPayload, job.accountKey);
        if (!credentials || typeof credentials !== 'object') throw errorWithStatus('供应商修复响应缺少账号凭据');
        const claimedAccount = accountsPayload(claimedPayload).find(
          (entry) => supplierAccountKey(entry) === String(job.accountKey || '').trim(),
        ) || (accountsPayload(claimedPayload).length === 1 ? accountsPayload(claimedPayload)[0] : null);
        credentialVersion = claimedPayload.credential_version || claimedPayload.credentialVersion
          || claimedAccount?.credential_version || claimedAccount?.credentialVersion || credentialVersion;
        job = await this.repository.upsertRecovery({
          ...job,
          status: 'credentials_saved',
          credentialVersion,
          credentialCiphertext: this.vault.encrypt({ credentials }),
          claimedAt: new Date(this.now()).toISOString(),
          lastError: '',
        });
      }
      job = await this.repository.upsertRecovery({ ...job, status: 'updating_sub2api', lastError: '' });
      const orderItem = await this.repository.getOrderItem(job.orderItemId);
      const rule = await this.repository.getRule(job.ruleId);
      await this.assertActiveTargetGroups(rule);
      let targetAccountId = job.sub2apiAccountId;
      try {
        await this.sub2ApiGateway.applyOAuthCredentials(targetAccountId, credentials, rule?.modelWhitelist);
        job = await this.repository.upsertRecovery({ ...job, status: 'verifying', lastError: '' });
        await this.sub2ApiGateway.configureAndVerify({
          accountId: targetAccountId,
          groupIds: rule.targetGroupIds,
          concurrency: rule.concurrency,
          loadFactor: rule.loadFactor,
          proxyId: rule.proxyId,
          priority: rule.priority,
          rateMultiplier: rule.rateMultiplier,
          autoPauseOnExpired: rule.autoPauseOnExpired,
          modelId: job.verificationModel || rule.verificationModel || 'gpt-5.6-luna',
          prompt: job.verificationPrompt || rule.verificationPrompt || 'Reply with a short success marker.',
        });
      } catch (error) {
        if (!isMissingSub2ApiAccount(error) || !orderItem || !rule) throw error;
        const account = await this.sub2ApiGateway.importAndVerify({
          name: orderItem.accountName || job.accountName || job.accountKey,
          platform: rule.platform,
          credentials,
          expiresAt: null,
          groupIds: rule.targetGroupIds,
          concurrency: rule.concurrency,
          loadFactor: rule.loadFactor,
          proxyId: rule.proxyId,
          priority: rule.priority,
          rateMultiplier: rule.rateMultiplier,
          autoPauseOnExpired: rule.autoPauseOnExpired,
          modelId: rule.verificationModel,
          prompt: rule.verificationPrompt,
          modelWhitelist: rule.modelWhitelist,
          onCreated: async (accountId) => this.repository.updateOrderItem(orderItem.id, {
            status: 'importing', sub2apiAccountId: accountId,
          }),
        });
        targetAccountId = account?.id || targetAccountId;
        await this.repository.addEvent({
          ruleId: job.ruleId,
          orderId: orderItem.orderId,
          itemId: job.orderItemId,
          eventType: 'recovery_reimported',
          message: '原 Sub2API 账号不存在，已使用认领的新凭据重新导入并验号',
          details: { recoveryId: job.id, previousAccountId: job.sub2apiAccountId, accountId: targetAccountId },
        });
      }
      const encryptedCredentials = this.vault.encrypt({ credentials });
      await this.repository.updateOrderItem(job.orderItemId, {
        status: 'imported',
        verificationStatus: 'repaired',
        healthStatus: 'healthy',
        sub2apiAccountId: targetAccountId,
        credentialVersion,
        credentialCiphertext: encryptedCredentials,
        capacityStartedAt: new Date(this.now()).toISOString(),
        metadata: metadataWithoutExpiration(orderItem?.metadata),
        errorMessage: '',
        lastHealthAt: new Date(this.now()).toISOString(),
      });
      const recoveredOrderItem = await this.repository.getOrderItem(job.orderItemId);
      const recoveredOrder = recoveredOrderItem?.orderId
        ? await this.repository.getOrder(recoveredOrderItem.orderId)
        : null;
      if (recoveredOrder) {
        const validQuantity = recoveredOrder.items
          .filter((entry) => ['passed', 'repaired'].includes(entry.verificationStatus)).length;
        const failedQuantity = Math.max(0, recoveredOrder.requestedQuantity - validQuantity);
        const status = failedQuantity === 0 ? 'completed' : 'import_retry';
        await this.repository.updateOrder(recoveredOrder.id, {
          status,
          validQuantity,
          lastError: failedQuantity ? `${failedQuantity} 个账号等待修复` : '',
        });
        await this.repository.finishRun(recoveredOrder.runId, {
          status,
          actualPaidAmountCny: recoveredOrder.actualPaidAmountCny,
          deliveredQuantity: recoveredOrder.deliveredQuantity,
          validQuantity,
          failedQuantity,
          errorMessage: failedQuantity ? `${failedQuantity} 个账号等待修复` : '',
        });
      }
      job = await this.repository.upsertRecovery({
        ...job,
        sub2apiAccountId: targetAccountId,
        status: 'recovered',
        credentialVersion,
        credentialCiphertext: encryptedCredentials,
        nextRetryAt: null,
        lastError: '',
        recoveredAt: new Date(this.now()).toISOString(),
        completionSource: 'system',
      });
      await this.repository.addEvent({
        ruleId: job.ruleId,
        orderId: (await this.repository.getOrderItem(job.orderItemId))?.orderId || null,
        itemId: job.orderItemId,
        eventType: 'recovery_verified',
        message: `账号 ${job.accountName || job.accountKey} 已认领、更新并验号通过`,
        details: { recoveryId: job.id, targetAccountId, credentialVersion },
      });
      await this.reconcileCostLedgers();
      return {
        ok: true,
        recoveryId: job.id,
        credentialVersion,
        targetAccountId,
        imported: true,
      };
    } catch (error) {
      const staleClaim = Number(error?.httpStatus) === 409 || error?.code === 'claim_conflict'
        || error?.code === 'recovery_payload_invalid'
        || /recovery_payload_invalid/i.test(String(error?.message || ''));
      if (staleClaim && !job.credentialCiphertext) {
        const reason = Number(error?.httpStatus) === 409 || error?.code === 'claim_conflict'
          ? '认领链接已失效或已被使用，已清除旧链接并重新查询供应商。'
          : '供应商暂时无法提供补发文件，已清除旧链接并等待新链接。';
        job = await this.repository.invalidateRecoveryClaim(job.id, {
          status: 'waiting_supplier',
          deliveryStatus: 'claim link invalid',
          lastError: reason,
        });
        await this.syncSupplierRecoveries().catch((syncError) => {
          this.logger.warn('[replenishment] recovery refresh after stale claim failed', syncError?.message || syncError);
        });
        const refreshed = await this.repository.getRecovery(job.id);
        await this.repository.addEvent({
          ruleId: job.ruleId,
          orderId: job.orderId || null,
          itemId: job.orderItemId,
          eventType: refreshed?.status === 'manual_required' ? 'recovery_manual_required' : 'recovery_claim_refreshed',
          message: refreshed?.lastError || reason,
          details: { recoveryId: job.id, supplierCode: error?.code || '', httpStatus: error?.httpStatus || 0 },
        });
        throw errorWithStatus(refreshed?.lastError || reason, refreshed?.status === 'manual_required' ? 409 : 502);
      }
      const attempts = Number(job.attemptCount || 0) + 1;
      const retryLimit = job.recoveryRetryLimit === null || job.recoveryRetryLimit === undefined
        ? null : Number(job.recoveryRetryLimit);
      const exhausted = isBlockedRecoveryConfiguration(error)
        || (retryLimit !== null && attempts > retryLimit);
      await this.repository.upsertRecovery({
        ...job,
        status: exhausted ? 'manual_required' : 'retry_wait',
        attemptCount: attempts,
        nextRetryAt: exhausted ? null : new Date(this.now()
          + Number(job.recoveryRetryIntervalSeconds || 60) * 1000).toISOString(),
        lastError: String(error?.message || error),
      });
      await this.repository.addEvent({
        ruleId: job.ruleId,
        orderId: (await this.repository.getOrderItem(job.orderItemId))?.orderId || null,
        itemId: job.orderItemId,
        eventType: exhausted ? 'recovery_manual_required' : 'recovery_retry_scheduled',
        message: String(error?.message || error),
        details: { recoveryId: job.id, attempts, retryLimit, exhausted },
      });
      throw error;
    }
  }

  async waitForSupplierRecovery({ item, rule, order, error }) {
    const targetAccountId = Number(item?.sub2apiAccountId);
    if (!textIncludesAuthFailure(error?.message, error?.cause?.message)
      || !Number.isSafeInteger(targetAccountId) || targetAccountId <= 0 || !rule?.id) return false;
    const recovery = await this.repository.upsertRecovery({
      recoveryKey: `item:${item.id}:credential:${item.credentialVersion || 'initial'}`,
      orderItemId: item.id,
      ruleId: rule.id,
      sub2apiAccountId: targetAccountId,
      accountKey: item.externalAccountKey || item.accountName,
      status: 'waiting_supplier',
      deliveryStatus: 'credential invalidated',
      credentialVersion: item.credentialVersion,
      lastError: String(error?.message || error),
    });
    await this.repository.updateOrderItem(item.id, {
      status: 'waiting_supplier_recovery',
      verificationStatus: 'failed',
      nextImportRetryAt: null,
      errorMessage: String(error?.message || error),
    });
    await this.repository.addEvent({
      ruleId: rule.id,
      runId: order?.runId || null,
      orderId: order?.id || item.orderId,
      itemId: item.id,
      eventType: 'import_recovery_waiting_supplier',
      message: '账号凭据 401/失效，停止重放旧凭据并等待供应商恢复认领',
      details: { recoveryId: recovery.id, targetAccountId },
    });
    return true;
  }

  async inspectRuleInventory(rule) {
    const items = await this.repository.listTrackedItems(rule.id);
    const recoveries = await this.repository.listRecoveries({ limit: 500 });
    const openByItem = latestRecoveryByItem(recoveries, (entry) => OPEN_RECOVERY_STATUSES.has(entry.status));
    const accounts = [];
    let effectiveAccounts = 0;
    let lowQuotaAccounts = 0;
    let unavailableAccounts = 0;
    let repairingAccounts = 0;
    let unknownQuotaAccounts = 0;
    let graceRepairingAccounts = 0;
    for (const tracked of items) {
      let account = null;
      let usage = null;
      let readError = '';
      try {
        account = await this.sub2ApiGateway.getAccount(tracked.sub2apiAccountId);
        const platform = String(account?.platform || '').trim().toLowerCase();
        const accountType = String(account?.type || account?.account_type || '').trim().toLowerCase();
        const passiveUsageSupported = platform === 'anthropic'
          && ['oauth', 'setup-token', 'setup_token'].includes(accountType);
        if (passiveUsageSupported) {
          usage = await this.sub2ApiGateway
            .getAccountUsage(tracked.sub2apiAccountId, { source: 'passive' })
            .catch(() => null);
        }
      } catch (error) {
        readError = String(error?.message || error);
      }
      const expiresAt = epochSeconds(
        account?.expires_at
        ?? account?.expiresAt
        ?? tracked.metadata?.expiresAt,
      );
      const expired = expiresAt !== null && expiresAt * 1000 <= this.now();
      const authFailed = textIncludesAuthFailure(
        readError,
        account?.error_message,
        account?.errorMessage,
        usage?.error,
        usage?.error_code,
      ) || Boolean(usage?.needs_reauth);
      const manuallyCompleted = tracked.repairCompletionSource === 'manual_compensation';
      let recoveryJob = openByItem.get(tracked.id);
      if (manuallyCompleted) {
        recoveryJob = null;
        openByItem.delete(tracked.id);
      }
      if (authFailed && !recoveryJob && !manuallyCompleted) {
        recoveryJob = await this.repository.upsertRecovery({
          recoveryKey: `item:${tracked.id}:credential:${tracked.credentialVersion || 'initial'}`,
          orderItemId: tracked.id,
          ruleId: rule.id,
          sub2apiAccountId: tracked.sub2apiAccountId,
          accountKey: tracked.externalAccountKey || tracked.accountName,
          status: 'detected',
          deliveryStatus: '401 detected',
        });
        await this.repository.addEvent({
          ruleId: rule.id,
          orderId: tracked.orderId,
          itemId: tracked.id,
          eventType: 'account_recovery_detected',
          message: `账号 ${tracked.accountName} 检测到 401 或凭据失效`,
          details: { sub2apiAccountId: tracked.sub2apiAccountId },
        });
        openByItem.set(tracked.id, recoveryJob);
      }
      const repairing = Boolean(recoveryJob);
      const accountGroups = accountGroupIds(account);
      const groupMatched = rule.targetGroupIds.every((id) => accountGroups.includes(Number(id)));
      const platformMatched = String(account?.platform || rule.platform) === rule.platform;
      const schedule = scheduleSnapshot(account, {
        readError,
        expired,
        repairing,
        status: account?.status || '',
        authFailed,
        platformMatched,
        groupMatched,
        nowMs: this.now(),
      });
      const healthyStatus = !readError
        && String(account?.status || '').toLowerCase() === 'active'
        && platformMatched
        && groupMatched
        // Sub2API exposes the UI's "normal" state as active + schedulable.
        // Treat missing runtime eligibility conservatively so a partial API
        // response cannot inflate the replenishment inventory.
        && account?.schedulable === true
        && schedule.state === 'schedulable'
        && !expired
        && !authFailed
        && !repairing;
      const staleHealthy = Boolean(readError)
        && !authFailed
        && !repairing
        && recentlyHealthyAfterReadError(tracked, rule, this.now());
      const quota = quotaSnapshot(account, usage);
      const selected = selectedQuota(quota, rule.quotaWindow);
      const quotaUnknown = selected.value === null;
      const lowQuota = selected.value !== null && selected.value >= rule.quotaUsedThresholdPercent;
      const unknownCountsLow = quotaUnknown && rule.quotaUnknownPolicy === 'low';
      let healthStatus;
      if (repairing) {
        healthStatus = 'repairing';
        repairingAccounts += 1;
        const ageMs = this.now() - Date.parse(recoveryJob.firstSeenAt || new Date(this.now()).toISOString());
        if (ageMs < rule.repairGraceSeconds * 1000) graceRepairingAccounts += 1;
      } else if (!healthyStatus && !staleHealthy) {
        healthStatus = 'unavailable';
        unavailableAccounts += 1;
      } else if (staleHealthy) {
        // Keep the last known healthy state until the read error outlives the
        // grace window; a successful read will replace it on the next pass.
        healthStatus = tracked.healthStatus;
        effectiveAccounts += 1;
      } else if (lowQuota || unknownCountsLow) {
        healthStatus = 'low_quota';
        lowQuotaAccounts += 1;
      } else {
        healthStatus = quotaUnknown ? 'quota_unknown' : 'healthy';
        effectiveAccounts += 1;
      }
      if (healthyStatus && quotaUnknown) unknownQuotaAccounts += 1;
      await this.repository.updateOrderItem(tracked.id, {
        healthStatus,
        quotaUsedPercent: selected.value,
        quotaWindow: selected.window,
        lastHealthAt: staleHealthy
          ? tracked.lastHealthAt
          : new Date(this.now()).toISOString(),
        errorMessage: staleHealthy
          ? 'Sub2API account temporarily unavailable; using last known healthy state'
          : authFailed
          ? 'Sub2API account requires reauthentication'
            : healthyStatus
              ? ''
            : tracked.errorMessage,
      });
      accounts.push({
        orderItemId: tracked.id,
        sub2apiAccountId: tracked.sub2apiAccountId,
        accountName: tracked.accountName,
        healthStatus,
        quotaUsedPercent: selected.value,
        quotaWindow: selected.window,
        quotaShortUsedPercent: quota.short,
        quotaLongUsedPercent: quota.long,
        sourceStatus: account?.status || '',
        status: account?.status || '',
        sourceSchedulable: schedule.sourceSchedulable,
        schedulable: schedule.sourceSchedulable === true,
        scheduleState: schedule.state,
        scheduleReason: schedule.reason,
        rateLimitResetAt: schedule.rateLimitResetAt
          || account?.rate_limit_reset_at
          || account?.rateLimitResetAt
          || null,
        tempUnschedulableUntil: schedule.tempUnschedulableUntil,
        tempUnschedulableReason: schedule.tempUnschedulableReason,
        expired,
        staleHealthy,
        expiresAt,
        createdAt: tracked.createdAt || null,
        readError,
        lastError: readError || account?.error_message || account?.errorMessage || '',
      });
    }
    const pendingAccounts = await this.repository.pendingQuantity(rule.id);
    const snapshot = {
      capturedAt: new Date(this.now()).toISOString(),
      trackedAccounts: items.length,
      effectiveAccounts,
      lowQuotaAccounts,
      unavailableAccounts,
      repairingAccounts,
      graceRepairingAccounts,
      unknownQuotaAccounts,
      pendingAccounts,
      accounts,
    };
    await this.repository.saveInventorySnapshot(rule.id, snapshot);
    return snapshot;
  }

  async forecastRuleCapacity(rule, inventorySnapshot) {
    if (!this.sourceUsageRepository || !this.accountReader) {
      throw new Error('智能预测所需的 Sub2API 只读数据源未配置');
    }
    const [trackedItems, sourceAccounts, planning] = await Promise.all([
      this.repository.listTrackedItemsForPool(rule.targetPoolKey),
      this.accountReader.listAllAccounts({ platform: rule.platform, status: '' }),
      this.repository.getPoolPlanningStats(rule.targetPoolKey),
    ]);
    const poolAccounts = (sourceAccounts || []).filter((account) => accountMatchesRule(account, rule));
    const trackedByAccountId = new Map(trackedItems
      .filter((item) => Number.isSafeInteger(Number(item.sub2apiAccountId)))
      .map((item) => [Number(item.sub2apiAccountId), item]));
    const inventoryByAccountId = new Map((inventorySnapshot?.accounts || [])
      .map((account) => [Number(account.sub2apiAccountId), account]));
    const repairingAccountIds = new Set((inventorySnapshot?.accounts || [])
      .filter((account) => account.healthStatus === 'repairing')
      .map((account) => Number(account.sub2apiAccountId)));
    const accountStates = [];
    const sourceIds = new Set();

    for (const account of poolAccounts) {
      const accountId = Number(account?.id);
      if (!Number.isSafeInteger(accountId) || accountId <= 0) continue;
      sourceIds.add(accountId);
      const tracked = trackedByAccountId.get(accountId);
      const inventoryAccount = inventoryByAccountId.get(accountId);
      const expiresAt = epochSeconds(account?.expires_at ?? account?.expiresAt);
      const expired = expiresAt !== null && expiresAt * 1000 <= this.now();
      const schedule = scheduleSnapshot(account, {
        expired,
        repairing: repairingAccountIds.has(accountId),
        status: account?.status || '',
        platformMatched: true,
        groupMatched: true,
        nowMs: this.now(),
      });
      const liveQuota = quotaSnapshot(account, null).long;
      const fallbackQuota = inventoryAccount?.quotaLongUsedPercent
        ?? (tracked?.quotaWindow === 'long' ? tracked.quotaUsedPercent : null);
      accountStates.push({
        accountId,
        quotaUsedPercent: liveQuota ?? fallbackQuota,
        available: String(account?.status || '').toLowerCase() === 'active'
          && account?.schedulable === true
          && schedule.state === 'schedulable'
          && !expired
          && !repairingAccountIds.has(accountId),
        capacityStartedAt: tracked?.capacityStartedAt
          || tracked?.createdAt || account?.created_at || account?.createdAt || null,
      });
    }

    for (const tracked of trackedItems) {
      const accountId = Number(tracked.sub2apiAccountId);
      if (!Number.isSafeInteger(accountId) || accountId <= 0) continue;
      sourceIds.add(accountId);
      if (accountStates.some((entry) => entry.accountId === accountId)) continue;
      const inventoryAccount = inventoryByAccountId.get(accountId);
      accountStates.push({
        accountId,
        quotaUsedPercent: inventoryAccount?.quotaLongUsedPercent
          ?? (tracked.quotaWindow === 'long' ? tracked.quotaUsedPercent : null),
        available: false,
        capacityStartedAt: tracked.capacityStartedAt || tracked.createdAt || null,
      });
    }

    const maximumLookbackHours = 168;
    const completedEndMs = Math.floor(this.now() / 3_600_000) * 3_600_000;
    const usageRows = await this.sourceUsageRepository.getHourlyAccountStats({
      start: new Date(completedEndMs - maximumLookbackHours * 3_600_000),
      end: new Date(completedEndMs),
      accountIds: [...sourceIds],
    });
    const historicalSuccessRate = planning.historicalSuccessRate === null
      || planning.historicalSuccessRate === undefined
      ? 0.8
      : bounded(planning.historicalSuccessRate, 0.1, 1);
    const adaptive = deriveAdaptiveForecastParameters(usageRows, {
      nowMs: this.now(),
      maximumLookbackHours,
      leadTimeHoursP50: planning.leadTimeHoursP50,
      leadTimeHoursP90: planning.leadTimeHoursP90,
      historicalSuccessRate,
    });
    const leadTimeHours = adaptive.leadTimeHoursP90;
    const coverageHours = adaptive.coverageHours;
    const horizonHours = Math.max(1, Math.ceil(leadTimeHours + coverageHours));
    const demand = forecastHourlyDemand(usageRows, {
      nowMs: this.now(),
      lookbackHours: adaptive.lookbackHours,
      horizonHours,
      safetyFactor: adaptive.safetyFactor,
      timezone: this.config.timezone,
    });
    const capacity = estimateFiniteQuotaCapacity({
      accountStates,
      usageRows,
      minimumSamples: 3,
    });
    const accountCapacity = capacity.conservativeAccountCapacity;
    const pendingAccounts = Number(planning.pendingQuantity || 0);
    const inFlightCapacity = accountCapacity === null
      ? 0
      : pendingAccounts * accountCapacity * historicalSuccessRate;
    const forecastUsage = Number(demand.forecastUsage || 0);
    const capacityGap = Math.max(
      0,
      forecastUsage - Number(capacity.currentRemainingCapacity || 0) - inFlightCapacity,
    );
    const deliveredAccountCapacity = accountCapacity === null
      ? null
      : accountCapacity * historicalSuccessRate;
    const predictedQuantity = deliveredAccountCapacity && capacityGap > 0
      ? Math.ceil(capacityGap / deliveredAccountCapacity)
      : 0;
    const projectedEffectiveAccounts = capacity.effectiveAccounts
      + Math.floor(pendingAccounts * historicalSuccessRate);
    const emergencyQuantity = Math.max(
      0,
      Number(rule.minAvailableAccounts || 0) - projectedEffectiveAccounts,
    );
    const uncappedRecommendedQuantity = Math.max(predictedQuantity, emergencyQuantity);
    const recommendedQuantity = Math.max(
      0,
      Math.min(uncappedRecommendedQuantity, Number(rule.replenishQuantity || 1), 1000),
    );
    const insufficient = demand.confidence === 'insufficient' || accountCapacity === null;
    const status = recommendedQuantity > 0
      ? emergencyQuantity > predictedQuantity
        ? 'emergency_replenishment'
        : 'replenishment_needed'
      : insufficient
        ? 'insufficient_data'
        : 'capacity_healthy';
    const protectedCapacity = Number(capacity.currentRemainingCapacity || 0) + inFlightCapacity;
    const protectedHourlyRate = Math.max(
      Number(demand.recentHourlyRate || 0) * Number(demand.safetyFactor || 1),
      Number(demand.forecastUsage || 0) / Math.max(1, horizonHours),
    );
    const runwayHours = protectedHourlyRate > 0
      ? protectedCapacity / protectedHourlyRate
      : null;
    const nextCheckSeconds = recommendedQuantity > 0
      ? 300
      : runwayHours !== null && runwayHours <= leadTimeHours + 6
        ? 600
        : runwayHours !== null && runwayHours <= leadTimeHours + coverageHours
          ? 900
          : insufficient
            ? 900
            : 1800;
    const lookbackReasons = {
      recent_shift: '近期用量明显变化，采用24小时数据',
      trend: '近期用量存在趋势，采用72小时数据',
      sparse: '用量样本稀疏，采用168小时数据',
      insufficient: '暂无有效用量，保留168小时观察窗口',
      stable: '用量稳定，采用168小时数据',
    };
    const decisionReasons = [
      lookbackReasons[adaptive.lookbackReason] || lookbackReasons.stable,
      `波动系数 ${adaptive.volatility}，安全余量 ${rounded((adaptive.safetyFactor - 1) * 100, 1)}%`,
      `采购提前期 P50 ${adaptive.leadTimeHoursP50} 小时 / P90 ${adaptive.leadTimeHoursP90} 小时`,
      runwayHours === null
        ? `每 ${nextCheckSeconds / 60} 分钟重新评估`
        : `库存预计续航 ${rounded(runwayHours, 1)} 小时`,
    ];
    const snapshot = {
      capturedAt: new Date(this.now()).toISOString(),
      status,
      parameterMode: adaptive.parameterMode,
      lookbackHours: demand.lookbackHours,
      horizonHours: demand.horizonHours,
      leadTimeHours: rounded(leadTimeHours, 3),
      leadTimeHoursP50: adaptive.leadTimeHoursP50,
      leadTimeHoursP90: adaptive.leadTimeHoursP90,
      coverageHours,
      safetyFactor: demand.safetyFactor,
      volatility: adaptive.volatility,
      recentDemandChange: adaptive.recentDemandChange,
      observedUsage1h: demand.observedUsage1h,
      observedUsage6h: demand.observedUsage6h,
      observedUsage24h: demand.observedUsage24h,
      recentHourlyRate: demand.recentHourlyRate,
      trendFactor: demand.trendFactor,
      forecastUsage: demand.forecastUsage,
      currentRemainingCapacity: capacity.currentRemainingCapacity,
      inFlightCapacity: rounded(inFlightCapacity),
      capacityGap: rounded(capacityGap),
      conservativeAccountCapacity: accountCapacity,
      capacitySampleCount: capacity.sampleCount,
      capacityConfidence: capacity.confidence,
      demandConfidence: demand.confidence,
      effectiveAccounts: capacity.effectiveAccounts,
      exhaustedAccounts: capacity.exhaustedAccounts,
      unknownQuotaAccounts: capacity.unknownQuotaAccounts,
      pendingAccounts,
      pendingSuccessRate: rounded(historicalSuccessRate, 4),
      historicalOrderCount: Number(planning.historicalOrderCount || 0),
      emergencyQuantity,
      predictedQuantity,
      uncappedRecommendedQuantity,
      recommendedQuantity,
      runwayHours: rounded(runwayHours, 3),
      nextCheckSeconds,
      decisionReasons,
      sourceAccountCount: poolAccounts.length,
      trackedAccountCount: trackedItems.length,
    };
    await this.repository.saveForecastSnapshot(rule.id, snapshot);
    return { snapshot, hasActiveOrder: Boolean(planning.hasActiveOrder) };
  }

  async createOrderForRule(rule, {
    trigger = 'scheduled', actor = 'system', force = false, scheduledFor = null,
  } = {}) {
    if (!rule?.enabled && !force) return { status: 'disabled' };
    const triggerStrategy = rule.triggerStrategy || 'inventory_threshold';
    const configuredIntervalSeconds = triggerStrategy === 'smart_forecast'
      ? Math.max(300, Number(rule.lastForecastSnapshot?.nextCheckSeconds || 600))
      : Math.max(1, Number(rule.scheduleIntervalSeconds || 300));
    const intervalMs = configuredIntervalSeconds * 1000;
    const slotMs = Math.floor(this.now() / intervalMs) * intervalMs;
    const effectiveScheduledFor = trigger === 'scheduled'
      ? scheduledFor || new Date(slotMs).toISOString()
      : null;
    const recordDecision = async (eventType, message, details = {}) => this.repository.addEvent({
      ruleId: rule?.id || null,
      eventType,
      message,
      details: {
        trigger,
        triggerStrategy,
        ...(effectiveScheduledFor ? { scheduledFor: effectiveScheduledFor } : {}),
        ...details,
        ...(details.inventory ? { inventory: inventoryEventSummary(details.inventory) } : {}),
      },
      actor,
    });
    try {
      if (!rule.product || !rule.platform || !rule.targetPoolKey) {
        throw errorWithStatus('补号策略缺少商品映射', 400);
      }
      const inventoryStrategy = triggerStrategy === 'inventory_threshold';
      const smartStrategy = triggerStrategy === 'smart_forecast';
      const dynamicStrategy = inventoryStrategy || smartStrategy;
      const snapshot = dynamicStrategy ? await this.inspectRuleInventory(rule) : null;
      let smartForecast = null;
      let smartForecastError = '';
      let smartHasActiveOrder = false;
      if (smartStrategy) {
        try {
          const result = await this.forecastRuleCapacity(rule, snapshot);
          smartForecast = result.snapshot;
          smartHasActiveOrder = result.hasActiveOrder;
        } catch (error) {
          smartForecastError = String(error?.message || error);
          smartForecast = {
            capturedAt: new Date(this.now()).toISOString(),
            status: 'read_failed',
            parameterMode: 'adaptive',
            recommendedQuantity: 0,
            effectiveAccounts: Number(snapshot?.effectiveAccounts || 0),
            pendingAccounts: Number(snapshot?.pendingAccounts || 0),
            nextCheckSeconds: 300,
            error: smartForecastError,
          };
          await this.repository.saveForecastSnapshot(rule.id, smartForecast, {
            error: `智能预测读取失败：${smartForecastError}`,
          });
        }
      }
      const hasActiveOrder = smartStrategy
        ? smartHasActiveOrder || await this.repository.hasActiveOrder(rule.id)
        : await this.repository.hasActiveOrder(rule.id);
      if (!dynamicStrategy && hasActiveOrder) {
        await recordDecision('order_skipped', '已有进行中的补号订单，本轮不重复下单', {
          reason: 'already_active',
        });
        return { status: 'already_active' };
      }
      let quantity;
      if (inventoryStrategy) {
        const effectiveAccounts = Number(snapshot.effectiveAccounts || 0);
        const pendingAccounts = Number(snapshot.pendingAccounts || 0);
        const graceRepairingAccounts = Number(snapshot.graceRepairingAccounts || 0);
        const projectedInventory = effectiveAccounts + graceRepairingAccounts + pendingAccounts;
        const targetAvailableAccounts = Number(rule.targetAvailableAccounts || 0);
        const coverage = {
          effectiveAccounts,
          pendingAccounts,
          graceRepairingAccounts,
          projectedInventory,
          targetAvailableAccounts,
        };
        if (hasActiveOrder && projectedInventory >= targetAvailableAccounts) {
          await recordDecision(
            'order_skipped',
            `库存检查完成：有效 ${effectiveAccounts}、进行中订单待补 ${pendingAccounts}、修复等待 ${graceRepairingAccounts}，投影库存 ${projectedInventory} 已达到目标 ${targetAvailableAccounts}，无需追加补号`,
            { reason: 'active_order_covers_target', ...coverage, inventory: snapshot },
          );
          return {
            status: 'already_active',
            available: effectiveAccounts,
            pending: pendingAccounts,
            projectedInventory,
            target: targetAvailableAccounts,
            inventory: snapshot,
          };
        }
        if (!force && !hasActiveOrder && projectedInventory >= rule.minAvailableAccounts) {
          const heldByRepairGrace = effectiveAccounts < rule.minAvailableAccounts
            && effectiveAccounts + graceRepairingAccounts >= rule.minAvailableAccounts;
          const eventType = heldByRepairGrace ? 'order_skipped' : 'inventory_healthy';
          const status = heldByRepairGrace ? 'repair_grace' : 'healthy';
          const message = heldByRepairGrace
            ? '账号仍在修复等待期并占用库存，本轮暂不补号'
            : `库存检查完成：有效 ${effectiveAccounts}、进行中订单待补 ${pendingAccounts}、修复等待 ${graceRepairingAccounts}，投影库存 ${projectedInventory}，无需补号`;
          await recordDecision(eventType, message, {
            reason: heldByRepairGrace ? 'repair_grace' : 'projected_inventory_healthy',
            ...coverage,
            inventory: snapshot,
          });
          return {
            status,
            available: effectiveAccounts,
            pending: pendingAccounts,
            projectedInventory,
            inventory: snapshot,
          };
        }
        const desired = Math.max(0, targetAvailableAccounts - projectedInventory);
        if (!desired) {
          await recordDecision('inventory_healthy', `库存检查完成：有效 ${effectiveAccounts}、进行中订单待补 ${pendingAccounts}、修复等待 ${graceRepairingAccounts}，投影库存 ${projectedInventory}，无需补号`, {
            ...coverage, inventory: snapshot,
          });
          return {
            status: 'healthy',
            available: effectiveAccounts,
            pending: pendingAccounts,
            projectedInventory,
            target: targetAvailableAccounts,
            inventory: snapshot,
          };
        }
        quantity = Math.max(1, Math.min(desired, rule.replenishQuantity, 1000));
      } else if (smartStrategy) {
        if (hasActiveOrder) {
          await recordDecision('order_skipped', '目标账号池已有进行中的补号订单，本轮不重复下单', {
            reason: 'pool_order_active',
            forecast: smartForecast,
            inventory: snapshot,
          });
          return {
            status: 'already_active',
            forecast: smartForecast,
            inventory: snapshot,
          };
        }
        if (smartForecastError) {
          const effectiveAccounts = Number(snapshot?.effectiveAccounts || 0);
          const pendingAccounts = Number(snapshot?.pendingAccounts || 0);
          const projectedInventory = effectiveAccounts + pendingAccounts;
          const emergencyQuantity = Math.max(
            0,
            Number(rule.minAvailableAccounts || 0) - projectedInventory,
          );
          if (!emergencyQuantity) {
            await recordDecision('forecast_insufficient', '智能预测数据读取失败，当前库存未触发紧急兜底，本轮不下单', {
              reason: 'forecast_read_failed',
              error: smartForecastError,
              forecast: smartForecast,
              inventory: snapshot,
            });
            return {
              status: 'forecast_unavailable',
              forecast: smartForecast,
              inventory: snapshot,
            };
          }
          quantity = Math.max(1, Math.min(emergencyQuantity, Number(rule.replenishQuantity || 1), 1000));
          smartForecast = {
            ...smartForecast,
            status: 'emergency_fallback',
            emergencyQuantity,
            recommendedQuantity: quantity,
            nextCheckSeconds: 300,
          };
          await this.repository.saveForecastSnapshot(rule.id, smartForecast, {
            error: `智能预测读取失败，已按最低库存兜底：${smartForecastError}`,
          });
        } else {
          quantity = Number(smartForecast?.recommendedQuantity || 0);
          if (quantity <= 0) {
            const insufficient = smartForecast?.status === 'insufficient_data';
            const message = insufficient
              ? '智能预测样本不足且未触发最低库存兜底，本轮不下单'
              : `智能预测完成：未来 ${smartForecast.horizonHours} 小时需求 ${smartForecast.forecastUsage || 0}，当前及在途容量可覆盖，无需补号`;
            await recordDecision(insufficient ? 'forecast_insufficient' : 'forecast_healthy', message, {
              reason: insufficient ? 'forecast_samples_insufficient' : 'forecast_capacity_healthy',
              forecast: smartForecast,
              inventory: snapshot,
            });
            return {
              status: insufficient ? 'forecast_insufficient' : 'healthy',
              forecast: smartForecast,
              inventory: snapshot,
            };
          }
        }
      } else {
        quantity = Math.max(1, Math.min(Number(rule.replenishQuantity), 1000));
      }
      let inventoryResponse = await this.inventory(rule.product, quantity);
      let inventory = payloadOf(inventoryResponse) || {};
      const supplierAvailable = numeric(inventory.available, numeric(inventory.available_count, 0)) || 0;
      if (supplierAvailable <= 0) {
        if (snapshot) await this.repository.saveInventorySnapshot(rule.id, snapshot, { error: '供应商当前无可售账号' });
        else await this.repository.markRuleError(rule.id, '供应商当前无可售账号');
        await recordDecision('rule_blocked', '供应商当前无可售账号，本轮无法补号', {
          reason: 'supplier_inventory', supplierAvailable, ...(snapshot ? { inventory: snapshot } : {}),
        });
        return { status: 'blocked_supplier_inventory', supplierAvailable, ...(snapshot ? { inventory: snapshot } : {}) };
      }
      if (supplierAvailable < quantity) {
        if (!dynamicStrategy) {
          const message = `供应商仅有 ${supplierAvailable} 个账号，少于固定购买数量 ${quantity}`;
          await this.repository.markRuleError(rule.id, message);
          await recordDecision('rule_blocked', `${message}，本轮不下单`, {
            reason: 'supplier_inventory_insufficient', supplierAvailable, quantity,
          });
          return { status: 'blocked_supplier_inventory', supplierAvailable, quantity };
        }
        quantity = supplierAvailable;
        inventoryResponse = await this.inventory(rule.product, quantity);
        inventory = payloadOf(inventoryResponse) || {};
      }
      const quotedCny = centsToCny(inventory.estimated_total_fen ?? inventory.estimatedTotalFen);
      if ((rule.maxOrderAmountCny !== null || rule.maxDailyAmountCny !== null) && quotedCny === null) {
        if (snapshot) await this.repository.markRuleInventory(rule.id, { error: '供应商未返回报价，成本上限开启时禁止下单' });
        else await this.repository.markRuleError(rule.id, '供应商未返回报价，成本上限开启时禁止下单');
        await recordDecision('rule_blocked', '供应商未返回报价，成本保护已阻止下单', {
          reason: 'cost_unknown', ...(snapshot ? { inventory: snapshot } : {}),
        });
        return { status: 'blocked_cost_unknown' };
      }
      if (rule.maxOrderAmountCny !== null && quotedCny !== null && quotedCny > rule.maxOrderAmountCny) {
        const message = `报价 ${quotedCny} CNY 超过单次上限`;
        if (snapshot) await this.repository.markRuleInventory(rule.id, { error: message });
        else await this.repository.markRuleError(rule.id, message);
        await recordDecision('rule_blocked', `报价 ${quotedCny} CNY 超过单次成本上限`, {
          reason: 'order_cost', quotedCny, ...(snapshot ? { inventory: snapshot } : {}),
        });
        return { status: 'blocked_cost', quotedCny };
      }
      const dailySpend = await this.repository.dailySpend(rule.id);
      if (rule.maxDailyAmountCny !== null && quotedCny !== null && dailySpend + quotedCny > rule.maxDailyAmountCny) {
        const message = `今日累计报价将超过 ${rule.maxDailyAmountCny} CNY`;
        if (snapshot) await this.repository.markRuleInventory(rule.id, { error: message });
        else await this.repository.markRuleError(rule.id, message);
        await recordDecision('rule_blocked', message, {
          reason: 'daily_cost', dailySpend, quotedCny, ...(snapshot ? { inventory: snapshot } : {}),
        });
        return { status: 'blocked_daily_cost', dailySpend, quotedCny };
      }
      if (rule.mode === 'observe') {
        const message = smartStrategy
          ? `观察模式：未来 ${smartForecast.horizonHours || 0} 小时预测用量 ${smartForecast.forecastUsage || 0}，容量缺口 ${smartForecast.capacityGap || 0}，建议补充 ${quantity} 个账号，未创建订单`
          : inventoryStrategy
            ? `观察模式：有效 ${snapshot.effectiveAccounts}、进行中订单待补 ${snapshot.pendingAccounts}、修复等待 ${snapshot.graceRepairingAccounts}，投影库存 ${snapshot.effectiveAccounts + snapshot.graceRepairingAccounts + snapshot.pendingAccounts}，计划补充 ${quantity} 个账号，未创建订单`
            : `观察模式：建议购买 ${quantity} 个账号，未创建订单`;
        if (snapshot) await this.repository.saveInventorySnapshot(rule.id, snapshot, { error: message });
        else await this.repository.markRuleError(rule.id, message);
        await recordDecision('observed_replenishment', message, {
          available: snapshot?.effectiveAccounts ?? null,
          ...(inventoryStrategy ? {
            effectiveAccounts: snapshot.effectiveAccounts,
            pendingAccounts: snapshot.pendingAccounts,
            graceRepairingAccounts: snapshot.graceRepairingAccounts,
            projectedInventory: snapshot.effectiveAccounts
              + snapshot.graceRepairingAccounts
              + snapshot.pendingAccounts,
            targetAvailableAccounts: Number(rule.targetAvailableAccounts || 0),
          } : {}),
          ...(smartStrategy ? { forecast: smartForecast } : {}),
          quotedCny,
          quantity,
          ...(snapshot ? { inventory: snapshot } : {}),
        });
        return {
          status: 'observed_need', available: snapshot?.effectiveAccounts ?? null, quotedCny, quantity,
          ...(smartStrategy ? { forecast: smartForecast } : {}),
          ...(snapshot ? { inventory: snapshot } : {}),
        };
      }
      const balance = await this.balance().catch(() => null);
      const availableBalanceCny = centsToCny(balance?.available_fen ?? balance?.availableFen);
      if (quotedCny !== null && availableBalanceCny !== null && quotedCny > availableBalanceCny) {
        if (snapshot) await this.repository.markRuleInventory(rule.id, { error: 'OAuth Supply 可用余额不足' });
        else await this.repository.markRuleError(rule.id, 'OAuth Supply 可用余额不足');
        await recordDecision('rule_blocked', 'OAuth Supply 可用余额不足，本轮无法下单', {
          reason: 'balance', quotedCny, availableBalanceCny, ...(snapshot ? { inventory: snapshot } : {}),
        });
        return { status: 'blocked_balance', quotedCny, availableBalanceCny };
      }
      const parsedScheduledFor = Date.parse(effectiveScheduledFor || '');
      const scheduledSlotMs = Number.isFinite(parsedScheduledFor) ? parsedScheduledFor : slotMs;
      const idempotencyKey = trigger === 'scheduled'
        ? `finops-replenishment-${rule.id}-${scheduledSlotMs}`
        : `finops-replenishment-${rule.id}-${this.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const planned = await this.repository.createPlannedOrder({
        rule,
        trigger,
        quantity,
        availableBefore: smartStrategy
          ? smartForecast?.effectiveAccounts ?? null
          : snapshot?.effectiveAccounts ?? null,
        quotedAmountCny: quotedCny,
        actor,
        status: rule.mode === 'approval' ? 'approval_required' : 'ordering',
        idempotencyKey,
      });
      if (!planned) {
        await recordDecision('order_skipped', '已有进行中的补号订单，本轮不重复下单', {
          reason: 'already_active', ...(snapshot ? { inventory: snapshot } : {}),
        });
        return { status: 'already_active', ...(snapshot ? { inventory: snapshot } : {}) };
      }
      if (planned.idempotentReplay) {
        await recordDecision('order_skipped', '该定时时间点已经执行，本轮不重复下单', {
          reason: 'scheduled_slot_already_processed', orderId: planned.id,
        });
        return { status: 'already_processed', order: planned };
      }
      await this.repository.addEvent({
        ruleId: rule.id,
        runId: planned.runId,
        orderId: planned.id,
        eventType: rule.mode === 'approval' ? 'approval_required' : 'order_planned',
        message: rule.mode === 'approval' ? '订单等待审批' : '订单开始创建',
        details: {
          available: snapshot?.effectiveAccounts ?? null,
          ...(inventoryStrategy ? {
            effectiveAccounts: snapshot.effectiveAccounts,
            pendingAccounts: snapshot.pendingAccounts,
            graceRepairingAccounts: snapshot.graceRepairingAccounts,
            projectedInventory: snapshot.effectiveAccounts
              + snapshot.graceRepairingAccounts
              + snapshot.pendingAccounts,
            targetAvailableAccounts: Number(rule.targetAvailableAccounts || 0),
          } : {}),
          ...(smartStrategy ? { forecast: smartForecast } : {}),
          quantity,
          quotedCny,
          trigger,
          triggerStrategy,
          ...(effectiveScheduledFor ? { scheduledFor: effectiveScheduledFor } : {}),
          ...(snapshot ? { inventory: inventoryEventSummary(snapshot) } : {}),
        },
        actor,
      });
      if (rule.mode === 'approval') return planned;
      return this.submitOrder(planned, rule);
    } catch (error) {
      await recordDecision('rule_execution_failed', String(error?.message || error), { error: String(error?.message || error) })
        .catch(() => {});
      throw error;
    }
  }

  async approveOrder(orderId, actor = 'admin') {
    const current = await this.repository.getOrder(orderId);
    if (!current) throw errorWithStatus('补号订单不存在', 404);
    if (current.status !== 'approval_required') return current;
    const rule = await this.repository.getRule(current.ruleId);
    const updated = await this.repository.updateOrder(current.id, {
      status: 'ordering',
      approvedBy: actor,
      approvedAt: new Date(this.now()).toISOString(),
    });
    return this.submitOrder(updated, rule);
  }

  async submitOrder(order, rule) {
    const response = await this.customerRequest(({ settings, token }) => this.client.createOrder({
      baseUrl: settings.baseUrl,
      token,
      product: order.product,
      quantity: order.requestedQuantity,
      idempotencyKey: order.idempotencyKey,
    }));
    const remote = orderPayload(payloadOf(response));
    const externalOrderId = remote.id || remote.order_id || remote.orderId;
    if (!externalOrderId) throw errorWithStatus('OAuth Supply 下单响应缺少订单 ID');
    const nextPollAt = new Date(this.now() + 3000).toISOString();
    const remoteStatus = String(remote.status || '').toLowerCase();
    const updated = await this.repository.updateOrder(order.id, {
      externalOrderId: String(externalOrderId),
      status: ['ready', 'claimable', 'completed'].includes(remoteStatus) ? 'ready_to_collect' : 'queued',
      quotedAmountCny: centsToCny(remote.estimated_total_fen ?? remote.estimatedTotalFen) ?? order.quotedAmountCny,
      nextPollAt,
      lastError: '',
      failureCount: 0,
    });
    await this.repository.addEvent({
      ruleId: rule.id,
      runId: order.runId,
      orderId: order.id,
      eventType: 'order_created',
      message: `OAuth Supply 订单 ${externalOrderId} 已创建`,
      details: { externalOrderId, remoteStatus: remote.status || '' },
    });
    if (updated.status === 'ready_to_collect') return this.takeOrder(updated, rule);
    return updated;
  }

  async pollOrder(order) {
    const rule = await this.repository.getRule(order.ruleId);
    if (!rule) return;
    const response = await this.customerRequest(({ settings, token }) => this.client.getOrder({
      baseUrl: settings.baseUrl,
      token,
      orderId: order.externalOrderId,
    }));
    const remote = orderPayload(payloadOf(response));
    const remoteStatus = String(remote.status || '').toLowerCase();
    if (['ready', 'claimable'].includes(remoteStatus) || response.status === 200 && accountsPayload(payloadOf(response)).length) {
      await this.repository.updateOrder(order.id, {
        status: 'ready_to_collect',
        nextPollAt: new Date(this.now()).toISOString(),
        deliveredQuantity: numeric(remote.delivered, numeric(remote.delivered_quantity, order.deliveredQuantity)) || order.deliveredQuantity,
        failureCount: 0,
      });
      return this.takeOrder(order, rule);
    }
    const failed = ['failed', 'cancelled', 'expired'].includes(remoteStatus);
    await this.repository.updateOrder(order.id, {
      status: failed ? 'failed' : 'processing',
      nextPollAt: failed ? null : new Date(this.now() + rule.pollIntervalSeconds * 1000).toISOString(),
      lastError: remote.error || '',
      failureCount: 0,
    });
    if (failed) {
      await this.repository.finishRun(order.runId, {
        status: 'failed',
        actualPaidAmountCny: order.actualPaidAmountCny,
        deliveredQuantity: order.deliveredQuantity,
        validQuantity: order.validQuantity,
        failedQuantity: Math.max(0, order.requestedQuantity - order.validQuantity),
        errorMessage: remote.error || `OAuth Supply order ${remoteStatus}`,
      });
    }
  }

  async takeOrder(order, rule) {
    const response = await this.customerRequest(({ settings, token }) => this.client.takeOrder({
      baseUrl: settings.baseUrl,
      token,
      orderId: order.externalOrderId,
    }));
    const payload = payloadOf(response) || {};
    const remote = orderPayload(payload);
    if (response.status === 202 || String(remote.status || '').toLowerCase() !== 'completed' && !accountsPayload(payload).length) {
      await this.repository.updateOrder(order.id, {
        status: 'processing',
        nextPollAt: new Date(this.now() + rule.pollIntervalSeconds * 1000).toISOString(),
      });
      return;
    }
    await this.processDelivery(order, rule, payload);
  }

  async processDelivery(order, rule, payload) {
    const accounts = accountsPayload(payload);
    const remote = orderPayload(payload);
    const remoteItems = orderItemsPayload(payload);
    const actualPaidAmountCny = centsToCny(
      remote.charged_fen ?? remote.chargedFen ?? payload.charged_fen ?? payload.chargedFen,
    ) ?? order.quotedAmountCny;
    const releasedAmountCny = centsToCny(
      remote.released_fen ?? remote.releasedFen
      ?? remote.refunded_fen ?? remote.refundedFen
      ?? payload.released_fen ?? payload.releasedFen
      ?? payload.refunded_fen ?? payload.refundedFen,
    );
    await this.repository.updateOrder(order.id, {
      status: 'importing',
      deliveredQuantity: accounts.length,
      actualPaidAmountCny,
      releasedAmountCny,
      payloadCiphertext: this.vault.available ? this.vault.encrypt({ payload }) : '',
      nextPollAt: null,
      lastError: '',
    });
    const suppliedItems = accounts.map((raw, index) => {
      const remoteItem = matchingOrderItem(raw, index, remoteItems);
      return {
      externalItemId: String(
        remoteItem?.inventory_account_id || remoteItem?.id
        || raw?.id || raw?.account_id || raw?.accountId || index + 1,
      ),
      externalAccountKey: String(
        raw?.email || remoteItem?.email || raw?.account_id || raw?.accountId || '',
      ),
      accountName: accountName(raw, index),
      credentialVersion: String(raw?.credential_version || raw?.credentialVersion || ''),
      individualCostCny: centsToCny(
        remoteItem?.charged_fen ?? remoteItem?.chargedFen ?? raw?.charged_fen ?? raw?.chargedFen,
      ),
      originalPriceCny: centsToCny(
        remoteItem?.base_price_fen ?? remoteItem?.basePriceFen
        ?? raw?.base_price_fen ?? raw?.basePriceFen,
      ),
      credentialCiphertext: this.vault.available ? this.vault.encrypt({ credentials: accountCredential(raw), raw }) : '',
      metadata: {
        email: raw?.email || remoteItem?.email || '',
        remainingSeconds: raw?.remaining_seconds ?? raw?.remainingSeconds
          ?? remoteItem?.remaining_seconds ?? remoteItem?.remainingSeconds ?? null,
        originalPriceCny: centsToCny(
          remoteItem?.base_price_fen ?? remoteItem?.basePriceFen
          ?? raw?.base_price_fen ?? raw?.basePriceFen,
        ),
        supplierChargedCny: centsToCny(
          remoteItem?.charged_fen ?? remoteItem?.chargedFen ?? raw?.charged_fen ?? raw?.chargedFen,
        ),
      },
      };
    });
    const items = await this.repository.addOrderItems(order.id, suppliedItems);
    let validQuantity = 0;
    let failedQuantity = 0;
    for (let index = 0; index < items.length; index += 1) {
      const current = items[index];
      try {
        const raw = accounts[index];
        const remoteItem = matchingOrderItem(raw, index, remoteItems);
        const credentials = accountCredential(raw);
        const expiresAt = accountExpiresAt(raw, remoteItem);
        if (!Object.keys(credentials).length) throw new Error('交付账号凭据为空');
        if (!this.vault.available && !this.config.demoMode) throw new Error('服务端未配置 SUPPLIER_CREDENTIALS_KEY');
        const configuration = {
          groupIds: rule.targetGroupIds,
          concurrency: rule.concurrency,
          loadFactor: rule.loadFactor,
          proxyId: rule.proxyId,
          priority: rule.priority,
          rateMultiplier: rule.rateMultiplier,
          autoPauseOnExpired: rule.autoPauseOnExpired,
          modelId: rule.verificationModel,
          prompt: rule.verificationPrompt,
          modelWhitelist: rule.modelWhitelist,
        };
        const account = current.sub2apiAccountId
          ? await (async () => {
            await this.sub2ApiGateway.applyOAuthCredentials(
              current.sub2apiAccountId,
              credentials,
              rule.modelWhitelist,
            );
            return this.sub2ApiGateway.configureAndVerify({
              accountId: current.sub2apiAccountId,
              ...configuration,
            });
          })()
          : await this.sub2ApiGateway.importAndVerify({
            name: current.accountName,
            platform: rule.platform,
            credentials,
            expiresAt,
            ...configuration,
            onCreated: async (accountId) => {
              await this.repository.updateOrderItem(current.id, {
                status: 'importing',
                sub2apiAccountId: accountId,
              });
            },
        });
        validQuantity += 1;
        await this.repository.updateOrderItem(current.id, {
          status: 'imported',
          verificationStatus: 'passed',
          sub2apiAccountId: account?.id,
          capacityStartedAt: new Date(this.now()).toISOString(),
          metadata: {
            ...metadataWithoutExpiration(current.metadata),
            ...(expiresAt === null ? {} : { expiresAt }),
          },
        });
      } catch (error) {
        failedQuantity += 1;
        const policy = await this.repository.getRecoveryPolicyByRule(rule.id);
        const savedItem = await this.repository.getOrderItem(current.id);
        if (await this.waitForSupplierRecovery({ item: savedItem || current, rule, order, error })) {
          continue;
        }
        const retryEnabled = policy?.enabled !== false && current.credentialCiphertext;
        await this.repository.updateOrderItem(current.id, {
          status: retryEnabled ? 'retry_wait' : 'manual_required',
          verificationStatus: 'failed',
          importAttemptCount: Number(current.importAttemptCount || 0) + 1,
          nextImportRetryAt: retryEnabled
            ? new Date(this.now() + Number(policy?.retryIntervalSeconds || 60) * 1000).toISOString()
            : null,
          errorMessage: String(error?.message || error),
        });
        await this.repository.addEvent({
          ruleId: rule.id,
          runId: order.runId,
          orderId: order.id,
          itemId: current.id,
          eventType: retryEnabled ? 'import_retry_scheduled' : 'import_retry_manual_required',
          message: String(error?.message || error),
        });
      }
    }
    const allocatedCosts = allocateOrderCosts(suppliedItems, actualPaidAmountCny);
    for (let index = 0; index < items.length; index += 1) {
      const current = items[index];
      const cost = allocatedCosts[index];
      await this.repository.updateOrderItem(current.id, {
        finalCostCny: cost,
      });
    }
    const finalStatus = validQuantity === order.requestedQuantity
      ? 'completed'
      : 'import_retry';
    await this.repository.updateOrder(order.id, {
      status: finalStatus,
      deliveredQuantity: accounts.length,
      validQuantity,
      actualPaidAmountCny,
      lastError: failedQuantity ? `${failedQuantity} 个账号导入或验号失败` : '',
    });
    await this.repository.finishRun(order.runId, {
      status: finalStatus,
      actualPaidAmountCny,
      deliveredQuantity: accounts.length,
      validQuantity,
      failedQuantity,
      errorMessage: failedQuantity ? `${failedQuantity} 个账号导入或验号失败` : '',
    });
    await this.repository.addEvent({
      ruleId: rule.id,
      runId: order.runId,
      orderId: order.id,
      eventType: 'delivery_processed',
      message: `已导入 ${validQuantity}/${accounts.length} 个账号`,
      details: { validQuantity, failedQuantity, actualPaidAmountCny, allocatedCosts },
    });
    await this.reconcileCostLedgers();
  }

  async reconcileCostLedgers() {
    if (!this.ledgerRepository?.createAccountCostPeriod || this.config.demoMode) return;
    for (const item of await this.repository.listPendingCostItems({ limit: 50 })) {
      try {
        if (item.finalCostCny === null || item.finalCostCny === undefined) continue;
        if (Number(item.persistedFinalCostCny) !== Number(item.finalCostCny)) {
          await this.repository.updateOrderItem(item.id, { finalCostCny: item.finalCostCny });
        }
        const purchaseBatch = `oauth-supply:${item.order?.externalOrderId || item.orderId}`;
        const existing = await this.ledgerRepository.listAccountCostPeriods({
          accountId: item.sub2apiAccountId,
          page: 1,
          pageSize: 100,
          offset: 0,
        });
        const recorded = existing?.items?.find((period) => period.purchaseBatch === purchaseBatch);
        if (recorded) {
          await this.repository.updateOrderItem(item.id, {
            costLedgerStatus: 'recorded',
            costLedgerPeriodId: recorded.id,
            costLedgerError: '',
          });
          continue;
        }
        const effectiveFrom = new Date(item.order?.createdAt || this.now());
        const remainingSeconds = numeric(item.metadata?.remainingSeconds);
        const productDays = numeric(String(item.order?.product || '').match(/(\d+)d/i)?.[1], 30);
        const coverageMs = remainingSeconds !== null && remainingSeconds > 0
          ? remainingSeconds * 1000
          : productDays * 86_400_000;
        const effectiveTo = new Date(effectiveFrom.getTime() + Math.max(1000, coverageMs));
        const period = await this.ledgerRepository.createAccountCostPeriod({
          accountId: item.sub2apiAccountId,
          costProfileId: null,
          originalAmount: item.finalCostCny,
          originalCurrency: 'CNY',
          fxRate: 1,
          baseAmount: item.finalCostCny,
          feeAmount: 0,
          taxAmount: 0,
          effectiveFrom: effectiveFrom.toISOString(),
          effectiveTo: effectiveTo.toISOString(),
          supplier: 'OAuth Supply',
          purchaseBatch,
          tags: ['oauth-supply', item.order?.product || 'oauth'],
          allocationStrategy: 'equal',
          notes: `自动补号订单 ${item.order?.externalOrderId || item.orderId}，账号 ${item.accountName}`,
        }, 'replenishment');
        await this.repository.updateOrderItem(item.id, {
          costLedgerStatus: 'recorded',
          costLedgerPeriodId: period?.id,
          costLedgerError: '',
        });
      } catch (error) {
        const message = String(error?.message || error);
        await this.repository.updateOrderItem(item.id, {
          costLedgerStatus: error?.statusCode === 404 ? 'pending' : 'failed',
          costLedgerError: message,
        });
      }
    }
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const order of await this.repository.listPollableOrders()) {
        try {
          if (order.status === 'ordering' && !order.externalOrderId) {
            const rule = await this.repository.getRule(order.ruleId);
            if (rule) await this.submitOrder(order, rule);
          } else if (ACTIVE_STATUSES.has(order.status) && order.externalOrderId) {
            await this.pollOrder(order);
          }
        } catch (error) {
          const rule = await this.repository.getRule(order.ruleId);
          const failureCount = Number(order.failureCount || 0) + 1;
          const exhausted = failureCount > Number(rule?.retryLimit ?? 3);
          await this.repository.updateOrder(order.id, {
            status: exhausted ? 'failed' : order.externalOrderId ? 'processing' : 'ordering',
            failureCount,
            nextPollAt: exhausted ? null : new Date(this.now() + 10_000).toISOString(),
            lastError: String(error?.message || error),
          });
          if (exhausted) {
            await this.repository.finishRun(order.runId, {
              status: 'failed',
              actualPaidAmountCny: order.actualPaidAmountCny,
              deliveredQuantity: order.deliveredQuantity,
              validQuantity: order.validQuantity,
              failedQuantity: Math.max(0, order.requestedQuantity - order.validQuantity),
              errorMessage: String(error?.message || error),
            });
          }
        }
      }
      await this.reconcileCostLedgers();
      await this.syncSupplierRecoveries().catch((error) => {
        this.logger.warn('[replenishment] recovery sync failed', error?.message || error);
      });
      for (const recovery of await this.repository.listDueRecoveries({ limit: 30 })) {
        if (!recovery.recoveryEnabled || recovery.mode !== 'auto') continue;
        await this.claimRecovery(recovery.id).catch((error) => {
          this.logger.warn('[replenishment] recovery processing failed', error?.message || error);
        });
      }
      for (const policy of await this.repository.listRecoveryPolicies()) {
        if (!policy.enabled || policy.mode !== 'auto'
          || !intervalElapsed(policy.lastScannedAt, policy.retryIntervalSeconds, this.now())) continue;
        await this.repository.markRecoveryPolicyScanned(policy.ruleId, new Date(this.now()).toISOString());
        for (const item of (await this.repository.listImportRetryItems({ limit: 30 }))
          .filter((entry) => Number(entry.order?.ruleId) === Number(policy.ruleId))) {
          await this.retryImportItem(item.id).catch((error) => {
            this.logger.warn('[replenishment] import retry failed', error?.message || error);
          });
        }
      }
      for (const rule of await this.repository.listRules({ enabledOnly: true })) {
        const nowMs = this.now();
        const scheduleIntervalSeconds = (rule.triggerStrategy || 'inventory_threshold') === 'smart_forecast'
          ? Math.max(300, Number(rule.lastForecastSnapshot?.nextCheckSeconds || 600))
          : Number(rule.scheduleIntervalSeconds || 300);
        if (!insideSchedule(rule, nowMs, this.config.timezone)
          || !intervalElapsed(rule.lastScheduledAt, scheduleIntervalSeconds, nowMs)) continue;
        const intervalMs = Math.max(1, scheduleIntervalSeconds) * 1000;
        const scheduledFor = new Date(Math.floor(nowMs / intervalMs) * intervalMs).toISOString();
        await this.repository.markRuleScheduled(rule.id, new Date(nowMs).toISOString());
        try {
          await this.createOrderForRule(rule, { scheduledFor });
        } catch (error) {
          if ((rule.triggerStrategy || 'inventory_threshold') === 'fixed_schedule') {
            await this.repository.markRuleError(rule.id, String(error?.message || error));
          } else {
            await this.repository.markRuleInventory(rule.id, { error: String(error?.message || error) });
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}
