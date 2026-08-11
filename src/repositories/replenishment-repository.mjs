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
    priority: Number(row.priority || 0),
    verificationModel: row.verification_model || 'gpt-5.6-luna',
    verificationPrompt: row.verification_prompt || '',
    pollIntervalSeconds: Number(row.poll_interval_seconds || 5),
    retryLimit: Number(row.retry_limit || 3),
    cooldownSeconds: Number(row.cooldown_seconds || 300),
    lastTriggeredAt: row.last_triggered_at || null,
    lastInventoryAt: row.last_inventory_at || null,
    lastError: row.last_error || '',
    lastInventorySnapshot: row.last_inventory_snapshot || {},
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
  };
}

function recovery(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    recoveryKey: row.recovery_key,
    supplierRecoveryId: row.supplier_recovery_id || '',
    orderItemId: Number(row.order_item_id),
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
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    mode: row.mode || '',
    verificationModel: row.verification_model || '',
    verificationPrompt: row.verification_prompt || '',
    recoveryRetryLimit: row.recovery_retry_limit === null || row.recovery_retry_limit === undefined
      ? null : Number(row.recovery_retry_limit),
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
    priority: Number(input.priority ?? 100),
    verificationModel: String(input.verificationModel || 'gpt-5.6-luna').trim(),
    verificationPrompt: String(input.verificationPrompt || '').trim(),
    pollIntervalSeconds: Number(input.pollIntervalSeconds || 5),
    retryLimit: Number(input.retryLimit ?? 3),
    cooldownSeconds: Number(input.cooldownSeconds ?? 300),
  };
  if (!values.name) throw badRequest('请输入策略名称');
  if (!Number.isSafeInteger(values.productMappingId) || values.productMappingId <= 0) {
    throw badRequest('请选择有效的商品映射');
  }
  if (!['observe', 'approval', 'auto'].includes(values.mode)) throw badRequest('运行模式无效');
  if (!Number.isSafeInteger(values.minAvailableAccounts) || values.minAvailableAccounts < 0) {
    throw badRequest('最低有效库存必须是非负整数');
  }
  if (!Number.isSafeInteger(values.targetAvailableAccounts)
    || values.targetAvailableAccounts <= values.minAvailableAccounts) {
    throw badRequest('目标库存必须大于最低有效库存');
  }
  if (!Number.isSafeInteger(values.replenishQuantity) || values.replenishQuantity < 1 || values.replenishQuantity > 1000) {
    throw badRequest('单次最多购买数量必须在 1 到 1000 之间');
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
      priority: 20,
      verificationModel: 'gpt-5.6-luna',
      verificationPrompt: 'Reply with OK.',
      pollIntervalSeconds: 5,
      retryLimit: 3,
      cooldownSeconds: 300,
      product: 'oauth_30d',
      platform: 'openai',
      targetPoolKey: 'openai-team-primary',
      targetGroupIds: [1],
      lastTriggeredAt: null,
      lastInventoryAt: null,
      lastError: '',
      lastInventorySnapshot: {},
      updatedAt: new Date().toISOString(),
    }] : [];
    this.orders = [];
    this.items = [];
    this.runs = [];
    this.events = [];
    this.recoveries = [];
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
      values.minAvailableAccounts, values.targetAvailableAccounts, values.replenishQuantity,
      values.quotaUsedThresholdPercent, values.quotaWindow, values.quotaUnknownPolicy,
      values.repairGraceSeconds, values.recoveryRetryLimit,
      values.maxOrderAmountCny, values.maxDailyAmountCny, values.concurrency, values.priority,
      values.verificationModel, values.verificationPrompt, values.pollIntervalSeconds,
      values.retryLimit, values.cooldownSeconds,
    ];
    const result = input.id
      ? await this.pool.query(`
          UPDATE ${this.schema}.replenishment_rules SET
            name=$2,product_mapping_id=$3,mode=$4,enabled=$5,min_available_accounts=$6,
            target_available_accounts=$7,replenish_quantity=$8,quota_used_threshold_percent=$9,
            quota_window=$10,quota_unknown_policy=$11,repair_grace_seconds=$12,recovery_retry_limit=$13,
            max_order_amount_cny=$14,max_daily_amount_cny=$15,concurrency=$16,priority=$17,
            verification_model=$18,verification_prompt=$19,poll_interval_seconds=$20,
            retry_limit=$21,cooldown_seconds=$22,updated_at=NOW()
          WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [input.id, ...params])
      : await this.pool.query(`
          INSERT INTO ${this.schema}.replenishment_rules(
            name,product_mapping_id,mode,enabled,min_available_accounts,target_available_accounts,
            replenish_quantity,quota_used_threshold_percent,quota_window,quota_unknown_policy,
            repair_grace_seconds,recovery_retry_limit,max_order_amount_cny,max_daily_amount_cny,
            concurrency,priority,verification_model,verification_prompt,poll_interval_seconds,
            retry_limit,cooldown_seconds,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
          RETURNING id`, [...params, actor]);
    if (!result.rowCount) throw notFound('补号策略不存在或已删除');
    return this.getRule(result.rows[0]?.id);
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
    const activeRecoveryStatuses = new Set([
      'detected', 'waiting_supplier', 'claimable', 'credentials_saved',
      'updating_sub2api', 'verifying', 'retry_wait',
    ]);
    if (this.demo) {
      const index = this.rules.findIndex((entry) => entry.id === ruleId);
      if (index < 0) throw notFound('补号策略不存在或已删除');
      if (await this.hasActiveOrder(ruleId)) throw conflict('策略存在进行中订单，请等待订单完成后再删除');
      if (this.recoveries.some((entry) => entry.ruleId === ruleId && activeRecoveryStatuses.has(entry.status))) {
        throw conflict('策略存在进行中的账号修复任务，请等待修复完成后再删除');
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
    const activeRecovery = await this.pool.query(`
      SELECT 1 FROM ${this.schema}.replenishment_recoveries
      WHERE rule_id=$1
        AND status=ANY($2::text[])
      LIMIT 1`, [ruleId, [...activeRecoveryStatuses]]);
    if (activeRecovery.rowCount) throw conflict('策略存在进行中的账号修复任务，请等待修复完成后再删除');
    const result = await this.pool.query(`
      UPDATE ${this.schema}.replenishment_rules SET
        enabled=FALSE,deleted_at=NOW(),updated_at=NOW()
      WHERE id=$1 AND deleted_at IS NULL
      RETURNING id`, [ruleId]);
    if (!result.rowCount) throw notFound('补号策略不存在或已删除');
    return { deleted: true, id: ruleId };
  }

  async deleteMapping(id) {
    const mappingId = Number(id);
    if (this.demo) {
      const index = this.mappings.findIndex((entry) => entry.id === mappingId);
      if (index < 0) throw notFound('商品映射不存在或已删除');
      if (this.rules.some((entry) => entry.productMappingId === mappingId)) {
        throw conflict('商品映射仍被补号策略使用，请先删除关联策略');
      }
      this.mappings.splice(index, 1);
      return { deleted: true, id: mappingId };
    }
    const referenced = await this.pool.query(`
      SELECT 1 FROM ${this.schema}.replenishment_rules
      WHERE product_mapping_id=$1 AND deleted_at IS NULL
      LIMIT 1`, [mappingId]);
    if (referenced.rowCount) throw conflict('商品映射仍被补号策略使用，请先删除关联策略');
    const result = await this.pool.query(`
      UPDATE ${this.schema}.oauth_supply_product_mappings SET
        enabled=FALSE,deleted_at=NOW(),updated_at=NOW()
      WHERE id=$1 AND deleted_at IS NULL
      RETURNING id`, [mappingId]);
    if (!result.rowCount) throw notFound('商品映射不存在或已删除');
    return { deleted: true, id: mappingId };
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
        AND i.verification_status IN ('passed','repaired')
      ORDER BY i.id`, [ruleId]);
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
        next_retry_at,last_error,claimed_at,recovered_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT(recovery_key) DO UPDATE SET
        supplier_recovery_id=COALESCE(NULLIF(EXCLUDED.supplier_recovery_id,''),${this.schema}.replenishment_recoveries.supplier_recovery_id),
        delivery_status=EXCLUDED.delivery_status,
        credential_version=COALESCE(NULLIF(EXCLUDED.credential_version,''),${this.schema}.replenishment_recoveries.credential_version),
        claim_url_ciphertext=COALESCE(NULLIF(EXCLUDED.claim_url_ciphertext,''),${this.schema}.replenishment_recoveries.claim_url_ciphertext),
        credential_ciphertext=COALESCE(NULLIF(EXCLUDED.credential_ciphertext,''),${this.schema}.replenishment_recoveries.credential_ciphertext),
        status=EXCLUDED.status,attempt_count=EXCLUDED.attempt_count,next_retry_at=EXCLUDED.next_retry_at,
        last_error=EXCLUDED.last_error,claimed_at=COALESCE(EXCLUDED.claimed_at,${this.schema}.replenishment_recoveries.claimed_at),
        recovered_at=COALESCE(EXCLUDED.recovered_at,${this.schema}.replenishment_recoveries.recovered_at),
        last_seen_at=NOW(),updated_at=NOW()
      RETURNING *`,
    [values.recoveryKey, values.supplierRecoveryId || null, values.orderItemId, values.ruleId,
      values.sub2apiAccountId, values.accountKey, values.status, values.deliveryStatus,
      values.credentialVersion, values.claimUrlCiphertext, values.credentialCiphertext,
      values.attemptCount, values.nextRetryAt, values.lastError.slice(0, 1000),
      values.claimedAt, values.recoveredAt]);
    return recovery(result.rows[0]);
  }

  async getRecovery(id) {
    if (this.demo) return this.recoveries.find((entry) => entry.id === Number(id)) || null;
    const result = await this.pool.query(`
      SELECT rr.*,i.account_name,r.mode,r.verification_model,r.verification_prompt,r.recovery_retry_limit
      FROM ${this.schema}.replenishment_recoveries rr
      JOIN ${this.schema}.oauth_supply_order_items i ON i.id=rr.order_item_id
      JOIN ${this.schema}.replenishment_rules r ON r.id=rr.rule_id
      WHERE rr.id=$1`, [id]);
    return recovery(result.rows[0]);
  }

  async listRecoveries({ limit = 100 } = {}) {
    if (this.demo) return [...this.recoveries].sort((a, b) => b.id - a.id).slice(0, limit).map((entry) => ({ ...entry }));
    const result = await this.pool.query(`
      SELECT rr.*,i.account_name,r.mode,r.verification_model,r.verification_prompt,r.recovery_retry_limit
      FROM ${this.schema}.replenishment_recoveries rr
      JOIN ${this.schema}.oauth_supply_order_items i ON i.id=rr.order_item_id
      JOIN ${this.schema}.replenishment_rules r ON r.id=rr.rule_id
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
      SELECT rr.*,i.account_name,r.mode,r.verification_model,r.verification_prompt,r.recovery_retry_limit
      FROM ${this.schema}.replenishment_recoveries rr
      JOIN ${this.schema}.oauth_supply_order_items i ON i.id=rr.order_item_id
      JOIN ${this.schema}.replenishment_rules r ON r.id=rr.rule_id
      WHERE rr.status=ANY($1::text[]) AND (rr.next_retry_at IS NULL OR rr.next_retry_at<=NOW())
      ORDER BY rr.updated_at LIMIT $2`, [statuses, limit]);
    return result.rows.map(recovery);
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
          healthStatus: value.healthStatus || 'unknown', quotaUsedPercent: value.quotaUsedPercent ?? null,
          quotaWindow: value.quotaWindow || '', lastHealthAt: value.lastHealthAt || null,
          metadata: value.metadata || {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
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
        value.credentialCiphertext || '', JSON.stringify(value.metadata || {})]);
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
        quota_window=$16,last_health_at=$17,updated_at=NOW()
      WHERE id=$1 RETURNING *`,
    [id, merged.status, merged.verificationStatus, merged.individualCostCny, merged.finalCostCny,
      merged.credentialVersion || '', merged.credentialCiphertext || '', merged.sub2apiAccountId,
      merged.costLedgerStatus || 'pending', merged.costLedgerPeriodId,
      String(merged.costLedgerError || '').slice(0, 1000),
      String(merged.errorMessage || '').slice(0, 1000), JSON.stringify(merged.metadata || {}),
      merged.healthStatus || 'unknown', merged.quotaUsedPercent ?? null, merged.quotaWindow || '',
      merged.lastHealthAt || null]);
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
        .filter((entry) => entry.verificationStatus === 'passed'
          && entry.sub2apiAccountId && entry.costLedgerStatus === 'pending')
        .slice(0, limit)
        .map((entry) => {
          const currentOrder = this.orders.find((candidate) => candidate.id === entry.orderId);
          return { ...entry, order: currentOrder ? { ...currentOrder } : null };
        });
    }
    const result = await this.pool.query(`
      SELECT i.*,o.external_order_id,o.product,o.platform,o.target_pool_key,o.created_at AS order_created_at
      FROM ${this.schema}.oauth_supply_order_items i
      JOIN ${this.schema}.oauth_supply_orders o ON o.id=i.order_id
      WHERE i.verification_status='passed'
        AND i.sub2api_account_id IS NOT NULL
        AND i.final_cost_cny IS NOT NULL
        AND i.cost_ledger_status='pending'
      ORDER BY i.id
      LIMIT $1`, [limit]);
    return result.rows.map((row) => ({
      ...item(row),
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

  async listEvents({ ruleId = null, limit = 100 } = {}) {
    const selectedRuleId = ruleId === null || ruleId === undefined || ruleId === '' ? null : Number(ruleId);
    const selectedLimit = Math.min(200, Math.max(1, Number(limit) || 100));
    if (this.demo) {
      return [...this.events]
        .filter((entry) => selectedRuleId === null || Number(entry.ruleId) === selectedRuleId)
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
      ORDER BY e.created_at DESC,e.id DESC
      LIMIT $2`, [selectedRuleId, selectedLimit]);
    return result.rows.map(event);
  }

  async dashboard() {
    const [mappings, rules, orders] = await Promise.all([
      this.listMappings(),
      this.listRules(),
      this.listOrders({ limit: 20 }),
    ]);
    return {
      mappings,
      rules,
      orders,
      summary: {
        enabledRules: rules.filter((entry) => entry.enabled).length,
        activeOrders: orders.filter((entry) => ['approval_required', 'ordering', 'queued', 'processing', 'ready_to_collect', 'importing'].includes(entry.status)).length,
        completedOrders: orders.filter((entry) => entry.status === 'completed').length,
        totalCostCny: orders.reduce((sum, entry) => sum + Number(entry.actualPaidAmountCny || 0), 0),
        importedAccounts: orders.reduce((sum, entry) => sum + Number(entry.validQuantity || 0), 0),
        effectiveAccounts: rules.reduce((sum, entry) => sum + Number(entry.lastInventorySnapshot?.effectiveAccounts || 0), 0),
        lowQuotaAccounts: rules.reduce((sum, entry) => sum + Number(entry.lastInventorySnapshot?.lowQuotaAccounts || 0), 0),
        unavailableAccounts: rules.reduce((sum, entry) => sum + Number(entry.lastInventorySnapshot?.unavailableAccounts || 0), 0),
        repairingAccounts: rules.reduce((sum, entry) => sum + Number(entry.lastInventorySnapshot?.repairingAccounts || 0), 0),
      },
    };
  }
}
