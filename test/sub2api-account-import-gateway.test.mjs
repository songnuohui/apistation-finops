import test from 'node:test';
import assert from 'node:assert/strict';
import { Sub2ApiAccountImportGateway, applyModelWhitelist } from '../src/services/sub2api-account-import-gateway.mjs';

const config = {
  sub2apiAuthUrl: 'https://sub2api.example',
  sub2apiAuthTimeoutMs: 1_000,
};

test('Sub2API group catalog returns sanitized groups for platform and multi-select controls', async () => {
  const gateway = new Sub2ApiAccountImportGateway(config, console, async (url, options) => {
    assert.equal(url, 'https://sub2api.example/api/v1/admin/groups/all?include_inactive=true');
    assert.equal(options.headers['x-api-key'], 'admin-key');
    return new Response(JSON.stringify({
      data: [
        { id: 9, name: 'OpenAI 主力', platform: 'openai', status: 'active', sort_order: 2, secret: 'omit' },
        { id: 3, name: 'OpenAI 备用', platform: 'openai', status: 'disabled', sort_order: 1 },
      ],
    }), { status: 200 });
  });
  gateway.setAccessTokenProvider({
    async getAuthentication() {
      return { credential: 'admin-key', headers: { 'x-api-key': 'admin-key' } };
    },
  });

  assert.deepEqual(await gateway.listGroups(), [
    { id: 3, name: 'OpenAI 备用', platform: 'openai', status: 'disabled', rateMultiplier: null, sortOrder: 1 },
    { id: 9, name: 'OpenAI 主力', platform: 'openai', status: 'active', rateMultiplier: null, sortOrder: 2 },
  ]);
});

test('Sub2API import fixes and verifies groups, concurrency and priority', async () => {
  const requests = [];
  const gateway = new Sub2ApiAccountImportGateway(config, console, async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/accounts') && options.method === 'POST') {
      return new Response(JSON.stringify({ data: { id: 2780 } }), { status: 201 });
    }
    if (url.endsWith('/accounts/2780') && options.method === 'PUT') {
      return new Response(JSON.stringify({ data: { id: 2780 } }), { status: 200 });
    }
    if (url.endsWith('/accounts/2780') && options.method === 'GET') {
      return new Response(JSON.stringify({
        data: {
          id: 2780, group_ids: [9, 3], concurrency: 7, priority: 2,
          load_factor: 12, proxy_id: 44, rate_multiplier: 0.75, auto_pause_on_expired: false,
        },
      }), { status: 200 });
    }
    if (url.endsWith('/accounts/2780/schedulable')) {
      return new Response(JSON.stringify({ data: { id: 2780, schedulable: true } }), { status: 200 });
    }
    if (url.endsWith('/accounts/2780/test')) {
      return new Response('data: {"type":"test_start"}\n\ndata: {"type":"test_complete","success":true}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    throw new Error(`unexpected request ${url}`);
  });
  gateway.setAccessTokenProvider({
    async getAuthentication() {
      return { credential: 'admin-key', headers: { 'x-api-key': 'admin-key' } };
    },
  });

  const created = await gateway.importAndVerify({
    name: 'account@example.com',
    platform: 'openai',
    credentials: { access_token: 'secret-token' },
    groupIds: [3, 9],
    concurrency: 7,
    loadFactor: 12,
    proxyId: 44,
    priority: 2,
    rateMultiplier: 0.75,
    autoPauseOnExpired: false,
    modelId: 'gpt-5.6-luna',
    prompt: 'Reply with OK.',
    modelWhitelist: ['gpt-5.6', 'gpt-5.2'],
  });

  assert.equal(created.id, 2780);
  const createBody = JSON.parse(requests.find((entry) => entry.url.endsWith('/accounts') && entry.options.method === 'POST').options.body);
  assert.deepEqual(createBody.credentials.model_mapping, {
    'gpt-5.6': 'gpt-5.6',
    'gpt-5.2': 'gpt-5.2',
  });
  const putBody = JSON.parse(requests.find((entry) => entry.options.method === 'PUT').options.body);
  assert.deepEqual(putBody.group_ids, [3, 9]);
  assert.equal(putBody.concurrency, 7);
  assert.equal(putBody.load_factor, 12);
  assert.equal(putBody.proxy_id, 44);
  assert.equal(putBody.priority, 2);
  assert.equal(putBody.rate_multiplier, 0.75);
  assert.equal(putBody.auto_pause_on_expired, false);
  const testBody = JSON.parse(requests.find((entry) => entry.url.endsWith('/test')).options.body);
  assert.equal(testBody.model_id, 'gpt-5.6-luna');
  assert.equal(testBody.prompt, 'Reply with OK.');
});

