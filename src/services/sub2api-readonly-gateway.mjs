function endpoint(baseUrl, pathname) {
  return new URL(pathname, `${baseUrl}/`).toString();
}

export class Sub2ApiReadonlyGateway {
  constructor(config, logger = console, fetchImpl = fetch) {
    this.config = config;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.accessToken = '';
    this.cache = new Map();
  }

  setAccessToken(token) {
    this.accessToken = String(token || '').trim();
    if (!this.accessToken) this.cache.clear();
  }

  clearAccessToken() {
    this.accessToken = '';
    this.cache.clear();
  }

  async request(pathname, { method = 'GET', body, cacheKey = pathname, ttlMs = 30_000 } = {}) {
    if (!this.accessToken) throw Object.assign(new Error('sub2api administrator session is unavailable'), { statusCode: 503 });
    const now = Date.now();
    const existing = this.cache.get(cacheKey);
    if (existing && existing.expiresAt > now) return existing.payload;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.sub2apiAuthTimeoutMs || 10_000);
    try {
      const response = await this.fetchImpl(endpoint(this.config.sub2apiAuthUrl, pathname), {
        method,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let raw = null;
      try { raw = await response.json(); } catch { throw new Error('sub2api returned invalid JSON'); }
      if (!response.ok || (Object.hasOwn(raw, 'code') && raw.code !== 0)) {
        throw Object.assign(new Error('sub2api read-only API request failed'), {
          statusCode: response.status >= 500 ? 503 : response.status,
        });
      }
      const payload = Object.hasOwn(raw, 'data') ? raw.data : raw;
      this.cache.set(cacheKey, { payload, expiresAt: now + ttlMs });
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  dashboardSnapshot(params = {}) {
    const search = new URLSearchParams({
      include_stats: params.includeStats === false ? 'false' : 'true',
      include_trend: params.includeTrend === false ? 'false' : 'true',
      include_model_stats: params.includeModels === false ? 'false' : 'true',
      include_group_stats: params.includeGroups === true ? 'true' : 'false',
      include_users_trend: params.includeUsersTrend === true ? 'true' : 'false',
      ...(params.startDate ? { start_date: params.startDate } : {}),
      ...(params.endDate ? { end_date: params.endDate } : {}),
    });
    return this.request(`/api/v1/admin/dashboard/snapshot-v2?${search}`, {
      cacheKey: `dashboard:${search}`,
      ttlMs: 30_000,
    });
  }

  accountTodayStats(accountIds) {
    return this.request('/api/v1/admin/accounts/today-stats/batch', {
      method: 'POST',
      body: { account_ids: accountIds },
      cacheKey: `account-today:${[...accountIds].sort((a, b) => a - b).join(',')}`,
      ttlMs: 30_000,
    });
  }

  channelMonitors() {
    return this.request('/api/v1/admin/channel-monitors', { cacheKey: 'channel-monitors', ttlMs: 5_000 });
  }

  riskControlStatus() {
    return this.request('/api/v1/admin/risk-control/status', { cacheKey: 'risk-control', ttlMs: 2_000 });
  }
}
