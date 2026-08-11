import { SupplierCredentialVault } from './supplier-credentials.mjs';

const ACTIVE_STATUSES = new Set(['ordering', 'queued', 'processing', 'ready_to_collect', 'importing']);

function errorWithStatus(message, statusCode = 502) {
  return Object.assign(new Error(message), { statusCode });
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

function accountExpiresAt(raw, orderItem, nowMs) {
  const direct = numeric(raw?.expires_at ?? raw?.expiresAt ?? orderItem?.expires_at ?? orderItem?.expiresAt);
  if (direct !== null) return Math.floor(direct > 10_000_000_000 ? direct / 1000 : direct);
  const remaining = numeric(
    raw?.remaining_seconds ?? raw?.remainingSeconds
    ?? orderItem?.remaining_seconds ?? orderItem?.remainingSeconds,
  );
  return remaining === null ? null : Math.floor(nowMs / 1000 + Math.max(0, remaining));
}

const OPEN_RECOVERY_STATUSES = new Set([
  'detected', 'waiting_supplier', 'claimable', 'credentials_saved',
  'updating_sub2api', 'verifying', 'retry_wait', 'manual_required',
]);

function textIncludesAuthFailure(...values) {
  return values.some((value) => /(?:^|\D)401(?:\D|$)|unauth|invalid[_ -]?token|token.*expired|needs[_ -]?reauth/i.test(String(value || '')));
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

function retryDelayMs(attempt) {
  return Math.min(15 * 60_000, 15_000 * (2 ** Math.max(0, attempt - 1)));
}

function inventoryEventSummary(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const { accounts: _accounts, ...summary } = snapshot;
  return summary;
}

export class ReplenishmentService {
  constructor(repository, oauthSupplyAuthService, sub2ApiGateway, config, logger = console, {
    client,
    ledgerRepository = null,
    now = () => Date.now(),
  } = {}) {
    this.repository = repository;
    this.oauthSupplyAuthService = oauthSupplyAuthService;
    this.sub2ApiGateway = sub2ApiGateway;
    this.config = config;
    this.logger = logger;
    this.client = client;
    this.ledgerRepository = ledgerRepository;
    this.now = now;
    this.vault = new SupplierCredentialVault(config.supplierCredentialsKey);
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer || this.config.demoMode) return;
    const intervalMs = Math.max(10_000, Number(this.config.replenishmentTickSeconds || 30) * 1000);
    this.timer = setInterval(() => this.tick().catch((error) => {
      this.logger.warn('[replenishment] tick failed', error?.message || error);
    }), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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

  async recoveries() {
    await this.syncSupplierRecoveries().catch((error) => {
      this.logger.warn('[replenishment] recovery sync failed', error?.message || error);
    });
    const entries = await this.repository.listRecoveries({ limit: 100 });
    return {
      items: entries.map((entry) => ({
        id: entry.id,
        accountName: entry.accountName || entry.accountKey,
        deliveryStatus: entry.deliveryStatus,
        status: entry.status,
        ready: ['claimable', 'credentials_saved', 'retry_wait', 'manual_required'].includes(entry.status),
        credentialVersion: entry.credentialVersion,
        attemptCount: entry.attemptCount,
        nextRetryAt: entry.nextRetryAt,
        lastError: entry.lastError,
        firstSeenAt: entry.firstSeenAt,
        recoveredAt: entry.recoveredAt,
        targetAccountId: entry.sub2apiAccountId,
      })),
    };
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
    const activeByItem = new Map(existing.filter((entry) => OPEN_RECOVERY_STATUSES.has(entry.status))
      .map((entry) => [entry.orderItemId, entry]));
    let beforeId = 0;
    for (let page = 0; page < 10; page += 1) {
      const payload = await this.rawRecoveries({ beforeId });
      const entries = Array.isArray(payload) ? payload : payload.items || payload.recoveries || [];
      for (const entry of entries) {
        const accountKey = entry.email || entry.account_email || entry.account_id || entry.accountId;
        const matchingItem = await this.repository.findOrderItemByAccountKey(accountKey);
        if (!matchingItem?.sub2apiAccountId) continue;
        const order = await this.repository.getOrder(matchingItem.orderId);
        const current = activeByItem.get(matchingItem.id);
        const claimUrl = entry.claim_url || entry.claimUrl || '';
        const ready = Boolean(entry.ready || entry.delivery_status === 'claimable' || claimUrl);
        const recoveryKey = current?.recoveryKey
          || `item:${matchingItem.id}:credential:${matchingItem.credentialVersion || 'initial'}`;
        const status = current && ['credentials_saved', 'retry_wait', 'manual_required'].includes(current.status)
          ? current.status
          : ready ? 'claimable' : 'waiting_supplier';
        const saved = await this.repository.upsertRecovery({
          ...(current || {}),
          recoveryKey,
          supplierRecoveryId: entry.id || entry.recovery_id,
          orderItemId: matchingItem.id,
          ruleId: order?.ruleId,
          sub2apiAccountId: matchingItem.sub2apiAccountId,
          accountKey,
          status,
          deliveryStatus: entry.delivery_status || entry.status || '',
          credentialVersion: entry.credential_version || entry.credentialVersion || current?.credentialVersion || '',
          claimUrlCiphertext: claimUrl && this.vault.available
            ? this.vault.encrypt({ claimUrl })
            : current?.claimUrlCiphertext || '',
        });
        activeByItem.set(matchingItem.id, saved);
      }
      const next = numeric(payload.next_before_id ?? payload.nextBeforeId, 0);
      if (!entries.length || !next || next === beforeId) break;
      beforeId = next;
    }
  }

  async claimRecovery(recoveryId) {
    let job = await this.repository.getRecovery(recoveryId);
    if (!job) throw errorWithStatus('修复任务不存在', 404);
    if (job.status === 'recovered') return { ok: true, recoveryId: job.id, targetAccountId: job.sub2apiAccountId };
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
        credentials = claimedPayload.credentials || claimedPayload.payload?.credentials || claimedPayload.payload;
        if (!credentials || typeof credentials !== 'object') throw errorWithStatus('供应商修复响应缺少账号凭据');
        credentialVersion = claimedPayload.credential_version || claimedPayload.credentialVersion || credentialVersion;
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
      await this.sub2ApiGateway.applyOAuthCredentials(job.sub2apiAccountId, credentials);
      job = await this.repository.upsertRecovery({ ...job, status: 'verifying', lastError: '' });
      await this.sub2ApiGateway.testAccount(job.sub2apiAccountId, {
        modelId: job.verificationModel || 'gpt-5.6-luna',
        prompt: job.verificationPrompt || 'Reply with a short success marker.',
      });
      const encryptedCredentials = this.vault.encrypt({ credentials });
      await this.repository.updateOrderItem(job.orderItemId, {
        status: 'imported',
        verificationStatus: 'repaired',
        healthStatus: 'healthy',
        credentialVersion,
        credentialCiphertext: encryptedCredentials,
        errorMessage: '',
        lastHealthAt: new Date(this.now()).toISOString(),
      });
      job = await this.repository.upsertRecovery({
        ...job,
        status: 'recovered',
        credentialVersion,
        credentialCiphertext: encryptedCredentials,
        nextRetryAt: null,
        lastError: '',
        recoveredAt: new Date(this.now()).toISOString(),
      });
      await this.repository.addEvent({
        ruleId: job.ruleId,
        orderId: (await this.repository.getOrderItem(job.orderItemId))?.orderId || null,
        itemId: job.orderItemId,
        eventType: 'recovery_verified',
        message: `账号 ${job.accountName || job.accountKey} 已认领、更新并验号通过`,
        details: { recoveryId: job.id, targetAccountId: job.sub2apiAccountId, credentialVersion },
      });
      return {
        ok: true,
        recoveryId: job.id,
        credentialVersion,
        targetAccountId: job.sub2apiAccountId,
        imported: true,
      };
    } catch (error) {
      const attempts = Number(job.attemptCount || 0) + 1;
      const retryLimit = job.recoveryRetryLimit === null || job.recoveryRetryLimit === undefined
        ? null : Number(job.recoveryRetryLimit);
      const exhausted = retryLimit !== null && attempts > retryLimit;
      await this.repository.upsertRecovery({
        ...job,
        status: exhausted ? 'manual_required' : 'retry_wait',
        attemptCount: attempts,
        nextRetryAt: exhausted ? null : new Date(this.now() + retryDelayMs(attempts)).toISOString(),
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

  async inspectRuleInventory(rule) {
    const items = await this.repository.listTrackedItems(rule.id);
    const recoveries = await this.repository.listRecoveries({ limit: 500 });
    const openByItem = new Map(recoveries.filter((entry) => OPEN_RECOVERY_STATUSES.has(entry.status))
      .map((entry) => [entry.orderItemId, entry]));
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
        [account, usage] = await Promise.all([
          this.sub2ApiGateway.getAccount(tracked.sub2apiAccountId),
          this.sub2ApiGateway.getAccountUsage(tracked.sub2apiAccountId, { source: 'passive' }).catch(() => null),
        ]);
      } catch (error) {
        readError = String(error?.message || error);
      }
      const expiresAt = numeric(account?.expires_at ?? account?.expiresAt ?? tracked.metadata?.expiresAt);
      const expired = expiresAt !== null && expiresAt * 1000 <= this.now();
      const authFailed = textIncludesAuthFailure(
        readError,
        account?.error_message,
        account?.errorMessage,
        usage?.error,
        usage?.error_code,
      ) || Boolean(usage?.needs_reauth);
      let recoveryJob = openByItem.get(tracked.id);
      if (authFailed && !recoveryJob) {
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
      const accountGroups = (account?.group_ids || account?.groups || [])
        .map((entry) => Number(entry?.id ?? entry));
      const groupMatched = rule.targetGroupIds.every((id) => accountGroups.includes(Number(id)));
      const healthyStatus = !readError
        && String(account?.status || '').toLowerCase() === 'active'
        && String(account?.platform || rule.platform) === rule.platform
        && groupMatched
        && account?.schedulable !== false
        && !expired
        && !authFailed
        && !repairing;
      const quota = quotaSnapshot(account, usage);
      const selected = selectedQuota(quota, rule.quotaWindow);
      const quotaUnknown = selected.value === null;
      const lowQuota = selected.value !== null && selected.value >= rule.quotaUsedThresholdPercent;
      const unknownCountsLow = quotaUnknown && rule.quotaUnknownPolicy === 'low';
      const effective = healthyStatus && !lowQuota && !unknownCountsLow;
      if (effective) effectiveAccounts += 1;
      if (lowQuota) lowQuotaAccounts += 1;
      if (quotaUnknown) unknownQuotaAccounts += 1;
      if (!healthyStatus && !repairing) unavailableAccounts += 1;
      if (repairing) {
        repairingAccounts += 1;
        const ageMs = this.now() - Date.parse(recoveryJob.firstSeenAt || new Date(this.now()).toISOString());
        if (ageMs < rule.repairGraceSeconds * 1000) graceRepairingAccounts += 1;
      }
      const healthStatus = repairing ? 'repairing'
        : !healthyStatus ? 'unavailable'
          : lowQuota || unknownCountsLow ? 'low_quota'
            : quotaUnknown ? 'quota_unknown' : 'healthy';
      await this.repository.updateOrderItem(tracked.id, {
        healthStatus,
        quotaUsedPercent: selected.value,
        quotaWindow: selected.window,
        lastHealthAt: new Date(this.now()).toISOString(),
        errorMessage: authFailed ? 'Sub2API account requires reauthentication' : tracked.errorMessage,
      });
      accounts.push({
        orderItemId: tracked.id,
        sub2apiAccountId: tracked.sub2apiAccountId,
        accountName: tracked.accountName,
        healthStatus,
        quotaUsedPercent: selected.value,
        quotaWindow: selected.window,
        status: account?.status || '',
        schedulable: account?.schedulable !== false,
        expiresAt,
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

  async createOrderForRule(rule, { trigger = 'scheduled', actor = 'system', force = false } = {}) {
    if (!rule?.enabled && !force) return { status: 'disabled' };
    const recordDecision = async (eventType, message, details = {}) => this.repository.addEvent({
      ruleId: rule?.id || null,
      eventType,
      message,
      details: {
        trigger,
        ...details,
        ...(details.inventory ? { inventory: inventoryEventSummary(details.inventory) } : {}),
      },
      actor,
    });
    try {
      if (!rule.product || !rule.platform || !rule.targetPoolKey) {
        throw errorWithStatus('补号策略缺少商品映射', 400);
      }
      const snapshot = await this.inspectRuleInventory(rule);
      if (!force && snapshot.effectiveAccounts > rule.minAvailableAccounts) {
        await recordDecision('inventory_healthy', `库存检查完成：有效 ${snapshot.effectiveAccounts}，无需补号`, { inventory: snapshot });
        return { status: 'healthy', available: snapshot.effectiveAccounts, inventory: snapshot };
      }
      if (await this.repository.hasActiveOrder(rule.id)) {
        await recordDecision('order_skipped', '已有进行中的补号订单，本轮不重复下单', { reason: 'already_active', inventory: snapshot });
        return { status: 'already_active', inventory: snapshot };
      }
      if (!force && snapshot.effectiveAccounts > 0
        && snapshot.effectiveAccounts + snapshot.graceRepairingAccounts > rule.minAvailableAccounts) {
        await recordDecision('order_skipped', '账号仍在修复等待期，本轮暂不补号', { reason: 'repair_grace', inventory: snapshot });
        return { status: 'repair_grace', inventory: snapshot };
      }
      if (!force && rule.lastTriggeredAt && this.now() - Date.parse(rule.lastTriggeredAt) < rule.cooldownSeconds * 1000) {
        await recordDecision('order_skipped', '策略处于下单冷却期，本轮暂不补号', { reason: 'cooldown', inventory: snapshot });
        return { status: 'cooldown', inventory: snapshot };
      }
      const desired = Math.max(0,
        Number(rule.targetAvailableAccounts) - snapshot.effectiveAccounts - snapshot.pendingAccounts);
      if (!desired) {
        await recordDecision('inventory_healthy', `库存检查完成：有效 ${snapshot.effectiveAccounts}、在途 ${snapshot.pendingAccounts}，无需补号`, { inventory: snapshot });
        return { status: 'healthy', available: snapshot.effectiveAccounts, inventory: snapshot };
      }
      let quantity = Math.max(1, Math.min(desired, rule.replenishQuantity, 1000));
      let inventoryResponse = await this.inventory(rule.product, quantity);
      let inventory = payloadOf(inventoryResponse) || {};
      const supplierAvailable = numeric(inventory.available, numeric(inventory.available_count, 0)) || 0;
      if (supplierAvailable <= 0) {
        await this.repository.saveInventorySnapshot(rule.id, snapshot, { error: '供应商当前无可售账号' });
        await recordDecision('rule_blocked', '供应商当前无可售账号，本轮无法补号', { reason: 'supplier_inventory', supplierAvailable, inventory: snapshot });
        return { status: 'blocked_supplier_inventory', supplierAvailable, inventory: snapshot };
      }
      if (supplierAvailable < quantity) {
        quantity = supplierAvailable;
        inventoryResponse = await this.inventory(rule.product, quantity);
        inventory = payloadOf(inventoryResponse) || {};
      }
      const quotedCny = centsToCny(inventory.estimated_total_fen ?? inventory.estimatedTotalFen);
      if ((rule.maxOrderAmountCny !== null || rule.maxDailyAmountCny !== null) && quotedCny === null) {
        await this.repository.markRuleInventory(rule.id, { error: '供应商未返回报价，成本上限开启时禁止下单' });
        await recordDecision('rule_blocked', '供应商未返回报价，成本保护已阻止下单', { reason: 'cost_unknown', inventory: snapshot });
        return { status: 'blocked_cost_unknown' };
      }
      if (rule.maxOrderAmountCny !== null && quotedCny !== null && quotedCny > rule.maxOrderAmountCny) {
        await this.repository.markRuleInventory(rule.id, { error: `报价 ${quotedCny} CNY 超过单次上限` });
        await recordDecision('rule_blocked', `报价 ${quotedCny} CNY 超过单次成本上限`, { reason: 'order_cost', quotedCny, inventory: snapshot });
        return { status: 'blocked_cost', quotedCny };
      }
      const dailySpend = await this.repository.dailySpend(rule.id);
      if (rule.maxDailyAmountCny !== null && quotedCny !== null && dailySpend + quotedCny > rule.maxDailyAmountCny) {
        await this.repository.markRuleInventory(rule.id, { error: `今日累计报价将超过 ${rule.maxDailyAmountCny} CNY` });
        await recordDecision('rule_blocked', `今日累计报价将超过 ${rule.maxDailyAmountCny} CNY`, { reason: 'daily_cost', dailySpend, quotedCny, inventory: snapshot });
        return { status: 'blocked_daily_cost', dailySpend, quotedCny };
      }
      if (rule.mode === 'observe') {
        await this.repository.saveInventorySnapshot(rule.id, snapshot, {
          error: `有效库存 ${snapshot.effectiveAccounts}，已达到补号阈值 ${rule.minAvailableAccounts}`,
        });
        await recordDecision('observed_replenishment', `观察模式：建议购买 ${quantity} 个账号，未创建订单`, { available: snapshot.effectiveAccounts, quotedCny, quantity, inventory: snapshot });
        return { status: 'observed_need', available: snapshot.effectiveAccounts, quotedCny, quantity, inventory: snapshot };
      }
      const balance = await this.balance().catch(() => null);
      const availableBalanceCny = centsToCny(balance?.available_fen ?? balance?.availableFen);
      if (quotedCny !== null && availableBalanceCny !== null && quotedCny > availableBalanceCny) {
        await this.repository.markRuleInventory(rule.id, { error: 'OAuth Supply 可用余额不足' });
        await recordDecision('rule_blocked', 'OAuth Supply 可用余额不足，本轮无法下单', { reason: 'balance', quotedCny, availableBalanceCny, inventory: snapshot });
        return { status: 'blocked_balance', quotedCny, availableBalanceCny };
      }
      const idempotencyKey = `finops-replenishment-${rule.id}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const planned = await this.repository.createPlannedOrder({
        rule,
        trigger,
        quantity,
        availableBefore: snapshot.effectiveAccounts,
        quotedAmountCny: quotedCny,
        actor,
        status: rule.mode === 'approval' ? 'approval_required' : 'ordering',
        idempotencyKey,
      });
      await this.repository.addEvent({
        ruleId: rule.id,
        runId: planned.runId,
        orderId: planned.id,
        eventType: rule.mode === 'approval' ? 'approval_required' : 'order_planned',
        message: rule.mode === 'approval' ? '订单等待审批' : '订单开始创建',
        details: {
          available: snapshot.effectiveAccounts,
          quantity,
          quotedCny,
          trigger,
          inventory: inventoryEventSummary(snapshot),
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
    await this.repository.updateOrder(order.id, {
      status: 'importing',
      deliveredQuantity: accounts.length,
      actualPaidAmountCny,
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
      credentialCiphertext: this.vault.available ? this.vault.encrypt({ credentials: accountCredential(raw), raw }) : '',
      metadata: {
        email: raw?.email || remoteItem?.email || '',
        remainingSeconds: raw?.remaining_seconds ?? raw?.remainingSeconds
          ?? remoteItem?.remaining_seconds ?? remoteItem?.remainingSeconds ?? null,
      },
      };
    });
    const items = await this.repository.addOrderItems(order.id, suppliedItems);
    let validQuantity = 0;
    let failedQuantity = 0;
    const passedItemIds = new Set();
    for (let index = 0; index < items.length; index += 1) {
      const current = items[index];
      try {
        const raw = accounts[index];
        const remoteItem = matchingOrderItem(raw, index, remoteItems);
        const credentials = accountCredential(raw);
        if (!Object.keys(credentials).length) throw new Error('交付账号凭据为空');
        if (!this.vault.available && !this.config.demoMode) throw new Error('服务端未配置 SUPPLIER_CREDENTIALS_KEY');
        const configuration = {
          groupIds: rule.targetGroupIds,
          concurrency: rule.concurrency,
          priority: rule.priority,
          modelId: rule.verificationModel,
          prompt: rule.verificationPrompt,
        };
        const account = current.sub2apiAccountId
          ? await this.sub2ApiGateway.configureAndVerify({
            accountId: current.sub2apiAccountId,
            ...configuration,
          })
          : await this.sub2ApiGateway.importAndVerify({
            name: current.accountName,
            platform: rule.platform,
            credentials,
            expiresAt: accountExpiresAt(raw, remoteItem, this.now()),
            ...configuration,
            onCreated: async (accountId) => {
              await this.repository.updateOrderItem(current.id, {
                status: 'importing',
                sub2apiAccountId: accountId,
              });
            },
          });
        validQuantity += 1;
        passedItemIds.add(current.id);
        await this.repository.updateOrderItem(current.id, {
          status: 'imported',
          verificationStatus: 'passed',
          sub2apiAccountId: account?.id,
          metadata: {
            ...current.metadata,
            expiresAt: accountExpiresAt(raw, remoteItem, this.now()),
          },
        });
      } catch (error) {
        failedQuantity += 1;
        await this.repository.updateOrderItem(current.id, {
          status: 'failed',
          verificationStatus: 'failed',
          errorMessage: String(error?.message || error),
        });
        await this.repository.addEvent({
          ruleId: rule.id,
          runId: order.runId,
          orderId: order.id,
          itemId: current.id,
          eventType: 'import_failed',
          message: String(error?.message || error),
        });
      }
    }
    const perAccountCost = suppliedItems.every((entry) => entry.individualCostCny !== null)
      ? null
      : validQuantity > 0 && actualPaidAmountCny !== null
        ? Number(actualPaidAmountCny) / validQuantity
        : null;
    for (const current of items) {
      const cost = current.individualCostCny
        ?? (passedItemIds.has(current.id) ? perAccountCost : null);
      await this.repository.updateOrderItem(current.id, {
        finalCostCny: cost,
      });
    }
    const finalStatus = validQuantity === order.requestedQuantity
      ? 'completed'
      : validQuantity > 0 ? 'partial_failed' : 'failed';
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
      details: { validQuantity, failedQuantity, actualPaidAmountCny, perAccountCost },
    });
    await this.reconcileCostLedgers();
  }

  async reconcileCostLedgers() {
    if (!this.ledgerRepository?.createAccountCostPeriod || this.config.demoMode) return;
    for (const item of await this.repository.listPendingCostItems({ limit: 50 })) {
      try {
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
        const expiresAtSeconds = numeric(item.metadata?.expiresAt);
        const productDays = numeric(String(item.order?.product || '').match(/(\d+)d/i)?.[1], 30);
        const effectiveTo = expiresAtSeconds
          ? new Date(expiresAtSeconds * 1000)
          : new Date(effectiveFrom.getTime() + productDays * 86_400_000);
        if (effectiveTo <= effectiveFrom) effectiveTo.setTime(effectiveFrom.getTime() + 86_400_000);
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
        if (recovery.mode !== 'auto') continue;
        await this.claimRecovery(recovery.id).catch((error) => {
          this.logger.warn('[replenishment] recovery processing failed', error?.message || error);
        });
      }
      for (const rule of await this.repository.listRules({ enabledOnly: true })) {
        try {
          await this.createOrderForRule(rule);
        } catch (error) {
          await this.repository.markRuleInventory(rule.id, { error: String(error?.message || error) });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
