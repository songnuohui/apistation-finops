import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPinnedHttpsRequestOptions, SupplierAdapterError, SupplierAdapterRegistry, SupplierHttpClient,
  normalizeSupplierBaseUrl,
} from '../src/services/supplier-adapters.mjs';

const config = { supplierRequestTimeoutMs: 1_000, supplierMaxResponseBytes: 1024 * 1024 };
const publicDns = async () => [{ address: '8.8.8.8', family: 4 }];

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestBody(options) {
  return options.body ? JSON.parse(options.body) : undefined;
}

test('supplier base URLs normalize safely and private DNS targets are rejected before fetch', async () => {
  assert.equal(normalizeSupplierBaseUrl(' https://supplier.example.test/api/ '), 'https://supplier.example.test/api');
  assert.throws(() => normalizeSupplierBaseUrl('https://user:pass@supplier.example.test'), /without credentials/);
  assert.throws(() => normalizeSupplierBaseUrl('https://supplier.example.test/?page=1'), /without credentials/);

  const client = new SupplierHttpClient(config, {
    dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
    fetchImpl: async () => assert.fail('fetch must not run for a private target'),
  });
  await assert.rejects(
    client.request('https://supplier.example.test', '/api/status'),
    (error) => error instanceof SupplierAdapterError && error.code === 'private_address_blocked',
  );
});

test('pinned HTTPS requests connect directly to the validated address while preserving Host and SNI', () => {
  const options = buildPinnedHttpsRequestOptions(
    'https://supplier.example.test:8443/api/v1/keys?page=2',
    { method: 'GET', headers: { Accept: 'application/json' } },
    { address: '203.0.113.10', family: 4 },
  );
  assert.deepEqual(options, {
    protocol: 'https:',
    hostname: '203.0.113.10',
    family: 4,
    port: '8443',
    path: '/api/v1/keys?page=2',
    method: 'GET',
    headers: { Accept: 'application/json', Host: 'supplier.example.test:8443' },
    servername: 'supplier.example.test',
    autoSelectFamily: false,
  });
  assert.equal('lookup' in options, false);
});

test('supplier redirects identify the migrated host without forwarding credentials', async () => {
  let request;
  const client = new SupplierHttpClient(config, {
    dnsLookup: publicDns,
    fetchImpl: async (url, options) => {
      request = { url, redirect: options.redirect, authorization: options.headers.Authorization };
      return new Response('<html>moved</html>', {
        status: 301,
        headers: {
          location: 'https://new-supplier.example.test/api/v1/auth/me',
          'content-type': 'text/html',
        },
      });
    },
  });

  await assert.rejects(
    client.request('https://supplier.example.test', '/api/v1/auth/me', { token: 'portal-token' }),
    (error) => error instanceof SupplierAdapterError
      && error.code === 'supplier_redirect'
      && error.statusCode === 422
      && error.httpStatus === 301
      && /GET \/api\/v1\/auth\/me/.test(error.message)
      && /https:\/\/new-supplier\.example\.test/.test(error.message),
  );
  assert.deepEqual(request, {
    url: 'https://supplier.example.test/api/v1/auth/me',
    redirect: 'error',
    authorization: 'Bearer portal-token',
  });
});

