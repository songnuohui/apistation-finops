import path from 'node:path';

export function resolveStaticPath(webRoot, requestPath) {
  let pathname = decodeURIComponent(requestPath);
  if (pathname === '/' || !path.extname(pathname)) pathname = '/index.html';
  const candidate = path.resolve(webRoot, `.${pathname}`);
  const relative = path.relative(webRoot, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('forbidden'), { statusCode: 403 });
  }
  return candidate;
}

