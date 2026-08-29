const UPSTREAM_ORIGIN = 'https://sinan-estimate-push.ligugu69.workers.dev';
const ROUTES = Object.freeze({
  '/__fundval_dev/estimates': '/estimates',
  '/__fundval_dev/holdings': '/holdings',
});

function validCacheBust(value) {
  return value == null || /^\d{1,20}$/.test(value);
}

export function resolveDevProxyTarget(requestUrl, method = 'GET') {
  if (method !== 'GET') return { ok: false, status: 405, reason: 'method_not_allowed' };
  const url = requestUrl instanceof URL ? requestUrl : new URL(String(requestUrl), 'http://127.0.0.1');
  const upstreamPath = ROUTES[url.pathname];
  if (!upstreamPath) return { ok: false, status: 404, reason: 'route_not_found' };
  const allowedKeys = upstreamPath === '/estimates' ? new Set(['codes', '_']) : new Set(['code', '_']);
  if ([...url.searchParams.keys()].some(key => !allowedKeys.has(key)) || !validCacheBust(url.searchParams.get('_'))) {
    return { ok: false, status: 400, reason: 'invalid_query' };
  }
  if (upstreamPath === '/estimates') {
    const codes = String(url.searchParams.get('codes') || '').split(',').filter(Boolean);
    if (!codes.length || codes.length > 100 || codes.some(code => !/^\d{6}$/.test(code)) || new Set(codes).size !== codes.length) {
      return { ok: false, status: 400, reason: 'invalid_codes' };
    }
  } else if (!/^\d{6}$/.test(String(url.searchParams.get('code') || ''))) {
    return { ok: false, status: 400, reason: 'invalid_code' };
  }
  const target = new URL(upstreamPath, UPSTREAM_ORIGIN);
  for (const key of allowedKeys) {
    const value = url.searchParams.get(key);
    if (value != null) target.searchParams.set(key, value);
  }
  return { ok: true, status: 200, target };
}

export async function proxyFundData(request, response, requestUrl) {
  const resolved = resolveDevProxyTarget(requestUrl, request.method);
  if (!resolved.ok) {
    response.writeHead(resolved.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ error: resolved.reason }));
    return true;
  }
  try {
    const upstream = await fetch(resolved.target, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(body);
  } catch (_) {
    response.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ error: 'upstream_unavailable' }));
  }
  return true;
}
