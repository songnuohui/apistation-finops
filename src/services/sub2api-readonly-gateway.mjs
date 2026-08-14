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
    this.accessTokenProvider = provider && (
      typeof provider.getAccessToken === 'function'
      || typeof provider.getAuthentication === 'function'
    ) ? provider : null;
  }

  setAccessToken(token) {
    this.accessToken = String(token || '').trim();
    if (!this.accessToken) this.cache.clear();
  }

  clearAccessToken() {
    this.accessToken = '';
    this.cache.clear();
  }

  async authentication({ force = false } = {}) {
    const managed = this.accessTokenProvider?.getAuthentication
      ? await this.accessTokenProvider.getAuthentication({ force })
      : null;
    if (managed?.credential) {
      return {
        credential: String(managed.credential).trim(),
        headers: managed.headers || {},
        serviceManaged: true,
      };
    }
    const token = this.accessTokenProvider ? await this.accessTokenProvider.getAccessToken({ force }) : '';
    const credential = String(token || this.accessToken || '').trim();
    return {
      credential,
      headers: { Authorization: `Bearer ${credential}` },
      serviceManaged: Boolean(token),
    };
  }

  async request(pathname, { method = 'GET', body, cacheKey = pathname, ttlMs = 30_000, cache = true } = {}) {
    const now = Date.now();
    const existing = cache && method === 'GET' ? this.cache.get(cacheKey) : null;
    if (existing && existing.expiresAt > now) return existing.payload;
    const requestWithAuthentication = async (authentication) => {
      if (!authentication?.credential) throw Object.assign(new Error('sub2api administrator session is unavailable'), { statusCode: 503 });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.sub2apiAuthTimeoutMs || 10_000);
      try {
        const response = await this.fetchImpl(endpoint(this.config.sub2apiAuthUrl, pathname), {
          method,
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            ...authentication.headers,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const responseText = await response.text();
        let raw = {};
        if (responseText.trim()) {
          try { raw = JSON.parse(responseText); } catch { throw new Error('sub2api returned invalid JSON'); }
        }
        if (!response.ok || (Object.hasOwn(raw, 'code') && raw.code !== 0)) {
          throw Object.assign(new Error(raw?.message || raw?.error || 'sub2api administrator API request failed'), {
            statusCode: response.status >= 500 ? 503 : response.status || 502,
            httpStatus: response.status,
          });
        }
        return Object.hasOwn(raw, 'data') ? raw.data : raw;
      } finally {
        clearTimeout(timer);
      }
    };
    const selected = await this.authentication();
    try {
      const payload = await requestWithAuthentication(selected);
      if (cache && method === 'GET') this.cache.set(cacheKey, { payload, expiresAt: now + ttlMs });
      return payload;
    } catch (error) {
      if ((error?.statusCode === 401 || error?.statusCode === 403) && selected.serviceManaged) {
        await this.accessTokenProvider.invalidateAccessToken(selected.credential);
        const retryAuthentication = await this.authentication({ force: true });
        const payload = await requestWithAuthentication(retryAuthentication);
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

  async listAccounts({
    page = 1, pageSize = 100, platform = '', accountType = '',
    group = '', privacyMode = '', search = '', status = 'active',
  } = {}) {
    const params = new URLSearchParams({
      page: String(Math.max(1, Number(page) || 1)),
      page_size: String(Math.min(100, Math.max(1, Number(pageSize) || 100))),
      ...(platform ? { platform: String(platform) } : {}),
      ...(accountType ? { type: String(accountType) } : {}),
      ...(group ? { group: String(group) } : {}),
      ...(privacyMode ? { privacy_mode: String(privacyMode) } : {}),
      ...(search ? { search: String(search) } : {}),
      ...(status ? { status: String(status) } : {}),
      lite: 'true',
    });
    return this.request(`/api/v1/admin/accounts?${params}`, {
      cacheKey: `accounts:${params}`,
      ttlMs: 10_000,
    });
  }

  async listAllAccounts(filters = {}) {
    const first = await this.listAccounts({ ...filters, page: 1, pageSize: 100 });
    const firstItems = first?.items || first?.accounts || [];
    const total = Number(first?.total ?? firstItems.length);
    const pageCount = Math.ceil(total / 100);
    const remaining = pageCount > 1
      ? await Promise.all(Array.from({ length: pageCount - 1 }, (_, index) => (
        this.listAccounts({ ...filters, page: index + 2, pageSize: 100 })
      )))
      : [];
    return [...firstItems, ...remaining.flatMap((payload) => payload?.items || payload?.accounts || [])];
  }

  async listAccountIds(filters = {}) {
    return (await this.listAllAccounts(filters))
      .map((account) => Number(account?.id))
      .filter((id) => Number.isSafeInteger(id) && id > 0);
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

  async deleteAccount(accountId) {
    const normalizedId = Number(accountId);
    if (!Number.isSafeInteger(normalizedId) || normalizedId <= 0) {
      throw Object.assign(new Error('invalid Sub2API account id'), { statusCode: 400 });
    }
    const payload = await this.request(`/api/v1/admin/accounts/${normalizedId}`, {
      method: 'DELETE',
      cache: false,
    });
    this.invalidate(`account:${normalizedId}`, 'accounts:', 'groups:');
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
