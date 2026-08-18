function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function notFound(message) {
  return Object.assign(new Error(message), { statusCode: 404 });
}

function conflict(message) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

function compareListValues(left, right, direction) {
  const multiplier = direction === 'asc' ? 1 : -1;
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (left !== null && left !== undefined && right !== null && right !== undefined
    && String(left).trim() !== '' && String(right).trim() !== ''
    && Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return (leftNumber - rightNumber) * multiplier;
  }
  const leftDate = Date.parse(String(left || ''));
  const rightDate = Date.parse(String(right || ''));
  if (Number.isFinite(leftDate) && Number.isFinite(rightDate)) {
    return (leftDate - rightDate) * multiplier;
  }
  return String(left || '').localeCompare(String(right || ''), 'zh-CN') * multiplier;
}

function sortDemoRows(rows, sortKey, sortOrder) {
  return [...rows].sort((left, right) => {
    const result = compareListValues(left[sortKey], right[sortKey], sortOrder);
    return result || Number(right.id || 0) - Number(left.id || 0);
  });
}

function percentileForDemo(values, ratio) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const position = Math.min(1, Math.max(0, Number(ratio) || 0)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function itemMetadata(value) {
  const metadata = { ...(value || {}) };
  const rawExpiresAt = metadata.expiresAt;
  const numericExpiresAt = Number(rawExpiresAt);
  const datedExpiresAt = Date.parse(String(rawExpiresAt || ''));
  if (rawExpiresAt === null || rawExpiresAt === undefined || rawExpiresAt === ''
    || (Number.isFinite(numericExpiresAt) ? numericExpiresAt <= 0 : !Number.isFinite(datedExpiresAt))) {
    delete metadata.expiresAt;
  }
  return metadata;
}

function mappingPoolKey(platform, groupIds) {
  return `${platform}:groups:${groupIds.join('-')}`;
}

function mapping(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    product: row.product,
    platform: row.platform,
    targetPoolKey: row.target_pool_key,
    targetGroupIds: (row.target_group_ids || []).map(Number),
    enabled: Boolean(row.enabled),
    notes: row.notes || '',
    updatedAt: row.updated_at || null,
  };
}

function rule(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    productMappingId: Number(row.product_mapping_id),
    mode: row.mode,
    enabled: Boolean(row.enabled),
    triggerStrategy: row.trigger_strategy || 'inventory_threshold',
    minAvailableAccounts: Number(row.min_available_accounts || 0),
    targetAvailableAccounts: Number(row.target_available_accounts || 0),
    replenishQuantity: Number(row.replenish_quantity || 1),
    quotaUsedThresholdPercent: Number(row.quota_used_threshold_percent ?? 80),
    quotaWindow: row.quota_window || 'any',
    quotaUnknownPolicy: row.quota_unknown_policy || 'warn',
    repairGraceSeconds: Number(row.repair_grace_seconds ?? 900),
    recoveryRetryLimit: row.recovery_retry_limit === null || row.recovery_retry_limit === undefined
      ? null : Number(row.recovery_retry_limit),
    maxOrderAmountCny: number(row.max_order_amount_cny),
    maxDailyAmountCny: number(row.max_daily_amount_cny),
    concurrency: Number(row.concurrency || 1),
    loadFactor: number(row.load_factor),
    proxyId: number(row.proxy_id),
    priority: Number(row.priority || 0),
    rateMultiplier: Number(row.rate_multiplier ?? 1),
    autoPauseOnExpired: row.auto_pause_on_expired === undefined ? true : Boolean(row.auto_pause_on_expired),
    verificationModel: row.verification_model || 'gpt-5.6-luna',
    verificationPrompt: row.verification_prompt || '',
    modelWhitelist: Array.isArray(row.model_whitelist) ? row.model_whitelist.map(String).filter(Boolean) : [],
    pollIntervalSeconds: Number(row.poll_interval_seconds || 5),
    retryLimit: Number(row.retry_limit || 3),
    cooldownSeconds: 0,
    scheduleStartTime: String(row.schedule_start_time || '00:00').slice(0, 5),
    scheduleEndTime: String(row.schedule_end_time || '00:00').slice(0, 5),
    scheduleIntervalSeconds: Number(row.schedule_interval_seconds || 300),
    forecastLookbackHours: Number(row.forecast_lookback_hours || 168),
    forecastCoverageHours: Number(row.forecast_coverage_hours || 24),
    forecastSafetyFactor: Number(row.forecast_safety_factor || 1.2),
    forecastFallbackLeadTimeHours: Number(row.forecast_fallback_lead_time_hours || 2),
    forecastDefaultAccountCapacity: number(row.forecast_default_account_capacity),
    lastScheduledAt: row.last_scheduled_at || null,
    lastTriggeredAt: row.last_triggered_at || null,
    lastInventoryAt: row.last_inventory_at || null,
    lastError: row.last_error || '',
    lastInventorySnapshot: row.last_inventory_snapshot || {},
    lastForecastAt: row.last_forecast_at || null,
    lastForecastSnapshot: row.last_forecast_snapshot || {},
    product: row.product || '',
    platform: row.platform || '',
    targetPoolKey: row.target_pool_key || '',
    targetGroupIds: (row.target_group_ids || []).map(Number),
    updatedAt: row.updated_at || null,
  };
}

function order(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    ruleId: Number(row.rule_id),
    ruleName: row.rule_name || '',
    externalOrderId: row.external_order_id || '',
    idempotencyKey: row.idempotency_key,
    product: row.product,
    platform: row.platform,
    targetPoolKey: row.target_pool_key,
    requestedQuantity: Number(row.requested_quantity || 0),
    deliveredQuantity: Number(row.delivered_quantity || 0),
    validQuantity: Number(row.valid_quantity || 0),
    status: row.status,
    quotedAmountCny: number(row.quoted_amount_cny),
    actualPaidAmountCny: number(row.actual_paid_amount_cny),
    releasedAmountCny: number(row.released_amount_cny),
    payloadCiphertext: row.payload_ciphertext || '',
    lastError: row.last_error || '',
    failureCount: Number(row.failure_count || 0),
    nextPollAt: row.next_poll_at || null,
    approvedBy: row.approved_by || '',
    approvedAt: row.approved_at || null,
    trigger: row.trigger || '',
    mode: row.run_mode || row.mode || '',
    targetGroupIds: (row.target_group_ids || []).map(Number),
    itemCount: Number(row.item_count || 0),
    failedQuantity: Number(
      row.failed_quantity
      ?? Math.max(0, Number(row.requested_quantity || 0) - Number(row.valid_quantity || 0)),
    ),
    pendingDeliveryQuantity: Math.max(
      0,
      Number(row.requested_quantity || 0) - Number(row.delivered_quantity || 0),
    ),
    pendingImportQuantity: Math.max(
      0,
      Number(row.delivered_quantity || 0) - Number(row.valid_quantity || 0),
    ),
    healthyItemCount: Number(row.healthy_item_count || 0),
    lowQuotaItemCount: Number(row.low_quota_item_count || 0),
    unavailableItemCount: Number(row.unavailable_item_count || 0),
    repairingItemCount: Number(row.repairing_item_count || 0),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function item(row) {
  return {
    id: Number(row.id),
    orderId: Number(row.order_id),
    externalItemId: row.external_item_id || '',
    externalAccountKey: row.external_account_key || '',
    accountName: row.account_name || '',
    status: row.status,
    verificationStatus: row.verification_status,
    individualCostCny: number(row.individual_cost_cny),
    finalCostCny: number(row.final_cost_cny),
    credentialVersion: row.credential_version || '',
    sub2apiAccountId: number(row.sub2api_account_id),
    costLedgerStatus: row.cost_ledger_status || 'pending',
    costLedgerPeriodId: number(row.cost_ledger_period_id),
    costLedgerError: row.cost_ledger_error || '',
    errorMessage: row.error_message || '',
    healthStatus: row.health_status || 'unknown',
    quotaUsedPercent: number(row.quota_used_percent),
    quotaWindow: row.quota_window || '',
    lastHealthAt: row.last_health_at || null,
    metadata: row.metadata || {},
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    credentialCiphertext: row.credential_ciphertext || '',
    importAttemptCount: Number(row.import_attempt_count || 0),
    nextImportRetryAt: row.next_import_retry_at || null,
    repairCompletionSource: row.repair_completion_source || '',
    capacityStartedAt: row.capacity_started_at || row.created_at || null,
  };
}

function recovery(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    recoveryKey: row.recovery_key,
    supplierRecoveryId: row.supplier_recovery_id || '',
    orderItemId: Number(row.order_item_id),
    orderId: number(row.order_id),
    externalOrderId: row.external_order_id || '',
    ruleId: Number(row.rule_id),
    sub2apiAccountId: Number(row.sub2api_account_id),
    accountKey: row.account_key || '',
    accountName: row.account_name || '',
    status: row.status,
    deliveryStatus: row.delivery_status || '',
    credentialVersion: row.credential_version || '',
    claimUrlCiphertext: row.claim_url_ciphertext || '',
    credentialCiphertext: row.credential_ciphertext || '',
    attemptCount: Number(row.attempt_count || 0),
    nextRetryAt: row.next_retry_at || null,
    lastError: row.last_error || '',
    firstSeenAt: row.first_seen_at || null,
    lastSeenAt: row.last_seen_at || null,
    claimedAt: row.claimed_at || null,
    recoveredAt: row.recovered_at || null,
    completionSource: row.completion_source || '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    mode: row.recovery_mode || row.mode || 'manual',
    recoveryEnabled: row.recovery_enabled === false ? false : true,
    verificationModel: row.verification_model || '',
    verificationPrompt: row.verification_prompt || '',
    recoveryRetryLimit: row.recovery_policy_retry_limit === null || row.recovery_policy_retry_limit === undefined
      ? null : Number(row.recovery_policy_retry_limit),
    recoveryRetryIntervalSeconds: Number(row.recovery_retry_interval_seconds || 60),
  };
}

function recoveryFeedEntry(row) {
  if (!row) return null;
  return {
    id: row.feed_id,
    recoveryId: number(row.recovery_id),
    kind: row.kind || 'account',
    orderItemId: Number(row.order_item_id),
    orderId: Number(row.order_id),
    externalOrderId: row.external_order_id || '',
    ruleId: Number(row.rule_id),
    ruleName: row.rule_name || '',
    product: row.product || '',
    platform: row.platform || '',
    targetPoolKey: row.target_pool_key || '',
    targetGroupIds: (row.target_group_ids || []).map(Number),
    accountName: row.account_name || row.external_account_key || '',
    externalAccountKey: row.external_account_key || '',
    targetAccountId: number(row.sub2api_account_id),
    status: row.status || '',
    deliveryStatus: row.delivery_status || '',
    credentialVersion: row.credential_version || '',
    attemptCount: Number(row.attempt_count || 0),
    nextRetryAt: row.next_retry_at || null,
    firstSeenAt: row.first_seen_at || null,
    lastSeenAt: row.last_seen_at || null,
    claimedAt: row.claimed_at || null,
    recoveredAt: row.recovered_at || null,
    completionSource: row.completion_source || '',
    healthStatus: row.health_status || 'unknown',
    quotaUsedPercent: number(row.quota_used_percent),
    quotaWindow: row.quota_window || '',
    lastHealthAt: row.last_health_at || null,
    accountCostCny: number(row.account_cost_cny),
    lastError: row.last_error || '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    ready: ['claimable', 'credentials_saved', 'retry_wait', 'manual_required'].includes(row.status),
  };
}

function recoveryPolicy(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    ruleId: Number(row.rule_id),
    ruleName: row.rule_name || '',
    enabled: Boolean(row.enabled),
    mode: row.mode || 'manual',
    retryLimit: row.retry_limit === null || row.retry_limit === undefined ? null : Number(row.retry_limit),
    retryIntervalSeconds: Number(row.retry_interval_seconds || 60),
    lastScannedAt: row.last_scanned_at || null,
    updatedAt: row.updated_at || null,
  };
}

function compactInventorySnapshot(snapshot = {}) {
  return {
    capturedAt: snapshot.capturedAt || null,
    pendingAccounts: Number(snapshot.pendingAccounts || 0),
    trackedAccounts: Number(snapshot.trackedAccounts || 0),
    lowQuotaAccounts: Number(snapshot.lowQuotaAccounts || 0),
    effectiveAccounts: Number(snapshot.effectiveAccounts || 0),
    repairingAccounts: Number(snapshot.repairingAccounts || 0),
    unavailableAccounts: Number(snapshot.unavailableAccounts || 0),
    unknownQuotaAccounts: Number(snapshot.unknownQuotaAccounts || 0),
    graceRepairingAccounts: Number(snapshot.graceRepairingAccounts || 0),
  };
}

function compactForecastSnapshot(snapshot = {}) {
  return {
    capturedAt: snapshot.capturedAt || null,
    status: snapshot.status || '',
    parameterMode: snapshot.parameterMode || '',
    lookbackHours: Number(snapshot.lookbackHours || 0),
    horizonHours: Number(snapshot.horizonHours || 0),
    leadTimeHours: number(snapshot.leadTimeHours),
    leadTimeHoursP50: number(snapshot.leadTimeHoursP50),
    leadTimeHoursP90: number(snapshot.leadTimeHoursP90),
    coverageHours: Number(snapshot.coverageHours || 0),
    safetyFactor: number(snapshot.safetyFactor),
    volatility: number(snapshot.volatility),
    recentDemandChange: number(snapshot.recentDemandChange),
    observedUsage1h: number(snapshot.observedUsage1h),
    observedUsage6h: number(snapshot.observedUsage6h),
    observedUsage24h: number(snapshot.observedUsage24h),
    recentHourlyRate: number(snapshot.recentHourlyRate),
    forecastUsage: number(snapshot.forecastUsage),
    currentRemainingCapacity: number(snapshot.currentRemainingCapacity),
    inFlightCapacity: number(snapshot.inFlightCapacity),
    capacityGap: number(snapshot.capacityGap),
    conservativeAccountCapacity: number(snapshot.conservativeAccountCapacity),
    capacitySampleCount: Number(snapshot.capacitySampleCount || 0),
    capacityConfidence: snapshot.capacityConfidence || '',
    demandConfidence: snapshot.demandConfidence || '',
    effectiveAccounts: Number(snapshot.effectiveAccounts || 0),
    pendingAccounts: Number(snapshot.pendingAccounts || 0),
    pendingSuccessRate: number(snapshot.pendingSuccessRate),
    emergencyQuantity: Number(snapshot.emergencyQuantity || 0),
    predictedQuantity: Number(snapshot.predictedQuantity || 0),
    recommendedQuantity: Number(snapshot.recommendedQuantity || 0),
    runwayHours: number(snapshot.runwayHours),
    nextCheckSeconds: Number(snapshot.nextCheckSeconds || 0),
    decisionReasons: Array.isArray(snapshot.decisionReasons)
      ? snapshot.decisionReasons.map(String).slice(0, 4)
      : [],
    sourceAccountCount: Number(snapshot.sourceAccountCount || 0),
  };
}

function event(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    ruleId: number(row.resolved_rule_id ?? row.rule_id),
    ruleName: row.rule_name || '',
    runId: number(row.run_id),
    orderId: number(row.order_id),
    itemId: number(row.item_id),
    eventType: row.event_type || '',
    message: row.message || '',
    details: row.details || {},
    actor: row.created_by || row.actor || 'system',
    createdAt: row.created_at || row.createdAt || null,
  };
}

