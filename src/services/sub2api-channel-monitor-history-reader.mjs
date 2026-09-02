function nullableInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export class Sub2ApiChannelMonitorHistoryReader {
  constructor(pool, logger = console) {
    this.pool = pool;
    this.logger = logger;
  }

  async read() {
    if (!this.pool) return null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');
      const monitorResult = await client.query(`
        SELECT id,name,provider,group_name,primary_model,enabled,last_checked_at
        FROM public.channel_monitors
        WHERE enabled
        ORDER BY id`);
      const latestResult = await client.query(`
        WITH ranked AS (
          SELECT h.monitor_id,h.model,h.status,h.latency_ms,h.ping_latency_ms,h.checked_at,
                 ROW_NUMBER() OVER (
                   PARTITION BY h.monitor_id
                   ORDER BY h.checked_at DESC,h.id DESC
                 ) AS history_rank
          FROM public.channel_monitor_histories h
          JOIN public.channel_monitors m ON m.id=h.monitor_id
          WHERE m.enabled
            AND h.model=m.primary_model
        )
        SELECT monitor_id,model,status,latency_ms,ping_latency_ms,checked_at
        FROM ranked
        WHERE history_rank=1`);
      const historyResult = await client.query(`
        WITH ranked AS (
          SELECT h.id,h.monitor_id,h.model,h.status,h.latency_ms,h.ping_latency_ms,h.checked_at,
                 ROW_NUMBER() OVER (
                   PARTITION BY h.monitor_id
                   ORDER BY h.checked_at DESC,h.id DESC
                 ) AS history_rank
          FROM public.channel_monitor_histories h
          JOIN public.channel_monitors m ON m.id=h.monitor_id
          WHERE m.enabled
            AND h.model=m.primary_model
        )
        SELECT id,monitor_id,model,status,latency_ms,ping_latency_ms,checked_at
        FROM ranked
        WHERE history_rank <= 60
        ORDER BY monitor_id,checked_at,id`);
      const todayStatsResult = await client.query(`
        SELECT h.monitor_id,
               COUNT(*) AS total_checks,
               COUNT(*) FILTER (WHERE h.status IN ('operational','degraded')) AS ok_count,
               COALESCE(SUM(h.latency_ms) FILTER (WHERE h.latency_ms IS NOT NULL),0) AS sum_latency_ms,
               COUNT(h.latency_ms) AS count_latency,
               COALESCE(SUM(h.ping_latency_ms) FILTER (WHERE h.ping_latency_ms IS NOT NULL),0) AS sum_ping_latency_ms,
               COUNT(h.ping_latency_ms) AS count_ping_latency
        FROM public.channel_monitor_histories h
        JOIN public.channel_monitors m ON m.id=h.monitor_id
        WHERE m.enabled
          AND h.model=m.primary_model
          AND h.checked_at >= CURRENT_DATE
        GROUP BY h.monitor_id`);
      const rollupResult = await client.query(`
        SELECT r.id,r.monitor_id,r.model,r.bucket_date,
               r.total_checks,r.ok_count,
               r.sum_latency_ms,r.count_latency,
               r.sum_ping_latency_ms,r.count_ping_latency
        FROM public.channel_monitor_daily_rollups r
        JOIN public.channel_monitors m ON m.id=r.monitor_id
        WHERE m.enabled
          AND r.model=m.primary_model
          AND r.bucket_date >= CURRENT_DATE - 29
          AND r.bucket_date < CURRENT_DATE
        ORDER BY r.monitor_id,r.bucket_date`);
      const todayResult = await client.query('SELECT CURRENT_DATE::text AS today_date');
      await client.query('COMMIT');
      return {
        todayDate: todayResult.rows[0]?.today_date || new Date().toISOString().slice(0, 10),
        monitors: monitorResult.rows.map((row) => ({
          id: nullableInteger(row.id),
          name: String(row.name || '').trim(),
          provider: String(row.provider || '').trim(),
          groupName: String(row.group_name || '').trim(),
          primaryModel: String(row.primary_model || '').trim(),
          enabled: row.enabled !== false,
          lastCheckedAt: row.last_checked_at || null,
        })),
        latest: latestResult.rows.map((row) => ({
          monitorId: nullableInteger(row.monitor_id),
          model: String(row.model || '').trim(),
          status: String(row.status || '').trim(),
          latencyMs: row.latency_ms,
          pingLatencyMs: row.ping_latency_ms,
          checkedAt: row.checked_at || null,
        })).filter((row) => row.monitorId && row.checkedAt),
        histories: historyResult.rows.map((row) => ({
          id: nullableInteger(row.id),
          monitorId: nullableInteger(row.monitor_id),
          model: String(row.model || '').trim(),
          status: String(row.status || '').trim(),
          latencyMs: row.latency_ms,
          pingLatencyMs: row.ping_latency_ms,
          checkedAt: row.checked_at || null,
        })).filter((row) => row.id && row.monitorId && row.checkedAt),
        todayStats: todayStatsResult.rows.map((row) => ({
          monitorId: nullableInteger(row.monitor_id),
          totalChecks: nullableInteger(row.total_checks) || 0,
          okCount: nullableInteger(row.ok_count) || 0,
          sumLatencyMs: nullableInteger(row.sum_latency_ms) || 0,
          countLatency: nullableInteger(row.count_latency) || 0,
          sumPingLatencyMs: nullableInteger(row.sum_ping_latency_ms) || 0,
          countPingLatency: nullableInteger(row.count_ping_latency) || 0,
        })).filter((row) => row.monitorId),
        rollups: rollupResult.rows.map((row) => ({
          id: nullableInteger(row.id),
          monitorId: nullableInteger(row.monitor_id),
          model: String(row.model || '').trim(),
          bucketDate: row.bucket_date || null,
          totalChecks: nullableInteger(row.total_checks) || 0,
          okCount: nullableInteger(row.ok_count) || 0,
          sumLatencyMs: nullableInteger(row.sum_latency_ms) || 0,
          countLatency: nullableInteger(row.count_latency) || 0,
          sumPingLatencyMs: nullableInteger(row.sum_ping_latency_ms) || 0,
          countPingLatency: nullableInteger(row.count_ping_latency) || 0,
        })).filter((row) => row.id && row.monitorId && row.bucketDate),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
