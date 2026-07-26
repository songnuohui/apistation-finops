import crypto from 'node:crypto';

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function authorize(request, config) {
  if (config.authDisabled) return { ok: true, actor: 'local-admin' };
  const header = request.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim() || '';
  if (!token || !safeEqual(token, config.adminToken)) return { ok: false };
  return { ok: true, actor: 'admin' };
}
