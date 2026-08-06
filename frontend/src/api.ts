export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  let payload: any = null;
  try { payload = await response.json(); } catch {}
  if (!response.ok) throw new Error(payload?.error || `请求失败（${response.status}）`);
  return payload as T;
}

export const get = <T = any>(path: string) => api<T>(path);
export const send = <T = any>(path: string, method: string, body: any) => api<T>(path, {
  method, body: JSON.stringify(body),
});

export function query(params: Record<string, string | number | boolean | null | undefined>) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  });
  return search.toString();
}

export function rangeQuery(range: string | undefined, start = '', end = '') {
  return {
    range: range || '7d',
    ...(range === 'custom' ? { start, end } : {}),
  };
}
