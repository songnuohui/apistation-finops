function number(value) {
  return value === null || value === undefined ? 0 : Number(value);
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
}

function zonedDateTimeToUtc(parts, timeZone) {
  const target = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour || 0,
    parts.minute || 0,
    parts.second || 0,
  );
  let guess = target;
  for (let index = 0; index < 3; index += 1) {
    const shown = zonedParts(new Date(guess), timeZone);
    const shownUtc = Date.UTC(
      shown.year,
      shown.month - 1,
      shown.day,
      shown.hour,
      shown.minute,
      shown.second,
    );
    guess += target - shownUtc;
  }
  return new Date(guess);
}

function nextCalendarDate(parts) {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function dateKey(parts) {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function dailyWindows(start, end, timeZone) {
  const first = new Date(start);
  const last = new Date(end);
  if (!Number.isFinite(first.getTime()) || !Number.isFinite(last.getTime()) || first >= last) return [];

  const windows = [];
  let cursor = first;
  while (cursor < last) {
    const parts = zonedParts(cursor, timeZone);
    const nextBoundary = zonedDateTimeToUtc(nextCalendarDate(parts), timeZone);
    const windowEnd = nextBoundary < last ? nextBoundary : last;
    windows.push({ start: cursor, end: windowEnd, day: dateKey(parts) });
    cursor = windowEnd;
  }
  return windows;
}

function modelKey(requestedModel, model) {
  const value = requestedModel === null || requestedModel === undefined ? model : requestedModel;
  return String(value || '').trim() || 'unlabeled';
}

function mergeUsageRow(target, key, day, row, extra = {}) {
  const accountId = number(row.account_id);
  const current = target.get(key) || {
    accountId,
    day,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    totalTokens: 0,
    cost: 0,
    actualCost: 0,
    ...extra,
  };
  current.requests += number(row.requests);
  current.inputTokens += number(row.input_tokens);
  current.outputTokens += number(row.output_tokens);
  current.cacheTokens += number(row.cache_tokens);
  current.totalTokens += number(row.total_tokens);
  current.cost += number(row.cost);
  current.actualCost += number(row.actual_cost);
  target.set(key, current);
  return current;
}

function dailyUnionQuery({ schema, windows, accountIds = null, select, groupBy }) {
  const params = [];
  const branches = windows.map((window) => {
    const startParameter = `$${params.push(window.start)}`;
    const endParameter = `$${params.push(window.end)}`;
    const accountPredicate = accountIds
      ? `AND ul.account_id=ANY($${params.push(accountIds)}::bigint[])`
      : '';
    return `
      SELECT '${window.day}'::text AS day,${select}
      FROM ${schema}.usage_logs ul
      WHERE ul.created_at >= ${startParameter} AND ul.created_at < ${endParameter}
        ${accountPredicate}
      GROUP BY ${groupBy}
    `;
  });
  return {
    text: branches.join('\nUNION ALL\n'),
    params,
  };
}

export class SourceUsageRepository {
  constructor(pool, config) {
    this.pool = pool;
    this.sourceSchema = config.sourceSchema;
    this.schema = `"${config.sourceSchema}"`;
    this.timezone = config.timezone || 'Asia/Shanghai';
    this.queryConcurrency = Math.max(
      1,
      Math.min(2, Number(config.sub2apiUsageDatabasePoolMax) || 2),
    );
    this.ttlMs = (config.sub2apiUsageCacheTtlSeconds || 30) * 1_000;
    this.staleTtlMs = Math.max(
      this.ttlMs,
      (config.sub2apiUsageStaleCacheTtlSeconds || 300) * 1_000,
    );
    this.cache = new Map();
    this.inflight = new Map();
  }

  cacheKey({ start, end, accountIds, dimension = 'account' }) {
    const ids = accountIds?.length
      ? [...new Set(accountIds.map(Number).filter(Number.isSafeInteger))]
        .sort((left, right) => left - right)
      : [];
    const endBucket = Math.floor(new Date(end).getTime() / this.ttlMs);
    return `${dimension}:${new Date(start).toISOString()}:${endBucket}:${ids.length ? ids.join(',') : '*'}`;
  }

  pruneCache(now = Date.now()) {
    for (const [key, entry] of this.cache) {
      if ((entry.staleExpiresAt || entry.expiresAt) <= now) this.cache.delete(key);
    }
    while (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value);
  }

  async readOnlyQuery(text, params = []) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');
      const result = await client.query(text, params);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listModelAuditUsage({
    cursorCreatedAt,
    cursorId = 0,
    until = new Date(),
    userEmails = [],
    limit = 5000,
  } = {}) {
    const normalizedEmails = [...new Set((userEmails || [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean))];
    const result = await this.readOnlyQuery(`
      SELECT
        ul.id,
        ul.user_id,
        COALESCE(u.email,'') AS email,
        COALESCE(ul.model,'') AS model,
        COALESCE(ul.requested_model,'') AS requested_model,
        COALESCE(ul.upstream_model,'') AS upstream_model,
        COALESCE(ul.upstream_response_model,'') AS upstream_response_model,
        ul.upstream_model_mismatch,
        ul.created_at
      FROM ${this.schema}.usage_logs ul
      LEFT JOIN ${this.schema}.users u ON u.id=ul.user_id
      WHERE (ul.created_at,ul.id) > ($1::timestamptz,$2::bigint)
        AND ul.created_at < $3::timestamptz
        AND ($4::text[] IS NULL OR LOWER(COALESCE(u.email,''))=ANY($4::text[]))
      ORDER BY ul.created_at ASC,ul.id ASC
      LIMIT $5`, [
      cursorCreatedAt,
      Number(cursorId),
      until,
      normalizedEmails.length ? normalizedEmails : null,
      Math.min(50_000, Math.max(1, Number(limit) || 5_000)),
    ]);
    return result.rows;
  }

  async validateModelAuditSchema() {
    const requiredColumns = {
      usage_logs: [
        'id',
        'user_id',
        'model',
        'requested_model',
        'upstream_model',
        'upstream_response_model',
        'upstream_model_mismatch',
        'created_at',
      ],
      users: ['id', 'email'],
    };
    const result = await this.readOnlyQuery(`
      SELECT table_name,column_name
      FROM information_schema.columns
      WHERE table_schema=$1 AND table_name=ANY($2::text[])`, [
      this.sourceSchema,
      Object.keys(requiredColumns),
    ]);
    const found = new Map();
    for (const row of result.rows) {
      if (!found.has(row.table_name)) found.set(row.table_name, new Set());
      found.get(row.table_name).add(row.column_name);
    }
    const missing = [];
    for (const [table, columns] of Object.entries(requiredColumns)) {
      for (const column of columns) {
        if (!found.get(table)?.has(column)) missing.push(`${table}.${column}`);
      }
    }
    if (missing.length) {
      throw new Error(
        `Sub2API model audit schema is incompatible; missing: ${missing.join(', ')}`,
      );
    }
    return { sourceSchema: this.sourceSchema, tables: Object.keys(requiredColumns) };
  }

  async queryDailyUnionRows(windows, buildQuery) {
    const batches = Array.from(
      { length: Math.min(this.queryConcurrency, windows.length) },
      () => [],
    );
    windows.forEach((window, index) => {
      batches[index % batches.length].push(window);
    });
    const results = await Promise.all(batches.map(async (batch) => {
      const query = buildQuery(batch);
      const result = await this.readOnlyQuery(query.text, query.params);
      return result.rows;
    }));
    return results.flat();
  }

  async getDailyAccountGroupStats({ start, end, accountIds = null }) {
    const ids = accountIds?.length
      ? [...new Set(accountIds.map(Number)
        .filter((value) => Number.isSafeInteger(value) && value > 0))]
      : null;
    if (Array.isArray(accountIds) && !ids?.length) return [];
    const key = this.cacheKey({ start, end, accountIds: ids, dimension: 'account' });
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached?.expiresAt > now) return cached.value;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const load = (async () => {
      const rows = new Map();
      const windows = dailyWindows(start, end, this.timezone);
      if (windows.length) {
        const resultRows = await this.queryDailyUnionRows(windows, (batch) => dailyUnionQuery({
          schema: this.schema,
          windows: batch,
          accountIds: ids,
          select: `
            ul.account_id,
            COUNT(*)::bigint AS requests,
            COALESCE(SUM(ul.input_tokens),0) AS input_tokens,
            COALESCE(SUM(ul.output_tokens),0) AS output_tokens,
            COALESCE(SUM(ul.cache_creation_tokens+ul.cache_read_tokens),0) AS cache_tokens,
            COALESCE(SUM(
              ul.input_tokens+ul.output_tokens+ul.cache_creation_tokens+ul.cache_read_tokens
            ),0) AS total_tokens,
            COALESCE(SUM(ul.total_cost),0) AS cost,
            COALESCE(SUM(ul.actual_cost),0) AS actual_cost
          `,
          groupBy: 'ul.account_id',
        }));
        for (const row of resultRows) {
          const day = String(row.day || '');
          mergeUsageRow(rows, JSON.stringify([number(row.account_id), day]), day, row);
        }
      }
      const value = [...rows.values()].sort((left, right) => (
        left.accountId - right.accountId || left.day.localeCompare(right.day)
      ));
      this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
      this.pruneCache();
      return value;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, load);
    return load;
  }

  async getDailyDimensionStats({ start, end, dimension, accountIds = null }) {
    if (!['model', 'user'].includes(dimension)) {
      throw new Error(`unsupported usage dimension: ${dimension}`);
    }
    const ids = accountIds?.length
      ? [...new Set(accountIds.map(Number)
        .filter((value) => Number.isSafeInteger(value) && value > 0))]
      : null;
    if (Array.isArray(accountIds) && !ids?.length) return [];
    const key = this.cacheKey({ start, end, accountIds: ids, dimension });
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached?.expiresAt > now) return cached.value;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const load = (async () => {
      const rows = new Map();
      const windows = dailyWindows(start, end, this.timezone);
      if (windows.length) {
        const query = dimension === 'model'
          ? (batch) => dailyUnionQuery({
            schema: this.schema,
            windows: batch,
            accountIds: ids,
            select: `
              ul.account_id,ul.model,ul.requested_model,
              COUNT(*)::bigint AS requests,
              COALESCE(SUM(ul.input_tokens),0) AS input_tokens,
              COALESCE(SUM(ul.output_tokens),0) AS output_tokens,
              COALESCE(SUM(ul.cache_creation_tokens+ul.cache_read_tokens),0) AS cache_tokens,
              COALESCE(SUM(
                ul.input_tokens+ul.output_tokens+ul.cache_creation_tokens+ul.cache_read_tokens
              ),0) AS total_tokens,
              COALESCE(SUM(ul.total_cost),0) AS cost,
              COALESCE(SUM(ul.actual_cost),0) AS actual_cost
            `,
            groupBy: 'ul.account_id,ul.model,ul.requested_model',
          })
          : (batch) => dailyUnionQuery({
            schema: this.schema,
            windows: batch,
            accountIds: ids,
            select: `
              ul.account_id,ul.user_id,
              COUNT(*)::bigint AS requests,
              COALESCE(SUM(ul.input_tokens),0) AS input_tokens,
              COALESCE(SUM(ul.output_tokens),0) AS output_tokens,
              COALESCE(SUM(ul.cache_creation_tokens+ul.cache_read_tokens),0) AS cache_tokens,
              COALESCE(SUM(
                ul.input_tokens+ul.output_tokens+ul.cache_creation_tokens+ul.cache_read_tokens
              ),0) AS total_tokens,
              COALESCE(SUM(ul.total_cost),0) AS cost,
              COALESCE(SUM(ul.actual_cost),0) AS actual_cost
            `,
            groupBy: 'ul.account_id,ul.user_id',
          });
        const resultRows = await this.queryDailyUnionRows(windows, query);
        let userNames = new Map();
        if (dimension === 'user') {
          const userIds = [...new Set(resultRows
            .map((row) => number(row.user_id))
            .filter((value) => Number.isSafeInteger(value) && value > 0))];
          if (userIds.length) {
            const userResult = await this.readOnlyQuery(`
              SELECT u.id,COALESCE(u.email,'') AS email
              FROM ${this.schema}.users u
              WHERE u.id=ANY($1::bigint[])
            `, [userIds]);
            userNames = new Map(userResult.rows.map((row) => [
              number(row.id),
              row.email || '',
            ]));
          }
        }
        for (const row of resultRows) {
          const day = String(row.day || '');
          if (dimension === 'model') {
            const name = modelKey(row.requested_model, row.model);
            mergeUsageRow(
              rows,
              JSON.stringify([number(row.account_id), day, name]),
              day,
              row,
              { dimensionKey: name, dimensionName: name },
            );
          } else {
            const dimensionKey = number(row.user_id);
            mergeUsageRow(
              rows,
              JSON.stringify([number(row.account_id), day, dimensionKey]),
              day,
              row,
              { dimensionKey, dimensionName: userNames.get(dimensionKey) || '' },
            );
          }
        }
      }
      const value = [...rows.values()].sort((left, right) => (
        left.accountId - right.accountId
        || left.day.localeCompare(right.day)
        || String(left.dimensionKey).localeCompare(String(right.dimensionKey), 'zh-CN')
      ));
      this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
      this.pruneCache();
      return value;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, load);
    return load;
  }

  async getDailyAccountAndModelStats({ start, end }) {
    const key = this.cacheKey({ start, end, dimension: 'account-model' });
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached?.expiresAt > now) return cached.value;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const load = (async () => {
      const accounts = new Map();
      const models = new Map();
      try {
        const windows = dailyWindows(start, end, this.timezone);
        if (windows.length) {
          const resultRows = await this.queryDailyUnionRows(windows, (batch) => dailyUnionQuery({
            schema: this.schema,
            windows: batch,
            select: `
              ul.account_id,ul.model,ul.requested_model,
              COUNT(*)::bigint AS requests,
              COALESCE(SUM(ul.input_tokens),0) AS input_tokens,
              COALESCE(SUM(ul.output_tokens),0) AS output_tokens,
              COALESCE(SUM(ul.cache_creation_tokens+ul.cache_read_tokens),0) AS cache_tokens,
              COALESCE(SUM(
                ul.input_tokens+ul.output_tokens+ul.cache_creation_tokens+ul.cache_read_tokens
              ),0) AS total_tokens,
              COALESCE(SUM(ul.total_cost),0) AS cost,
              COALESCE(SUM(ul.actual_cost),0) AS actual_cost
            `,
            groupBy: 'ul.account_id,ul.model,ul.requested_model',
          }));
          for (const row of resultRows) {
            const day = String(row.day || '');
            const accountId = number(row.account_id);
            mergeUsageRow(
              accounts,
              JSON.stringify([accountId, day]),
              day,
              row,
            );
            const name = modelKey(row.requested_model, row.model);
            mergeUsageRow(
              models,
              JSON.stringify([accountId, day, name]),
              day,
              row,
              { dimensionKey: name, dimensionName: name },
            );
          }
        }
      } catch (error) {
        if (cached?.staleExpiresAt > Date.now()) {
          return cached.value;
        }
        throw error;
      }
      const value = {
        accounts: [...accounts.values()].sort((left, right) => (
          left.accountId - right.accountId || left.day.localeCompare(right.day)
        )),
        models: [...models.values()].sort((left, right) => (
          left.accountId - right.accountId
          || left.day.localeCompare(right.day)
          || left.dimensionName.localeCompare(right.dimensionName, 'zh-CN')
        )),
      };
      const loadedAt = Date.now();
      this.cache.set(key, {
        value,
        expiresAt: loadedAt + this.ttlMs,
        staleExpiresAt: loadedAt + this.staleTtlMs,
      });
      this.pruneCache();
      return value;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, load);
    return load;
  }

  async getHourlyAccountStats({ start, end, accountIds = null }) {
    const ids = accountIds?.length
      ? [...new Set(accountIds.map(Number)
        .filter((value) => Number.isSafeInteger(value) && value > 0))]
      : null;
    if (!ids?.length) return [];
    const key = this.cacheKey({ start, end, accountIds: ids, dimension: 'account-hour' });
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached?.expiresAt > now) return cached.value;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const load = (async () => {
      const client = await this.pool.connect();
      let result;
      try {
        await client.query('BEGIN TRANSACTION READ ONLY');
        result = await client.query(`
          SELECT
            COALESCE(ul.account_id,0)::bigint AS account_id,
            TO_TIMESTAMP(FLOOR(EXTRACT(EPOCH FROM ul.created_at) / 3600) * 3600) AS hour,
            COUNT(*)::bigint AS requests,
            COALESCE(SUM(ul.total_cost),0) AS cost
          FROM ${this.schema}.usage_logs ul
          WHERE ul.created_at >= $1 AND ul.created_at < $2
            AND ul.account_id=ANY($3::bigint[])
          GROUP BY
            COALESCE(ul.account_id,0),
            TO_TIMESTAMP(FLOOR(EXTRACT(EPOCH FROM ul.created_at) / 3600) * 3600)
          ORDER BY hour,account_id
        `, [start, end, ids]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      const value = result.rows.map((row) => ({
        accountId: number(row.account_id),
        hour: row.hour instanceof Date ? row.hour.toISOString() : String(row.hour || ''),
        requests: number(row.requests),
        cost: number(row.cost),
      }));
      this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
      this.pruneCache();
      return value;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, load);
    return load;
  }

  async getFiveMinuteAccountStats({ start, end, accountIds = null }) {
    const ids = accountIds?.length
      ? [...new Set(accountIds.map(Number)
        .filter((value) => Number.isSafeInteger(value) && value > 0))]
      : null;
    if (!ids?.length) return [];
    const key = `account-5m:${new Date(start).toISOString()}:${new Date(end).toISOString()}:${ids
      .sort((left, right) => left - right).join(',')}`;
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached?.expiresAt > now) return cached.value;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const load = (async () => {
      const client = await this.pool.connect();
      let result;
      try {
        await client.query('BEGIN TRANSACTION READ ONLY');
        result = await client.query(`
          SELECT
            COALESCE(ul.account_id,0)::bigint AS account_id,
            TO_TIMESTAMP(FLOOR(EXTRACT(EPOCH FROM ul.created_at) / 300) * 300) AS bucket,
            COUNT(*)::bigint AS requests,
            COALESCE(SUM(
              COALESCE(ul.account_stats_cost,ul.total_cost)
              * COALESCE(ul.account_rate_multiplier,1)
            ),0) AS usage
          FROM ${this.schema}.usage_logs ul
          WHERE ul.created_at >= $1 AND ul.created_at < $2
            AND ul.account_id=ANY($3::bigint[])
          GROUP BY
            COALESCE(ul.account_id,0),
            TO_TIMESTAMP(FLOOR(EXTRACT(EPOCH FROM ul.created_at) / 300) * 300)
          ORDER BY bucket,account_id
        `, [start, end, ids]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      const value = result.rows.map((row) => ({
        accountId: number(row.account_id),
        bucket: row.bucket instanceof Date ? row.bucket.toISOString() : String(row.bucket || ''),
        requests: number(row.requests),
        usage: number(row.usage),
      }));
      // Completed five-minute buckets are immutable. Keep them until the
      // rolling window advances instead of querying the same range every poll.
      this.cache.set(key, { value, expiresAt: Date.now() + 10 * 60_000 });
      this.pruneCache();
      return value;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, load);
    return load;
  }

  async getAccountCapacityUsageTotals({ accounts = [], end = new Date() } = {}) {
    const normalized = accounts
      .map((entry) => ({
        accountId: Number(entry?.accountId),
        startedAt: new Date(entry?.startedAt || 0),
      }))
      .filter((entry) => Number.isSafeInteger(entry.accountId) && entry.accountId > 0
        && Number.isFinite(entry.startedAt.getTime()));
    if (!normalized.length) return [];
    const unique = [...new Map(normalized.map((entry) => [entry.accountId, entry])).values()]
      .sort((left, right) => left.accountId - right.accountId);
    const key = `account-capacity-total:${unique
      .map((entry) => `${entry.accountId}:${entry.startedAt.toISOString()}`).join(',')}`;
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached?.expiresAt > now) return cached.value;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const load = (async () => {
      const accountIds = unique.map((entry) => entry.accountId);
      const startedAt = unique.map((entry) => entry.startedAt.toISOString());
      const client = await this.pool.connect();
      let result;
      try {
        await client.query('BEGIN TRANSACTION READ ONLY');
        result = await client.query(`
          WITH scope AS (
            SELECT *
            FROM UNNEST($1::bigint[],$2::timestamptz[]) AS selected(account_id,started_at)
          )
          SELECT
            scope.account_id,
            COALESCE(totals.usage,0) AS usage,
            COALESCE(totals.requests,0)::bigint AS requests,
            totals.last_usage_at
          FROM scope
          LEFT JOIN LATERAL (
            SELECT
              COALESCE(SUM(
                COALESCE(ul.account_stats_cost,ul.total_cost)
                * COALESCE(ul.account_rate_multiplier,1)
              ),0) AS usage,
              COUNT(*)::bigint AS requests,
              MAX(ul.created_at) AS last_usage_at
            FROM ${this.schema}.usage_logs ul
            WHERE ul.account_id=scope.account_id
              AND ul.created_at>=scope.started_at
              AND ul.created_at<$3
          ) totals ON TRUE
          ORDER BY scope.account_id
        `, [accountIds, startedAt, end]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      const value = result.rows.map((row) => ({
        accountId: number(row.account_id),
        usage: number(row.usage),
        requests: number(row.requests),
        lastUsageAt: row.last_usage_at instanceof Date
          ? row.last_usage_at.toISOString()
          : row.last_usage_at || null,
      }));
      // Full-capacity calibration changes slowly; a five-minute cache keeps the
      // read-only source database load bounded while recent velocity stays live.
      this.cache.set(key, { value, expiresAt: Date.now() + 5 * 60_000 });
      this.pruneCache();
      return value;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, load);
    return load;
  }
}
