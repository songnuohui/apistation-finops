import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listSub2ApiAdminGroups,
  listSub2ApiChannelMonitors,
  loginSub2ApiAdministrator,
  Sub2ApiAuthError,
} from '../src/services/sub2api-auth-service.mjs';

const config = {
  sub2apiAuthUrl: 'http://127.0.0.1:8080',
  sub2apiAuthTimeoutMs: 1_000,
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('sub2api admin login verifies the issued token against the current profile', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/login')) {
      return json({ code: 0, data: { access_token: 'short-lived-token' } });
    }
    return json({
      code: 0,
      data: { id: 12, username: 'Operations', email: 'admin@example.com', role: 'admin', status: 'active' },
    });
  };

  const result = await loginSub2ApiAdministrator(
    { email: 'admin@example.com', password: 'not-recorded', clientIp: '203.0.113.6' },
    config,
    fetchImpl,
  );

  assert.deepEqual(result, {
    requiresTwoFactor: false,
    user: { id: 12, username: 'Operations', email: 'admin@example.com', role: 'admin' },
    accessToken: 'short-lived-token',
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://127.0.0.1:8080/api/v1/auth/login');
  assert.deepEqual(JSON.parse(calls[0].options.body), { email: 'admin@example.com', password: 'not-recorded' });
  assert.equal(calls[1].options.headers.Authorization, 'Bearer short-lived-token');
  assert.equal(calls[1].options.headers['X-Forwarded-For'], '203.0.113.6');
});

test('sub2api group catalog keeps only sanitized display fields', async () => {
  const result = await listSub2ApiAdminGroups(
    { accessToken: 'short-lived-token', clientIp: '203.0.113.6' },
    config,
    async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:8080/api/v1/admin/groups/all?include_inactive=true');
      assert.equal(options.headers.Authorization, 'Bearer short-lived-token');
      return json({
        code: 0,
        data: [{
          id: 21,
          name: 'Codex 主力',
          platform: 'openai',
          status: 'active',
          rate_multiplier: 0.08,
          sort_order: 2,
          default_mapped_model: 'gpt-5.6',
          updated_at: '2026-08-01T06:00:00Z',
          model_routing: { secret: ['must not persist'] },
        }],
      });
    },
  );
  assert.deepEqual(result, [{
    sourceGroupId: 21,
    name: 'Codex 主力',
    platform: 'openai',
    status: 'active',
    groupMultiplier: 0.08,
    sortOrder: 2,
    defaultModel: 'gpt-5.6',
    sourceUpdatedAt: '2026-08-01T06:00:00Z',
  }]);
});

test('sub2api user channel monitor list keeps only public status fields needed by FinOps', async () => {
  const result = await listSub2ApiChannelMonitors(
    { accessToken: 'short-lived-token' },
    config,
    async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:8080/api/v1/channel-monitors');
      assert.equal(options.headers.Authorization, 'Bearer short-lived-token');
      return json({
        code: 0,
        data: {
          items: [{
            id: 7,
            name: 'PLUS monitor',
            group_name: 'PLUS 分组',
            primary_model: 'gpt-5.4',
            enabled: true,
            primary_status: 'operational',
            primary_latency_ms: 220,
            primary_ping_latency_ms: 12,
            availability_7d: 99.1,
            timeline: [{ status: 'operational', checked_at: '2026-08-01T06:00:00Z' }],
          }],
        },
      });
    },
  );
  assert.deepEqual(result, [{
    id: 7,
    name: 'PLUS monitor',
    groupName: 'PLUS 分组',
    primaryModel: 'gpt-5.4',
    enabled: true,
    primaryStatus: 'operational',
    primaryLatencyMs: 220,
    primaryPingLatencyMs: 12,
    availability7d: 99.1,
    lastCheckedAt: null,
  }]);
});

test('sub2api login keeps a TOTP challenge server-side', async () => {
  const result = await loginSub2ApiAdministrator(
    { email: 'admin@example.com', password: 'not-recorded' },
    config,
    async () => json({ code: 0, data: { requires_2fa: true, temp_token: 'sub2api-pending-token', user_email_masked: 'a***@example.com' } }),
  );

  assert.deepEqual(result, {
    requiresTwoFactor: true,
    tempToken: 'sub2api-pending-token',
    emailMasked: 'a***@example.com',
  });
});

test('sub2api users without the admin role are rejected', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/auth/login')) return json({ code: 0, data: { access_token: 'short-lived-token' } });
    return json({ code: 0, data: { id: 18, username: 'User', email: 'user@example.com', role: 'user', status: 'active' } });
  };

  await assert.rejects(
    () => loginSub2ApiAdministrator({ email: 'user@example.com', password: 'not-recorded' }, config, fetchImpl),
    (error) => error instanceof Sub2ApiAuthError && error.code === 'admin_required' && error.statusCode === 403,
  );
});
