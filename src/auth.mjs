import crypto from 'node:crypto';

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const SESSION_COOKIE = 'finops_session';
const PENDING_LOGIN_COOKIE = 'finops_login_pending';

function cookieOptions(config, maxAge) {
  return [
    `Max-Age=${maxAge}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(config.sessionCookieSecure ? ['Secure'] : []),
  ].join('; ');
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function encodeSession(actor, config, now) {
  const issuedAt = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    iat: issuedAt,
    exp: issuedAt + config.sessionTtlSeconds,
    user: {
      id: String(actor.id),
      username: actor.username,
      email: actor.email,
      role: 'admin',
    },
  })).toString('base64url');
  return `${payload}.${sign(payload, config.sessionSecret)}`;
}

function decodeSession(token, config, now) {
  if (typeof token !== 'string') return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra || !safeEqual(signature, sign(payload, config.sessionSecret))) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (
      value?.v !== 1
      || value?.user?.role !== 'admin'
      || !value.user.id
      || !value.user.email
      || !Number.isInteger(value.exp)
      || value.exp <= Math.floor(now / 1000)
    ) return null;
    return value.user;
  } catch {
    return null;
  }
}

export function cookies(request) {
  const header = request.headers.cookie || '';
  return Object.fromEntries(header.split(';').map((item) => {
    const index = item.indexOf('=');
    if (index < 0) return [item.trim(), ''];
    const name = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    try {
      return [name, decodeURIComponent(value)];
    } catch {
      return [name, ''];
    }
  }).filter(([name]) => name));
}

export function sessionFromRequest(request, config, now = Date.now()) {
  if (config.authDisabled) {
    return { id: 'local-admin', username: 'Local admin', email: 'local-admin', role: 'admin' };
  }
  return decodeSession(cookies(request)[SESSION_COOKIE], config, now);
}

export function authorize(request, config, now = Date.now()) {
  const user = sessionFromRequest(request, config, now);
  if (!user) return { ok: false };
  return { ok: true, actor: user.email || user.username || `admin:${user.id}`, user };
}

export function sessionCookie(actor, config, now = Date.now()) {
  return `${SESSION_COOKIE}=${encodeSession(actor, config, now)}; ${cookieOptions(config, config.sessionTtlSeconds)}`;
}

export function clearSessionCookie(config) {
  return `${SESSION_COOKIE}=; ${cookieOptions(config, 0)}`;
}

export function pendingLoginCookie(id, config, maxAge = 300) {
  return `${PENDING_LOGIN_COOKIE}=${encodeURIComponent(id)}; ${cookieOptions(config, maxAge)}`;
}

export function clearPendingLoginCookie(config) {
  return `${PENDING_LOGIN_COOKIE}=; ${cookieOptions(config, 0)}`;
}

export function pendingLoginId(request) {
  return cookies(request)[PENDING_LOGIN_COOKIE] || '';
}
