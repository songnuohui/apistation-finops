import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { maskSecret, totpCode } from './supplier-credentials.mjs';

export class SupplierAdapterError extends Error {
  constructor(code, message, { statusCode = 502, httpStatus = 0 } = {}) {
    super(message);
    this.name = 'SupplierAdapterError';
    this.code = code;
    this.statusCode = statusCode;
    this.httpStatus = httpStatus;
  }
}

function privateAddress(value) {
  const address = String(value || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv4(address)) {
    const [first, second, third] = address.split('.').map(Number);
    return first === 0 || first === 10 || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 0)
      || (first === 192 && second === 88 && third === 99)
      || (first === 192 && second === 168)
      || (first === 198 && (second === 18 || second === 19))
      || (first === 198 && second === 51 && third === 100)
      || (first === 203 && second === 0 && third === 113)
      || first >= 224;
  }
  if (net.isIPv6(address)) {
    if (address.startsWith('::ffff:')) {
      const mapped = address.slice(7);
      return net.isIPv4(mapped) ? privateAddress(mapped) : true;
    }
    return address === '::' || address === '::1'
      || address.startsWith('fc') || address.startsWith('fd')
      || /^fe[89ab]/.test(address) || address.startsWith('ff')
      || address.startsWith('100:') || address.startsWith('2001:db8')
      || address.startsWith('2001:10:') || address.startsWith('2001:20:');
  }
  return true;
}

function hostname(parsed) {
  return parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

function blockedSupplierHost(host, blockedHosts = []) {
  const candidate = String(host || '').replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  return blockedHosts.some((value) => {
    const blocked = String(value || '').replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    return blocked && (candidate === blocked || candidate.endsWith(`.${blocked}`));
  });
}

function assertSupplierHostAllowed(host, blockedHosts) {
  if (blockedSupplierHost(host, blockedHosts)) {
    throw new SupplierAdapterError(
      'protected_sub2api_blocked',
      'supplier monitoring is blocked from connecting to the production Sub2API host',
      { statusCode: 400 },
    );
  }
}

export function normalizeSupplierBaseUrl(value, { blockedHosts = [] } = {}) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw Object.assign(new Error('invalid supplier base URL'), { statusCode: 400 });
  }
  if (parsed.protocol !== 'https:' || !hostname(parsed)
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw Object.assign(new Error('supplier base URL must be an HTTPS URL without credentials, query, or fragment'), { statusCode: 400 });
  }
  assertSupplierHostAllowed(hostname(parsed), blockedHosts);
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString().replace(/\/$/, '');
}

async function assertPublicSupplierUrl(baseUrl, dnsLookup, blockedHosts) {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:') {
    throw new SupplierAdapterError('insecure_protocol_blocked', 'supplier monitoring requires HTTPS', { statusCode: 400 });
  }
  const host = hostname(parsed);
  assertSupplierHostAllowed(host, blockedHosts);
  if (net.isIP(host)) {
    if (privateAddress(host) || blockedSupplierHost(host, blockedHosts)) {
      throw new SupplierAdapterError('private_address_blocked', 'supplier URL resolves to a private or reserved address', { statusCode: 400 });
    }
    return [{ address: host, family: net.isIP(host) }];
  }
  let records;
  try {
    records = await dnsLookup(host, { all: true, verbatim: true });
  } catch {
    throw new SupplierAdapterError('dns_lookup_failed', 'supplier hostname could not be resolved', { statusCode: 400 });
  }
  const addresses = Array.isArray(records) ? records : [records];
  if (!addresses.length || addresses.some((record) => {
    const address = record?.address || record;
    return privateAddress(address) || blockedSupplierHost(address, blockedHosts);
  })) {
    throw new SupplierAdapterError('private_address_blocked', 'supplier URL resolves to a private or reserved address', { statusCode: 400 });
  }
  const targets = [];
  const seen = new Set();
  for (const record of addresses) {
    const address = record?.address || record;
    if (seen.has(address)) continue;
    seen.add(address);
    targets.push({
      address,
      family: Number(record?.family) || net.isIP(address),
    });
  }
  return targets;
}

function endpoint(baseUrl, pathname) {
  return `${baseUrl.replace(/\/+$/, '')}/${String(pathname).replace(/^\/+/, '')}`;
}

