import test from 'node:test';
import assert from 'node:assert/strict';
import { Sub2ApiAccountImportGateway } from '../src/services/sub2api-account-import-gateway.mjs';

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
        data: { id: 2780, group_ids: [9, 3], concurrency: 7, priority: 2 },
      }), { status: 200 });
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
    priority: 2,
    modelId: 'gpt-5.6-luna',
    prompt: 'Reply with OK.',
  });

  assert.equal(created.id, 2780);
  const putBody = JSON.parse(requests.find((entry) => entry.options.method === 'PUT').options.body);
  assert.deepEqual(putBody.group_ids, [3, 9]);
  assert.equal(putBody.concurrency, 7);
  assert.equal(putBody.priority, 2);
  const testBody = JSON.parse(requests.find((entry) => entry.url.endsWith('/test')).options.body);
  assert.equal(testBody.model_id, 'gpt-5.6-luna');
  assert.equal(testBody.prompt, 'Reply with OK.');
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