test('non-JSON supplier errors include the request stage and response type', async () => {
  const client = new SupplierHttpClient(config, {
    dnsLookup: publicDns,
    fetchImpl: async () => new Response('<html>gateway error</html>', {
      status: 502,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  });

  await assert.rejects(
    client.request('https://supplier.example.test', '/api/v1/groups/rates'),
    (error) => error instanceof SupplierAdapterError
      && error.code === 'invalid_json'
      && error.httpStatus === 502
      && error.message === 'GET /api/v1/groups/rates: supplier returned text/html with HTTP 502',
  );
});

test('Sub2API adapter supports password plus TOTP and probes only the documented billing read endpoint', async () => {
  const requests = [];
  const registry = new SupplierAdapterRegistry(config, {
    dnsLookup: publicDns,
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      const body = requestBody(options);
      requests.push({ method: options.method, path: `${parsed.pathname}${parsed.search}`, body, authorization: options.headers.Authorization || '' });
      if (parsed.pathname === '/api/v1/auth/login') {
        assert.deepEqual(body, { email: 'operator@example.test', password: 'secret' });
        return json({ success: true, data: { requires_2fa: true, temp_token: 'pending-2fa' } });
      }
      if (parsed.pathname === '/api/v1/auth/login/2fa') {
        assert.equal(body.temp_token, 'pending-2fa');
        assert.match(body.totp_code, /^\d{6}$/);
        return json({ success: true, data: { access_token: 'sub2-portal-token' } });
      }
      if (parsed.pathname === '/api/v1/auth/me') return json({ success: true, data: { email: 'operator@example.test', balance: 7.5 } });
      if (parsed.pathname === '/api/v1/groups/available') return json({ success: true, data: [{ id: 2, name: 'Pro', rate_multiplier: 1.2 }] });
      if (parsed.pathname === '/api/v1/groups/rates') return json({ success: true, data: { 2: 1.5 } });
      if (parsed.pathname === '/api/v1/keys') {
        assert.equal(parsed.searchParams.get('page'), '1');
        assert.equal(parsed.searchParams.get('page_size'), '100');
        return json({ success: true, data: { items: [{
          id: 4, name: 'seat', key: 'sk-sub-key', status: 'active', group_id: 2,
          quota: 10, quota_used: 3, expires_at: -1,
        }], pages: 1 } });
      }
      if (parsed.pathname === '/v1/sub2api/billing') {
        assert.equal(options.method, 'GET');
        assert.equal(options.headers.Authorization, 'Bearer sk-sub-key');
        return json({
          object: 'sub2api.key_billing', schema_version: 1, billing_scope: 'token',
          group_rate_multiplier: 1.2, resolved_rate_multiplier: 1.5, effective_rate_multiplier: 1.8,
          peak_rate_enabled: true, peak_rate_multiplier: 1.2, applied_peak_multiplier: 1.2,
          observed_at: '2026-08-03T12:00:00Z',
        });
      }
      assert.fail(`unexpected request: ${parsed.pathname}`);
    },
  });
  const connection = { adapterType: 'sub2api', authMode: 'password', baseUrl: 'https://supplier.example.test' };
  const credentials = { username: 'operator@example.test', password: 'secret', totpSecret: 'JBSWY3DPEHPK3PXP' };

  const snapshot = await registry.snapshot(connection, credentials);
  assert.equal(snapshot.adapterType, 'sub2api');
  assert.equal(snapshot.identity, 'op***@example.test');
  assert.equal(snapshot.balance, 7.5);
  assert.deepEqual(snapshot.keys[0], {
    externalId: '4', name: 'seat', rawKey: 'sk-sub-key', maskedKey: 'sk-su...-key', status: 'active',
    groupId: '2', groupName: 'Pro', rateMultiplier: 1.5, quotaTotal: 10, quotaUsed: 3, quotaRemaining: 7,
    quotaCurrency: 'USD', expiresAt: null, lastUsedAt: null,
    sourceData: { rateLimit5h: null, rateLimit1d: null, rateLimit7d: null, usage5h: null, usage1d: null, usage7d: null },
  });
  const check = await registry.check(connection, credentials, snapshot, snapshot.keys[0]);
  assert.equal(check.status, 'ok');
  assert.equal(check.rateMultiplier, 1.8);
  assert.deepEqual(requests.filter((request) => request.method === 'POST').map((request) => request.path), [
    '/api/v1/auth/login', '/api/v1/auth/login/2fa',
  ]);
});

test('NewAPI adapter handles password 2FA and does not request plaintext token keys', async () => {
  const requests = [];
  const registry = new SupplierAdapterRegistry(config, {
    dnsLookup: publicDns,
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      const body = requestBody(options);
      requests.push({ method: options.method, path: `${parsed.pathname}${parsed.search}`, body, authorization: options.headers.Authorization || '' });
      if (parsed.pathname === '/api/user/login') {
        assert.deepEqual(body, { username: 'finance', password: 'secret' });
        return json({ success: true, data: { require_2fa: true, flow_token: 'newapi-flow' } });
      }
      if (parsed.pathname === '/api/user/login/2fa') {
        assert.equal(body.flow_token, 'newapi-flow');
        assert.match(body.code, /^\d{6}$/);
        return json({ success: true, data: { access_token: 'newapi-portal-token' } });
      }
      if (parsed.pathname === '/api/status') return json({ success: true, data: {
        quota_per_unit: 500000, quota_display_type: 'CUSTOM', custom_currency_exchange_rate: 2,
      } });
      if (parsed.pathname === '/api/user/self') return json({ success: true, data: { username: 'finance', quota: 1500000 } });
      if (parsed.pathname === '/api/user/self/groups') return json({ success: true, data: { 'tier-a': { ratio: 1.2 } } });
      if (parsed.pathname === '/api/token/') return json({ success: true, data: { items: [{
        id: 9, name: 'seat', key: 'sk-...masked', status: 1, group: 'tier-a', remain_quota: 500000,
        used_quota: 1000000, unlimited_quota: false, expired_time: -1,
      }], total: 1 } });
      assert.fail(`unexpected request: ${parsed.pathname}`);
    },
  });
  const connection = { adapterType: 'newapi', authMode: 'password', baseUrl: 'https://supplier.example.test' };
  const credentials = { username: 'finance', password: 'secret', totpSecret: 'JBSWY3DPEHPK3PXP' };

  const snapshot = await registry.snapshot(connection, credentials);
  assert.equal(snapshot.identity, 'fi***');
  assert.equal(snapshot.balance, 6);
  assert.equal(snapshot.balanceCurrency, 'CUSTOM');
  assert.deepEqual(snapshot.keys[0], {
    externalId: '9', name: 'seat', rawKey: '', maskedKey: 'sk-...masked', status: 'active',
    groupId: 'tier-a', groupName: 'tier-a', rateMultiplier: 1.2, quotaTotal: 6, quotaUsed: 4, quotaRemaining: 2,
    quotaCurrency: 'CUSTOM', expiresAt: null, lastUsedAt: null,
    sourceData: { unlimitedQuota: false, modelLimitsEnabled: false, modelLimits: '', autoGroups: [] },
  });
  const check = await registry.check(connection, credentials, snapshot, snapshot.keys[0]);
  assert.deepEqual(check, {
    status: 'skipped', method: 'portal_inventory', errorCode: 'raw_key_not_requested',
    errorMessage: 'per-key checks do not retrieve plaintext keys',
  });
  assert.equal(requests.some((request) => request.path === '/api/token/9/key'), false);
  assert.deepEqual(requests.filter((request) => request.method === 'POST').map((request) => request.path), [
    '/api/user/login', '/api/user/login/2fa',
  ]);
});

