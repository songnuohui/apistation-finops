import {
  normalizeSupplierBaseUrl,
  SupplierAdapterError,
  SupplierHttpClient,
} from './supplier-adapters.mjs';

const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class OAuthSupplyClientError extends Error {
  constructor(code, message, { statusCode = 502, httpStatus = 0 } = {}) {
    super(message);
    this.name = 'OAuthSupplyClientError';
    this.code = code;
    this.statusCode = statusCode;
    this.httpStatus = httpStatus;
  }
}

function tokenFromJwt(value, now = Date.now) {
  try {
    const payload = String(value || '').split('.')[1];
    if (!payload) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const expiresAt = Number(parsed?.exp) * 1000;
    return Number.isFinite(expiresAt) && expiresAt > now() ? new Date(expiresAt) : null;
  } catch {
    return null;
  }
}

function findToken(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = [
    payload.token,
    payload.access_token,
    payload.accessToken,
    payload.data?.token,
    payload.data?.access_token,
    payload.data?.accessToken,
    payload.result?.token,
    payload.result?.access_token,
    payload.result?.accessToken,
  ];
  return candidates.map((value) => String(value || '').trim()).find(Boolean) || '';
}

function expiryFromPayload(payload, token, now = Date.now) {
  const value = payload?.expiresAt
    || payload?.expires_at
    || payload?.expireAt
    || payload?.data?.expiresAt
    || payload?.data?.expires_at
    || payload?.data?.expireAt;
  if (value) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds > 10_000_000_000 ? seconds : seconds * 1000);
  }
  return tokenFromJwt(token, now) || new Date(now() + DEFAULT_TOKEN_TTL_MS);
}

export class OAuthSupplyClient {
  constructor(config, logger = console, fetchImpl, now = () => Date.now(), dnsLookup) {
    this.config = config;
    this.logger = logger;
    this.now = now;
    this.http = new SupplierHttpClient(config, {
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(dnsLookup ? { dnsLookup } : {}),
    });
  }

  baseUrl(value) {
    return normalizeSupplierBaseUrl(value, { blockedHosts: this.config.supplierBlockedHosts || [] });
  }

  async login({ baseUrl, username, password }) {
    const normalizedBaseUrl = this.baseUrl(baseUrl);
    try {
      const { response, payload } = await this.http.request(normalizedBaseUrl, '/api/customer/login', {
        method: 'POST',
        body: { username, password },
        allowError: true,
      });
      if (!response.ok) {
        const statusCode = response.status === 401 || response.status === 403 ? 401 : 502;
        throw new OAuthSupplyClientError(
          response.status === 401 || response.status === 403 ? 'invalid_credentials' : 'upstream_error',
          response.status === 401 || response.status === 403 ? 'OAuth Supply 账号或密码错误' : `OAuth Supply 登录失败（HTTP ${response.status}）`,
          { statusCode, httpStatus: response.status },
        );
      }
      const token = findToken(payload);
      if (!token) {
        throw new OAuthSupplyClientError('invalid_response', 'OAuth Supply 登录响应中没有 Token', { statusCode: 502 });
      }
      return {
        token,
        expiresAt: expiryFromPayload(payload, token, this.now),
      };
    } catch (error) {
      if (error instanceof OAuthSupplyClientError) throw error;
      if (error instanceof SupplierAdapterError) {
        const statusCode = error.code === 'timeout' ? 504
          : error.code === 'authentication_failed' ? 401
            : error.statusCode || 502;
        throw new OAuthSupplyClientError(error.code, error.message, {
          statusCode,
          httpStatus: error.httpStatus,
        });
      }
      this.logger.warn('[oauth-supply] login request failed', error?.message || error);
      throw new OAuthSupplyClientError('network_error', '无法连接 OAuth Supply', { statusCode: 502 });
    }
  }

