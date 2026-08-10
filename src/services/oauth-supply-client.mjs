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
}

export const oauthSupplyTokenTtlMs = DEFAULT_TOKEN_TTL_MS;