function normalizeRuleInput(input) {
  const values = {
    name: String(input.name || '').trim(),
    productMappingId: Number(input.productMappingId),
    mode: input.mode,
    enabled: Boolean(input.enabled),
    triggerStrategy: String(input.triggerStrategy || 'inventory_threshold'),
    minAvailableAccounts: Number(input.minAvailableAccounts || 0),
    targetAvailableAccounts: Number(input.targetAvailableAccounts || 0),
    replenishQuantity: Number(input.replenishQuantity || 1),
    quotaUsedThresholdPercent: Number(input.quotaUsedThresholdPercent ?? 80),
    quotaWindow: String(input.quotaWindow || 'any'),
    quotaUnknownPolicy: String(input.quotaUnknownPolicy || 'warn'),
    repairGraceSeconds: Number(input.repairGraceSeconds ?? 900),
    recoveryRetryLimit: input.recoveryRetryLimit === null
      || input.recoveryRetryLimit === undefined
      || input.recoveryRetryLimit === ''
      ? null : Number(input.recoveryRetryLimit),
    maxOrderAmountCny: input.maxOrderAmountCny === null || input.maxOrderAmountCny === '' ? null : Number(input.maxOrderAmountCny),
    maxDailyAmountCny: input.maxDailyAmountCny === null || input.maxDailyAmountCny === '' ? null : Number(input.maxDailyAmountCny),
    concurrency: Number(input.concurrency || 1),
    loadFactor: input.loadFactor === null || input.loadFactor === undefined || input.loadFactor === ''
      ? null : Number(input.loadFactor),
    proxyId: input.proxyId === null || input.proxyId === undefined || input.proxyId === ''
      ? null : Number(input.proxyId),
    priority: Number(input.priority ?? 100),
    rateMultiplier: input.rateMultiplier === null || input.rateMultiplier === undefined || input.rateMultiplier === ''
      ? 1 : Number(input.rateMultiplier),
    autoPauseOnExpired: input.autoPauseOnExpired !== false,
    verificationModel: String(input.verificationModel || 'gpt-5.6-luna').trim(),
    verificationPrompt: String(input.verificationPrompt || '').trim(),
    modelWhitelist: [...new Set((Array.isArray(input.modelWhitelist) ? input.modelWhitelist : []).map((value) => String(value).trim()).filter(Boolean))],
    pollIntervalSeconds: Number(input.pollIntervalSeconds || 5),
    retryLimit: Number(input.retryLimit ?? 3),
    cooldownSeconds: 0,
    scheduleStartTime: String(input.scheduleStartTime || '00:00').trim(),
    scheduleEndTime: String(input.scheduleEndTime || '00:00').trim(),
    scheduleIntervalSeconds: Number(input.scheduleIntervalSeconds ?? 300),
    forecastLookbackHours: Number(input.forecastLookbackHours ?? 168),
    forecastCoverageHours: Number(input.forecastCoverageHours ?? 24),
    forecastSafetyFactor: Number(input.forecastSafetyFactor ?? 1.2),
    forecastFallbackLeadTimeHours: Number(input.forecastFallbackLeadTimeHours ?? 2),
    forecastDefaultAccountCapacity: input.forecastDefaultAccountCapacity === null
      || input.forecastDefaultAccountCapacity === undefined
      || input.forecastDefaultAccountCapacity === ''
      ? null : Number(input.forecastDefaultAccountCapacity),
  };
  if (values.triggerStrategy === 'smart_forecast') {
    values.quotaWindow = 'long';
    values.targetAvailableAccounts = values.minAvailableAccounts;
    values.repairGraceSeconds = 0;
    values.scheduleIntervalSeconds = 300;
    values.forecastLookbackHours = 168;
    values.forecastCoverageHours = 24;
    values.forecastSafetyFactor = 1.2;
    values.forecastFallbackLeadTimeHours = 2;
    values.forecastDefaultAccountCapacity = null;
  }
  if (!values.name) throw badRequest('请输入策略名称');
  if (!Number.isSafeInteger(values.productMappingId) || values.productMappingId <= 0) {
    throw badRequest('请选择有效的商品映射');
  }
  if (!['observe', 'approval', 'auto'].includes(values.mode)) throw badRequest('运行模式无效');
  if (!['inventory_threshold', 'fixed_schedule', 'smart_forecast'].includes(values.triggerStrategy)) {
    throw badRequest('补号方式无效');
  }
  if (!Number.isSafeInteger(values.minAvailableAccounts) || values.minAvailableAccounts < 1) {
    throw badRequest('最低有效库存必须是至少为 1 的整数');
  }
  if (values.triggerStrategy !== 'fixed_schedule'
    && (!Number.isSafeInteger(values.targetAvailableAccounts)
      || values.targetAvailableAccounts < values.minAvailableAccounts)) {
    throw badRequest('目标库存不能低于最低有效库存');
  }
  if (!Number.isSafeInteger(values.replenishQuantity) || values.replenishQuantity < 1 || values.replenishQuantity > 1000) {
    throw badRequest('单次最多购买数量必须在 1 到 1000 之间');
  }
  if (values.loadFactor !== null
    && (!Number.isSafeInteger(values.loadFactor) || values.loadFactor < 1 || values.loadFactor > 10000)) {
    throw badRequest('负载因子必须留空或填写 1 到 10000 之间的整数');
  }
  if (values.proxyId !== null && (!Number.isSafeInteger(values.proxyId) || values.proxyId <= 0)) {
    throw badRequest('代理选择无效');
  }
  if (!Number.isFinite(values.rateMultiplier) || values.rateMultiplier < 0 || values.rateMultiplier > 999999.9999) {
    throw badRequest('账号计费倍率必须在 0 到 999999.9999 之间');
  }
  if (!Number.isFinite(values.quotaUsedThresholdPercent)
    || values.quotaUsedThresholdPercent < 0 || values.quotaUsedThresholdPercent > 100) {
    throw badRequest('额度消耗阈值必须在 0% 到 100% 之间');
  }
  if (!['short', 'long', 'any'].includes(values.quotaWindow)) throw badRequest('额度判断窗口无效');
  if (!['warn', 'low', 'ignore'].includes(values.quotaUnknownPolicy)) throw badRequest('额度未知处理方式无效');
  if (!Number.isSafeInteger(values.repairGraceSeconds) || values.repairGraceSeconds < 0 || values.repairGraceSeconds > 86400) {
    throw badRequest('修复等待时间必须在 0 到 86400 秒之间');
  }
  if (values.recoveryRetryLimit !== null
    && (!Number.isSafeInteger(values.recoveryRetryLimit)
      || values.recoveryRetryLimit < 0 || values.recoveryRetryLimit > 20)) {
    throw badRequest('修复重试次数必须在 0 到 20 之间');
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(values.scheduleStartTime)
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(values.scheduleEndTime)) {
    throw badRequest('自动补号执行时段必须是有效的 24 小时时间');
  }
  if (!Number.isSafeInteger(values.scheduleIntervalSeconds)
    || values.scheduleIntervalSeconds < 3 || values.scheduleIntervalSeconds > 86400) {
    throw badRequest('自动补号轮询间隔必须在 3 到 86400 秒之间');
  }
  if (!Number.isSafeInteger(values.forecastLookbackHours)
    || values.forecastLookbackHours < 24 || values.forecastLookbackHours > 720) {
    throw badRequest('预测回看时长必须在 24 到 720 小时之间');
  }
  if (!Number.isSafeInteger(values.forecastCoverageHours)
    || values.forecastCoverageHours < 1 || values.forecastCoverageHours > 168) {
    throw badRequest('预测保障时长必须在 1 到 168 小时之间');
  }
  if (!Number.isFinite(values.forecastSafetyFactor)
    || values.forecastSafetyFactor < 1 || values.forecastSafetyFactor > 3) {
    throw badRequest('预测安全系数必须在 1 到 3 之间');
  }
  if (!Number.isFinite(values.forecastFallbackLeadTimeHours)
    || values.forecastFallbackLeadTimeHours < 0.25 || values.forecastFallbackLeadTimeHours > 168) {
    throw badRequest('缺省采购提前期必须在 0.25 到 168 小时之间');
  }
  if (values.forecastDefaultAccountCapacity !== null
    && (!Number.isFinite(values.forecastDefaultAccountCapacity)
      || values.forecastDefaultAccountCapacity <= 0)) {
    throw badRequest('缺省单账号容量必须留空或大于 0');
  }
  return values;
}

function normalizeRecoveryPolicyInput(input) {
  const values = {
    ruleId: Number(input.ruleId),
    enabled: input.enabled !== false,
    mode: String(input.mode || 'manual'),
    retryLimit: input.retryLimit === null || input.retryLimit === undefined || input.retryLimit === ''
      ? null : Number(input.retryLimit),
    retryIntervalSeconds: Number(input.retryIntervalSeconds ?? 60),
  };
  if (!Number.isSafeInteger(values.ruleId) || values.ruleId <= 0) throw badRequest('请选择有效的补号策略');
  if (!['manual', 'auto'].includes(values.mode)) throw badRequest('修复执行模式无效');
  if (values.retryLimit !== null
    && (!Number.isSafeInteger(values.retryLimit) || values.retryLimit < 0 || values.retryLimit > 20)) {
    throw badRequest('修复重试次数必须在 0 到 20 之间');
  }
  if (!Number.isSafeInteger(values.retryIntervalSeconds)
    || values.retryIntervalSeconds < 15 || values.retryIntervalSeconds > 86400) {
    throw badRequest('修复重试间隔必须在 15 到 86400 秒之间');
  }
  return values;
}

export class ReplenishmentRepository {
  constructor(pool, config = {}) {
    this.pool = pool;
    this.schema = `"${config.finopsSchema || 'finops'}"`;
    this.demo = !pool;
    this.sequence = 10;
    this.mappings = this.demo ? [{
      id: 1,
      product: 'oauth_30d',
      platform: 'openai',
      targetPoolKey: 'openai-team-primary',
      targetGroupIds: [1],
      enabled: true,
      notes: 'Demo OAuth 30D pool',
      updatedAt: new Date().toISOString(),
    }] : [];
    this.rules = this.demo ? [{
      id: 1,
      name: 'OAuth 30D 主账号池',
      productMappingId: 1,
      mode: 'observe',
      enabled: true,
      triggerStrategy: 'inventory_threshold',
      minAvailableAccounts: 3,
      targetAvailableAccounts: 5,
      replenishQuantity: 2,
      quotaUsedThresholdPercent: 80,
      quotaWindow: 'any',
      quotaUnknownPolicy: 'warn',
      repairGraceSeconds: 900,
      recoveryRetryLimit: null,
      maxOrderAmountCny: 100,
      maxDailyAmountCny: 300,
      concurrency: 5,
      loadFactor: null,
      proxyId: null,
      priority: 20,
      rateMultiplier: 1,
      autoPauseOnExpired: true,
      verificationModel: 'gpt-5.6-luna',
      verificationPrompt: 'Reply with OK.',
      modelWhitelist: [],
      pollIntervalSeconds: 5,
      retryLimit: 3,
      cooldownSeconds: 0,
      scheduleStartTime: '00:00',
      scheduleEndTime: '00:00',
      scheduleIntervalSeconds: 300,
      forecastLookbackHours: 168,
      forecastCoverageHours: 24,
      forecastSafetyFactor: 1.2,
      forecastFallbackLeadTimeHours: 2,
      forecastDefaultAccountCapacity: null,
      lastScheduledAt: null,
      product: 'oauth_30d',
      platform: 'openai',
      targetPoolKey: 'openai-team-primary',
      targetGroupIds: [1],
      lastTriggeredAt: null,
      lastInventoryAt: null,
      lastError: '',
      lastInventorySnapshot: {},
      lastForecastAt: null,
      lastForecastSnapshot: {},
      updatedAt: new Date().toISOString(),
    }] : [];
    this.orders = [];
    this.items = [];
    this.runs = [];
    this.events = [];
    this.recoveries = [];
    this.recoveryPolicies = this.demo ? [{
      id: 2, ruleId: 1, ruleName: 'OAuth 30D 主账号池', enabled: true,
      mode: 'manual', retryLimit: null, retryIntervalSeconds: 60,
      lastScannedAt: null,
      updatedAt: new Date().toISOString(),
    }] : [];
  }

  async listMappings() {
    if (this.demo) return this.mappings.map((entry) => ({ ...entry, targetGroupIds: [...entry.targetGroupIds] }));
    const result = await this.pool.query(`
      SELECT * FROM ${this.schema}.oauth_supply_product_mappings
      WHERE deleted_at IS NULL
      ORDER BY enabled DESC, product, platform, target_pool_key, id`);
    return result.rows.map(mapping);
  }

