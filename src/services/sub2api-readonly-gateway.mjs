function endpoint(baseUrl, pathname) {
  return new URL(pathname, `${baseUrl}/`).toString();
}

function queryPath(pathname, params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export class Sub2ApiReadonlyGateway {
  constructor(config, logger = console, fetchImpl = fetch) {
    this.config = config;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.accessToken = '';
    this.accessTokenProvider = null;
    this.cache = new Map();
    this.inflight = new Map();
    this.activeRequests = 0;
    this.waiters = [];
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
    this.inflight.clear();
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

  async acquireRequestSlot() {
    const limit = this.config.sub2apiUsageMaxConcurrency || 4;
    if (this.activeRequests < limit) {
      this.activeRequests += 1;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
    this.activeRequests += 1;
  }

  releaseRequestSlot() {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.waiters.shift()?.();
  }

  pruneCache(now = Date.now()) {
    if (this.cache.size <= 500) return;
    for (const [key, entry] of this.cache) {
      if (entry.staleUntil <= now) this.cache.delete(key);
      if (this.cache.size <= 400) break;
    }
  }

  async request(pathname, {
    method = 'GET',
    body,
    cacheKey = pathname,
    ttlMs = 30_000,
    staleTtlMs = (this.config.sub2apiUsageStaleTtlSeconds || 0) * 1_000,
    timeoutMs = this.config.sub2apiAuthTimeoutMs || 10_000,
    cache = true,
    cachePost = false,
  } = {}) {
    const now = Date.now();
    const cacheable = cache && (method === 'GET' || cachePost);
    const existing = cacheable ? this.cache.get(cacheKey) : null;
    if (existing && existing.expiresAt > now) return existing.payload;
    const coalesced = cacheable ? this.inflight.get(cacheKey) : null;
    if (coalesced) return coalesced;
    const requestWithAuthentication = async (authentication) => {
      if (!authentication?.credential) throw Object.assign(new Error('sub2api administrator session is unavailable'), { statusCode: 503 });
      await this.acquireRequestSlot();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
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
        this.releaseRequestSlot();
      }
    };
    const execute = async () => {
      const selected = await this.authentication();
      try {
        const payload = await requestWithAuthentication(selected);
        if (cacheable) {
          this.cache.set(cacheKey, {
            payload,
            expiresAt: Date.now() + ttlMs,
            staleUntil: Date.now() + ttlMs + staleTtlMs,
          });
          this.pruneCache();
        }
        return payload;
      } catch (error) {
        if ((error?.statusCode === 401 || error?.statusCode === 403) && selected.serviceManaged) {
          await this.accessTokenProvider.invalidateAccessToken(selected.credential);
          const retryAuthentication = await this.authentication({ force: true });
          try {
            const payload = await requestWithAuthentication(retryAuthentication);
            if (cacheable) {
              this.cache.set(cacheKey, {
                payload,
                expiresAt: Date.now() + ttlMs,
                staleUntil: Date.now() + ttlMs + staleTtlMs,
              });
            }
            return payload;
          } catch (retryError) {
            if (existing && existing.staleUntil > Date.now()) {
              this.logger.warn('[sub2api readonly] using stale cached response after authentication retry', cacheKey, retryError?.message || retryError);
              return existing.payload;
            }
            throw retryError;
          }
        }
        if (error?.statusCode === 401 || error?.statusCode === 403) this.clearAccessToken();
        if (existing && existing.staleUntil > Date.now()) {
          this.logger.warn('[sub2api readonly] using stale cached response', cacheKey, error?.message || error);
          return existing.payload;
        }
        throw error;
      }
    };
    const promise = execute().finally(() => {
      if (cacheable) this.inflight.delete(cacheKey);
    });
    if (cacheable) this.inflight.set(cacheKey, promise);
    return promise;
  }

  usageRequest(pathname, params = {}, { ttlSeconds, cacheKey } = {}) {
    const path = queryPath(pathname, params);
    return this.request(path, {
      cacheKey: cacheKey || `usage:${path}`,
      ttlMs: (ttlSeconds || this.config.sub2apiUsageCacheTtlSeconds || 30) * 1_000,
      timeoutMs: this.config.sub2apiUsageTimeoutMs || 15_000,
    });
  }

  usageStats({
    startDate = '', endDate = '', timezone = this.config.timezone,
    userId, apiKeyId, accountId, groupId, model = '', billingMode = '',
  } = {}) {
    return this.usageRequest('/api/v1/admin/usage/stats', {
      start_date: startDate,
      end_date: endDate,
      timezone,
      user_id: userId,
      api_key_id: apiKeyId,
      account_id: accountId,
      group_id: groupId,
      model,
      billing_mode: billingMode,
    });
  }

  listUsage({
    startDate = '', endDate = '', timezone = this.config.timezone,
    page = 1, pageSize = 20, userId, accountId, requestId = '', model = '',
    sortBy = 'created_at', sortOrder = 'desc',
  } = {}) {
    return this.usageRequest('/api/v1/admin/usage', {
      start_date: startDate,
      end_date: endDate,
      timezone,
      page,
      page_size: pageSize,
      user_id: userId,
      account_id: accountId,
      request_id: requestId,
      model,
      sort_by: sortBy,
      sort_order: sortOrder,
      exact_total: false,
    }, { ttlSeconds: Math.min(10, this.config.sub2apiUsageCacheTtlSeconds || 30) });
  }

  dashboardTrend({
    startDate = '', endDate = '', timezone = this.config.timezone,
    granularity = 'day', userId, accountId,
  } = {}) {
    return this.usageRequest('/api/v1/admin/dashboard/trend', {
      start_date: startDate,
      end_date: endDate,
      timezone,
      granularity,
      user_id: userId,
      account_id: accountId,
    });
  }

  dashboardModels({
    startDate = '', endDate = '', timezone = this.config.timezone,
    userId, accountId, modelSource = 'requested',
  } = {}) {
    return this.usageRequest('/api/v1/admin/dashboard/models', {
      start_date: startDate,
      end_date: endDate,
      timezone,
      user_id: userId,
      account_id: accountId,
      model_source: modelSource,
    });
  }

  dashboardGroups({
    startDate = '', endDate = '', timezone = this.config.timezone,
    userId, accountId, groupId,
  } = {}) {
    return this.usageRequest('/api/v1/admin/dashboard/groups', {
      start_date: startDate,
      end_date: endDate,
      timezone,
      user_id: userId,
      account_id: accountId,
      group_id: groupId,
    });
  }

  dashboardUserBreakdown({
    startDate = '', endDate = '', timezone = this.config.timezone,
    userId, accountId, limit = 200, sortBy = 'actual_cost',
  } = {}) {
    return this.usageRequest('/api/v1/admin/dashboard/user-breakdown', {
      start_date: startDate,
      end_date: endDate,
      timezone,
      user_id: userId,
      account_id: accountId,
      limit: Math.min(200, Math.max(1, Number(limit) || 200)),
      sort_by: sortBy,
    });
  }

  accountStats(accountId, { days = 30 } = {}) {
    return this.usageRequest(`/api/v1/admin/accounts/${Number(accountId)}/stats`, {
      days: Math.min(365, Math.max(1, Number(days) || 30)),
    }, {
      cacheKey: `usage:account-stats:${Number(accountId)}:${Number(days) || 30}`,
    });
  }

  async sourceUsageHealth() {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.config.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    return this.usageStats({ startDate: today, endDate: today });
  }

  clearUsageCache() {
    this.invalidate('usage:');
    for (const key of this.inflight.keys()) {
      if (String(key).startsWith('usage:')) this.inflight.delete(key);
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
      ...(params.timezone ? { timezone: params.timezone } : {}),
      ...(params.userId ? { user_id: String(params.userId) } : {}),
      ...(params.apiKeyId ? { api_key_id: String(params.apiKeyId) } : {}),
      ...(params.accountId ? { account_id: String(params.accountId) } : {}),
      ...(params.groupId ? { group_id: String(params.groupId) } : {}),
      ...(params.model ? { model: String(params.model) } : {}),
    });
    return this.request(`/api/v1/admin/dashboard/snapshot-v2?${search}`, {
      cacheKey: `usage:dashboard:${search}`,
      ttlMs: (this.config.sub2apiUsageCacheTtlSeconds || 30) * 1_000,
      timeoutMs: this.config.sub2apiUsageTimeoutMs || 15_000,
    });
  }

  accountTodayStats(accountIds) {
    return this.request('/api/v1/admin/accounts/today-stats/batch', {
      method: 'POST',
      body: { account_ids: accountIds },
      cacheKey: `account-today:${[...accountIds].sort((a, b) => a - b).join(',')}`,
      ttlMs: 30_000,
      cachePost: true,
    });
  }

  channelMonitors() {
    return this.request('/api/v1/admin/channel-monitors', { cacheKey: 'channel-monitors', ttlMs: 5_000 });
  }

  riskControlStatus() {
    return this.request('/api/v1/admin/risk-control/status', { cacheKey: 'risk-control', ttlMs: 2_000 });
  }
}