  async customerRequest({ baseUrl, token, pathname, method = 'GET', body, headers = {}, idempotencyKey = '' }) {
    const normalizedBaseUrl = this.baseUrl(baseUrl);
    const requestHeaders = {
      'X-Customer-Token': String(token || '').trim(),
      ...headers,
    };
    if (idempotencyKey) requestHeaders['Idempotency-Key'] = idempotencyKey;
    try {
      const { response, payload } = await this.http.request(normalizedBaseUrl, pathname, {
        method,
        token: '',
        body,
        headers: requestHeaders,
        allowError: true,
      });
      if (!response.ok) {
        const remoteCode = String(
          payload?.error_code || payload?.code || payload?.error?.code
          || (typeof payload?.error === 'string' ? payload.error : ''),
        ).trim();
        const message = payload?.error?.message || payload?.message
          || (typeof payload?.error === 'string' ? payload.error : '')
          || `OAuth Supply API failed (HTTP ${response.status})`;
        const code = response.status === 401 ? 'token_expired'
          : response.status === 409 ? 'claim_conflict'
            : response.status === 429 ? 'rate_limited'
              : remoteCode === 'recovery_payload_invalid' ? remoteCode : 'upstream_error';
        throw new OAuthSupplyClientError(
          code,
          String(message).slice(0, 500),
          { statusCode: response.status === 401 ? 401 : response.status === 429 ? 429 : 502, httpStatus: response.status },
        );
      }
      return { status: response.status, payload: payload || {} };
    } catch (error) {
      if (error instanceof OAuthSupplyClientError) throw error;
      if (error instanceof SupplierAdapterError) {
        throw new OAuthSupplyClientError(error.code, error.message, {
          statusCode: error.statusCode || 502,
          httpStatus: error.httpStatus,
        });
      }
      throw new OAuthSupplyClientError('network_error', '无法连接 OAuth Supply', { statusCode: 502 });
    }
  }

  async products({ baseUrl, token }) {
    return this.customerRequest({ baseUrl, token, pathname: '/api/customer/products' });
  }

  async inventory({ baseUrl, token, product, quantity = 1 }) {
    const query = new URLSearchParams({ product: String(product), quantity: String(quantity) });
    return this.customerRequest({ baseUrl, token, pathname: `/api/customer/inventory?${query}` });
  }

  async balance({ baseUrl, token }) {
    return this.customerRequest({ baseUrl, token, pathname: '/api/customer/balance' });
  }

  async createOrder({ baseUrl, token, product, quantity, idempotencyKey }) {
    return this.customerRequest({
      baseUrl,
      token,
      pathname: '/api/customer/pickup/orders',
      method: 'POST',
      body: { product, quantity },
      idempotencyKey,
    });
  }

  async getOrder({ baseUrl, token, orderId }) {
    return this.customerRequest({
      baseUrl,
      token,
      pathname: `/api/customer/pickup/orders/${encodeURIComponent(orderId)}`,
    });
  }

  async takeOrder({ baseUrl, token, orderId }) {
    return this.customerRequest({
      baseUrl,
      token,
      pathname: `/api/customer/pickup/orders/${encodeURIComponent(orderId)}/take`,
      method: 'POST',
    });
  }

  async recoveries({ baseUrl, token, beforeId = 0, limit = 100 }) {
    const query = new URLSearchParams({
      before_id: beforeId ? String(beforeId) : '',
      limit: String(Math.min(100, Math.max(1, quantityOrOne(limit)))),
    });
    return this.customerRequest({ baseUrl, token, pathname: `/api/customer/recoveries?${query}` });
  }

  async claimRecovery({ baseUrl, token, claimUrl }) {
    const pathname = this.sameOriginPath(baseUrl, claimUrl, '认领');
    return this.customerRequest({
      baseUrl,
      token,
      pathname,
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
  }

  async getRecoveryStatus({ baseUrl, token, statusUrl }) {
    const pathname = this.sameOriginPath(baseUrl, statusUrl, '状态查询');
    return this.customerRequest({
      baseUrl,
      token,
      pathname,
      headers: { Accept: 'application/json' },
    });
  }

  sameOriginPath(baseUrl, value, label) {
    const expected = new URL(this.baseUrl(baseUrl));
    let parsed;
    try {
      parsed = new URL(String(value || ''), expected);
    } catch {
      throw new OAuthSupplyClientError('invalid_claim_url', `OAuth Supply 返回了无效的${label}地址`, { statusCode: 502 });
    }
    if (parsed.origin !== expected.origin) {
      throw new OAuthSupplyClientError('invalid_claim_url', `OAuth Supply ${label}地址不属于已配置的站点`, { statusCode: 502 });
    }
    return `${parsed.pathname}${parsed.search}`;
  }
}

export const oauthSupplyTokenTtlMs = DEFAULT_TOKEN_TTL_MS;

function quantityOrOne(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}
