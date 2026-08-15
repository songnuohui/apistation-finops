function endpoint(baseUrl, pathname) {
  return new URL(pathname, `${baseUrl}/`).toString();
}

function normalizeAccountId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw Object.assign(new Error('invalid Sub2API account id'), { statusCode: 400 });
  }
  return id;
}

function unwrap(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  return Object.hasOwn(payload, 'data') ? payload.data : payload;
}

function groupCatalogEntry(group) {
  const id = Number(group?.id ?? group?.group_id ?? group?.source_group_id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return {
    id,
    name: String(group?.name || '').trim().slice(0, 160),
    platform: String(group?.platform || '').trim().slice(0, 50),
    status: String(group?.status || '').trim().slice(0, 24),
    rateMultiplier: group?.rate_multiplier ?? group?.rateMultiplier ?? null,
    sortOrder: Number.parseInt(group?.sort_order ?? group?.sortOrder, 10) || 0,
  };
}

function normalizeModelWhitelist(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value).trim()).filter(Boolean))];
}

export function applyModelWhitelist(credentials, modelWhitelist) {
  const next = { ...(credentials || {}) };
  const models = normalizeModelWhitelist(modelWhitelist);
  next.model_mapping = Object.fromEntries(models.map((model) => [model, model]));
  return next;
}

export class Sub2ApiAccountImportGateway {
  constructor(config, logger = console, fetchImpl = fetch) {
    this.config = config;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.accessTokenProvider = null;
  }

  setAccessTokenProvider(provider) {
    this.accessTokenProvider = provider || null;
  }

  async authentication({ force = false } = {}) {
    const managed = this.accessTokenProvider?.getAuthentication
      ? await this.accessTokenProvider.getAuthentication({ force })
      : null;
    if (managed?.credential) return managed;
    const token = this.accessTokenProvider?.getAccessToken
      ? await this.accessTokenProvider.getAccessToken({ force })
      : '';
    return {
      credential: String(token || '').trim(),
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      serviceManaged: Boolean(token),
    };
  }

