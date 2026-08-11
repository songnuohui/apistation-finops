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
    const payload = await this.rawRecoveries();
    const entries = Array.isArray(payload) ? payload : payload.items || payload.recoveries || [];
    return {
      items: entries.map((entry) => ({
        id: entry.id || entry.recovery_id,
        accountName: entry.email || entry.account_email || entry.account_id || '',
        deliveryStatus: entry.delivery_status || entry.status || '',
        ready: Boolean(entry.ready || entry.delivery_status === 'claimable'),
        credentialVersion: entry.credential_version || entry.credentialVersion || '',
        retryAfterSeconds: numeric(entry.retry_after_seconds, null),
        targetAccountId: numeric(entry.sub2api_account_id || entry.target_account_id, null),
      })),
      nextBeforeId: payload.next_before_id || null,
    };
  }

  async rawRecoveries() {
    const response = await this.customerRequest(({ settings, token }) => this.client.recoveries({
      baseUrl: settings.baseUrl,
      token,
      limit: 100,
    }));
    return payloadOf(response) || {};
  }

  async claimRecovery(recoveryId) {
    const payload = await this.rawRecoveries();
    const entries = Array.isArray(payload) ? payload : payload.items || payload.recoveries || [];
    const entry = entries.find((candidate) => String(candidate.id || candidate.recovery_id) === String(recoveryId));
    if (!entry) throw errorWithStatus('修复记录不存在或已经翻页', 404);
    const claimUrl = entry.claim_url || entry.claimUrl;
    if (!claimUrl) throw errorWithStatus('修复文件尚未准备好认领', 409);
    const claimed = await this.customerRequest(({ settings, token }) => this.client.claimRecovery({
      baseUrl: settings.baseUrl,
      token,
      claimUrl,
    }));
    const claimedPayload = payloadOf(claimed) || {};
    const matchingItem = await this.repository.findOrderItemByAccountKey(
      entry.email || entry.account_email || entry.account_id || entry.accountId,
    );
    const targetAccountId = numeric(
      entry.sub2api_account_id || entry.target_account_id || matchingItem?.sub2apiAccountId,
      null,
    );
    const credentials = claimedPayload.credentials || claimedPayload.payload?.credentials || claimedPayload.payload;
    if (targetAccountId && credentials && typeof credentials === 'object') {
      await this.sub2ApiGateway.applyOAuthCredentials(targetAccountId, credentials);
    }
    if (matchingItem) {
      await this.repository.updateOrderItem(matchingItem.id, {
        verificationStatus: 'repaired',
        credentialVersion: claimedPayload.credential_version || claimedPayload.credentialVersion || '',
      });
      await this.repository.addEvent({
        orderId: matchingItem.orderId,
        itemId: matchingItem.id,
        eventType: 'recovery_claimed',
        message: `修复账号 ${matchingItem.accountName} 已认领并更新`,
        details: { recoveryId, targetAccountId },
      });
    }
    return {
      ok: true,
      recoveryId,
      credentialVersion: claimedPayload.credential_version || claimedPayload.credentialVersion || '',
      targetAccountId,
      imported: Boolean(targetAccountId && credentials),
    };
  }

  async createOrderForRule(rule, { trigger = 'scheduled', actor = 'system', force = false } = {}) {
    if (!rule?.enabled && !force) return { status: 'disabled' };
    if (!rule.product || !rule.platform || !rule.targetPoolKey) {
      throw errorWithStatus('补号策略缺少商品映射', 400);
    }
    if (await this.repository.hasActiveOrder(rule.id)) return { status: 'already_active' };
    if (!force && rule.lastTriggeredAt && this.now() - Date.parse(rule.lastTriggeredAt) < rule.cooldownSeconds * 1000) {
      return { status: 'cooldown' };
    }
    const inventoryResponse = await this.inventory(rule.product, rule.replenishQuantity);
    const inventory = payloadOf(inventoryResponse) || {};
    const available = numeric(inventory.available, numeric(inventory.available_count, 0)) || 0;
    await this.repository.markRuleInventory(rule.id);
    if (!force && available >= rule.minAvailableAccounts) {
      return { status: 'healthy', available };
    }
    const quantity = Math.max(1, Math.min(rule.replenishQuantity, 1000));
    const quotedCny = centsToCny(inventory.estimated_total_fen ?? inventory.estimatedTotalFen);
    if ((rule.maxOrderAmountCny !== null || rule.maxDailyAmountCny !== null) && quotedCny === null) {
      await this.repository.markRuleInventory(rule.id, { error: '供应商未返回报价，成本上限开启时禁止下单' });
      return { status: 'blocked_cost_unknown' };
    }
    if (rule.maxOrderAmountCny !== null && quotedCny !== null && quotedCny > rule.maxOrderAmountCny) {
      await this.repository.markRuleInventory(rule.id, { error: `报价 ${quotedCny} CNY 超过单次上限` });
      return { status: 'blocked_cost', quotedCny };
    }
    const dailySpend = await this.repository.dailySpend(rule.id);
    if (rule.maxDailyAmountCny !== null && quotedCny !== null && dailySpend + quotedCny > rule.maxDailyAmountCny) {
      await this.repository.markRuleInventory(rule.id, { error: `今日累计报价将超过 ${rule.maxDailyAmountCny} CNY` });
      return { status: 'blocked_daily_cost', dailySpend, quotedCny };
    }
    if (rule.mode === 'observe') {
      await this.repository.markRuleInventory(rule.id, {
        error: `观察到库存 ${available}，低于阈值 ${rule.minAvailableAccounts}`,
      });
      return { status: 'observed_need', available, quotedCny };
    }
    const balance = await this.balance().catch(() => null);
    const availableBalanceCny = centsToCny(balance?.available_fen ?? balance?.availableFen);
    if (quotedCny !== null && availableBalanceCny !== null && quotedCny > availableBalanceCny) {
      await this.repository.markRuleInventory(rule.id, { error: 'OAuth Supply 可用余额不足' });
      return { status: 'blocked_balance', quotedCny, availableBalanceCny };
    }
    const idempotencyKey = `finops-replenishment-${rule.id}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const planned = await this.repository.createPlannedOrder({
      rule,
      trigger,
      quantity,
      availableBefore: available,
      quotedAmountCny: quotedCny,
      actor,
      status: rule.mode === 'approval' ? 'approval_required' : 'ordering',
      idempotencyKey,
    });
    await this.repository.addEvent({
      runId: planned.runId,
      orderId: planned.id,
      eventType: rule.mode === 'approval' ? 'approval_required' : 'order_planned',
      message: rule.mode === 'approval' ? '订单等待审批' : '订单开始创建',
      details: { available, quantity, quotedCny, trigger },
      actor,
    });
    if (rule.mode === 'approval') return planned;
    return this.submitOrder(planned, rule);
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
      const recoveryPayload = await this.rawRecoveries().catch(() => null);
      const recoveryEntries = recoveryPayload
        ? (Array.isArray(recoveryPayload) ? recoveryPayload : recoveryPayload.items || recoveryPayload.recoveries || [])
        : [];
      for (const entry of recoveryEntries) {
        if (entry.delivery_status !== 'claimable' && !entry.ready) continue;
        const matchingItem = await this.repository.findOrderItemByAccountKey(
          entry.email || entry.account_email || entry.account_id || entry.accountId,
        );
        if (!matchingItem) continue;
        const recoveryOrder = await this.repository.getOrder(matchingItem.orderId);
        const recoveryRule = await this.repository.getRule(recoveryOrder?.ruleId);
        if (recoveryRule?.mode === 'auto') {
          await this.claimRecovery(entry.id || entry.recovery_id).catch((error) => {
            this.logger.warn('[replenishment] recovery claim failed', error?.message || error);
          });
        }
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