test('NewAPI adapter falls back to a login session cookie when no access token is returned', async () => {
  const requests = [];
  const registry = new SupplierAdapterRegistry(config, {
    dnsLookup: publicDns,
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      requests.push({
        path: parsed.pathname,
        cookie: options.headers.Cookie || '',
        authorization: options.headers.Authorization || '',
        userId: options.headers['New-Api-User'] || '',
      });
      if (parsed.pathname === '/api/user/login') {
        return new Response(JSON.stringify({ success: true, data: { id: 42, username: 'legacy' } }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'set-cookie': 'session=legacy-session; Path=/' },
        });
      }
      if (parsed.pathname === '/api/status') return json({ success: true, data: {
        quota_per_unit: 1, quota_display_type: 'USD',
      } });
      if (parsed.pathname === '/api/user/self') return json({ success: true, data: { username: 'legacy', quota: 7 } });
      if (parsed.pathname === '/api/user/self/groups') return json({ success: true, data: {} });
      if (parsed.pathname === '/api/token/') return json({ success: true, data: { items: [], total: 0 } });
      assert.fail(`unexpected request: ${parsed.pathname}`);
    },
  });
  const snapshot = await registry.snapshot(
    { adapterType: 'newapi', authMode: 'password', baseUrl: 'https://supplier.example.test' },
    { username: 'legacy', password: 'secret' },
  );
  assert.equal(snapshot.accessToken, '');
  assert.equal(snapshot.sessionCookie, 'session=legacy-session');
  assert.equal(snapshot.userId, '42');
  assert.equal(snapshot.balance, 7);
  assert.ok(requests.filter((request) => ['/api/user/self', '/api/user/self/groups', '/api/token/'].includes(request.path))
    .every((request) => request.cookie === 'session=legacy-session'));
  assert.ok(requests.filter((request) => ['/api/user/self', '/api/user/self/groups', '/api/token/'].includes(request.path))
    .every((request) => request.userId === '42'));
});

