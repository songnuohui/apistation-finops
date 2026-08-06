function endpoint(baseUrl, pathname) {
  return new URL(pathname, `${baseUrl}/`).toString();
}

export class Sub2ApiReadonlyGateway {
  constructor(config, logger = console, fetchImpl = fetch) {
    this.config = config;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.accessToken = '';
    this.accessTokenProvider = null;
    this.cache = new Map();
  }

  setAccessTokenProvider(provider) {
    this.accessTokenProvider = provider && typeof provider.getAccessToken === 'function' ? provider : null;
  }

  setAccessToken(token) {
    this.accessToken = String(token || '').trim();
    if (!this.accessToken) this.cache.clear();
  }

  clearAccessToken() {
    this.accessToken = '';
    this.cache.clear();
  }

  async token() {
    const token = this.accessTokenProvider ? await this.accessTokenProvider.getAccessToken() : '';
    return { token: String(token || this.accessToken || '').trim(), serviceManaged: Boolean(token) };
  }

  async request(pathname, { method = 'GET', body, cacheKey = pathname, ttlMs = 30_000, cache = true } = {}) {
    const now = Date.now();
    const existing = cache && method === 'GET' ? this.cache.get(cacheKey) : null;
    if (existing && existing.expiresAt > now) return existing.payload;
    const requestWithToken = async (accessToken) => {
      if (!accessToken) throw Object.assign(new Error('sub2api administrator session is unavailable'), { statusCode: 503 });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.sub2apiAuthTimeoutMs || 10_000);
      try {
        const response = await this.fetchImpl(endpoint(this.config.sub2apiAuthUrl, pathname), {
          method,
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        let raw = null;
        try { raw = await response.json(); } catch { throw new Error('sub2api returned invalid JSON'); }
        if (!response.ok || (Object.hasOwn(raw, 'code') && raw.code !== 0)) {
          throw Object.assign(new Error('sub2api administrator API request failed'), {
            statusCode: response.status >= 500 ? 503 : response.status,
          });
        }
        return Object.hasOwn(raw, 'data') ? raw.data : raw;
      } finally {
        clearTimeout(timer);
      }
    };
    const selected = await this.token();
    try {
      const payload = await requestWithToken(selected.token);
      if (cache && method === 'GET') this.cache.set(cacheKey, { payload, expiresAt: now + ttlMs });
      return payload;
    } catch (error) {
      if ((error?.statusCode === 401 || error?.statusCode === 403) && selected.serviceManaged) {
        await this.accessTokenProvider.invalidateAccessToken(selected.token);
        const retryToken = await this.accessTokenProvider.getAccessToken({ force: true });
        const payload = await requestWithToken(retryToken);
        if (cache && method === 'GET') this.cache.set(cacheKey, { payload, expiresAt: now + ttlMs });
        return payload;
      }
      if (error?.statusCode === 401 || error?.statusCode === 403) this.clearAccessToken();
      throw error;
    }
  }

  invalidate(...prefixes) {
    if (!prefixes.length) return this.cache.clear();
    for (const key of this.cache.keys()) {
      if (prefixes.some((prefix) => String(key).startsWith(prefix))) this.cache.delete(key);
    }
  }

  async getAccount(accountId, { fresh = false } = {}) {
    const payload = await this.request(`/api/v1/admin/accounts/${Number(accountId)}`, {
      cacheKey: `account:${Number(accountId)}`,
      ttlMs: 5_000,
      cache: !fresh,
    });
    return payload?.account || payload;
  }

  async listGroups() {
    return this.request('/api/v1/admin/groups', {
      cacheKey: 'groups',
      ttlMs: 10_000,
    });
  }

  async updateAccountGroups(accountId, groupIds) {
    const payload = await this.request(`/api/v1/admin/accounts/${Number(accountId)}`, {
      method: 'PUT',
      body: {
        group_ids: [...new Set(groupIds.map((value) => Number(value)).filter((value) => Number.isSafeInteger(value) && value > 0))],
        confirm_mixed_channel_risk: true,
      },
      cache: false,
    });
    this.invalidate(`account:${Number(accountId)}`, 'accounts:', 'groups:');
    return payload?.account || payload;
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
