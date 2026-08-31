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

function administratorHeaders(accessToken, clientIp = '', authHeaders = null) {
  const token = String(accessToken || '').trim();
  if (!token) throw new Sub2ApiAuthError('upstream_unavailable', 'sub2api administrator token is unavailable', 503);
  const provided = authHeaders && typeof authHeaders === 'object' ? authHeaders : null;
  return {
    Accept: 'application/json',
    ...(provided && Object.keys(provided).length ? provided : { Authorization: `Bearer ${token}` }),
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

export async function listSub2ApiAdminGroups({ accessToken, clientIp = '', authHeaders = null }, config, fetchImpl = fetch) {
  const token = String(accessToken || '').trim();
  const payload = await request(
    config.sub2apiAuthUrl,
    '/api/v1/admin/groups',
    {
      method: 'GET',
      headers: administratorHeaders(token, clientIp, authHeaders),
    },
    config.sub2apiAuthTimeoutMs,
    fetchImpl,
  );
  const groups = Array.isArray(payload) ? payload : payload?.items;
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

function optionalInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function pagedItems(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

export async function listSub2ApiChannelMonitors({ accessToken, clientIp = '', authHeaders = null }, config, fetchImpl = fetch) {
  const token = String(accessToken || '').trim();
  const payload = await request(
    config.sub2apiAuthUrl,
    '/api/v1/channel-monitors',
    {
      method: 'GET',
      headers: administratorHeaders(token, clientIp, authHeaders),
    },
    config.sub2apiAuthTimeoutMs,
    fetchImpl,
  );
  const monitors = Array.isArray(payload) ? payload : payload?.items;
  if (!Array.isArray(monitors)) {
    throw new Sub2ApiAuthError('upstream_unavailable', 'sub2api returned an invalid channel monitor list', 503);
  }
  return monitors.flatMap((monitor) => {
    const id = optionalInteger(monitor?.id);
    if (!id || id <= 0) return [];
    return [{
      id,
      name: String(monitor.name || '').trim().slice(0, 120),
      groupName: String(monitor.group_name || '').trim().slice(0, 120),
      primaryModel: String(monitor.primary_model || '').trim().slice(0, 160),
      enabled: monitor.enabled !== false,
      primaryStatus: String(monitor.primary_status || '').trim().slice(0, 24),
      primaryLatencyMs: optionalInteger(monitor.primary_latency_ms),
      primaryPingLatencyMs: optionalInteger(monitor.primary_ping_latency_ms),
      availability7d: optionalNumber(monitor.availability_7d),
      lastCheckedAt: monitor.last_checked_at || null,
    }];
  });
}

export async function getSub2ApiAdministratorUserConcurrencySnapshot({ accessToken, clientIp = '', authHeaders = null }, config, fetchImpl = fetch) {
  const token = String(accessToken || '').trim();
  const payload = await request(
    config.sub2apiAuthUrl,
    `/api/v1/admin/ops/user-concurrency?timezone=${encodeURIComponent(config.timezone || 'Asia/Shanghai')}`,
    {
      method: 'GET',
      headers: administratorHeaders(token, clientIp, authHeaders),
    },
    config.sub2apiAuthTimeoutMs,
    fetchImpl,
  );
  const userMap = payload?.user;
  if (payload?.enabled !== false && (!userMap || typeof userMap !== 'object' || Array.isArray(userMap))) {
    throw new Sub2ApiAuthError('upstream_unavailable', 'sub2api returned an invalid user concurrency snapshot', 503);
  }
  const users = Object.values(userMap || {}).flatMap((user) => {
    const sourceUserId = optionalInteger(user?.user_id);
    if (!sourceUserId || sourceUserId <= 0) return [];
    const maxConcurrency = Math.max(0, optionalInteger(user?.max_capacity) || 0);
    const currentConcurrency = Math.max(0, optionalInteger(user?.current_in_use) || 0);
    const waitingCount = Math.max(0, optionalInteger(user?.waiting_in_queue) || 0);
    return [{
      sourceUserId,
      email: String(user.user_email || '').trim().slice(0, 255),
      username: String(user.username || '').trim().slice(0, 100),
      maxConcurrency,
      currentConcurrency,
      waitingCount,
      loadPercentage: Math.max(0, optionalNumber(user.load_percentage) || 0),
    }];
  }).sort((a, b) => b.waitingCount - a.waitingCount || b.currentConcurrency - a.currentConcurrency || a.sourceUserId - b.sourceUserId);
  return {
    enabled: payload?.enabled !== false,
    users,
    observedAt: payload?.timestamp || null,
  };
}

export async function listSub2ApiAdministratorUserConcurrency({ accessToken, clientIp = '', authHeaders = null }, config, fetchImpl = fetch) {
  return (await getSub2ApiAdministratorUserConcurrencySnapshot(
    { accessToken, clientIp, authHeaders },
    config,
    fetchImpl,
  )).users;
}

export async function getSub2ApiRuntimeQueueStatus({ accessToken, clientIp = '', authHeaders = null }, config, fetchImpl = fetch) {
  const token = String(accessToken || '').trim();
  const payload = await request(
    config.sub2apiAuthUrl,
    '/api/v1/admin/risk-control/status',
    {
      method: 'GET',
      headers: administratorHeaders(token, clientIp, authHeaders),
    },
    config.sub2apiAuthTimeoutMs,
    fetchImpl,
  );
  return {
    enabled: payload?.enabled === true,
    mode: String(payload?.mode || '').trim().slice(0, 32),
    workerCount: Math.max(0, optionalInteger(payload?.worker_count) || 0),
    activeWorkers: Math.max(0, optionalInteger(payload?.active_workers) || 0),
    idleWorkers: Math.max(0, optionalInteger(payload?.idle_workers) || 0),
    queueSize: Math.max(0, optionalInteger(payload?.queue_size) || 0),
    queueLength: Math.max(0, optionalInteger(payload?.queue_length) || 0),
    queueUsagePercent: Math.max(0, optionalNumber(payload?.queue_usage_percent) || 0),
    processed: Math.max(0, optionalInteger(payload?.processed) || 0),
    errors: Math.max(0, optionalInteger(payload?.errors) || 0),
  };
}