test('NewAPI cookie login fails clearly when the legacy user ID is missing', async () => {
  const registry = new SupplierAdapterRegistry(config, {
    dnsLookup: publicDns,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/user/login') {
        return new Response(JSON.stringify({ success: true, data: { username: 'legacy' } }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'set-cookie': 'session=legacy-session; Path=/' },
        });
      }
      assert.fail(`unexpected request: ${parsed.pathname}`);
    },
  });
  await assert.rejects(
    registry.snapshot(
      { adapterType: 'newapi', authMode: 'password', baseUrl: 'https://supplier.example.test' },
      { username: 'legacy', password: 'secret' },
    ),
    (error) => error.code === 'authentication_failed' && /user ID required/.test(error.message),
  );
});

test('active probes measure the first streamed output token and honor the selected model budget', async () => {
  let request;
  const encoder = new TextEncoder();
  const client = new SupplierHttpClient(config, {
    dnsLookup: publicDns,
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body), authorization: options.headers.Authorization };
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'));
          setTimeout(() => {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          }, 15);
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });

  const result = await client.probeChatCompletion(
    'https://supplier.example.test', 'sk-probe', 'gpt-4o-mini', { maxOutputTokens: 2 },
  );

  assert.equal(request.url, 'https://supplier.example.test/v1/chat/completions');
  assert.equal(request.authorization, 'Bearer sk-probe');
  assert.equal(request.body.model, 'gpt-4o-mini');
  assert.equal(request.body.max_tokens, 2);
  assert.equal(request.body.stream, true);
  assert.equal(result.status, 'ok');
  assert.ok(result.ttftMs >= 10);
  assert.ok(result.durationMs >= result.ttftMs);
});

test('NewAPI model discovery reveals only the selected key in memory', async () => {
  const requests = [];
  const registry = new SupplierAdapterRegistry(config, {
    dnsLookup: publicDns,
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      requests.push({ path: parsed.pathname, method: options.method, authorization: options.headers.Authorization || '' });
      if (parsed.pathname === '/api/token/9/key') {
        return json({ success: true, data: { key: 'sk-selected-key' } });
      }
      if (parsed.pathname === '/v1/models') {
        assert.equal(options.headers.Authorization, 'Bearer sk-selected-key');
        return json({ object: 'list', data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-a' }] });
      }
      assert.fail(`unexpected request: ${parsed.pathname}`);
    },
  });
  const models = await registry.listProbeModels(
    { adapterType: 'newapi', baseUrl: 'https://supplier.example.test' },
    { adapterType: 'newapi', accessToken: 'portal-token', keys: [] },
    { externalId: '9', rawKey: '' },
  );
  assert.deepEqual(models, ['model-a', 'model-b']);
  assert.deepEqual(requests.map((item) => `${item.method} ${item.path}`), [
    'POST /api/token/9/key', 'GET /v1/models',
  ]);
});