function unwrap(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if ('success' in payload) {
    if (!payload.success) throw new SupplierAdapterError('remote_error', String(payload.message || 'supplier returned an error'));
    return payload.data;
  }
  if ('code' in payload && typeof payload.code !== 'boolean') {
    if (Number(payload.code) !== 0) throw new SupplierAdapterError('remote_error', String(payload.message || 'supplier returned an error'));
    return payload.data;
  }
  return payload.data ?? payload;
}

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestamp(value) {
  if (!value || Number(value) === -1) return null;
  const numeric = Number(value);
  const parsed = new Date(Number.isFinite(numeric) ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric) : value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function status(value) {
  const text = String(value ?? '').toLowerCase();
  if (['1', 'active', 'enabled', 'ok', 'normal'].includes(text)) return 'active';
  if (['2', 'disabled', 'inactive', 'banned'].includes(text)) return 'disabled';
  if (['expired'].includes(text)) return 'expired';
  return text || 'unknown';
}

function maskedIdentity(value) {
  const text = String(value || '').trim();
  const at = text.indexOf('@');
  if (at > 1) return `${text.slice(0, 2)}***${text.slice(at)}`;
  return text ? `${text.slice(0, 2)}***` : '';
}

function rawKey(value) {
  const key = String(value || '').trim();
  return !key || key.includes('...') || key.includes('*') ? '' : key;
}

function items(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Array.isArray(value.items) ? value.items : (Array.isArray(value.data) ? value.data : []);
}

async function readLimitedFetchBody(response, maxResponseBytes) {
  const declaredLength = Number(response.headers?.get?.('content-length') || 0);
  if (declaredLength > maxResponseBytes) {
    throw new SupplierAdapterError('response_too_large', 'supplier response is too large', { httpStatus: response.status });
  }
  const chunks = [];
  let length = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        length += chunk.length;
        if (length > maxResponseBytes) {
          await reader.cancel().catch(() => {});
          throw new SupplierAdapterError('response_too_large', 'supplier response is too large', { httpStatus: response.status });
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, length);
  }
  if (response.body?.[Symbol.asyncIterator]) {
    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      length += chunk.length;
      if (length > maxResponseBytes) {
        response.body.destroy?.();
        throw new SupplierAdapterError('response_too_large', 'supplier response is too large', { httpStatus: response.status });
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
  }
  // This fallback exists for small injected test responses. Real supplier
  // traffic always uses the pinned streaming transport below.
  const raw = Buffer.from(await response.arrayBuffer());
  if (raw.length > maxResponseBytes) {
    throw new SupplierAdapterError('response_too_large', 'supplier response is too large', { httpStatus: response.status });
  }
  return raw;
}

export function buildPinnedHttpsRequestOptions(urlValue, init, target) {
  const parsed = new URL(urlValue);
  const originalHostname = hostname(parsed);
  const headers = { ...init.headers };
  if (!Object.keys(headers).some((name) => name.toLowerCase() === 'host')) {
    headers.Host = parsed.host;
  }
  return {
    protocol: 'https:',
    hostname: target.address,
    family: target.family,
    port: parsed.port || 443,
    path: `${parsed.pathname}${parsed.search}`,
    method: init.method,
    headers,
    servername: net.isIP(originalHostname) ? undefined : originalHostname,
    autoSelectFamily: false,
  };
}

function pinnedHttpsRequest(urlValue, init, target, { timeoutMs, maxResponseBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const request = https.request(buildPinnedHttpsRequestOptions(urlValue, init, target), (response) => {
      const status = Number(response.statusCode || 0);
      const declaredLength = Number(response.headers['content-length'] || 0);
      if (declaredLength > maxResponseBytes) {
        response.destroy();
        finish(new SupplierAdapterError('response_too_large', 'supplier response is too large', { httpStatus: status }));
        return;
      }
      const chunks = [];
      let length = 0;
      response.on('data', (value) => {
        if (settled) return;
        const chunk = Buffer.from(value);
        length += chunk.length;
        if (length > maxResponseBytes) {
          response.destroy();
          request.destroy();
          finish(new SupplierAdapterError('response_too_large', 'supplier response is too large', { httpStatus: status }));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(null, {
        response: {
          status,
          ok: status >= 200 && status < 300,
          headers: { get: (name) => response.headers[String(name).toLowerCase()] || null },
        },
        raw: Buffer.concat(chunks, length),
      }));
      response.on('error', (error) => finish(error instanceof SupplierAdapterError
        ? error : new SupplierAdapterError('request_failed', 'could not connect to supplier')));
    });
    request.on('error', (error) => finish(error instanceof SupplierAdapterError
      ? error : new SupplierAdapterError('request_failed', 'could not connect to supplier')));
    timer = setTimeout(() => {
      const error = new SupplierAdapterError('timeout', 'supplier request timed out');
      request.destroy(error);
      finish(error);
    }, timeoutMs);
    if (init.body) request.write(init.body);
    request.end();
  });
}

export class SupplierHttpClient {
  constructor(config = {}, { fetchImpl, dnsLookup = dns.lookup } = {}) {
    if (fetchImpl !== undefined && typeof fetchImpl !== 'function') throw new TypeError('fetch implementation must be a function');
    if (typeof dnsLookup !== 'function') throw new TypeError('DNS lookup implementation is required');
    this.config = config;
    this.fetchImpl = fetchImpl || null;
    this.dnsLookup = dnsLookup;
  }

  async request(baseUrl, pathname, { method = 'GET', token = '', body, headers = {}, allowError = false } = {}) {
    const requestPath = new URL(endpoint(baseUrl, pathname)).pathname;
    const stage = `${method} ${requestPath}`;
    const targets = await assertPublicSupplierUrl(baseUrl, this.dnsLookup, this.config.supplierBlockedHosts || []);
    const timeoutMs = Number(this.config.supplierRequestTimeoutMs) || 10_000;
    const maxResponseBytes = Number(this.config.supplierMaxResponseBytes) || 1_048_576;
    const startedAt = Date.now();
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    const requestHeaders = {
      Accept: 'application/json',
      'User-Agent': 'ApiStation-FinOps-Supplier-Monitor/1.0',
      ...(serializedBody === undefined ? {} : {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(serializedBody),
      }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    };
    try {
      let response;
      let raw;
      if (this.fetchImpl) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          response = await this.fetchImpl(endpoint(baseUrl, pathname), {
            method, redirect: 'error', signal: controller.signal,
            headers: requestHeaders, body: serializedBody,
          });
          raw = await readLimitedFetchBody(response, maxResponseBytes);
        } finally {
          clearTimeout(timeout);
        }
      } else {
        let lastError;
        for (let index = 0; index < targets.length; index += 1) {
          const remainingMs = timeoutMs - (Date.now() - startedAt);
          if (remainingMs <= 0) break;
          const attemptTimeoutMs = index === targets.length - 1
            ? remainingMs
            : Math.max(1_000, Math.floor(remainingMs / (targets.length - index)));
          try {
            ({ response, raw } = await pinnedHttpsRequest(
              endpoint(baseUrl, pathname),
              { method, headers: requestHeaders, body: serializedBody },
              targets[index],
              { timeoutMs: attemptTimeoutMs, maxResponseBytes },
            ));
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            if (!['timeout', 'request_failed'].includes(error?.code) || index === targets.length - 1) throw error;
          }
        }
        if (!response) throw lastError || new SupplierAdapterError('timeout', 'supplier request timed out');
      }
      let payload = null;
      if (raw.length) {
        try {
          payload = JSON.parse(raw.toString('utf8'));
        } catch {
          if (!response.ok || !allowError) {
            throw new SupplierAdapterError('invalid_json', 'supplier response is not JSON', { httpStatus: response.status });
          }
        }
      }
      if (!response.ok && !allowError) {
        const remoteMessage = payload?.message || payload?.error?.message || payload?.error || `HTTP ${response.status}`;
        throw new SupplierAdapterError(
          response.status === 401 || response.status === 403 ? 'authentication_failed' : 'http_error',
          String(remoteMessage).slice(0, 300),
          { httpStatus: response.status },
        );
      }
      return { response, payload, latencyMs: Date.now() - startedAt };
    } catch (error) {
      if (error instanceof SupplierAdapterError) {
        if (['timeout', 'request_failed'].includes(error.code)) {
          throw new SupplierAdapterError(error.code, `${stage}: ${error.message}`, {
            statusCode: error.statusCode,
            httpStatus: error.httpStatus,
          });
        }
        throw error;
      }
      if (error?.name === 'AbortError') throw new SupplierAdapterError('timeout', `${stage}: supplier request timed out`);
      throw new SupplierAdapterError('request_failed', `${stage}: could not connect to supplier`);
    }
  }
}

async function sub2ApiToken(connection, credentials, client) {
  if (connection.authMode === 'access_token') {
    if (!credentials.accessToken) throw new SupplierAdapterError('missing_credentials', 'access token is not configured', { statusCode: 400 });
    return credentials.accessToken;
  }
  if (connection.authMode !== 'password' || !credentials.username || !credentials.password) {
    throw new SupplierAdapterError('missing_credentials', 'username and password are not configured', { statusCode: 400 });
  }
  // Password connections may have an encrypted, previously issued token.
  // Reuse it until the portal rejects it; the caller retries with a fresh login.
  if (credentials.accessToken && (!credentials.accessTokenExpiresAt || Number(credentials.accessTokenExpiresAt) > Date.now())) {
    return credentials.accessToken;
  }
  const login = unwrap((await client.request(connection.baseUrl, '/api/v1/auth/login', {
    method: 'POST', body: { email: credentials.username, password: credentials.password },
  })).payload) || {};
  if (!login.requires_2fa) return login.access_token;
  if (!credentials.totpSecret) throw new SupplierAdapterError('two_factor_required', 'TOTP secret is required for this supplier account');
  const verified = unwrap((await client.request(connection.baseUrl, '/api/v1/auth/login/2fa', {
    method: 'POST', body: { temp_token: login.temp_token, totp_code: totpCode(credentials.totpSecret) },
  })).payload) || {};
  return verified.access_token;
}

function tokenExpiry(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const exp = Number(payload.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch {
    return null;
  }
}

async function sub2ApiSnapshotWithToken(connection, credentials, client, accessToken) {
  if (!accessToken) throw new SupplierAdapterError('authentication_failed', 'supplier login did not return an access token');
  const [profileResult, groupsResult, ratesResult] = await Promise.all([
    client.request(connection.baseUrl, '/api/v1/auth/me', { token: accessToken }),
    client.request(connection.baseUrl, '/api/v1/groups/available', { token: accessToken }),
    client.request(connection.baseUrl, '/api/v1/groups/rates', { token: accessToken }),
  ]);
  const profile = unwrap(profileResult.payload) || {};
  const groups = items(unwrap(groupsResult.payload));
  const customRates = unwrap(ratesResult.payload) || {};
  const groupMap = new Map(groups.map((group) => [String(group.id), group]));
  const keys = [];
  let page = 1;
  let pages = 1;
  do {
    const result = unwrap((await client.request(connection.baseUrl, `/api/v1/keys?page=${page}&page_size=100`, { token: accessToken })).payload) || {};
    for (const key of items(result)) {
      const group = groupMap.get(String(key.group_id ?? '')) || key.group || {};
      const secret = rawKey(key.key);
      const override = customRates[String(key.group_id ?? '')];
      const quota = number(key.quota);
      const quotaUsed = number(key.quota_used) || 0;
      keys.push({
        externalId: String(key.id),
        name: String(key.name || ''),
        rawKey: secret,
        maskedKey: secret ? maskSecret(secret) : String(key.key || ''),
        status: status(key.status),
        groupId: key.group_id === null || key.group_id === undefined ? '' : String(key.group_id),
        groupName: String(group.name || ''),
        rateMultiplier: number(override ?? group.rate_multiplier),
        quotaTotal: quota && quota > 0 ? quota : null,
        quotaUsed,
        quotaRemaining: quota && quota > 0 ? Math.max(0, quota - quotaUsed) : null,
        quotaCurrency: 'USD',
        expiresAt: timestamp(key.expires_at),
        lastUsedAt: timestamp(key.last_used_at),
        sourceData: {
          rateLimit5h: number(key.rate_limit_5h), rateLimit1d: number(key.rate_limit_1d), rateLimit7d: number(key.rate_limit_7d),
          usage5h: number(key.usage_5h), usage1d: number(key.usage_1d), usage7d: number(key.usage_7d),
        },
      });
    }
    pages = Number(result.pages || 1);
    page += 1;
  } while (page <= pages && page <= 100);
  return {
    adapterType: 'sub2api',
    identity: maskedIdentity(profile.email || credentials.username),
    balance: number(profile.balance),
    balanceCurrency: 'USD',
    keys,
    accessToken,
    accessTokenExpiresAt: tokenExpiry(accessToken),
  };
}

async function sub2ApiSnapshot(connection, credentials, client) {
  let accessToken = await sub2ApiToken(connection, credentials, client);
  try {
    return await sub2ApiSnapshotWithToken(connection, credentials, client, accessToken);
  } catch (error) {
    if (connection.authMode === 'password' && credentials.accessToken && error?.code === 'authentication_failed') {
      accessToken = await sub2ApiToken(connection, { ...credentials, accessToken: '', accessTokenExpiresAt: 0 }, client);
      return sub2ApiSnapshotWithToken(connection, credentials, client, accessToken);
    }
    throw error;
  }
}

async function newApiToken(connection, credentials, client) {
  if (connection.authMode === 'access_token') {
    if (!credentials.accessToken) throw new SupplierAdapterError('missing_credentials', 'access token is not configured', { statusCode: 400 });
    return credentials.accessToken;
  }
  if (connection.authMode !== 'password' || !credentials.username || !credentials.password) {
    throw new SupplierAdapterError('missing_credentials', 'username and password are not configured', { statusCode: 400 });
  }
  if (credentials.accessToken && (!credentials.accessTokenExpiresAt || Number(credentials.accessTokenExpiresAt) > Date.now())) {
    return credentials.accessToken;
  }
  const login = unwrap((await client.request(connection.baseUrl, '/api/user/login', {
    method: 'POST', body: { username: credentials.username, password: credentials.password },
  })).payload) || {};
  if (!login.require_2fa) return login.access_token || login.token;
  if (!credentials.totpSecret) throw new SupplierAdapterError('two_factor_required', 'TOTP secret is required for this supplier account');
  const verified = unwrap((await client.request(connection.baseUrl, '/api/user/login/2fa', {
    method: 'POST', body: { flow_token: login.flow_token, code: totpCode(credentials.totpSecret) },
  })).payload) || {};
  return verified.access_token || verified.token;
}

function newApiQuotaConverter(site) {
  const quotaPerUnit = number(site.quota_per_unit);
  const displayType = String(site.quota_display_type || '').toUpperCase();
  if (!quotaPerUnit || quotaPerUnit <= 0) return { currency: 'QUOTA', convert: number };
  if (displayType === 'TOKENS') return { currency: 'TOKENS', convert: number };
  if (displayType === 'CNY') {
    const exchangeRate = number(site.usd_exchange_rate);
    if (!exchangeRate || exchangeRate <= 0) return { currency: 'QUOTA', convert: number };
    return { currency: 'CNY', convert: (quota) => {
      const value = number(quota);
      return value === null ? null : value / quotaPerUnit * exchangeRate;
    } };
  }
  if (displayType === 'CUSTOM') {
    const exchangeRate = number(site.custom_currency_exchange_rate);
    if (!exchangeRate || exchangeRate <= 0) return { currency: 'CUSTOM', convert: number };
    return { currency: 'CUSTOM', convert: (quota) => {
      const value = number(quota);
      return value === null ? null : value / quotaPerUnit * exchangeRate;
    } };
  }
  if (displayType === 'USD') return { currency: 'USD', convert: (quota) => {
    const value = number(quota);
    return value === null ? null : value / quotaPerUnit;
  } };
  return { currency: 'QUOTA', convert: number };
}

async function newApiSnapshotWithToken(connection, credentials, client, accessToken) {
  if (!accessToken) throw new SupplierAdapterError('authentication_failed', 'supplier login did not return an access token');
  const [statusResult, profileResult, groupsResult] = await Promise.all([
    client.request(connection.baseUrl, '/api/status'),
    client.request(connection.baseUrl, '/api/user/self', { token: accessToken }),
    client.request(connection.baseUrl, '/api/user/self/groups', { token: accessToken }),
  ]);
  const site = unwrap(statusResult.payload) || {};
  const profile = unwrap(profileResult.payload) || {};
  const groups = unwrap(groupsResult.payload) || {};
  const quota = newApiQuotaConverter(site);
  const keys = [];
  let page = 1;
  let total = 0;
  do {
    const result = unwrap((await client.request(connection.baseUrl, `/api/token/?p=${page}&size=100`, { token: accessToken })).payload) || {};
    const listed = items(result);
    for (const key of listed) {
      const group = String(key.group || '');
      const groupInfo = groups[group] || {};
      const remaining = number(key.remain_quota);
      const used = number(key.used_quota);
      const unlimited = Boolean(key.unlimited_quota);
      keys.push({
        externalId: String(key.id),
        name: String(key.name || ''),
        rawKey: '',
        maskedKey: String(key.key || ''),
        status: status(key.status),
        groupId: group,
        groupName: group,
        rateMultiplier: number(groupInfo.ratio),
        quotaTotal: unlimited ? null : quota.convert((remaining || 0) + (used || 0)),
        quotaUsed: quota.convert(used),
        quotaRemaining: unlimited ? null : quota.convert(remaining),
        quotaCurrency: quota.currency,
        expiresAt: timestamp(key.expired_time),
        lastUsedAt: timestamp(key.accessed_time),
        sourceData: {
          unlimitedQuota: unlimited, modelLimitsEnabled: Boolean(key.model_limits_enabled),
          modelLimits: String(key.model_limits || ''), autoGroups: Array.isArray(key.auto_groups) ? key.auto_groups.slice(0, 20) : [],
        },
      });
    }
    total = Number(result.total || listed.length);
    page += 1;
  } while ((page - 1) * 100 < total && page <= 100);
  return {
    adapterType: 'newapi',
    identity: maskedIdentity(profile.email || profile.username || credentials.username),
    balance: quota.convert(profile.quota),
    balanceCurrency: quota.currency,
    keys,
    accessToken,
    accessTokenExpiresAt: tokenExpiry(accessToken),
  };
}

async function newApiSnapshot(connection, credentials, client) {
  let accessToken = await newApiToken(connection, credentials, client);
  try {
    return await newApiSnapshotWithToken(connection, credentials, client, accessToken);
  } catch (error) {
    if (connection.authMode === 'password' && credentials.accessToken && error?.code === 'authentication_failed') {
      accessToken = await newApiToken(connection, { ...credentials, accessToken: '', accessTokenExpiresAt: 0 }, client);
      return newApiSnapshotWithToken(connection, credentials, client, accessToken);
    }
    throw error;
  }
}

async function openAiCompatibleSnapshot(connection, credentials) {
  if (!credentials.apiKey) throw new SupplierAdapterError('missing_credentials', 'API key is not configured', { statusCode: 400 });
  const currency = String(credentials.balanceCurrency || connection.balanceCurrency || 'USD').toUpperCase();
  return {
    adapterType: 'openai_compatible',
    identity: '',
    balance: number(credentials.balance),
    balanceCurrency: currency,
    keys: [{
      externalId: 'configured-key', name: String(credentials.keyName || connection.name), rawKey: String(credentials.apiKey),
      maskedKey: maskSecret(credentials.apiKey), status: 'active', groupId: '', groupName: '',
      rateMultiplier: number(credentials.rateMultiplier), quotaTotal: null, quotaUsed: null, quotaRemaining: null,
      quotaCurrency: currency, expiresAt: null, lastUsedAt: null, sourceData: {},
    }],
  };
}

async function checkSub2ApiKey(connection, key, client) {
  if (!key.rawKey) {
    return { status: 'skipped', method: 'billing_metadata', errorCode: 'raw_key_unavailable', errorMessage: 'the supplier inventory did not provide a usable raw API key' };
  }
  const result = await client.request(connection.baseUrl, '/v1/sub2api/billing', {
    token: key.rawKey, allowError: true,
  });
  if ([404, 405].includes(result.response.status)) return { status: 'unsupported', method: 'billing_metadata', httpStatus: result.response.status, latencyMs: result.latencyMs };
  if (!result.response.ok) return { status: 'failed', method: 'billing_metadata', httpStatus: result.response.status, latencyMs: result.latencyMs, errorCode: 'http_error', errorMessage: 'API key authentication failed' };
  const data = result.payload || {};
  if (data.object !== 'sub2api.key_billing' || Number(data.schema_version) !== 1 || data.billing_scope !== 'token') {
    return { status: 'failed', method: 'billing_metadata', httpStatus: result.response.status, latencyMs: result.latencyMs, errorCode: 'invalid_billing_response', errorMessage: 'billing metadata response is invalid' };
  }
  const resolved = number(data.resolved_rate_multiplier);
  const effective = number(data.effective_rate_multiplier);
  if (resolved === null || resolved < 0 || effective === null || effective < 0) {
    return { status: 'failed', method: 'billing_metadata', httpStatus: result.response.status, latencyMs: result.latencyMs, errorCode: 'invalid_multiplier', errorMessage: 'billing metadata returned an invalid multiplier' };
  }
  return {
    status: 'ok', method: 'billing_metadata', httpStatus: result.response.status, latencyMs: result.latencyMs,
    rateMultiplier: effective,
    billing: {
      object: data.object, schema_version: 1, billing_scope: 'token',
      group_rate_multiplier: number(data.group_rate_multiplier), user_rate_multiplier: number(data.user_rate_multiplier),
      resolved_rate_multiplier: resolved, effective_rate_multiplier: effective,
      peak_rate_enabled: Boolean(data.peak_rate_enabled), peak_start: data.peak_start || '', peak_end: data.peak_end || '',
      peak_rate_multiplier: number(data.peak_rate_multiplier), applied_peak_multiplier: number(data.applied_peak_multiplier),
      timezone: data.timezone || '', observed_at: timestamp(data.observed_at) || new Date().toISOString(),
    },
  };
}

function checkNewApiKey() {
  // NewAPI reveals full token material only through POST /api/token/:id/key.
  // Inventory already contains the portal state, so per-key probing is skipped.
  return { status: 'skipped', method: 'portal_inventory', errorCode: 'raw_key_not_requested', errorMessage: 'per-key checks do not retrieve plaintext keys' };
}

async function checkOpenAiKey(connection, key, client) {
  const result = await client.request(connection.baseUrl, '/v1/models', { token: key.rawKey, allowError: true });
  if ([404, 405].includes(result.response.status)) return { status: 'unsupported', method: 'models', httpStatus: result.response.status, latencyMs: result.latencyMs };
  return result.response.ok
    ? { status: 'ok', method: 'models', httpStatus: result.response.status, latencyMs: result.latencyMs }
    : { status: 'failed', method: 'models', httpStatus: result.response.status, latencyMs: result.latencyMs, errorCode: 'token_rejected', errorMessage: 'model listing rejected the API key' };
}

export class SupplierAdapterRegistry {
  constructor(config, httpOptions = {}) {
    this.client = new SupplierHttpClient(config, httpOptions);
  }

  async snapshot(connection, credentials) {
    if (connection.adapterType === 'sub2api') return sub2ApiSnapshot(connection, credentials, this.client);
    if (connection.adapterType === 'newapi') return newApiSnapshot(connection, credentials, this.client);
    if (connection.adapterType === 'openai_compatible') return openAiCompatibleSnapshot(connection, credentials);
    if (connection.adapterType === 'custom') throw new SupplierAdapterError('adapter_required', 'this supplier requires a dedicated adapter', { statusCode: 422 });
    const failures = [];
    for (const adapter of ['sub2api', 'newapi']) {
      try {
        return await this.snapshot({ ...connection, adapterType: adapter }, credentials);
      } catch (error) {
        failures.push(error);
      }
    }
    const firstFailure = failures[0];
    throw new SupplierAdapterError(
      'unsupported_site',
      'supplier site was not recognized; select an explicit adapter type',
      { statusCode: 422, httpStatus: firstFailure?.httpStatus || 0 },
    );
  }

  async check(connection, credentials, snapshot, key) {
    if (snapshot.adapterType === 'sub2api') return checkSub2ApiKey(connection, key, this.client);
    if (snapshot.adapterType === 'newapi') return checkNewApiKey(connection, credentials, snapshot, key);
    if (snapshot.adapterType === 'openai_compatible') return checkOpenAiKey(connection, key, this.client);
    return { status: 'unsupported', method: 'none', errorCode: 'unsupported_adapter', errorMessage: 'no check adapter is configured' };
  }
}
