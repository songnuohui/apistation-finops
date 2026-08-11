function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
    replenishQuantity: Number(row.replenish_quantity || 1),
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
    metadata: row.metadata || {},
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    credentialCiphertext: row.credential_ciphertext || '',
  };
}

function normalizeRuleInput(input) {
  return {
    name: String(input.name || '').trim(),
    productMappingId: Number(input.productMappingId),
    mode: input.mode,
    enabled: Boolean(input.enabled),
    minAvailableAccounts: Number(input.minAvailableAccounts || 0),
    replenishQuantity: Number(input.replenishQuantity || 1),
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
      replenishQuantity: 2,
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
      updatedAt: new Date().toISOString(),
    }] : [];
    this.orders = [];
    this.items = [];
    this.runs = [];
    this.events = [];
  }

  async listMappings() {
    if (this.demo) return this.mappings.map((entry) => ({ ...entry, targetGroupIds: [...entry.targetGroupIds] }));
    const result = await this.pool.query(`
      SELECT * FROM ${this.schema}.oauth_supply_product_mappings
      ORDER BY enabled DESC, product, platform, target_pool_key, id`);
    return result.rows.map(mapping);
  }

  async upsertMapping(input, actor = 'admin') {
    const values = {
      product: String(input.product || '').trim(),
      platform: String(input.platform || '').trim(),
      targetPoolKey: String(input.targetPoolKey || '').trim(),
      targetGroupIds: [...new Set((input.targetGroupIds || []).map(Number))],
      enabled: input.enabled !== false,
      notes: String(input.notes || '').trim(),
    };
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
          WHERE id=$1 RETURNING *`,
        [input.id, values.product, values.platform, values.targetPoolKey, values.targetGroupIds,
          values.enabled, values.notes])
      : await this.pool.query(`
          INSERT INTO ${this.schema}.oauth_supply_product_mappings(
            product,platform,target_pool_key,target_group_ids,enabled,notes,created_by)
          VALUES($1,$2,$3,$4::bigint[],$5,$6,$7)
          RETURNING *`,
        [values.product, values.platform, values.targetPoolKey, values.targetGroupIds,
          values.enabled, values.notes, actor]);
    return mapping(result.rows[0]);
  }

  async listRules({ enabledOnly = false } = {}) {
    if (this.demo) return this.rules.filter((entry) => !enabledOnly || entry.enabled).map((entry) => ({ ...entry }));
    const result = await this.pool.query(`
      SELECT r.*,m.product,m.platform,m.target_pool_key,m.target_group_ids
      FROM ${this.schema}.replenishment_rules r
      JOIN ${this.schema}.oauth_supply_product_mappings m ON m.id=r.product_mapping_id
      ${enabledOnly ? 'WHERE r.enabled AND m.enabled' : ''}
      ORDER BY r.enabled DESC,r.id`);
    return result.rows.map(rule);
  }

  async getRule(id) {
    if (this.demo) return this.rules.find((entry) => entry.id === Number(id)) || null;
    const result = await this.pool.query(`
      SELECT r.*,m.product,m.platform,m.target_pool_key,m.target_group_ids
      FROM ${this.schema}.replenishment_rules r
      JOIN ${this.schema}.oauth_supply_product_mappings m ON m.id=r.product_mapping_id
      WHERE r.id=$1`, [id]);
    return rule(result.rows[0]);
  }

  async saveRule(input, actor = 'admin') {
    const values = normalizeRuleInput(input);
    if (this.demo) {
      let current = input.id ? this.rules.find((entry) => entry.id === Number(input.id)) : null;
      if (!current) {
        current = { id: ++this.sequence };
        this.rules.push(current);
      }
      const productMapping = this.mappings.find((entry) => entry.id === values.productMappingId);
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
    const params = [
      values.name, values.productMappingId, values.mode, values.enabled,
      values.minAvailableAccounts, values.replenishQuantity, values.maxOrderAmountCny,
      values.maxDailyAmountCny, values.concurrency, values.priority, values.verificationModel,
      values.verificationPrompt, values.pollIntervalSeconds, values.retryLimit, values.cooldownSeconds,
    ];
    const result = input.id
      ? await this.pool.query(`
          UPDATE ${this.schema}.replenishment_rules SET
            name=$2,product_mapping_id=$3,mode=$4,enabled=$5,min_available_accounts=$6,
            replenish_quantity=$7,max_order_amount_cny=$8,max_daily_amount_cny=$9,
            concurrency=$10,priority=$11,verification_model=$12,verification_prompt=$13,
            poll_interval_seconds=$14,retry_limit=$15,cooldown_seconds=$16,updated_at=NOW()
          WHERE id=$1 RETURNING id`, [input.id, ...params])
      : await this.pool.query(`
          INSERT INTO ${this.schema}.replenishment_rules(
            name,product_mapping_id,mode,enabled,min_available_accounts,replenish_quantity,
            max_order_amount_cny,max_daily_amount_cny,concurrency,priority,verification_model,
            verification_prompt,poll_interval_seconds,retry_limit,cooldown_seconds,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
          RETURNING id`, [...params, actor]);
    return this.getRule(result.rows[0]?.id);
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

  async hasActiveOrder(ruleId) {
    const active = new Set(['approval_required', 'ordering', 'queued', 'processing', 'ready_to_collect', 'importing']);
    if (this.demo) return this.orders.some((entry) => entry.ruleId === Number(ruleId) && active.has(entry.status));
    const result = await this.pool.query(`
      SELECT 1 FROM ${this.schema}.oauth_supply_orders
      WHERE rule_id=$1 AND status=ANY($2::text[]) LIMIT 1`, [ruleId, [...active]]);
    return Boolean(result.rowCount);
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
        error_message=$12,metadata=$13::jsonb,updated_at=NOW()
      WHERE id=$1 RETURNING *`,
    [id, merged.status, merged.verificationStatus, merged.individualCostCny, merged.finalCostCny,
      merged.credentialVersion || '', merged.credentialCiphertext || '', merged.sub2apiAccountId,
      merged.costLedgerStatus || 'pending', merged.costLedgerPeriodId,
      String(merged.costLedgerError || '').slice(0, 1000),
      String(merged.errorMessage || '').slice(0, 1000), JSON.stringify(merged.metadata || {})]);
    return item(result.rows[0]);
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

  async addEvent({ runId = null, orderId = null, itemId = null, eventType, message = '', details = {}, actor = 'system' }) {
    if (this.demo) {
      this.events.push({
        id: ++this.sequence, runId, orderId, itemId, eventType, message, details, actor,
        createdAt: new Date().toISOString(),
      });
      return;
    }
    await this.pool.query(`
      INSERT INTO ${this.schema}.replenishment_events(
        run_id,order_id,item_id,event_type,message,details,created_by)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [runId, orderId, itemId, eventType, String(message || '').slice(0, 2000),
      JSON.stringify(details || {}), actor]);
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
      },
    };
  }
}