  async upsertMapping(input, actor = 'admin') {
    const targetGroupIds = [...new Set((input.targetGroupIds || []).map(Number))].sort((left, right) => left - right);
    const platform = String(input.platform || '').trim();
    const values = {
      product: String(input.product || '').trim(),
      platform,
      targetPoolKey: mappingPoolKey(platform, targetGroupIds),
      targetGroupIds,
      enabled: input.enabled !== false,
      notes: String(input.notes || '').trim(),
    };
    if (!values.product) throw badRequest('请输入商品编码');
    if (!values.platform) throw badRequest('请输入平台');
    if (!values.targetGroupIds.length) throw badRequest('请至少选择一个 Sub2API 正式分组');
    if (values.targetGroupIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      throw badRequest('Sub2API 分组 ID 必须是正整数');
    }
    if (this.demo) {
      let current = input.id ? this.mappings.find((entry) => entry.id === Number(input.id)) : null;
      if (!current) {
        current = { id: ++this.sequence };
        this.mappings.push(current);
      }
      Object.assign(current, values, { updatedAt: new Date().toISOString() });
      return { ...current, targetGroupIds: [...current.targetGroupIds] };
    }
    const result = input.id
      ? await this.pool.query(`
          UPDATE ${this.schema}.oauth_supply_product_mappings SET
            product=$2,platform=$3,target_pool_key=$4,target_group_ids=$5::bigint[],
            enabled=$6,notes=$7,updated_at=NOW()
          WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
        [input.id, values.product, values.platform, values.targetPoolKey, values.targetGroupIds,
          values.enabled, values.notes])
      : await this.pool.query(`
          INSERT INTO ${this.schema}.oauth_supply_product_mappings(
            product,platform,target_pool_key,target_group_ids,enabled,notes,created_by)
          VALUES($1,$2,$3,$4::bigint[],$5,$6,$7)
          RETURNING *`,
        [values.product, values.platform, values.targetPoolKey, values.targetGroupIds,
          values.enabled, values.notes, actor]);
    if (!result.rowCount) throw notFound('商品映射不存在或已删除');
    return mapping(result.rows[0]);
  }

  async listRules({ enabledOnly = false } = {}) {
    if (this.demo) return this.rules.filter((entry) => !enabledOnly || entry.enabled).map((entry) => ({ ...entry }));
    const result = await this.pool.query(`
      SELECT r.*,m.product,m.platform,m.target_pool_key,m.target_group_ids
      FROM ${this.schema}.replenishment_rules r
      JOIN ${this.schema}.oauth_supply_product_mappings m ON m.id=r.product_mapping_id
      WHERE r.deleted_at IS NULL AND m.deleted_at IS NULL
        ${enabledOnly ? 'AND r.enabled AND m.enabled' : ''}
      ORDER BY r.enabled DESC,r.id`);
    return result.rows.map(rule);
  }

  async getRule(id) {
    if (this.demo) return this.rules.find((entry) => entry.id === Number(id)) || null;
    const result = await this.pool.query(`
      SELECT r.*,m.product,m.platform,m.target_pool_key,m.target_group_ids
      FROM ${this.schema}.replenishment_rules r
      JOIN ${this.schema}.oauth_supply_product_mappings m ON m.id=r.product_mapping_id
      WHERE r.id=$1 AND r.deleted_at IS NULL AND m.deleted_at IS NULL`, [id]);
    return rule(result.rows[0]);
  }

  async saveRule(input, actor = 'admin') {
    const values = normalizeRuleInput(input);
    if (this.demo) {
      const productMapping = this.mappings.find((entry) => entry.id === values.productMappingId);
      if (!productMapping) throw badRequest('商品映射不存在，请刷新后重新选择');
      let current = input.id ? this.rules.find((entry) => entry.id === Number(input.id)) : null;
      if (!current) {
        current = { id: ++this.sequence };
        this.rules.push(current);
      }
      Object.assign(current, values, {
        product: productMapping?.product || '',
        platform: productMapping?.platform || '',
        targetPoolKey: productMapping?.targetPoolKey || '',
        targetGroupIds: [...(productMapping?.targetGroupIds || [])],
        lastTriggeredAt: current.lastTriggeredAt || null,
        lastInventoryAt: current.lastInventoryAt || null,
        lastForecastAt: current.lastForecastAt || null,
        lastInventorySnapshot: current.lastInventorySnapshot || {},
        lastForecastSnapshot: current.lastForecastSnapshot || {},
        lastError: current.lastError || '',
        updatedAt: new Date().toISOString(),
      });
      return { ...current };
    }
    const productMapping = await this.pool.query(`
      SELECT id FROM ${this.schema}.oauth_supply_product_mappings
      WHERE id=$1 AND deleted_at IS NULL`, [values.productMappingId]);
    if (!productMapping.rowCount) throw badRequest('商品映射不存在，请刷新后重新选择');
    const params = [
      values.name, values.productMappingId, values.mode, values.enabled,
      values.triggerStrategy, values.minAvailableAccounts, values.targetAvailableAccounts, values.replenishQuantity,
      values.quotaUsedThresholdPercent, values.quotaWindow, values.quotaUnknownPolicy,
      values.repairGraceSeconds, values.recoveryRetryLimit,
      values.maxOrderAmountCny, values.maxDailyAmountCny, values.concurrency, values.loadFactor, values.proxyId,
      values.priority, values.rateMultiplier, values.autoPauseOnExpired,
      values.verificationModel, values.verificationPrompt, values.pollIntervalSeconds,
      values.modelWhitelist,
      values.retryLimit, values.cooldownSeconds,
      values.scheduleStartTime, values.scheduleEndTime, values.scheduleIntervalSeconds,
      values.forecastLookbackHours, values.forecastCoverageHours, values.forecastSafetyFactor,
      values.forecastFallbackLeadTimeHours, values.forecastDefaultAccountCapacity,
    ];
    const result = input.id
      ? await this.pool.query(`
          UPDATE ${this.schema}.replenishment_rules SET
            name=$2,product_mapping_id=$3,mode=$4,enabled=$5,trigger_strategy=$6,min_available_accounts=$7,
            target_available_accounts=$8,replenish_quantity=$9,quota_used_threshold_percent=$10,
            quota_window=$11,quota_unknown_policy=$12,repair_grace_seconds=$13,recovery_retry_limit=$14,
            max_order_amount_cny=$15,max_daily_amount_cny=$16,concurrency=$17,load_factor=$18,proxy_id=$19,priority=$20,
            rate_multiplier=$21,auto_pause_on_expired=$22,verification_model=$23,
            verification_prompt=$24,poll_interval_seconds=$25,model_whitelist=$26,retry_limit=$27,
            cooldown_seconds=$28,schedule_start_time=$29,schedule_end_time=$30,
            schedule_interval_seconds=$31,forecast_lookback_hours=$32,
            forecast_coverage_hours=$33,forecast_safety_factor=$34,
            forecast_fallback_lead_time_hours=$35,forecast_default_account_capacity=$36,
            updated_at=NOW()
          WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [input.id, ...params])
      : await this.pool.query(`
          INSERT INTO ${this.schema}.replenishment_rules(
            name,product_mapping_id,mode,enabled,trigger_strategy,min_available_accounts,target_available_accounts,
            replenish_quantity,quota_used_threshold_percent,quota_window,quota_unknown_policy,
            repair_grace_seconds,recovery_retry_limit,max_order_amount_cny,max_daily_amount_cny,
            concurrency,load_factor,proxy_id,priority,rate_multiplier,auto_pause_on_expired,verification_model,
            verification_prompt,poll_interval_seconds,model_whitelist,retry_limit,cooldown_seconds,
            schedule_start_time,schedule_end_time,
            schedule_interval_seconds,forecast_lookback_hours,forecast_coverage_hours,
            forecast_safety_factor,forecast_fallback_lead_time_hours,
            forecast_default_account_capacity,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36)
          RETURNING id`, [...params, actor]);
    if (!result.rowCount) throw notFound('补号策略不存在或已删除');
    return this.getRule(result.rows[0]?.id);
  }

  async markRuleScheduled(id, at = new Date().toISOString()) {
    if (this.demo) {
      const current = this.rules.find((entry) => entry.id === Number(id));
      if (current) current.lastScheduledAt = at;
      return;
    }
    await this.pool.query(`
      UPDATE ${this.schema}.replenishment_rules
      SET last_scheduled_at=$2,updated_at=NOW()
      WHERE id=$1`, [id, at]);
  }

  async listRecoveryPolicies() {
    if (this.demo) return this.recoveryPolicies.map((entry) => ({ ...entry }));
    const result = await this.pool.query(`
      SELECT policy.*,replenishment_rule.name AS rule_name
      FROM ${this.schema}.replenishment_recovery_policies policy
      JOIN ${this.schema}.replenishment_rules replenishment_rule ON replenishment_rule.id=policy.rule_id
      WHERE replenishment_rule.deleted_at IS NULL
      ORDER BY replenishment_rule.id`);
    return result.rows.map(recoveryPolicy);
  }

  async getRecoveryPolicyByRule(ruleId) {
    if (this.demo) return this.recoveryPolicies.find((entry) => entry.ruleId === Number(ruleId)) || null;
    const result = await this.pool.query(`
      SELECT policy.*,replenishment_rule.name AS rule_name
      FROM ${this.schema}.replenishment_recovery_policies policy
      JOIN ${this.schema}.replenishment_rules replenishment_rule ON replenishment_rule.id=policy.rule_id
      WHERE policy.rule_id=$1 AND replenishment_rule.deleted_at IS NULL`, [ruleId]);
    return recoveryPolicy(result.rows[0]);
  }

  async saveRecoveryPolicy(input, actor = 'admin') {
    const values = normalizeRecoveryPolicyInput(input);
    if (!await this.getRule(values.ruleId)) throw notFound('关联的补号策略不存在或已删除');
    if (this.demo) {
      let current = this.recoveryPolicies.find((entry) => entry.ruleId === values.ruleId);
      if (!current) {
        current = { id: ++this.sequence, ruleName: (await this.getRule(values.ruleId))?.name || '' };
        this.recoveryPolicies.push(current);
      }
      Object.assign(current, values, { updatedAt: new Date().toISOString() });
      return { ...current };
    }
    const result = await this.pool.query(`
      INSERT INTO ${this.schema}.replenishment_recovery_policies(
        rule_id,enabled,mode,retry_limit,retry_interval_seconds,created_by)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(rule_id) DO UPDATE SET
        enabled=EXCLUDED.enabled,mode=EXCLUDED.mode,retry_limit=EXCLUDED.retry_limit,
        retry_interval_seconds=EXCLUDED.retry_interval_seconds,updated_at=NOW()
      RETURNING rule_id`, [values.ruleId, values.enabled, values.mode, values.retryLimit,
      values.retryIntervalSeconds, actor]);
    return this.getRecoveryPolicyByRule(result.rows[0].rule_id);
  }

  async markRecoveryPolicyScanned(ruleId, at = new Date().toISOString()) {
    if (this.demo) {
      const current = this.recoveryPolicies.find((entry) => entry.ruleId === Number(ruleId));
      if (current) current.lastScannedAt = at;
      return;
    }
    await this.pool.query(`
      UPDATE ${this.schema}.replenishment_recovery_policies
      SET last_scanned_at=$2,updated_at=NOW()
      WHERE rule_id=$1`, [ruleId, at]);
  }

  async setRuleEnabled(id, enabled, actor = 'admin') {
    const ruleId = Number(id);
    if (this.demo) {
      const current = this.rules.find((entry) => entry.id === ruleId);
      if (!current) throw notFound('补号策略不存在或已删除');
      current.enabled = Boolean(enabled);
      current.updatedAt = new Date().toISOString();
      await this.addEvent({
        ruleId,
        eventType: enabled ? 'rule_enabled' : 'rule_disabled',
        message: enabled ? '策略已启动' : '策略已暂停',
        actor,
      });
      return { ...current };
    }
    const result = await this.pool.query(`
      UPDATE ${this.schema}.replenishment_rules r SET
        enabled=$2,last_error='',updated_at=NOW()
      FROM ${this.schema}.oauth_supply_product_mappings m
      WHERE r.id=$1
        AND r.product_mapping_id=m.id
        AND r.deleted_at IS NULL
        AND m.deleted_at IS NULL
      RETURNING r.id`, [ruleId, Boolean(enabled)]);
    if (!result.rowCount) throw notFound('补号策略不存在或商品映射已删除');
    const updated = await this.getRule(ruleId);
    await this.addEvent({
      ruleId,
      eventType: enabled ? 'rule_enabled' : 'rule_disabled',
      message: enabled ? '策略已启动' : '策略已暂停',
      actor,
    });
    return updated;
  }

  async deleteRule(id) {
    const ruleId = Number(id);
    const stoppedMessage = '补号策略已删除，已停止自动修复和导入重试';
    if (this.demo) {
      const index = this.rules.findIndex((entry) => entry.id === ruleId);
      if (index < 0) throw notFound('补号策略不存在或已删除');
      if (await this.hasActiveOrder(ruleId)) throw conflict('策略存在进行中订单，请等待订单完成后再删除');
      const policy = this.recoveryPolicies.find((entry) => entry.ruleId === ruleId);
      if (policy) policy.enabled = false;
      for (const recovery of this.recoveries.filter((entry) => entry.ruleId === ruleId
        && ['detected', 'waiting_supplier', 'claimable', 'credentials_saved',
          'updating_sub2api', 'verifying', 'retry_wait'].includes(entry.status))) {
        Object.assign(recovery, {
          status: 'manual_required',
          nextRetryAt: null,
          lastError: stoppedMessage,
          updatedAt: new Date().toISOString(),
        });
      }
      for (const item of this.items.filter((entry) => {
        const order = this.orders.find((candidate) => candidate.id === entry.orderId);
        return order?.ruleId === ruleId && entry.status === 'retry_wait';
      })) {
        Object.assign(item, {
          status: 'manual_required',
          nextImportRetryAt: null,
          errorMessage: stoppedMessage,
          updatedAt: new Date().toISOString(),
        });
      }
      this.rules.splice(index, 1);
      return { deleted: true, id: ruleId };
    }
    const activeOrder = await this.pool.query(`
      SELECT 1 FROM ${this.schema}.oauth_supply_orders
      WHERE rule_id=$1
        AND status=ANY($2::text[])
      LIMIT 1`,
    [ruleId, ['approval_required', 'ordering', 'queued', 'processing', 'ready_to_collect', 'importing']]);
    if (activeOrder.rowCount) throw conflict('策略存在进行中订单，请等待订单完成后再删除');
    const client = await this.pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      await this.stopRuleRecoveryAutomation(client, [ruleId], stoppedMessage);
      result = await client.query(`
        UPDATE ${this.schema}.replenishment_rules SET
          enabled=FALSE,deleted_at=NOW(),updated_at=NOW()
        WHERE id=$1 AND deleted_at IS NULL
        RETURNING id`, [ruleId]);
      if (!result.rowCount) throw notFound('补号策略不存在或已删除');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { deleted: true, id: ruleId };
  }

