export class Sub2ApiAuthError extends Error {
  constructor(code, message, statusCode = 401) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function endpoint(baseUrl, pathname) {
  return new URL(pathname, `${baseUrl}/`).toString();
}

async function responseData(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Sub2ApiAuthError('upstream_unavailable', 'sub2api authentication service returned an invalid response', 503);
  }
  if (!response.ok || (Object.hasOwn(payload, 'code') && payload.code !== 0)) {
    const statusCode = response.status >= 500 ? 503 : 401;
    throw new Sub2ApiAuthError(
      statusCode === 503 ? 'upstream_unavailable' : 'invalid_credentials',
      statusCode === 503 ? 'sub2api authentication service is unavailable' : 'invalid administrator credentials',
      statusCode,
    );
  }
  return Object.hasOwn(payload, 'data') ? payload.data : payload;
}

function upstreamHeaders(clientIp) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(clientIp ? { 'X-Forwarded-For': clientIp } : {}),
  };
}

async function request(baseUrl, pathname, options, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint(baseUrl, pathname), { ...options, signal: controller.signal });
    return responseData(response);
  } catch (error) {
    if (error instanceof Sub2ApiAuthError) throw error;
    throw new Sub2ApiAuthError('upstream_unavailable', 'sub2api authentication service is unavailable', 503);
  } finally {
    clearTimeout(timer);
  }
}

function validateAdmin(user) {
  if (!user || user.role !== 'admin') {
    throw new Sub2ApiAuthError('admin_required', 'this account is not a sub2api administrator', 403);
  }
  if (user.status && user.status !== 'active') {
    throw new Sub2ApiAuthError('invalid_credentials', 'invalid administrator credentials', 401);
  }
  if (user.id === undefined || !String(user.email || '').trim()) {
    throw new Sub2ApiAuthError('upstream_unavailable', 'sub2api returned an incomplete administrator profile', 503);
  }
  return {
    id: user.id,
    username: String(user.username || user.email).trim(),
    email: String(user.email).trim(),
    role: 'admin',
  };
}

async function verifiedAdminFromLogin(login, config, clientIp, fetchImpl) {
  const token = String(login?.access_token || '').trim();
  if (!token) {
    throw new Sub2ApiAuthError('upstream_unavailable', 'sub2api did not issue an access token', 503);
  }
  const profile = await request(
    config.sub2apiAuthUrl,
    '/api/v1/auth/me',
    { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(clientIp ? { 'X-Forwarded-For': clientIp } : {}) } },
    config.sub2apiAuthTimeoutMs,
    fetchImpl,
  );
  return { user: validateAdmin(profile), accessToken: token };
}

export async function loginSub2ApiAdministrator({ email, password, clientIp = '' }, config, fetchImpl = fetch) {
  const login = await request(
    config.sub2apiAuthUrl,
    '/api/v1/auth/login',
    { method: 'POST', headers: upstreamHeaders(clientIp), body: JSON.stringify({ email, password }) },
    config.sub2apiAuthTimeoutMs,
    fetchImpl,
  );
  if (login?.requires_2fa === true) {
    const tempToken = String(login.temp_token || '').trim();
    if (!tempToken) throw new Sub2ApiAuthError('upstream_unavailable', 'sub2api did not create a two-factor login session', 503);
    return { requiresTwoFactor: true, tempToken, emailMasked: String(login.user_email_masked || '').trim() };
  }
  return { requiresTwoFactor: false, ...await verifiedAdminFromLogin(login, config, clientIp, fetchImpl) };
}

export async function completeSub2ApiAdministratorTwoFactor({ tempToken, totpCode, clientIp = '' }, config, fetchImpl = fetch) {
  const login = await request(
    config.sub2apiAuthUrl,
    '/api/v1/auth/login/2fa',
    { method: 'POST', headers: upstreamHeaders(clientIp), body: JSON.stringify({ temp_token: tempToken, totp_code: totpCode }) },
    config.sub2apiAuthTimeoutMs,
    fetchImpl,
  );
  return verifiedAdminFromLogin(login, config, clientIp, fetchImpl);
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function listSub2ApiAdminGroups({ accessToken, clientIp = '' }, config, fetchImpl = fetch) {
  const token = String(accessToken || '').trim();
  if (!token) throw new Sub2ApiAuthError('upstream_unavailable', 'sub2api administrator token is unavailable', 503);
  const groups = await request(
    config.sub2apiAuthUrl,
    '/api/v1/admin/groups/all?include_inactive=true',
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(clientIp ? { 'X-Forwarded-For': clientIp } : {}),
      },
    },
    config.sub2apiAuthTimeoutMs,
    fetchImpl,
  );
  if (!Array.isArray(groups)) {
    throw new Sub2ApiAuthError('upstream_unavailable', 'sub2api returned an invalid group catalog', 503);
  }
  return groups.flatMap((group) => {
    const sourceGroupId = Number(group?.id);
    if (!Number.isSafeInteger(sourceGroupId) || sourceGroupId <= 0) return [];
    return [{
      sourceGroupId,
      name: String(group.name || '').trim().slice(0, 160),
      platform: String(group.platform || '').trim().slice(0, 50),
      status: String(group.status || '').trim().slice(0, 24),
      groupMultiplier: optionalNumber(group.rate_multiplier),
      sortOrder: Math.max(0, Math.min(1_000_000, Number.parseInt(group.sort_order, 10) || 0)),
      defaultModel: String(group.default_mapped_model || '').trim().slice(0, 120),
      sourceUpdatedAt: group.updated_at || null,
    }];
  });
}