test('Sub2API proxy catalog returns selectable non-secret proxy metadata', async () => {
  const gateway = new Sub2ApiAccountImportGateway(config, console, async (url) => {
    assert.equal(url, 'https://sub2api.example/api/v1/admin/proxies/all?include_inactive=true');
    return new Response(JSON.stringify({ data: [
      { id: 44, name: '美国ip', protocol: 'socks5', host: '15.204.89.179', port: 1179, username: 'hidden', password: 'hidden', status: 'active' },
      { id: 12, name: '无效代理', protocol: 'http', host: 'old.example', port: 8080, status: 'inactive' },
    ] }), { status: 200 });
  });
  gateway.setAccessTokenProvider({
    async getAuthentication() { return { credential: 'admin-key', headers: { 'x-api-key': 'admin-key' } }; },
  });

  assert.deepEqual(await gateway.listProxies(), [
    { id: 44, name: '美国ip', protocol: 'socks5', host: '15.204.89.179', port: 1179, status: 'active', expiresAt: null },
    { id: 12, name: '无效代理', protocol: 'http', host: 'old.example', port: 8080, status: 'inactive', expiresAt: null },
  ]);
});

test('blank load factor clears the Sub2API override and keeps explicit zero multiplier', async () => {
  const requests = [];
  const gateway = new Sub2ApiAccountImportGateway(config, console, async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/accounts') && options.method === 'POST') {
      return new Response(JSON.stringify({ data: { id: 2790 } }), { status: 201 });
    }
    if (url.endsWith('/accounts/2790') && options.method === 'PUT') {
      return new Response(JSON.stringify({ data: { id: 2790 } }), { status: 200 });
    }
    if (url.endsWith('/accounts/2790') && options.method === 'GET') {
      return new Response(JSON.stringify({ data: {
        id: 2790, group_ids: [3], concurrency: 1, priority: 0,
        load_factor: 0, rate_multiplier: 0, auto_pause_on_expired: true,
      } }), { status: 200 });
    }
    if (url.endsWith('/accounts/2790/schedulable')) {
      return new Response(JSON.stringify({ data: { id: 2790, schedulable: true } }), { status: 200 });
    }
    if (url.endsWith('/accounts/2790/test')) {
      return new Response('data: {"type":"test_complete","success":true}\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    }
    throw new Error(`unexpected request ${url}`);
  });
  gateway.setAccessTokenProvider({
    async getAuthentication() { return { credential: 'admin-key', headers: { 'x-api-key': 'admin-key' } }; },
  });

  await gateway.importAndVerify({
    name: 'blank-factor@example.com', platform: 'openai', credentials: { access_token: 'secret-token' },
    groupIds: [3], concurrency: 1, loadFactor: null, priority: 0, rateMultiplier: 0,
    autoPauseOnExpired: true, modelId: 'gpt-5.6-luna', prompt: 'Reply with OK.',
  });

  const createBody = JSON.parse(requests.find((entry) => entry.url.endsWith('/accounts') && entry.options.method === 'POST').options.body);
  assert.equal('load_factor' in createBody, false);
  const putBody = JSON.parse(requests.find((entry) => entry.options.method === 'PUT').options.body);
  assert.equal(putBody.load_factor, 0);
  assert.equal(putBody.rate_multiplier, 0);
  assert.equal(putBody.auto_pause_on_expired, true);
});

test('an empty model whitelist clears an inherited model restriction', () => {
  assert.deepEqual(applyModelWhitelist({ access_token: 'secret', model_mapping: { old: 'old' } }, []), {
    access_token: 'secret',
    model_mapping: {},
  });
});

test('Sub2API SSE verification rejects a stream without explicit completion', async () => {
  const gateway = new Sub2ApiAccountImportGateway(config, console, async (url) => {
    if (url.endsWith('/accounts/4/test')) {
      return new Response('data: {"type":"content","text":"OK"}\n\n', { status: 200 });
    }
    return new Response(JSON.stringify({ data: { id: 4, group_ids: [], concurrency: 1, priority: 1 } }), {
      status: 200,
    });
  });
  gateway.setAccessTokenProvider({
    async getAuthentication() {
      return { credential: 'admin-key', headers: { 'x-api-key': 'admin-key' } };
    },
  });

  await assert.rejects(
    gateway.testAccount(4, { modelId: 'gpt-5.6-luna', prompt: 'Reply with OK.' }),
    /explicit success event/,
  );
});

test('Sub2API account usage reads the passive quota snapshot without forcing a refresh', async () => {
  const gateway = new Sub2ApiAccountImportGateway(config, console, async (url, options) => {
    assert.equal(url, 'https://sub2api.example/api/v1/admin/accounts/2780/usage?source=passive');
    assert.equal(options.method, 'GET');
    return new Response(JSON.stringify({
      data: { codex_5h_used_percent: 32, codex_7d_used_percent: 81 },
    }), { status: 200 });
  });
  gateway.setAccessTokenProvider({
    async getAuthentication() {
      return { credential: 'admin-key', headers: { 'x-api-key': 'admin-key' } };
    },
  });

  assert.deepEqual(await gateway.getAccountUsage(2780), {
    codex_5h_used_percent: 32,
    codex_7d_used_percent: 81,
  });
});