  async deleteMapping(id) {
    const mappingId = Number(id);
    const stoppedMessage = '商品映射已删除，已停止关联策略的自动修复和导入重试';
    if (this.demo) {
      const index = this.mappings.findIndex((entry) => entry.id === mappingId);
      if (index < 0) throw notFound('商品映射不存在或已删除');
      const ruleIds = this.rules.filter((entry) => entry.productMappingId === mappingId).map((entry) => entry.id);
      for (const ruleId of ruleIds) {
        const policy = this.recoveryPolicies.find((entry) => entry.ruleId === ruleId);
        if (policy) policy.enabled = false;
        for (const recovery of this.recoveries.filter((entry) => entry.ruleId === ruleId
          && ['detected', 'waiting_supplier', 'claimable', 'credentials_saved',
            'updating_sub2api', 'verifying', 'retry_wait'].includes(entry.status))) {
          Object.assign(recovery, {
            status: 'manual_required',
            nextRetryAt: null,
            lastError: stoppedMessage,
            updatedAt: new Date().toISOString(),
          });
        }
      }
      this.rules = this.rules.filter((entry) => entry.productMappingId !== mappingId);
      this.mappings.splice(index, 1);
      return { deleted: true, id: mappingId, deletedRuleCount: ruleIds.length };
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const linkedRules = await client.query(`
        SELECT id FROM ${this.schema}.replenishment_rules
        WHERE product_mapping_id=$1 AND deleted_at IS NULL
        FOR UPDATE`, [mappingId]);
      const ruleIds = linkedRules.rows.map((row) => Number(row.id));
      const activeOrder = await client.query(`
        SELECT 1 FROM ${this.schema}.oauth_supply_orders
        WHERE rule_id=ANY($1::bigint[])
          AND status=ANY($2::text[])
        LIMIT 1`,
      [ruleIds, ['approval_required', 'ordering', 'queued', 'processing', 'ready_to_collect', 'importing']]);
      if (activeOrder.rowCount) throw conflict('商品映射关联策略存在进行中订单，请等待订单完成后再删除');
      await this.stopRuleRecoveryAutomation(client, ruleIds, stoppedMessage);
      if (ruleIds.length) {
        await client.query(`
          UPDATE ${this.schema}.replenishment_rules
          SET enabled=FALSE,deleted_at=NOW(),updated_at=NOW()
          WHERE id=ANY($1::bigint[]) AND deleted_at IS NULL`, [ruleIds]);
      }
      const result = await client.query(`
        UPDATE ${this.schema}.oauth_supply_product_mappings SET
          enabled=FALSE,deleted_at=NOW(),updated_at=NOW()
        WHERE id=$1 AND deleted_at IS NULL
        RETURNING id`, [mappingId]);
      if (!result.rowCount) throw notFound('商品映射不存在或已删除');
      await client.query('COMMIT');
      return { deleted: true, id: mappingId, deletedRuleCount: ruleIds.length };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async stopRuleRecoveryAutomation(client, ruleIds, message) {
    if (!ruleIds.length) return;
    await client.query(`
      UPDATE ${this.schema}.replenishment_recovery_policies
      SET enabled=FALSE,updated_at=NOW()
      WHERE rule_id=ANY($1::bigint[])`, [ruleIds]);
    await client.query(`
      UPDATE ${this.schema}.replenishment_recoveries
      SET status='manual_required',next_retry_at=NULL,last_error=$2,updated_at=NOW()
      WHERE rule_id=ANY($1::bigint[])
        AND status=ANY($3::text[])`,
    [ruleIds, message, ['detected', 'waiting_supplier', 'claimable', 'credentials_saved',
      'updating_sub2api', 'verifying', 'retry_wait']]);
    await client.query(`
      UPDATE ${this.schema}.oauth_supply_order_items item
      SET status='manual_required',next_import_retry_at=NULL,error_message=$2,updated_at=NOW()
      FROM ${this.schema}.oauth_supply_orders replenishment_order
      WHERE item.order_id=replenishment_order.id
        AND replenishment_order.rule_id=ANY($1::bigint[])
        AND item.status='retry_wait'`,
    [ruleIds, message]);
  }

  async markRuleInventory(id, { error = '' } = {}) {
    if (this.demo) {
      const current = this.rules.find((entry) => entry.id === Number(id));
      if (current) {
        current.lastInventoryAt = new Date().toISOString();
        current.lastError = error;
      }
      return;
    }
    await this.pool.query(`
      UPDATE ${this.schema}.replenishment_rules SET
        last_inventory_at=NOW(),last_error=$2,updated_at=NOW()
      WHERE id=$1`, [id, String(error || '').slice(0, 1000)]);
  }

  async markRuleError(id, error = '') {
    if (this.demo) {
      const current = this.rules.find((entry) => entry.id === Number(id));
      if (current) current.lastError = String(error || '').slice(0, 1000);
      return;
    }
    await this.pool.query(`
      UPDATE ${this.schema}.replenishment_rules SET
        last_error=$2,updated_at=NOW()
      WHERE id=$1`, [id, String(error || '').slice(0, 1000)]);
  }

  async saveInventorySnapshot(id, snapshot, { error = '' } = {}) {
    if (this.demo) {
      const current = this.rules.find((entry) => entry.id === Number(id));
      if (current) {
        current.lastInventoryAt = new Date().toISOString();
        current.lastInventorySnapshot = structuredClone(snapshot || {});
        current.lastError = error;
      }
      return;
    }
    await this.pool.query(`
      UPDATE ${this.schema}.replenishment_rules SET
        last_inventory_at=NOW(),last_inventory_snapshot=$2::jsonb,last_error=$3,updated_at=NOW()
      WHERE id=$1`,
    [id, JSON.stringify(snapshot || {}), String(error || '').slice(0, 1000)]);
  }

  async saveForecastSnapshot(id, snapshot, { error = '' } = {}) {
    if (this.demo) {
      const current = this.rules.find((entry) => entry.id === Number(id));
      if (current) {
        current.lastForecastAt = new Date().toISOString();
        current.lastForecastSnapshot = structuredClone(snapshot || {});
        current.lastError = error;
      }
      return;
    }
    await this.pool.query(`
      UPDATE ${this.schema}.replenishment_rules SET
        last_forecast_at=NOW(),last_forecast_snapshot=$2::jsonb,last_error=$3,updated_at=NOW()
      WHERE id=$1`,
    [id, JSON.stringify(snapshot || {}), String(error || '').slice(0, 1000)]);
  }

  async hasActiveOrder(ruleId) {
    const active = new Set(['approval_required', 'ordering', 'queued', 'processing', 'ready_to_collect', 'importing']);
    if (this.demo) return this.orders.some((entry) => entry.ruleId === Number(ruleId) && active.has(entry.status));
    const result = await this.pool.query(`
      SELECT 1 FROM ${this.schema}.oauth_supply_orders
      WHERE rule_id=$1 AND status=ANY($2::text[]) LIMIT 1`, [ruleId, [...active]]);
    return Boolean(result.rowCount);
  }

  async pendingQuantity(ruleId) {
    const active = ['approval_required', 'ordering', 'queued', 'processing', 'ready_to_collect', 'importing'];
    if (this.demo) {
      return this.orders
        .filter((entry) => entry.ruleId === Number(ruleId) && active.includes(entry.status))
        .reduce((sum, entry) => sum + Math.max(0, Number(entry.requestedQuantity || 0) - Number(entry.validQuantity || 0)), 0);
    }
    const result = await this.pool.query(`
      SELECT COALESCE(SUM(GREATEST(requested_quantity-valid_quantity,0)),0) AS quantity
      FROM ${this.schema}.oauth_supply_orders
      WHERE rule_id=$1 AND status=ANY($2::text[])`, [ruleId, active]);
    return Number(result.rows[0]?.quantity || 0);
  }

  async getPoolPlanningStats(targetPoolKey) {
    const active = ['approval_required', 'ordering', 'queued', 'processing', 'ready_to_collect', 'importing'];
    const terminal = ['completed', 'partial_failed', 'failed'];
    if (this.demo) {
      const poolOrders = this.orders.filter((entry) => entry.targetPoolKey === targetPoolKey);
      const historical = poolOrders.filter((entry) => terminal.includes(entry.status));
      const requested = historical.reduce((sum, entry) => sum + Number(entry.requestedQuantity || 0), 0);
      const valid = historical.reduce((sum, entry) => sum + Number(entry.validQuantity || 0), 0);
      const leadTimes = historical
        .filter((entry) => Number(entry.validQuantity || 0) > 0)
        .map((entry) => (Date.parse(entry.updatedAt) - Date.parse(entry.createdAt)) / 3_600_000)
        .filter((value) => Number.isFinite(value) && value >= 0);
      return {
        hasActiveOrder: poolOrders.some((entry) => active.includes(entry.status)),
        pendingQuantity: poolOrders
          .filter((entry) => active.includes(entry.status))
          .reduce((sum, entry) => sum + Math.max(
            0,
            Number(entry.requestedQuantity || 0) - Number(entry.validQuantity || 0),
          ), 0),
        historicalSuccessRate: requested > 0 ? valid / requested : null,
        leadTimeHoursP50: percentileForDemo(leadTimes, 0.5),
        leadTimeHoursP90: percentileForDemo(leadTimes, 0.9),
        historicalOrderCount: historical.length,
      };
    }
    const result = await this.pool.query(`
      SELECT
        EXISTS(
          SELECT 1 FROM ${this.schema}.oauth_supply_orders
          WHERE target_pool_key=$1 AND status=ANY($2::text[])
        ) AS has_active_order,
        COALESCE(SUM(GREATEST(requested_quantity-valid_quantity,0))
          FILTER (WHERE status=ANY($2::text[])),0)::int AS pending_quantity,
        (SUM(valid_quantity)
          FILTER (WHERE status=ANY($3::text[]) AND created_at>=NOW()-INTERVAL '90 days'))::numeric
          / NULLIF((SUM(requested_quantity)
          FILTER (WHERE status=ANY($3::text[]) AND created_at>=NOW()-INTERVAL '90 days'))::numeric,0)
          AS historical_success_rate,
        PERCENTILE_CONT(0.9) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (updated_at-created_at))/3600.0
        ) FILTER (
          WHERE status=ANY($3::text[]) AND valid_quantity>0
            AND created_at>=NOW()-INTERVAL '90 days'
        ) AS lead_time_hours_p90,
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (updated_at-created_at))/3600.0
        ) FILTER (
          WHERE status=ANY($3::text[]) AND valid_quantity>0
            AND created_at>=NOW()-INTERVAL '90 days'
        ) AS lead_time_hours_p50,
        COUNT(*) FILTER (
          WHERE status=ANY($3::text[]) AND created_at>=NOW()-INTERVAL '90 days'
        )::int AS historical_order_count
      FROM ${this.schema}.oauth_supply_orders
      WHERE target_pool_key=$1`, [targetPoolKey, active, terminal]);
    return {
      hasActiveOrder: Boolean(result.rows[0]?.has_active_order),
      pendingQuantity: Number(result.rows[0]?.pending_quantity || 0),
      historicalSuccessRate: number(result.rows[0]?.historical_success_rate),
      leadTimeHoursP50: number(result.rows[0]?.lead_time_hours_p50),
      leadTimeHoursP90: number(result.rows[0]?.lead_time_hours_p90),
      historicalOrderCount: Number(result.rows[0]?.historical_order_count || 0),
    };
  }

  async listTrackedItems(ruleId) {
    if (this.demo) {
      const orderIds = new Set(this.orders.filter((entry) => entry.ruleId === Number(ruleId)).map((entry) => entry.id));
      return this.items
        .filter((entry) => orderIds.has(entry.orderId) && entry.sub2apiAccountId)
        .map((entry) => ({ ...entry }));
    }
    const result = await this.pool.query(`
      SELECT i.*,o.rule_id,o.product,o.platform
      FROM ${this.schema}.oauth_supply_order_items i
      JOIN ${this.schema}.oauth_supply_orders o ON o.id=i.order_id
      WHERE o.rule_id=$1
        AND i.sub2api_account_id IS NOT NULL
      ORDER BY i.id`, [ruleId]);
    return result.rows.map(item);
  }

  async listTrackedItemsForPool(targetPoolKey) {
    if (this.demo) {
      const orderIds = new Set(this.orders
        .filter((entry) => entry.targetPoolKey === targetPoolKey)
        .map((entry) => entry.id));
      return this.items
        .filter((entry) => orderIds.has(entry.orderId) && entry.sub2apiAccountId)
        .map((entry) => ({ ...entry }));
    }
    const result = await this.pool.query(`
      SELECT i.*,o.rule_id,o.product,o.platform
      FROM ${this.schema}.oauth_supply_order_items i
      JOIN ${this.schema}.oauth_supply_orders o ON o.id=i.order_id
      WHERE o.target_pool_key=$1
        AND i.sub2api_account_id IS NOT NULL
      ORDER BY i.id`, [targetPoolKey]);
    return result.rows.map(item);
  }

  async upsertRecovery(input) {
    const values = {
      recoveryKey: String(input.recoveryKey || '').trim(),
      supplierRecoveryId: String(input.supplierRecoveryId || '').trim(),
      orderItemId: Number(input.orderItemId),
      ruleId: Number(input.ruleId),
      sub2apiAccountId: Number(input.sub2apiAccountId),
      accountKey: String(input.accountKey || '').trim(),
      status: String(input.status || 'waiting_supplier'),
      deliveryStatus: String(input.deliveryStatus || '').trim(),
      credentialVersion: String(input.credentialVersion || '').trim(),
      claimUrlCiphertext: String(input.claimUrlCiphertext || ''),
      credentialCiphertext: String(input.credentialCiphertext || ''),
      attemptCount: Number(input.attemptCount || 0),
      nextRetryAt: input.nextRetryAt || null,
      lastError: String(input.lastError || ''),
      claimedAt: input.claimedAt || null,
      recoveredAt: input.recoveredAt || null,
      completionSource: String(input.completionSource || '').trim(),
    };
    if (!values.recoveryKey || !Number.isSafeInteger(values.orderItemId) || !Number.isSafeInteger(values.ruleId)
      || !Number.isSafeInteger(values.sub2apiAccountId)) {
      throw badRequest('修复任务缺少关联账号');
    }
    if (this.demo) {
      let current = this.recoveries.find((entry) => entry.recoveryKey === values.recoveryKey);
      if (!current) {
        current = {
          id: ++this.sequence,
          firstSeenAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        };
        this.recoveries.push(current);
      }
      Object.assign(current, values, { lastSeenAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      return { ...current };
    }
    const result = await this.pool.query(`
      INSERT INTO ${this.schema}.replenishment_recoveries(
        recovery_key,supplier_recovery_id,order_item_id,rule_id,sub2api_account_id,account_key,status,
        delivery_status,credential_version,claim_url_ciphertext,credential_ciphertext,attempt_count,
        next_retry_at,last_error,claimed_at,recovered_at,completion_source)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT(recovery_key) DO UPDATE SET
        supplier_recovery_id=COALESCE(NULLIF(EXCLUDED.supplier_recovery_id,''),${this.schema}.replenishment_recoveries.supplier_recovery_id),
        sub2api_account_id=EXCLUDED.sub2api_account_id,
        delivery_status=EXCLUDED.delivery_status,
        credential_version=COALESCE(NULLIF(EXCLUDED.credential_version,''),${this.schema}.replenishment_recoveries.credential_version),
        claim_url_ciphertext=COALESCE(NULLIF(EXCLUDED.claim_url_ciphertext,''),${this.schema}.replenishment_recoveries.claim_url_ciphertext),
        credential_ciphertext=COALESCE(NULLIF(EXCLUDED.credential_ciphertext,''),${this.schema}.replenishment_recoveries.credential_ciphertext),
        status=EXCLUDED.status,attempt_count=EXCLUDED.attempt_count,next_retry_at=EXCLUDED.next_retry_at,
        last_error=EXCLUDED.last_error,claimed_at=COALESCE(EXCLUDED.claimed_at,${this.schema}.replenishment_recoveries.claimed_at),
        recovered_at=CASE WHEN EXCLUDED.status='recovered'
          THEN COALESCE(EXCLUDED.recovered_at,${this.schema}.replenishment_recoveries.recovered_at)
          ELSE NULL END,
        completion_source=CASE WHEN EXCLUDED.status='recovered'
          THEN COALESCE(NULLIF(EXCLUDED.completion_source,''),${this.schema}.replenishment_recoveries.completion_source)
          ELSE '' END,
        last_seen_at=NOW(),updated_at=NOW()
      RETURNING *`,
    [values.recoveryKey, values.supplierRecoveryId || null, values.orderItemId, values.ruleId,
      values.sub2apiAccountId, values.accountKey, values.status, values.deliveryStatus,
      values.credentialVersion, values.claimUrlCiphertext, values.credentialCiphertext,
      values.attemptCount, values.nextRetryAt, values.lastError.slice(0, 1000),
      values.claimedAt, values.recoveredAt, values.completionSource]);
    return recovery(result.rows[0]);
  }

  async getRecovery(id) {
    if (this.demo) {
      const current = this.recoveries.find((entry) => entry.id === Number(id));
      if (!current) return null;
      const policy = this.recoveryPolicies.find((entry) => entry.ruleId === current.ruleId);
      const selectedRule = this.rules.find((entry) => entry.id === current.ruleId);
      const selectedItem = this.items.find((entry) => entry.id === current.orderItemId);
      const selectedOrder = this.orders.find((entry) => entry.id === selectedItem?.orderId);
      return {
        ...current,
        orderId: selectedOrder?.id || selectedItem?.orderId || null,
        externalOrderId: selectedOrder?.externalOrderId || '',
        mode: policy?.mode || 'manual', recoveryEnabled: policy?.enabled !== false,
        recoveryRetryLimit: policy?.retryLimit ?? null,
        recoveryRetryIntervalSeconds: policy?.retryIntervalSeconds || 60,
        verificationModel: selectedRule?.verificationModel || '',
        verificationPrompt: selectedRule?.verificationPrompt || '',
      };
    }
    const result = await this.pool.query(`
      SELECT rr.*,i.account_name,i.order_id,o.external_order_id,r.verification_model,r.verification_prompt,
        policy.enabled AS recovery_enabled,policy.mode AS recovery_mode,
        policy.retry_limit AS recovery_policy_retry_limit,
        policy.retry_interval_seconds AS recovery_retry_interval_seconds
      FROM ${this.schema}.replenishment_recoveries rr
      JOIN ${this.schema}.oauth_supply_order_items i ON i.id=rr.order_item_id
      JOIN ${this.schema}.oauth_supply_orders o ON o.id=i.order_id
      JOIN ${this.schema}.replenishment_rules r ON r.id=rr.rule_id
      LEFT JOIN ${this.schema}.replenishment_recovery_policies policy ON policy.rule_id=rr.rule_id
      WHERE rr.id=$1`, [id]);
    return recovery(result.rows[0]);
  }

  async listRecoveries({ limit = 100 } = {}) {
    if (this.demo) return Promise.all([...this.recoveries].sort((a, b) => b.id - a.id).slice(0, limit)
      .map((entry) => this.getRecovery(entry.id)));
    const result = await this.pool.query(`
      SELECT rr.*,i.account_name,i.order_id,o.external_order_id,r.verification_model,r.verification_prompt,
        policy.enabled AS recovery_enabled,policy.mode AS recovery_mode,
        policy.retry_limit AS recovery_policy_retry_limit,
        policy.retry_interval_seconds AS recovery_retry_interval_seconds
      FROM ${this.schema}.replenishment_recoveries rr
      JOIN ${this.schema}.oauth_supply_order_items i ON i.id=rr.order_item_id
      JOIN ${this.schema}.oauth_supply_orders o ON o.id=i.order_id
      JOIN ${this.schema}.replenishment_rules r ON r.id=rr.rule_id
      LEFT JOIN ${this.schema}.replenishment_recovery_policies policy ON policy.rule_id=rr.rule_id
      ORDER BY rr.updated_at DESC,rr.id DESC LIMIT $1`, [limit]);
    return result.rows.map(recovery);
  }

  async listDueRecoveries({ limit = 30 } = {}) {
    const statuses = ['claimable', 'credentials_saved', 'retry_wait'];
    if (this.demo) {
      const now = Date.now();
      return this.recoveries.filter((entry) => statuses.includes(entry.status)
        && (!entry.nextRetryAt || Date.parse(entry.nextRetryAt) <= now))
        .slice(0, limit).map((entry) => ({ ...entry }));
    }
    const result = await this.pool.query(`
      SELECT rr.*,i.account_name,i.order_id,o.external_order_id,r.verification_model,r.verification_prompt,
        policy.enabled AS recovery_enabled,policy.mode AS recovery_mode,
        policy.retry_limit AS recovery_policy_retry_limit,
        policy.retry_interval_seconds AS recovery_retry_interval_seconds
      FROM ${this.schema}.replenishment_recoveries rr
      JOIN ${this.schema}.oauth_supply_order_items i ON i.id=rr.order_item_id
      JOIN ${this.schema}.oauth_supply_orders o ON o.id=i.order_id
      JOIN ${this.schema}.replenishment_rules r ON r.id=rr.rule_id
      LEFT JOIN ${this.schema}.replenishment_recovery_policies policy ON policy.rule_id=rr.rule_id
      WHERE rr.status=ANY($1::text[]) AND (rr.next_retry_at IS NULL OR rr.next_retry_at<=NOW())
      ORDER BY rr.updated_at LIMIT $2`, [statuses, limit]);
    return result.rows.map(recovery);
  }

  async invalidateRecoveryClaim(id, { status = 'waiting_supplier', deliveryStatus = '', lastError = '' } = {}) {
    if (this.demo) {
      const current = this.recoveries.find((entry) => entry.id === Number(id));
      if (!current) return null;
      Object.assign(current, {
        status, deliveryStatus, claimUrlCiphertext: '', nextRetryAt: null, lastError,
        lastSeenAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      return this.getRecovery(current.id);
    }
    const result = await this.pool.query(`
      UPDATE ${this.schema}.replenishment_recoveries SET
        status=$2,delivery_status=$3,claim_url_ciphertext='',next_retry_at=NULL,
        last_error=$4,last_seen_at=NOW(),updated_at=NOW()
      WHERE id=$1 RETURNING id`,
    [id, status, String(deliveryStatus || '').slice(0, 80), String(lastError || '').slice(0, 1000)]);
    return result.rowCount ? this.getRecovery(id) : null;
  }

  async completeRecovery(id, { completionSource = 'system', deliveryStatus = '', recoveredAt = null } = {}) {
    const completedAt = recoveredAt || new Date().toISOString();
    if (this.demo) {
      const current = this.recoveries.find((entry) => entry.id === Number(id));
      if (!current) return null;
      Object.assign(current, {
        status: 'recovered',
        completionSource,
        deliveryStatus: deliveryStatus || current.deliveryStatus || '',
        claimUrlCiphertext: '',
        nextRetryAt: null,
        lastError: '',
        recoveredAt: completedAt,
        lastSeenAt: completedAt,
        updatedAt: completedAt,
      });
      return this.getRecovery(current.id);
    }
    const result = await this.pool.query(`
      UPDATE ${this.schema}.replenishment_recoveries SET
        status='recovered',completion_source=$2,delivery_status=COALESCE(NULLIF($3,''),delivery_status),
        claim_url_ciphertext='',next_retry_at=NULL,last_error='',recovered_at=$4,
        last_seen_at=NOW(),updated_at=NOW()
      WHERE id=$1 RETURNING id`,
    [id, completionSource, String(deliveryStatus || '').slice(0, 80), completedAt]);
    return result.rowCount ? this.getRecovery(id) : null;
  }

  async dailySpend(ruleId) {
    if (this.demo) {
      const today = new Date().toISOString().slice(0, 10);
      return this.orders.filter((entry) => entry.ruleId === Number(ruleId)
        && String(entry.createdAt).slice(0, 10) === today)
        .reduce((sum, entry) => sum + Number(entry.actualPaidAmountCny || 0), 0);
    }
    const result = await this.pool.query(`
      SELECT COALESCE(SUM(actual_paid_amount_cny),0) AS total
      FROM ${this.schema}.oauth_supply_orders
      WHERE rule_id=$1 AND created_at>=date_trunc('day',NOW())`, [ruleId]);
    return Number(result.rows[0]?.total || 0);
  }

  async createPlannedOrder({ rule: selectedRule, trigger, quantity, availableBefore, quotedAmountCny, actor, status, idempotencyKey }) {
    if (this.demo) {
      const existing = this.orders.find((entry) => entry.idempotencyKey === idempotencyKey);
      if (existing) return { ...existing, idempotentReplay: true };
      if (this.orders.some((entry) => entry.targetPoolKey === selectedRule.targetPoolKey
        && ['approval_required', 'ordering', 'queued', 'processing', 'ready_to_collect', 'importing'].includes(entry.status))) {
        return null;
      }
      const run = {
        id: ++this.sequence, ruleId: selectedRule.id, trigger, mode: selectedRule.mode,
        status, requestedQuantity: quantity, availableBefore, quotedAmountCny,
        startedAt: new Date().toISOString(),
      };
      this.runs.push(run);
      const created = {
        id: ++this.sequence, runId: run.id, ruleId: selectedRule.id, ruleName: selectedRule.name,
        externalOrderId: '', idempotencyKey, product: selectedRule.product,
        platform: selectedRule.platform, targetPoolKey: selectedRule.targetPoolKey,
        requestedQuantity: quantity, deliveredQuantity: 0, validQuantity: 0, status,
        quotedAmountCny, actualPaidAmountCny: null, releasedAmountCny: null,
        payloadCiphertext: '', lastError: '', failureCount: 0, nextPollAt: null, approvedBy: '',
        approvedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      this.orders.push(created);
      selectedRule.lastTriggeredAt = new Date().toISOString();
      return { ...created };
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize creation per strategy and re-check active orders in the
      // same transaction to close the check-then-insert race.
      await client.query(`
        SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`apistation-finops:replenishment-pool:${selectedRule.targetPoolKey}`]);
      const duplicate = await client.query(`
        SELECT * FROM ${this.schema}.oauth_supply_orders
        WHERE idempotency_key=$1
        LIMIT 1`, [idempotencyKey]);
      if (duplicate.rowCount) {
        await client.query('COMMIT');
        return { ...order(duplicate.rows[0]), idempotentReplay: true };
      }
      const active = await client.query(`
        SELECT 1 FROM ${this.schema}.oauth_supply_orders
        WHERE target_pool_key=$1
          AND status=ANY($2::text[])
        LIMIT 1`,
      [selectedRule.targetPoolKey, ['approval_required', 'ordering', 'queued', 'processing', 'ready_to_collect', 'importing']]);
      if (active.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      const runResult = await client.query(`
        INSERT INTO ${this.schema}.replenishment_runs(
          rule_id,trigger,mode,status,requested_quantity,available_before,quoted_amount_cny,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [selectedRule.id, trigger, selectedRule.mode, status, quantity, availableBefore, quotedAmountCny, actor]);
      const result = await client.query(`
        INSERT INTO ${this.schema}.oauth_supply_orders(
          run_id,rule_id,idempotency_key,product,platform,target_pool_key,requested_quantity,
          status,quoted_amount_cny)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING *`,
      [runResult.rows[0].id, selectedRule.id, idempotencyKey, selectedRule.product,
        selectedRule.platform, selectedRule.targetPoolKey, quantity, status, quotedAmountCny]);
      await client.query(`
        UPDATE ${this.schema}.replenishment_rules
        SET last_triggered_at=NOW(),last_error='',updated_at=NOW() WHERE id=$1`, [selectedRule.id]);
      await client.query('COMMIT');
      return order(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getOrder(id, { includeCredentials = false } = {}) {
    if (this.demo) {
      const current = this.orders.find((entry) => entry.id === Number(id));
      if (!current) return null;
      return {
        ...current,
        items: this.items.filter((entry) => entry.orderId === current.id)
          .map((entry) => includeCredentials ? { ...entry } : { ...entry, credentialCiphertext: undefined }),
      };
    }
    const result = await this.pool.query(`
      SELECT o.*,r.name AS rule_name
      FROM ${this.schema}.oauth_supply_orders o
      JOIN ${this.schema}.replenishment_rules r ON r.id=o.rule_id
      WHERE o.id=$1`, [id]);
    if (!result.rowCount) return null;
    const itemsResult = await this.pool.query(`
      SELECT * FROM ${this.schema}.oauth_supply_order_items
      WHERE order_id=$1 ORDER BY id`, [id]);
    return {
      ...order(result.rows[0]),
      items: itemsResult.rows.map((row) => {
        const resultItem = item(row);
        if (!includeCredentials) delete resultItem.credentialCiphertext;
        return resultItem;
      }),
    };
  }

  async listOrders({ limit = 100 } = {}) {
    if (this.demo) return [...this.orders].sort((a, b) => b.id - a.id).slice(0, limit).map((entry) => ({
      ...entry,
      itemCount: this.items.filter((itemEntry) => itemEntry.orderId === entry.id).length,
    }));
    const result = await this.pool.query(`
      SELECT o.*,r.name AS rule_name,COUNT(i.id)::int AS item_count
      FROM ${this.schema}.oauth_supply_orders o
      JOIN ${this.schema}.replenishment_rules r ON r.id=o.rule_id
      LEFT JOIN ${this.schema}.oauth_supply_order_items i ON i.order_id=o.id
      GROUP BY o.id,r.name
      ORDER BY o.id DESC LIMIT $1`, [limit]);
    return result.rows.map((row) => ({ ...order(row), itemCount: Number(row.item_count || 0) }));
  }

  async getOrderSummary({ start = null, end = null } = {}) {
    const activeStatuses = ['approval_required', 'ordering', 'queued', 'processing', 'ready_to_collect', 'importing'];
    const rangeStart = start ? new Date(start) : new Date(0);
    const rangeEnd = end ? new Date(end) : new Date('9999-12-31T23:59:59.999Z');
    if (this.demo) {
      const scopedOrders = this.orders.filter((entry) => {
        const createdAt = new Date(entry.createdAt).getTime();
        return createdAt >= rangeStart.getTime() && createdAt < rangeEnd.getTime();
      });
      const scopedOrderIds = new Set(scopedOrders.map((entry) => Number(entry.id)));
      const scopedItems = this.items.filter((entry) => (
        scopedOrderIds.has(Number(entry.orderId))
        && entry.sub2apiAccountId !== null
        && entry.sub2apiAccountId !== undefined
      ));
      return {
        totalOrders: scopedOrders.length,
        activeOrders: scopedOrders.filter((entry) => activeStatuses.includes(entry.status)).length,
        completedOrders: scopedOrders.filter((entry) => entry.status === 'completed').length,
        totalCostCny: scopedOrders.reduce((sum, entry) => sum + Number(entry.actualPaidAmountCny || 0), 0),
        importedAccounts: scopedOrders.reduce((sum, entry) => sum + Number(entry.validQuantity || 0), 0),
        effectiveAccounts: scopedItems.filter((entry) => ['healthy', 'quota_unknown'].includes(entry.healthStatus)).length,
        lowQuotaAccounts: scopedItems.filter((entry) => entry.healthStatus === 'low_quota').length,
        unavailableAccounts: scopedItems.filter((entry) => entry.healthStatus === 'unavailable').length,
        repairingAccounts: scopedItems.filter((entry) => entry.healthStatus === 'repairing').length,
      };
    }
    const result = await this.pool.query(`
      WITH scoped_orders AS MATERIALIZED (
        SELECT id,status,actual_paid_amount_cny,valid_quantity
        FROM ${this.schema}.oauth_supply_orders
        WHERE created_at>=$2 AND created_at<$3
      ),
      order_summary AS (
        SELECT
          COUNT(*)::int AS total_orders,
          COUNT(*) FILTER (WHERE status=ANY($1::text[]))::int AS active_orders,
          COUNT(*) FILTER (WHERE status='completed')::int AS completed_orders,
          COALESCE(SUM(actual_paid_amount_cny),0) AS total_cost_cny,
          COALESCE(SUM(valid_quantity),0)::int AS imported_accounts
        FROM scoped_orders
      ),
      item_summary AS (
        SELECT
          COUNT(*) FILTER (
            WHERE item.health_status=ANY(ARRAY['healthy','quota_unknown']::text[])
          )::int AS effective_accounts,
          COUNT(*) FILTER (WHERE item.health_status='low_quota')::int AS low_quota_accounts,
          COUNT(*) FILTER (WHERE item.health_status='unavailable')::int AS unavailable_accounts,
          COUNT(*) FILTER (WHERE item.health_status='repairing')::int AS repairing_accounts
        FROM ${this.schema}.oauth_supply_order_items item
        JOIN scoped_orders scoped_order ON scoped_order.id=item.order_id
        WHERE item.sub2api_account_id IS NOT NULL
      )
      SELECT
        order_summary.*,
        item_summary.*
      FROM order_summary
      CROSS JOIN item_summary`, [activeStatuses, rangeStart, rangeEnd]);
    return {
      totalOrders: Number(result.rows[0]?.total_orders || 0),
      activeOrders: Number(result.rows[0]?.active_orders || 0),
      completedOrders: Number(result.rows[0]?.completed_orders || 0),
      totalCostCny: Number(result.rows[0]?.total_cost_cny || 0),
      importedAccounts: Number(result.rows[0]?.imported_accounts || 0),
      effectiveAccounts: Number(result.rows[0]?.effective_accounts || 0),
      lowQuotaAccounts: Number(result.rows[0]?.low_quota_accounts || 0),
      unavailableAccounts: Number(result.rows[0]?.unavailable_accounts || 0),
      repairingAccounts: Number(result.rows[0]?.repairing_accounts || 0),
    };
  }

  async listOrderPage({
    page = 1, pageSize = 20, offset = 0, search = '', filters = {},
    start = null, end = null, sortBy = 'created_at', sortOrder = 'desc',
  } = {}) {
    if (this.demo) {
      const rangeStart = start ? new Date(start).getTime() : Number.NEGATIVE_INFINITY;
      const rangeEnd = end ? new Date(end).getTime() : Number.POSITIVE_INFINITY;
      const rows = this.orders.map((entry) => {
          const selectedItems = this.items.filter((itemEntry) => itemEntry.orderId === entry.id);
          const selectedRule = this.rules.find((ruleEntry) => ruleEntry.id === entry.ruleId);
          const selectedRun = this.runs.find((runEntry) => runEntry.id === entry.runId);
          return {
            ...entry,
            ruleName: selectedRule?.name || entry.ruleName || '',
            trigger: selectedRun?.trigger || '',
            mode: selectedRun?.mode || selectedRule?.mode || '',
            targetGroupIds: [...(selectedRule?.targetGroupIds || [])],
            itemCount: selectedItems.length,
            failedQuantity: Number(selectedRun?.failedQuantity || 0),
            pendingDeliveryQuantity: Math.max(0, Number(entry.requestedQuantity || 0) - Number(entry.deliveredQuantity || 0)),
            pendingImportQuantity: Math.max(0, Number(entry.deliveredQuantity || 0) - Number(entry.validQuantity || 0)),
            healthyItemCount: selectedItems.filter((itemEntry) => ['healthy', 'quota_unknown'].includes(itemEntry.healthStatus)).length,
            lowQuotaItemCount: selectedItems.filter((itemEntry) => itemEntry.healthStatus === 'low_quota').length,
            unavailableItemCount: selectedItems.filter((itemEntry) => itemEntry.healthStatus === 'unavailable').length,
            repairingItemCount: selectedItems.filter((itemEntry) => itemEntry.healthStatus === 'repairing').length,
          };
        })
        .filter((entry) => {
          const query = String(search || '').toLocaleLowerCase();
          const selectedItems = this.items.filter((itemEntry) => itemEntry.orderId === entry.id);
          const matchesSearch = !query || [
            entry.id, entry.externalOrderId, entry.ruleName, entry.product,
            ...selectedItems.flatMap((itemEntry) => [
              itemEntry.accountName, itemEntry.externalAccountKey, itemEntry.sub2apiAccountId,
            ]),
          ].some((value) => String(value ?? '').toLocaleLowerCase().includes(query));
          const includes = (value, filter) => !filter
            || String(value ?? '').toLocaleLowerCase().includes(String(filter).toLocaleLowerCase());
          return matchesSearch
            && new Date(entry.createdAt).getTime() >= rangeStart
            && new Date(entry.createdAt).getTime() < rangeEnd
            && includes(entry.id, filters.orderId)
            && includes(entry.externalOrderId, filters.externalOrderId)
            && (!filters.accountName || selectedItems.some((itemEntry) => includes(
              `${itemEntry.accountName} ${itemEntry.externalAccountKey}`,
              filters.accountName,
            )))
            && (!filters.sub2apiAccountId || selectedItems.some((itemEntry) => includes(
              itemEntry.sub2apiAccountId,
              filters.sub2apiAccountId,
            )))
            && includes(`${entry.ruleName} ${entry.product}`, filters.ruleProduct)
            && includes(entry.status, filters.status);
        });
      const demoSortKeys = {
        created_at: 'createdAt',
        updated_at: 'updatedAt',
        id: 'id',
        external_order_id: 'externalOrderId',
        status: 'status',
        requested_quantity: 'requestedQuantity',
        delivered_quantity: 'deliveredQuantity',
        valid_quantity: 'validQuantity',
        actual_paid_amount_cny: 'actualPaidAmountCny',
      };
      const sortedRows = sortDemoRows(rows, demoSortKeys[sortBy] || 'createdAt', sortOrder);
      const total = sortedRows.length;
      return {
        items: sortedRows.slice(offset, offset + pageSize).map((entry) => {
          const next = { ...entry };
          delete next.payloadCiphertext;
          return next;
        }),
        page,
        pageSize,
        total,
        pages: Math.ceil(total / pageSize),
      };
    }
    const query = String(search || '').trim();
    const selectedFilters = {
      orderId: String(filters.orderId || '').trim(),
      externalOrderId: String(filters.externalOrderId || '').trim(),
      accountName: String(filters.accountName || '').trim(),
      sub2apiAccountId: String(filters.sub2apiAccountId || '').trim(),
      ruleProduct: String(filters.ruleProduct || '').trim(),
      status: String(filters.status || '').trim(),
    };
    const orderSortColumns = {
      created_at: 'created_at',
      updated_at: 'updated_at',
      id: 'id',
      external_order_id: 'external_order_id',
      status: 'status',
      requested_quantity: 'requested_quantity',
      delivered_quantity: 'delivered_quantity',
      valid_quantity: 'valid_quantity',
      actual_paid_amount_cny: 'actual_paid_amount_cny',
    };
    const sortColumn = orderSortColumns[sortBy] || orderSortColumns.created_at;
    const direction = sortOrder === 'asc' ? 'ASC' : 'DESC';
    const values = [];
    const parameter = (value) => {
      values.push(value);
      return `$${values.length}`;
    };
    const rangeStart = start ? new Date(start) : new Date(0);
    const rangeEnd = end ? new Date(end) : new Date('9999-12-31T23:59:59.999Z');
    const conditions = [
      `o.created_at>=${parameter(rangeStart)}`,
      `o.created_at<${parameter(rangeEnd)}`,
    ];
    if (query) {
      const placeholder = parameter(query);
      conditions.push(`(o.id::text ILIKE '%'||${placeholder}||'%'
        OR COALESCE(o.external_order_id,'') ILIKE '%'||${placeholder}||'%'
        OR r.name ILIKE '%'||${placeholder}||'%'
        OR o.product ILIKE '%'||${placeholder}||'%'
        OR EXISTS (
          SELECT 1 FROM ${this.schema}.oauth_supply_order_items search_item
          WHERE search_item.order_id=o.id
            AND (search_item.account_name ILIKE '%'||${placeholder}||'%'
              OR COALESCE(search_item.external_account_key,'') ILIKE '%'||${placeholder}||'%'
              OR COALESCE(search_item.sub2api_account_id::text,'') ILIKE '%'||${placeholder}||'%')
        ))`);
    }
    if (selectedFilters.orderId) {
      const placeholder = parameter(selectedFilters.orderId);
      conditions.push(/^\d+$/.test(selectedFilters.orderId)
        ? `o.id=${placeholder}::bigint`
        : `o.id::text ILIKE '%'||${placeholder}||'%'`);
    }
    if (selectedFilters.externalOrderId) {
      const placeholder = parameter(selectedFilters.externalOrderId);
      conditions.push(`COALESCE(o.external_order_id,'') ILIKE '%'||${placeholder}||'%'`);
    }
    if (selectedFilters.accountName) {
      const placeholder = parameter(selectedFilters.accountName);
      conditions.push(`EXISTS (
        SELECT 1 FROM ${this.schema}.oauth_supply_order_items account_item
        WHERE account_item.order_id=o.id
          AND (account_item.account_name ILIKE '%'||${placeholder}||'%'
            OR COALESCE(account_item.external_account_key,'') ILIKE '%'||${placeholder}||'%')
      )`);
    }
    if (selectedFilters.sub2apiAccountId) {
      const placeholder = parameter(selectedFilters.sub2apiAccountId);
      conditions.push(`EXISTS (
        SELECT 1 FROM ${this.schema}.oauth_supply_order_items sub2api_item
        WHERE sub2api_item.order_id=o.id
          AND COALESCE(sub2api_item.sub2api_account_id::text,'') ILIKE '%'||${placeholder}||'%'
      )`);
    }
    if (selectedFilters.ruleProduct) {
      const placeholder = parameter(selectedFilters.ruleProduct);
      conditions.push(`(r.name ILIKE '%'||${placeholder}||'%' OR o.product ILIKE '%'||${placeholder}||'%')`);
    }
    if (selectedFilters.status) {
      conditions.push(`o.status=${parameter(selectedFilters.status)}`);
    }
    const limitPlaceholder = parameter(pageSize);
    const offsetPlaceholder = parameter(offset);
    const result = await this.pool.query(`
      WITH filtered_orders AS MATERIALIZED (
        SELECT o.*,r.name AS rule_name,run.trigger,run.mode AS run_mode,
          run.failed_quantity,m.target_group_ids
        FROM ${this.schema}.oauth_supply_orders o
        JOIN ${this.schema}.replenishment_rules r ON r.id=o.rule_id
        JOIN ${this.schema}.replenishment_runs run ON run.id=o.run_id
        JOIN ${this.schema}.oauth_supply_product_mappings m ON m.id=r.product_mapping_id
        WHERE ${conditions.join('\n          AND ')}
      ),
      paged_orders AS (
        SELECT filtered_orders.*,(COUNT(*) OVER())::int AS total_count
        FROM filtered_orders
        ORDER BY ${sortColumn} ${direction} NULLS LAST,id DESC
        LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
      )
      SELECT paged_orders.*,
        item_stats.item_count,item_stats.healthy_item_count,item_stats.low_quota_item_count,
        item_stats.unavailable_item_count,item_stats.repairing_item_count
      FROM paged_orders
      LEFT JOIN LATERAL (
        SELECT
          COUNT(item.id)::int AS item_count,
          COUNT(item.id) FILTER (WHERE item.health_status=ANY(ARRAY['healthy','quota_unknown']::text[]))::int AS healthy_item_count,
          COUNT(item.id) FILTER (WHERE item.health_status='low_quota')::int AS low_quota_item_count,
          COUNT(item.id) FILTER (WHERE item.health_status='unavailable')::int AS unavailable_item_count,
          COUNT(item.id) FILTER (WHERE item.health_status='repairing')::int AS repairing_item_count
        FROM ${this.schema}.oauth_supply_order_items item
        WHERE item.order_id=paged_orders.id
      ) item_stats ON TRUE
      ORDER BY paged_orders.${sortColumn} ${direction} NULLS LAST,paged_orders.id DESC`,
    values);
    const total = Number(result.rows[0]?.total_count || 0);
    return {
      items: result.rows.map((row) => {
        const next = order(row);
        delete next.payloadCiphertext;
        return next;
      }),
      page,
      pageSize,
      total,
      pages: Math.ceil(total / pageSize),
    };
  }

  async listRecoveryFeed({
    scope = 'pending', page = 1, pageSize = 20, offset = 0,
    search = '', filters = {}, start = null, end = null,
    sortBy = 'created_at', sortOrder = 'desc',
  } = {}) {
    if (this.demo) {
      const rangeStart = start ? new Date(start).getTime() : Number.NEGATIVE_INFINITY;
      const rangeEnd = end ? new Date(end).getTime() : Number.POSITIVE_INFINITY;
      const recoveryItemIds = new Set(this.recoveries.map((entry) => Number(entry.orderItemId)));
      const accountEntries = await Promise.all(this.recoveries.map(async (entry) => {
        const job = await this.getRecovery(entry.id);
        const selectedItem = this.items.find((itemEntry) => itemEntry.id === job.orderItemId);
        const selectedOrder = this.orders.find((orderEntry) => orderEntry.id === selectedItem?.orderId);
        const selectedRule = this.rules.find((ruleEntry) => ruleEntry.id === job.ruleId);
        return {
          id: String(job.id),
          recoveryId: job.id,
          kind: 'account',
          orderItemId: job.orderItemId,
          orderId: selectedOrder?.id || selectedItem?.orderId,
          externalOrderId: selectedOrder?.externalOrderId || '',
          ruleId: job.ruleId,
          ruleName: selectedRule?.name || '',
          product: selectedOrder?.product || '',
          platform: selectedOrder?.platform || selectedRule?.platform || '',
          targetPoolKey: selectedOrder?.targetPoolKey || '',
          targetGroupIds: [...(selectedRule?.targetGroupIds || [])],
          accountName: selectedItem?.accountName || job.accountName || job.accountKey,
          externalAccountKey: selectedItem?.externalAccountKey || job.accountKey || '',
          targetAccountId: job.sub2apiAccountId,
          status: job.status,
          deliveryStatus: job.deliveryStatus || '',
          credentialVersion: job.credentialVersion || '',
          attemptCount: Number(job.attemptCount || 0),
          nextRetryAt: job.nextRetryAt || null,
          firstSeenAt: job.firstSeenAt || null,
          lastSeenAt: job.lastSeenAt || null,
          claimedAt: job.claimedAt || null,
          recoveredAt: job.recoveredAt || null,
          completionSource: job.completionSource || '',
          healthStatus: selectedItem?.healthStatus || 'unknown',
          quotaUsedPercent: selectedItem?.quotaUsedPercent ?? null,
          quotaWindow: selectedItem?.quotaWindow || '',
          lastHealthAt: selectedItem?.lastHealthAt || null,
          accountCostCny: selectedItem?.finalCostCny ?? selectedItem?.individualCostCny ?? null,
          lastError: job.lastError || '',
          createdAt: job.createdAt || null,
          updatedAt: job.updatedAt || null,
          ready: ['claimable', 'credentials_saved', 'retry_wait', 'manual_required'].includes(job.status),
        };
      }));
      const importEntries = this.items
        .filter((entry) => ['retry_wait', 'manual_required'].includes(entry.status))
        .map((entry) => {
          const selectedOrder = this.orders.find((orderEntry) => orderEntry.id === entry.orderId);
          const selectedRule = this.rules.find((ruleEntry) => ruleEntry.id === selectedOrder?.ruleId);
          return {
            id: `import:${entry.id}`,
            recoveryId: null,
            kind: 'import',
            orderItemId: entry.id,
            orderId: entry.orderId,
            externalOrderId: selectedOrder?.externalOrderId || '',
            ruleId: selectedOrder?.ruleId,
            ruleName: selectedRule?.name || '',
            product: selectedOrder?.product || '',
            platform: selectedOrder?.platform || '',
            targetPoolKey: selectedOrder?.targetPoolKey || '',
            targetGroupIds: [...(selectedRule?.targetGroupIds || [])],
            accountName: entry.accountName,
            externalAccountKey: entry.externalAccountKey || '',
            targetAccountId: entry.sub2apiAccountId,
            status: entry.status,
            deliveryStatus: '',
            credentialVersion: entry.credentialVersion || '',
            attemptCount: Number(entry.importAttemptCount || 0),
            nextRetryAt: entry.nextImportRetryAt || null,
            firstSeenAt: entry.createdAt || null,
            lastSeenAt: entry.updatedAt || null,
            claimedAt: null,
            recoveredAt: null,
            completionSource: '',
            healthStatus: entry.healthStatus || 'unknown',
            quotaUsedPercent: entry.quotaUsedPercent ?? null,
            quotaWindow: entry.quotaWindow || '',
            lastHealthAt: entry.lastHealthAt || null,
            accountCostCny: entry.finalCostCny ?? entry.individualCostCny ?? null,
            lastError: entry.errorMessage || '',
            createdAt: entry.createdAt || null,
            updatedAt: entry.updatedAt || null,
            ready: true,
          };
        });
      const completedImports = this.items
        .filter((entry) => !recoveryItemIds.has(Number(entry.id))
          && entry.status === 'imported'
          && ['passed', 'repaired'].includes(entry.verificationStatus)
          && Number(entry.importAttemptCount || 0) > 0)
        .map((entry) => {
          const selectedOrder = this.orders.find((orderEntry) => orderEntry.id === entry.orderId);
          const selectedRule = this.rules.find((ruleEntry) => ruleEntry.id === selectedOrder?.ruleId);
          return {
            id: `import-completed:${entry.id}`,
            recoveryId: null,
            kind: 'import',
            orderItemId: entry.id,
            orderId: entry.orderId,
            externalOrderId: selectedOrder?.externalOrderId || '',
            ruleId: selectedOrder?.ruleId,
            ruleName: selectedRule?.name || '',
            product: selectedOrder?.product || '',
            platform: selectedOrder?.platform || '',
            targetPoolKey: selectedOrder?.targetPoolKey || '',
            targetGroupIds: [...(selectedRule?.targetGroupIds || [])],
            accountName: entry.accountName,
            externalAccountKey: entry.externalAccountKey || '',
            targetAccountId: entry.sub2apiAccountId,
            status: 'recovered',
            deliveryStatus: '',
            credentialVersion: entry.credentialVersion || '',
            attemptCount: Number(entry.importAttemptCount || 0),
            nextRetryAt: null,
            firstSeenAt: entry.createdAt || null,
            lastSeenAt: entry.updatedAt || null,
            claimedAt: null,
            recoveredAt: entry.updatedAt || null,
            completionSource: 'system',
            healthStatus: entry.healthStatus || 'unknown',
            quotaUsedPercent: entry.quotaUsedPercent ?? null,
            quotaWindow: entry.quotaWindow || '',
            lastHealthAt: entry.lastHealthAt || null,
            accountCostCny: entry.finalCostCny ?? entry.individualCostCny ?? null,
            lastError: '',
            createdAt: entry.createdAt || null,
            updatedAt: entry.updatedAt || null,
            ready: false,
          };
        });
      const query = String(search || '').toLocaleLowerCase();
      const all = [...accountEntries, ...importEntries, ...completedImports]
        .filter((entry) => {
          const includes = (value, filter) => !filter
            || String(value ?? '').toLocaleLowerCase().includes(String(filter).toLocaleLowerCase());
          const matchesSearch = !query || [
            entry.accountName, entry.externalAccountKey, entry.orderId, entry.externalOrderId,
            entry.targetAccountId, entry.product, entry.ruleName, entry.status,
          ].some((value) => String(value ?? '').toLocaleLowerCase().includes(query));
          return matchesSearch
            && new Date(entry.createdAt).getTime() >= rangeStart
            && new Date(entry.createdAt).getTime() < rangeEnd
            && includes(`${entry.accountName} ${entry.externalAccountKey}`, filters.accountName)
            && includes(entry.orderId, filters.orderId)
            && includes(entry.externalOrderId, filters.externalOrderId)
            && includes(entry.targetAccountId, filters.sub2apiAccountId)
            && includes(entry.status, filters.status);
        });
      const demoSortKeys = {
        created_at: 'createdAt',
        updated_at: 'updatedAt',
        account_name: 'accountName',
        order_id: 'orderId',
        external_order_id: 'externalOrderId',
        sub2api_account_id: 'targetAccountId',
        status: 'status',
        attempt_count: 'attemptCount',
        claimed_at: 'claimedAt',
        recovered_at: 'recoveredAt',
        account_cost_cny: 'accountCostCny',
      };
      const sorted = sortDemoRows(all, demoSortKeys[sortBy] || 'createdAt', sortOrder);
      const pendingTotal = sorted.filter((entry) => entry.status !== 'recovered').length;
      const completedTotal = sorted.filter((entry) => entry.status === 'recovered').length;
      const filtered = sorted.filter((entry) => scope === 'all'
        || (scope === 'completed' ? entry.status === 'recovered' : entry.status !== 'recovered'));
      return {
        items: filtered.slice(offset, offset + pageSize),
        page,
        pageSize,
        total: filtered.length,
        pages: Math.ceil(filtered.length / pageSize),
        pendingTotal,
        completedTotal,
      };
    }

    const rangeStart = start ? new Date(start) : new Date(0);
    const rangeEnd = end ? new Date(end) : new Date('9999-12-31T23:59:59.999Z');
    const feedSql = `
      WITH recovery_feed AS (
        SELECT
          rr.id::text AS feed_id,rr.id AS recovery_id,'account'::text AS kind,
          i.id AS order_item_id,i.order_id,o.external_order_id,o.rule_id,r.name AS rule_name,
          o.product,o.platform,o.target_pool_key,m.target_group_ids,
          i.account_name,i.external_account_key,rr.sub2api_account_id,
          rr.status,rr.delivery_status,rr.credential_version,rr.attempt_count,
          rr.next_retry_at,rr.first_seen_at,rr.last_seen_at,rr.claimed_at,rr.recovered_at,
          rr.completion_source,i.health_status,i.quota_used_percent,i.quota_window,
          i.last_health_at,COALESCE(i.final_cost_cny,i.individual_cost_cny) AS account_cost_cny,
          rr.last_error,rr.created_at,rr.updated_at
        FROM ${this.schema}.replenishment_recoveries rr
        JOIN ${this.schema}.oauth_supply_order_items i ON i.id=rr.order_item_id
        JOIN ${this.schema}.oauth_supply_orders o ON o.id=i.order_id
        JOIN ${this.schema}.replenishment_rules r ON r.id=o.rule_id
        JOIN ${this.schema}.oauth_supply_product_mappings m ON m.id=r.product_mapping_id
        WHERE rr.created_at>=$1 AND rr.created_at<$2

        UNION ALL

        SELECT
          'import:'||i.id::text AS feed_id,NULL::bigint AS recovery_id,'import'::text AS kind,
          i.id AS order_item_id,i.order_id,o.external_order_id,o.rule_id,r.name AS rule_name,
          o.product,o.platform,o.target_pool_key,m.target_group_ids,
          i.account_name,i.external_account_key,i.sub2api_account_id,
          i.status,''::text AS delivery_status,i.credential_version,i.import_attempt_count AS attempt_count,
          i.next_import_retry_at AS next_retry_at,i.created_at AS first_seen_at,
          i.updated_at AS last_seen_at,NULL::timestamptz AS claimed_at,
          NULL::timestamptz AS recovered_at,
          ''::text AS completion_source,i.health_status,i.quota_used_percent,i.quota_window,
          i.last_health_at,COALESCE(i.final_cost_cny,i.individual_cost_cny) AS account_cost_cny,
          i.error_message AS last_error,i.created_at,i.updated_at
        FROM ${this.schema}.oauth_supply_order_items i
        JOIN ${this.schema}.oauth_supply_orders o ON o.id=i.order_id
        JOIN ${this.schema}.replenishment_rules r ON r.id=o.rule_id
        JOIN ${this.schema}.oauth_supply_product_mappings m ON m.id=r.product_mapping_id
        WHERE i.created_at>=$1 AND i.created_at<$2
          AND i.status=ANY(ARRAY['retry_wait','manual_required']::text[])

        UNION ALL

        SELECT
          'import-completed:'||i.id::text AS feed_id,NULL::bigint AS recovery_id,'import'::text AS kind,
          i.id AS order_item_id,i.order_id,o.external_order_id,o.rule_id,r.name AS rule_name,
          o.product,o.platform,o.target_pool_key,m.target_group_ids,
          i.account_name,i.external_account_key,i.sub2api_account_id,
          'recovered'::text AS status,''::text AS delivery_status,i.credential_version,
          i.import_attempt_count AS attempt_count,NULL::timestamptz AS next_retry_at,
          i.created_at AS first_seen_at,i.updated_at AS last_seen_at,
          NULL::timestamptz AS claimed_at,i.updated_at AS recovered_at,
          COALESCE(NULLIF(i.repair_completion_source,''),'system')::text AS completion_source,
          i.health_status,i.quota_used_percent,i.quota_window,
          i.last_health_at,COALESCE(i.final_cost_cny,i.individual_cost_cny) AS account_cost_cny,
          ''::text AS last_error,i.created_at,i.updated_at
        FROM ${this.schema}.oauth_supply_order_items i
        JOIN ${this.schema}.oauth_supply_orders o ON o.id=i.order_id
        JOIN ${this.schema}.replenishment_rules r ON r.id=o.rule_id
        JOIN ${this.schema}.oauth_supply_product_mappings m ON m.id=r.product_mapping_id
        WHERE i.created_at>=$1 AND i.created_at<$2
          AND i.status='imported'
          AND i.verification_status=ANY(ARRAY['passed','repaired']::text[])
          AND i.import_attempt_count>0
          AND NOT EXISTS (
            SELECT 1 FROM ${this.schema}.replenishment_recoveries rr
            WHERE rr.order_item_id=i.id
          )
      )`;
    const query = String(search || '').trim();
    const selectedFilters = {
      accountName: String(filters.accountName || '').trim(),
      orderId: String(filters.orderId || '').trim(),
      externalOrderId: String(filters.externalOrderId || '').trim(),
      sub2apiAccountId: String(filters.sub2apiAccountId || '').trim(),
      status: String(filters.status || '').trim(),
    };
    const recoverySortColumns = {
      created_at: 'created_at',
      updated_at: 'updated_at',
      account_name: 'account_name',
      order_id: 'order_id',
      external_order_id: 'external_order_id',
      sub2api_account_id: 'sub2api_account_id',
      status: 'status',
      attempt_count: 'attempt_count',
      claimed_at: 'claimed_at',
      recovered_at: 'recovered_at',
      account_cost_cny: 'account_cost_cny',
    };
    const sortColumn = recoverySortColumns[sortBy] || recoverySortColumns.created_at;
    const direction = sortOrder === 'asc' ? 'ASC' : 'DESC';
    const searchCondition = (placeholder) => `
      (${placeholder}='' OR account_name ILIKE '%'||${placeholder}||'%'
        OR COALESCE(external_account_key,'') ILIKE '%'||${placeholder}||'%'
        OR order_id::text ILIKE '%'||${placeholder}||'%'
        OR COALESCE(external_order_id,'') ILIKE '%'||${placeholder}||'%'
        OR COALESCE(sub2api_account_id::text,'') ILIKE '%'||${placeholder}||'%'
        OR product ILIKE '%'||${placeholder}||'%'
        OR rule_name ILIKE '%'||${placeholder}||'%'
        OR status ILIKE '%'||${placeholder}||'%')`;
    const filterCondition = (startIndex) => `
      AND ($${startIndex}='' OR account_name ILIKE '%'||$${startIndex}||'%'
        OR COALESCE(external_account_key,'') ILIKE '%'||$${startIndex}||'%')
      AND ($${startIndex + 1}='' OR order_id::text ILIKE '%'||$${startIndex + 1}||'%')
      AND ($${startIndex + 2}='' OR COALESCE(external_order_id,'') ILIKE '%'||$${startIndex + 2}||'%')
      AND ($${startIndex + 3}='' OR COALESCE(sub2api_account_id::text,'') ILIKE '%'||$${startIndex + 3}||'%')
      AND ($${startIndex + 4}='' OR status ILIKE '%'||$${startIndex + 4}||'%')`;
    const filterValues = [
      selectedFilters.accountName, selectedFilters.orderId, selectedFilters.externalOrderId,
      selectedFilters.sub2apiAccountId, selectedFilters.status,
    ];
    const [itemsResult, totalsResult] = await Promise.all([
      this.pool.query(`${feedSql}
        SELECT recovery_feed.*,COUNT(*) OVER() AS total_count
        FROM recovery_feed
        WHERE ($3='all'
          OR ($3='completed' AND status='recovered')
          OR ($3='pending' AND status<>'recovered'))
          AND ${searchCondition('$4')}
          ${filterCondition(5)}
        ORDER BY ${sortColumn} ${direction} NULLS LAST,order_item_id DESC,feed_id DESC
        LIMIT $10 OFFSET $11`,
      [rangeStart, rangeEnd, scope, query, ...filterValues, pageSize, offset]),
      this.pool.query(`${feedSql}
        SELECT
          COUNT(*) FILTER (WHERE status<>'recovered')::int AS pending_total,
          COUNT(*) FILTER (WHERE status='recovered')::int AS completed_total
        FROM recovery_feed
        WHERE ${searchCondition('$3')}
          ${filterCondition(4)}`, [rangeStart, rangeEnd, query, ...filterValues]),
    ]);
    const pendingTotal = Number(totalsResult.rows[0]?.pending_total || 0);
    const completedTotal = Number(totalsResult.rows[0]?.completed_total || 0);
    const total = scope === 'pending'
      ? pendingTotal
      : scope === 'completed'
        ? completedTotal
        : pendingTotal + completedTotal;
    return {
      items: itemsResult.rows.map(recoveryFeedEntry),
      page,
      pageSize,
      total,
      pages: Math.ceil(total / pageSize),
      pendingTotal,
      completedTotal,
    };
  }

  async listPollableOrders() {
    const statuses = ['ordering', 'queued', 'processing', 'ready_to_collect', 'importing'];
    if (this.demo) return this.orders.filter((entry) => statuses.includes(entry.status));
    const result = await this.pool.query(`
      SELECT o.*,r.name AS rule_name
      FROM ${this.schema}.oauth_supply_orders o
      JOIN ${this.schema}.replenishment_rules r ON r.id=o.rule_id
      WHERE o.status=ANY($1::text[]) AND (o.next_poll_at IS NULL OR o.next_poll_at<=NOW())
      ORDER BY o.updated_at LIMIT 20`, [statuses]);
    return result.rows.map(order);
  }

  async listImportRetryItems({ limit = 30, dueOnly = true, includeManual = false } = {}) {
    const statuses = includeManual ? ['retry_wait', 'manual_required'] : ['retry_wait'];
    if (this.demo) {
      return this.items.filter((entry) => statuses.includes(entry.status)
        && (!dueOnly || !entry.nextImportRetryAt || Date.parse(entry.nextImportRetryAt) <= Date.now()))
        .slice(0, limit).map((entry) => ({ ...entry,
          order: this.orders.find((candidate) => candidate.id === entry.orderId) || null,
          rule: this.rules.find((candidate) => candidate.id === this.orders.find((candidate) => candidate.id === entry.orderId)?.ruleId) || null,
        }));
    }
    const result = await this.pool.query(`
      SELECT i.*,o.rule_id,o.run_id,o.requested_quantity,o.valid_quantity AS order_valid_quantity,
        o.delivered_quantity,o.actual_paid_amount_cny,o.quoted_amount_cny,o.status AS order_status,
        o.product,o.platform,o.target_pool_key,o.external_order_id,
        r.name AS rule_name,m.target_group_ids,r.concurrency,r.load_factor,r.proxy_id,r.priority,
        r.rate_multiplier,r.auto_pause_on_expired,m.platform AS rule_platform,
        r.verification_model,r.verification_prompt,r.model_whitelist,
        policy.enabled AS recovery_enabled,policy.mode AS recovery_mode,
        policy.retry_limit AS recovery_policy_retry_limit,
        policy.retry_interval_seconds AS recovery_retry_interval_seconds
      FROM ${this.schema}.oauth_supply_order_items i
      JOIN ${this.schema}.oauth_supply_orders o ON o.id=i.order_id
      JOIN ${this.schema}.replenishment_rules r ON r.id=o.rule_id
      JOIN ${this.schema}.oauth_supply_product_mappings m ON m.id=r.product_mapping_id
      LEFT JOIN ${this.schema}.replenishment_recovery_policies policy ON policy.rule_id=o.rule_id
      WHERE i.status=ANY($2::text[])
        AND ($3::boolean=FALSE OR i.next_import_retry_at IS NULL OR i.next_import_retry_at<=NOW())
      ORDER BY i.updated_at,i.id LIMIT $1`, [limit, statuses, dueOnly]);
    return result.rows.map((row) => ({
      ...item(row),
      order: {
        id: Number(row.order_id), runId: Number(row.run_id), ruleId: Number(row.rule_id),
        requestedQuantity: Number(row.requested_quantity || 0), validQuantity: Number(row.order_valid_quantity || 0),
        deliveredQuantity: Number(row.delivered_quantity || 0), actualPaidAmountCny: number(row.actual_paid_amount_cny),
        quotedAmountCny: number(row.quoted_amount_cny), status: row.order_status,
        product: row.product, platform: row.platform, targetPoolKey: row.target_pool_key,
        externalOrderId: row.external_order_id || '',
      },
      rule: {
        id: Number(row.rule_id), name: row.rule_name, targetGroupIds: (row.target_group_ids || []).map(Number),
        concurrency: Number(row.concurrency || 1), loadFactor: number(row.load_factor), proxyId: number(row.proxy_id),
        priority: Number(row.priority || 0), rateMultiplier: Number(row.rate_multiplier ?? 1),
        autoPauseOnExpired: row.auto_pause_on_expired === undefined ? true : Boolean(row.auto_pause_on_expired),
        platform: row.rule_platform || row.platform, verificationModel: row.verification_model,
        verificationPrompt: row.verification_prompt,
        modelWhitelist: Array.isArray(row.model_whitelist) ? row.model_whitelist.map(String).filter(Boolean) : [],
      },
      recoveryPolicy: {
        enabled: row.recovery_enabled === undefined ? true : Boolean(row.recovery_enabled),
        mode: row.recovery_mode || 'manual',
        retryLimit: row.recovery_policy_retry_limit === null || row.recovery_policy_retry_limit === undefined
          ? null : Number(row.recovery_policy_retry_limit),
        retryIntervalSeconds: Number(row.recovery_retry_interval_seconds || 60),
      },
    }));
  }

  async listCompletedImportRepairs({ limit = 100 } = {}) {
    if (this.demo) {
      return this.items
        .filter((entry) => entry.status === 'imported'
          && ['passed', 'repaired'].includes(entry.verificationStatus)
          && Number(entry.importAttemptCount || 0) > 0)
        .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0))
        .slice(0, limit)
        .map((entry) => ({
          ...entry,
          order: this.orders.find((candidate) => candidate.id === entry.orderId) || null,
        }));
    }
    const result = await this.pool.query(`
      SELECT i.*,o.rule_id,o.external_order_id
      FROM ${this.schema}.oauth_supply_order_items i
      JOIN ${this.schema}.oauth_supply_orders o ON o.id=i.order_id
      WHERE i.status='imported'
        AND i.verification_status=ANY($2::text[])
        AND i.import_attempt_count>0
      ORDER BY i.updated_at DESC,i.id DESC
      LIMIT $1`, [limit, ['passed', 'repaired']]);
    return result.rows.map((row) => ({
      ...item(row),
      order: {
        id: Number(row.order_id),
        ruleId: Number(row.rule_id),
        externalOrderId: row.external_order_id || '',
      },
    }));
  }

  async updateOrder(id, updates) {
    if (this.demo) {
      const current = this.orders.find((entry) => entry.id === Number(id));
      if (!current) return null;
      Object.assign(current, updates, { updatedAt: new Date().toISOString() });
      return { ...current };
    }
    const current = await this.getOrder(id);
    if (!current) return null;
    const merged = { ...current, ...updates };
    const result = await this.pool.query(`
      UPDATE ${this.schema}.oauth_supply_orders SET
        external_order_id=$2,status=$3,delivered_quantity=$4,valid_quantity=$5,
        quoted_amount_cny=$6,actual_paid_amount_cny=$7,released_amount_cny=$8,payload_ciphertext=$9,
        last_error=$10,failure_count=$11,next_poll_at=$12,approved_by=$13,approved_at=$14,updated_at=NOW()
      WHERE id=$1 RETURNING *`,
    [id, merged.externalOrderId || null, merged.status, merged.deliveredQuantity,
      merged.validQuantity, merged.quotedAmountCny, merged.actualPaidAmountCny, merged.releasedAmountCny,
      merged.payloadCiphertext || '', String(merged.lastError || '').slice(0, 1000),
      Number(merged.failureCount || 0), merged.nextPollAt, merged.approvedBy || null, merged.approvedAt]);
    return order(result.rows[0]);
  }

  async addOrderItems(orderId, values) {
    const created = [];
    for (const value of values) {
      if (this.demo) {
        const record = {
          id: ++this.sequence, orderId: Number(orderId), externalItemId: value.externalItemId || '',
          externalAccountKey: value.externalAccountKey || '', accountName: value.accountName || '',
          status: value.status || 'delivered', verificationStatus: value.verificationStatus || 'pending',
          individualCostCny: value.individualCostCny ?? null, finalCostCny: value.finalCostCny ?? null,
          credentialVersion: value.credentialVersion || '', credentialCiphertext: value.credentialCiphertext || '',
          sub2apiAccountId: value.sub2apiAccountId || null, costLedgerStatus: value.costLedgerStatus || 'pending',
          costLedgerPeriodId: value.costLedgerPeriodId || null, costLedgerError: value.costLedgerError || '',
          errorMessage: value.errorMessage || '',
          importAttemptCount: value.importAttemptCount || 0, nextImportRetryAt: value.nextImportRetryAt || null,
          repairCompletionSource: value.repairCompletionSource || '',
          capacityStartedAt: value.capacityStartedAt || new Date().toISOString(),
          healthStatus: value.healthStatus || 'unknown', quotaUsedPercent: value.quotaUsedPercent ?? null,
          quotaWindow: value.quotaWindow || '', lastHealthAt: value.lastHealthAt || null,
          metadata: itemMetadata(value.metadata), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        };
        this.items.push(record);
        created.push({ ...record });
        continue;
      }
      const result = await this.pool.query(`
        INSERT INTO ${this.schema}.oauth_supply_order_items(
          order_id,external_item_id,external_account_key,account_name,status,verification_status,
          individual_cost_cny,final_cost_cny,credential_version,credential_ciphertext,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
        ON CONFLICT(order_id,external_item_id) DO UPDATE SET
          credential_ciphertext=EXCLUDED.credential_ciphertext,
          credential_version=EXCLUDED.credential_version,metadata=EXCLUDED.metadata,updated_at=NOW()
        RETURNING *`,
      [orderId, value.externalItemId || null, value.externalAccountKey || null, value.accountName || '',
        value.status || 'delivered', value.verificationStatus || 'pending',
        value.individualCostCny ?? null, value.finalCostCny ?? null, value.credentialVersion || '',
        value.credentialCiphertext || '', JSON.stringify(itemMetadata(value.metadata))]);
      created.push(item(result.rows[0]));
    }
    return created;
  }

  async updateOrderItem(id, updates) {
    if (this.demo) {
      const current = this.items.find((entry) => entry.id === Number(id));
      if (!current) return null;
      Object.assign(current, updates, { updatedAt: new Date().toISOString() });
      return { ...current };
    }
    const currentResult = await this.pool.query(`
      SELECT * FROM ${this.schema}.oauth_supply_order_items WHERE id=$1`, [id]);
    if (!currentResult.rowCount) return null;
    const current = item(currentResult.rows[0]);
    const merged = { ...current, ...updates };
    const result = await this.pool.query(`
      UPDATE ${this.schema}.oauth_supply_order_items SET
        status=$2,verification_status=$3,individual_cost_cny=$4,final_cost_cny=$5,
        credential_version=$6,credential_ciphertext=$7,sub2api_account_id=$8,
        cost_ledger_status=$9,cost_ledger_period_id=$10,cost_ledger_error=$11,
        error_message=$12,metadata=$13::jsonb,health_status=$14,quota_used_percent=$15,
        quota_window=$16,last_health_at=$17,import_attempt_count=$18,
        next_import_retry_at=$19,repair_completion_source=$20,capacity_started_at=$21,
        updated_at=NOW()
      WHERE id=$1 RETURNING *`,
    [id, merged.status, merged.verificationStatus, merged.individualCostCny, merged.finalCostCny,
      merged.credentialVersion || '', merged.credentialCiphertext || '', merged.sub2apiAccountId,
      merged.costLedgerStatus || 'pending', merged.costLedgerPeriodId,
      String(merged.costLedgerError || '').slice(0, 1000),
      String(merged.errorMessage || '').slice(0, 1000), JSON.stringify(itemMetadata(merged.metadata)),
      merged.healthStatus || 'unknown', merged.quotaUsedPercent ?? null, merged.quotaWindow || '',
      merged.lastHealthAt || null, Number(merged.importAttemptCount || 0), merged.nextImportRetryAt || null,
      merged.repairCompletionSource || '', merged.capacityStartedAt || current.capacityStartedAt || current.createdAt]);
    return item(result.rows[0]);
  }

  async getOrderItem(id) {
    if (this.demo) return this.items.find((entry) => entry.id === Number(id)) || null;
    const result = await this.pool.query(`
      SELECT * FROM ${this.schema}.oauth_supply_order_items WHERE id=$1`, [id]);
    return result.rowCount ? item(result.rows[0]) : null;
  }

  async listPendingCostItems({ limit = 50 } = {}) {
    if (this.demo) {
      return this.items
        .filter((entry) => entry.sub2apiAccountId && ['pending', 'failed'].includes(entry.costLedgerStatus))
        .slice(0, limit)
        .map((entry) => {
          const currentOrder = this.orders.find((candidate) => candidate.id === entry.orderId);
          const fallbackCost = currentOrder?.deliveredQuantity > 0 && currentOrder?.actualPaidAmountCny !== null
            ? Number(currentOrder.actualPaidAmountCny) / Number(currentOrder.deliveredQuantity)
            : null;
          return {
            ...entry,
            persistedFinalCostCny: entry.finalCostCny,
            finalCostCny: entry.finalCostCny ?? entry.individualCostCny ?? fallbackCost,
            order: currentOrder ? { ...currentOrder } : null,
          };
        });
    }
    const result = await this.pool.query(`
      SELECT i.*,o.external_order_id,o.product,o.platform,o.target_pool_key,o.created_at AS order_created_at,
        COALESCE(i.final_cost_cny,i.individual_cost_cny,
          CASE WHEN o.delivered_quantity>0 AND o.actual_paid_amount_cny IS NOT NULL
            THEN o.actual_paid_amount_cny/o.delivered_quantity ELSE NULL END
        ) AS resolved_final_cost_cny
      FROM ${this.schema}.oauth_supply_order_items i
      JOIN ${this.schema}.oauth_supply_orders o ON o.id=i.order_id
      WHERE i.sub2api_account_id IS NOT NULL
        AND COALESCE(i.final_cost_cny,i.individual_cost_cny,
          CASE WHEN o.delivered_quantity>0 AND o.actual_paid_amount_cny IS NOT NULL
            THEN o.actual_paid_amount_cny/o.delivered_quantity ELSE NULL END
        ) IS NOT NULL
        AND i.cost_ledger_status=ANY($2::text[])
      ORDER BY i.id
      LIMIT $1`, [limit, ['pending', 'failed']]);
    return result.rows.map((row) => ({
      ...item(row),
      persistedFinalCostCny: number(row.final_cost_cny),
      finalCostCny: number(row.resolved_final_cost_cny),
      order: {
        id: Number(row.order_id),
        externalOrderId: row.external_order_id || '',
        product: row.product,
        platform: row.platform,
        targetPoolKey: row.target_pool_key,
        createdAt: row.order_created_at || null,
      },
    }));
  }

  async findOrderItemByAccountKey(accountKey) {
    const key = String(accountKey || '').trim();
    if (!key) return null;
    if (this.demo) {
      const current = this.items.find((entry) => entry.externalAccountKey === key || entry.accountName === key);
      return current ? { ...current } : null;
    }
    const result = await this.pool.query(`
      SELECT * FROM ${this.schema}.oauth_supply_order_items
      WHERE external_account_key=$1 OR account_name=$1
      ORDER BY id DESC LIMIT 1`, [key]);
    return result.rowCount ? item(result.rows[0]) : null;
  }

  async findOrderItemByExternalOrderAndAccountKey(externalOrderId, accountKey) {
    const orderKey = String(externalOrderId || '').trim();
    const key = String(accountKey || '').trim();
    if (!orderKey || !key) return this.findOrderItemByAccountKey(key);
    if (this.demo) {
      const selectedOrder = this.orders.find((entry) => String(entry.externalOrderId) === orderKey);
      const current = this.items.find((entry) => entry.orderId === selectedOrder?.id
        && (entry.externalAccountKey === key || entry.accountName === key));
      return current ? { ...current } : null;
    }
    const result = await this.pool.query(`
      SELECT i.* FROM ${this.schema}.oauth_supply_order_items i
      JOIN ${this.schema}.oauth_supply_orders o ON o.id=i.order_id
      WHERE o.external_order_id=$1 AND (i.external_account_key=$2 OR i.account_name=$2)
      ORDER BY i.id DESC LIMIT 1`, [orderKey, key]);
    return result.rowCount ? item(result.rows[0]) : null;
  }

  async finishRun(runId, updates) {
    if (this.demo) {
      const current = this.runs.find((entry) => entry.id === Number(runId));
      if (current) Object.assign(current, updates, { finishedAt: new Date().toISOString() });
      return;
    }
    await this.pool.query(`
      UPDATE ${this.schema}.replenishment_runs SET
        status=$2,actual_paid_amount_cny=$3,delivered_quantity=$4,valid_quantity=$5,
        failed_quantity=$6,error_message=$7,finished_at=NOW()
      WHERE id=$1`,
    [runId, updates.status, updates.actualPaidAmountCny ?? null, updates.deliveredQuantity || 0,
      updates.validQuantity || 0, updates.failedQuantity || 0,
      String(updates.errorMessage || '').slice(0, 1000)]);
  }

  async addEvent({ ruleId = null, runId = null, orderId = null, itemId = null, eventType, message = '', details = {}, actor = 'system' }) {
    if (this.demo) {
      const created = {
        id: ++this.sequence, ruleId, runId, orderId, itemId, eventType, message, details, actor,
        createdAt: new Date().toISOString(),
      };
      this.events.push(created);
      return { ...created };
    }
    const result = await this.pool.query(`
      INSERT INTO ${this.schema}.replenishment_events(
        rule_id,run_id,order_id,item_id,event_type,message,details,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
      RETURNING *`,
    [ruleId, runId, orderId, itemId, eventType, String(message || '').slice(0, 2000),
      JSON.stringify(details || {}), actor]);
    return event(result.rows[0]);
  }

  async listEvents({ ruleId = null, limit = 100, start = null, end = null } = {}) {
    const selectedRuleId = ruleId === null || ruleId === undefined || ruleId === '' ? null : Number(ruleId);
    const selectedLimit = Math.min(200, Math.max(1, Number(limit) || 100));
    const rangeStart = start ? new Date(start) : new Date(0);
    const rangeEnd = end ? new Date(end) : new Date('9999-12-31T23:59:59.999Z');
    if (this.demo) {
      return [...this.events]
        .filter((entry) => selectedRuleId === null || Number(entry.ruleId) === selectedRuleId)
        .filter((entry) => {
          const createdAt = new Date(entry.createdAt).getTime();
          return createdAt >= rangeStart.getTime() && createdAt < rangeEnd.getTime();
        })
        .sort((left, right) => right.id - left.id)
        .slice(0, selectedLimit)
        .map((entry) => ({
          ...entry,
          ruleName: this.rules.find((ruleEntry) => Number(ruleEntry.id) === Number(entry.ruleId))?.name || '',
        }));
    }
    const result = await this.pool.query(`
      SELECT e.*,COALESCE(e.rule_id,run.rule_id,replenishment_order.rule_id) AS resolved_rule_id,
        replenishment_rule.name AS rule_name
      FROM ${this.schema}.replenishment_events e
      LEFT JOIN ${this.schema}.replenishment_runs run ON run.id=e.run_id
      LEFT JOIN ${this.schema}.oauth_supply_orders replenishment_order ON replenishment_order.id=e.order_id
      LEFT JOIN ${this.schema}.replenishment_rules replenishment_rule
        ON replenishment_rule.id=COALESCE(e.rule_id,run.rule_id,replenishment_order.rule_id)
      WHERE ($1::bigint IS NULL OR COALESCE(e.rule_id,run.rule_id,replenishment_order.rule_id)=$1)
        AND e.created_at>=$2
        AND e.created_at<$3
      ORDER BY e.created_at DESC,e.id DESC
      LIMIT $4`, [selectedRuleId, rangeStart, rangeEnd, selectedLimit]);
    return result.rows.map(event);
  }

  async dashboard({ start = null, end = null } = {}) {
    const [mappings, rules, orderSummary] = await Promise.all([
      this.listMappings(),
      this.listRules(),
      this.getOrderSummary({ start, end }),
    ]);
    return {
      mappings,
      rules: rules.map((entry) => ({
        ...entry,
        lastInventorySnapshot: compactInventorySnapshot(entry.lastInventorySnapshot),
        lastForecastSnapshot: compactForecastSnapshot(entry.lastForecastSnapshot),
      })),
      summary: {
        enabledRules: rules.filter((entry) => entry.enabled).length,
        ...orderSummary,
      },
    };
  }
}