  async request(pathname, { method = 'GET', body, accept = 'application/json' } = {}) {
    const execute = async (authentication) => {
      if (!authentication?.credential) {
        throw Object.assign(new Error('Sub2API service authentication is unavailable'), { statusCode: 503 });
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.sub2apiAuthTimeoutMs || 10_000);
      try {
        const response = await this.fetchImpl(endpoint(this.config.sub2apiAuthUrl, pathname), {
          method,
          signal: controller.signal,
          headers: {
            Accept: accept,
            ...authentication.headers,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        if (!response.ok) {
          let payload = {};
          try { payload = text ? JSON.parse(text) : {}; } catch {}
          throw Object.assign(new Error(payload?.message || payload?.error || `Sub2API returned HTTP ${response.status}`), {
            statusCode: response.status,
            httpStatus: response.status,
          });
        }
        return { response, text };
      } finally {
        clearTimeout(timer);
      }
    };
    const authentication = await this.authentication();
    try {
      return await execute(authentication);
    } catch (error) {
      if ([401, 403].includes(error?.httpStatus) && authentication.serviceManaged) {
        await this.accessTokenProvider?.invalidateAccessToken?.(authentication.credential);
        return execute(await this.authentication({ force: true }));
      }
      throw error;
    }
  }

  async jsonRequest(pathname, options = {}) {
    const { text } = await this.request(pathname, options);
    let payload = {};
    if (text.trim()) {
      try { payload = JSON.parse(text); } catch {
        throw Object.assign(new Error('Sub2API returned invalid JSON'), { statusCode: 502 });
      }
    }
    if (Object.hasOwn(payload, 'code') && Number(payload.code) !== 0) {
      throw Object.assign(new Error(payload.message || 'Sub2API administrator API request failed'), { statusCode: 502 });
    }
    return unwrap(payload);
  }

  async createAccount(input) {
    const payload = await this.jsonRequest('/api/v1/admin/accounts', {
      method: 'POST',
      body: {
        ...input,
        confirm_mixed_channel_risk: true,
      },
    });
    return payload?.account || payload;
  }

  async listGroups({ includeInactive = true } = {}) {
    const payload = await this.jsonRequest(
      `/api/v1/admin/groups/all${includeInactive ? '?include_inactive=true' : ''}`,
    );
    const groups = Array.isArray(payload) ? payload : payload?.items;
    if (!Array.isArray(groups)) {
      throw Object.assign(new Error('Sub2API returned an invalid group catalog'), { statusCode: 502 });
    }
    return groups
      .map(groupCatalogEntry)
      .filter(Boolean)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id);
  }

  async listModelCandidates(groups = []) {
    const representativeGroups = new Map();
    for (const group of groups) {
      if (Number.isSafeInteger(Number(group?.id)) && group?.platform && !representativeGroups.has(group.platform)) {
        representativeGroups.set(group.platform, group);
      }
    }
    const entries = await Promise.all([...representativeGroups.entries()].map(async ([platform, group]) => {
      try {
        const payload = await this.jsonRequest(`/api/v1/admin/groups/${Number(group.id)}/models-list-candidates?platform=${encodeURIComponent(platform)}`);
        const models = Array.isArray(payload) ? payload : payload?.models;
        const normalized = Array.isArray(models)
          ? models.map((model) => String(model?.id ?? model?.name ?? model).trim()).filter(Boolean)
          : [];
        return [platform, [...new Set(normalized)].sort()];
      } catch (error) {
        this.logger.warn(`[replenishment] model catalog unavailable for ${platform}`, error?.message || error);
        return [platform, []];
      }
    }));
    return Object.fromEntries(entries);
  }

  async updateAccountConfiguration(accountId, {
    groupIds,
    concurrency,
    loadFactor = null,
    priority,
    rateMultiplier = 1,
    autoPauseOnExpired = true,
    clearExpiration = true,
  }) {
    const id = normalizeAccountId(accountId);
    const payload = await this.jsonRequest(`/api/v1/admin/accounts/${id}`, {
      method: 'PUT',
      body: {
        group_ids: [...new Set((groupIds || []).map(Number))],
        concurrency: Number(concurrency),
        load_factor: loadFactor === null || loadFactor === undefined || loadFactor === ''
          ? 0 : Number(loadFactor),
        priority: Number(priority),
        rate_multiplier: rateMultiplier === null || rateMultiplier === undefined || rateMultiplier === ''
          ? 1 : Number(rateMultiplier),
        auto_pause_on_expired: Boolean(autoPauseOnExpired),
        ...(clearExpiration ? {
          expires_at: null,
        } : {}),
        confirm_mixed_channel_risk: true,
      },
    });
    return payload?.account || payload;
  }

  async setAccountSchedulable(accountId, schedulable) {
    const id = normalizeAccountId(accountId);
    const payload = await this.jsonRequest(`/api/v1/admin/accounts/${id}/schedulable`, {
      method: 'POST',
      body: { schedulable: Boolean(schedulable) },
    });
    return payload?.account || payload;
  }

  async applyOAuthCredentials(accountId, credentials, modelWhitelist = []) {
    const id = normalizeAccountId(accountId);
    const payload = await this.jsonRequest(`/api/v1/admin/accounts/${id}/apply-oauth-credentials`, {
      method: 'POST',
      body: {
        type: 'oauth',
        credentials: applyModelWhitelist(credentials, modelWhitelist),
      },
    });
    return payload?.account || payload;
  }

  async getAccount(accountId) {
    const id = normalizeAccountId(accountId);
    const payload = await this.jsonRequest(`/api/v1/admin/accounts/${id}`);
    return payload?.account || payload;
  }

  async getAccountUsage(accountId, { source = 'passive' } = {}) {
    const id = normalizeAccountId(accountId);
    const query = new URLSearchParams({ source: source === 'active' ? 'active' : 'passive' });
    return this.jsonRequest(`/api/v1/admin/accounts/${id}/usage?${query}`);
  }

  async testAccount(accountId, { modelId, prompt }) {
    const id = normalizeAccountId(accountId);
    const { text } = await this.request(`/api/v1/admin/accounts/${id}/test`, {
      method: 'POST',
      body: {
        model_id: modelId,
        prompt,
        mode: '',
      },
      accept: 'text/event-stream',
    });
    const events = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const raw = trimmed.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      try { events.push(JSON.parse(raw)); } catch {}
    }
    const failure = events.find((event) => event?.error || event?.type === 'error');
    if (failure) {
      throw Object.assign(new Error(failure?.error?.message || failure?.error || failure?.message || 'Sub2API account test failed'), {
        statusCode: 422,
      });
    }
    const completed = events.find((event) => event?.type === 'test_complete');
    if (!completed?.success) {
      throw Object.assign(new Error('Sub2API account test ended without an explicit success event'), {
        statusCode: 502,
      });
    }
    return { success: true, events: events.length };
  }

  async configureAndVerify({
    accountId,
    groupIds,
    concurrency,
    loadFactor = null,
    priority,
    rateMultiplier = 1,
    autoPauseOnExpired = true,
    modelId,
    prompt,
    clearExpiration = true,
  }) {
    await this.updateAccountConfiguration(accountId, {
      groupIds,
      concurrency,
      loadFactor,
      priority,
      rateMultiplier,
      autoPauseOnExpired,
      clearExpiration,
    });
    const confirmed = await this.getAccount(accountId);
    const confirmedGroups = (confirmed?.groups || confirmed?.group_ids || []).map((entry) => Number(entry?.id ?? entry));
    const expectedGroups = [...new Set((groupIds || []).map(Number))].sort((a, b) => a - b);
    const actualGroups = [...new Set(confirmedGroups)].sort((a, b) => a - b);
    const confirmedLoadFactorRaw = confirmed?.load_factor ?? confirmed?.loadFactor;
    const confirmedLoadFactor = confirmedLoadFactorRaw === null || confirmedLoadFactorRaw === undefined
      || Number(confirmedLoadFactorRaw) === 0 ? null : Number(confirmedLoadFactorRaw);
    const expectedLoadFactor = loadFactor === null || loadFactor === undefined || loadFactor === ''
      ? null : Number(loadFactor);
    const confirmedAutoPause = confirmed?.auto_pause_on_expired
      ?? confirmed?.autoPauseOnExpired
      ?? true;
    if (Number(confirmed?.concurrency) !== Number(concurrency)
      || confirmedLoadFactor !== expectedLoadFactor
      || Number(confirmed?.priority) !== Number(priority)
      || Number(confirmed?.rate_multiplier ?? confirmed?.rateMultiplier ?? 1)
        !== Number(rateMultiplier === null || rateMultiplier === undefined || rateMultiplier === '' ? 1 : rateMultiplier)
      || Boolean(confirmedAutoPause) !== Boolean(autoPauseOnExpired)
      || JSON.stringify(actualGroups) !== JSON.stringify(expectedGroups)) {
      throw Object.assign(new Error('Sub2API account configuration verification failed'), {
        statusCode: 502,
        accountId,
      });
    }
    await this.testAccount(accountId, { modelId, prompt });
    await this.setAccountSchedulable(accountId, true);
    return this.getAccount(accountId);
  }

  async importAndVerify({
    name,
    platform,
    credentials,
    groupIds,
    concurrency,
    loadFactor = null,
    priority,
    rateMultiplier = 1,
    autoPauseOnExpired = true,
    modelId,
    prompt,
    expiresAt = null,
    onCreated,
    modelWhitelist = [],
  }) {
    const normalizedCredentials = applyModelWhitelist(credentials, modelWhitelist);
    const created = await this.createAccount({
      name,
      platform,
      type: 'oauth',
      credentials: normalizedCredentials,
      group_ids: groupIds,
      concurrency,
      ...(loadFactor === null || loadFactor === undefined || loadFactor === '' ? {} : { load_factor: loadFactor }),
      priority,
      rate_multiplier: rateMultiplier === null || rateMultiplier === undefined || rateMultiplier === '' ? 1 : rateMultiplier,
      auto_pause_on_expired: autoPauseOnExpired,
      ...(expiresAt ? { expires_at: expiresAt } : {}),
    });
    const accountId = normalizeAccountId(created?.id);
    await onCreated?.(accountId);
    return this.configureAndVerify({
      accountId,
      groupIds,
      concurrency,
      loadFactor,
      priority,
      rateMultiplier,
      autoPauseOnExpired,
      modelId,
      prompt,
      clearExpiration: !expiresAt,
    });
  }
}
