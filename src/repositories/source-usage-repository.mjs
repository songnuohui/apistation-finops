function number(value) {
  return value === null || value === undefined ? 0 : Number(value);
}

export class SourceUsageRepository {
  constructor(pool, config) {
    this.pool = pool;
    this.schema = `"${config.sourceSchema}"`;
    this.timezone = config.timezone || 'Asia/Shanghai';
    this.ttlMs = (config.sub2apiUsageCacheTtlSeconds || 30) * 1_000;
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
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
    while (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value);
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
      const args = [start, end];
      const accountPredicate = ids
        ? `AND ul.account_id=ANY($${args.push(ids)}::bigint[])`
        : '';
      const timezoneParameter = args.push(this.timezone);
      const client = await this.pool.connect();
      let result;
      try {
        await client.query('BEGIN TRANSACTION READ ONLY');
        result = await client.query(`
          SELECT
            COALESCE(ul.account_id,0)::bigint AS account_id,
            (ul.created_at AT TIME ZONE $${timezoneParameter})::date::text AS day,
            COUNT(*)::bigint AS requests,
            COALESCE(SUM(ul.input_tokens),0) AS input_tokens,
            COALESCE(SUM(ul.output_tokens),0) AS output_tokens,
            COALESCE(SUM(ul.cache_creation_tokens+ul.cache_read_tokens),0) AS cache_tokens,
            COALESCE(SUM(
              ul.input_tokens+ul.output_tokens+ul.cache_creation_tokens+ul.cache_read_tokens
            ),0) AS total_tokens,
            COALESCE(SUM(ul.total_cost),0) AS cost,
            COALESCE(SUM(ul.actual_cost),0) AS actual_cost
          FROM ${this.schema}.usage_logs ul
          WHERE ul.created_at >= $1 AND ul.created_at < $2
            ${accountPredicate}
          GROUP BY
            COALESCE(ul.account_id,0),
            (ul.created_at AT TIME ZONE $${timezoneParameter})::date
          ORDER BY account_id,day
        `, args);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      const value = result.rows.map((row) => ({
        accountId: number(row.account_id),
        day: row.day || '',
        requests: number(row.requests),
        inputTokens: number(row.input_tokens),
        outputTokens: number(row.output_tokens),
        cacheTokens: number(row.cache_tokens),
        totalTokens: number(row.total_tokens),
        cost: number(row.cost),
        actualCost: number(row.actual_cost),
      }));
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
      const args = [start, end];
      const accountPredicate = ids
        ? `AND ul.account_id=ANY($${args.push(ids)}::bigint[])`
        : '';
      const timezoneParameter = args.push(this.timezone);
      const dimensionSelect = dimension === 'model'
        ? `COALESCE(NULLIF(BTRIM(COALESCE(ul.requested_model,ul.model)),''),'unlabeled')`
        : 'COALESCE(ul.user_id,0)::bigint';
      const dimensionLabel = dimension === 'model'
        ? `${dimensionSelect} AS dimension_name`
        : `COALESCE(MAX(u.email),'') AS dimension_name`;
      const join = dimension === 'user'
        ? `LEFT JOIN ${this.schema}.users u ON u.id=ul.user_id`
        : '';
      const client = await this.pool.connect();
      let result;
      try {
        await client.query('BEGIN TRANSACTION READ ONLY');
        result = await client.query(`
          SELECT
            COALESCE(ul.account_id,0)::bigint AS account_id,
            (ul.created_at AT TIME ZONE $${timezoneParameter})::date::text AS day,
            ${dimensionSelect} AS dimension_key,
            ${dimensionLabel},
            COUNT(*)::bigint AS requests,
            COALESCE(SUM(ul.input_tokens),0) AS input_tokens,
            COALESCE(SUM(ul.output_tokens),0) AS output_tokens,
            COALESCE(SUM(ul.cache_creation_tokens+ul.cache_read_tokens),0) AS cache_tokens,
            COALESCE(SUM(
              ul.input_tokens+ul.output_tokens+ul.cache_creation_tokens+ul.cache_read_tokens
            ),0) AS total_tokens,
            COALESCE(SUM(ul.total_cost),0) AS cost,
            COALESCE(SUM(ul.actual_cost),0) AS actual_cost
          FROM ${this.schema}.usage_logs ul
          ${join}
          WHERE ul.created_at >= $1 AND ul.created_at < $2
            ${accountPredicate}
          GROUP BY
            COALESCE(ul.account_id,0),
            (ul.created_at AT TIME ZONE $${timezoneParameter})::date,
            ${dimensionSelect}
          ORDER BY account_id,day,dimension_key
        `, args);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      const value = result.rows.map((row) => ({
        accountId: number(row.account_id),
        day: row.day || '',
        dimensionKey: dimension === 'user' ? number(row.dimension_key) : String(row.dimension_key || 'unlabeled'),
        dimensionName: row.dimension_name || '',
        requests: number(row.requests),
        inputTokens: number(row.input_tokens),
        outputTokens: number(row.output_tokens),
        cacheTokens: number(row.cache_tokens),
        totalTokens: number(row.total_tokens),
        cost: number(row.cost),
        actualCost: number(row.actual_cost),
      }));
      this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
      this.pruneCache();
      return value;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, load);
    return load;
  }
}
