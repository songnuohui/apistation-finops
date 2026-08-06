import test from 'node:test';
import assert from 'node:assert/strict';
import { Sub2ApiReadonlyGateway } from '../src/services/sub2api-readonly-gateway.mjs';
import { Sub2ApiServiceAuthService } from '../src/services/sub2api-service-auth-service.mjs';

const now = Date.parse('2026-08-06T08:00:00.000Z');
const config = {
  demoMode: false,
  supplierCredentialsKey: '4a'.repeat(32),
  sub2apiServiceAuthRefreshSeconds: 300,
  sub2apiAuthUrl: 'http://127.0.0.1:8080',
  sub2apiAuthTimeoutMs: 1_000,
};

function accessToken(expiresAt) {
  return `header.${Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1000) })).toString('base64url')}.signature`;
}

function serviceAuthRepository() {
  const settings = {
    enabled: false,
    authMode: 'password',
    email: '',
    credentialsCiphertext: '',
    lastAuthenticatedAt: null,
    tokenExpiresAt: null,
    lastError: '',
    updatedBy: 'system',
    updatedAt: null,
  };
  return {
    settings,
    async getSub2ApiServiceAuthSettings({ includeCiphertext = false } = {}) {
      const result = { ...settings, credentialsConfigured: Boolean(settings.credentialsCiphertext) };
      if (!includeCiphertext) delete result.credentialsCiphertext;
      return result;
    },
    async updateSub2ApiServiceAuthSettings(input, credentialsCiphertext, actor) {
      Object.assign(settings, {
        enabled: Boolean(input.enabled),
        authMode: input.authMode || 'password',
        email: input.email,
        credentialsCiphertext,
        lastAuthenticatedAt: null,
        tokenExpiresAt: null,
        lastError: '',
        updatedBy: actor,
        updatedAt: new Date(now).toISOString(),
      });
      return this.getSub2ApiServiceAuthSettings();
    },
    async recordSub2ApiServiceAuthResult(result) {
      if (result.lastAuthenticatedAt) settings.lastAuthenticatedAt = result.lastAuthenticatedAt;
      settings.tokenExpiresAt = result.lastAuthenticatedAt ? result.tokenExpiresAt : null;
      settings.lastError = result.lastError || '';
    },
  };
}

test('dedicated Sub2API service authentication encrypts credentials and keeps tokens in memory', async () => {
  const repository = serviceAuthRepository();
  const logins = [];
  const service = new Sub2ApiServiceAuthService(repository, config, console, {
    now: () => now,
    login: async (credentials) => {
      logins.push(credentials);
      return { requiresTwoFactor: false, accessToken: accessToken(now + 600_000) };
    },
  });

  const status = await service.updateSettings({
    enabled: true,
    email: 'finops-service@example.com',
    password: 'service-password',
    totpSecret: '',
    clearCredentials: false,
  }, 'finops-admin');

  assert.deepEqual(logins, [{ email: 'finops-service@example.com', password: 'service-password' }]);
  assert.equal(repository.settings.credentialsCiphertext.includes('service-password'), false);
  assert.equal(repository.settings.credentialsCiphertext.includes(accessToken(now + 600_000)), false);
  assert.equal(status.authenticated, true);
  assert.equal(status.credentialsConfigured, true);
  assert.equal(status.tokenExpiresAt, new Date(now + 600_000).toISOString());
  assert.equal('accessToken' in status, false);
});

test('dedicated Sub2API service authentication completes a TOTP challenge', async () => {
  const repository = serviceAuthRepository();
  const challenges = [];
  const service = new Sub2ApiServiceAuthService(repository, config, console, {
    now: () => now,
    login: async () => ({ requiresTwoFactor: true, tempToken: 'temporary-login-token' }),
    completeTwoFactor: async (input) => {
      challenges.push(input);
      return { accessToken: accessToken(now + 600_000) };
    },
  });

  await service.updateSettings({
    enabled: true,
    email: 'finops-service@example.com',
    password: 'service-password',
    totpSecret: 'JBSWY3DPEHPK3PXP',
    clearCredentials: false,
  });

  assert.deepEqual(challenges.map(({ tempToken }) => tempToken), ['temporary-login-token']);
  assert.match(challenges[0].totpCode, /^\d{6}$/);
  assert.equal(service.status().authenticated, true);
});

test('administrator API Key is encrypted and used through X-API-Key', async () => {
  const repository = serviceAuthRepository();
  const verified = [];
  const service = new Sub2ApiServiceAuthService(repository, config, console, {
    now: () => now,
    verifyApiKey: async ({ apiKey }) => { verified.push(apiKey); },
  });

  const status = await service.updateSettings({
    enabled: true,
    authMode: 'api_key',
    email: '',
    password: '',
    totpSecret: '',
    apiKey: 'admin-6e01-secret',
    clearCredentials: false,
  });
  const authentication = await service.getAuthentication();

  assert.deepEqual(verified, ['admin-6e01-secret']);
  assert.equal(repository.settings.credentialsCiphertext.includes('admin-6e01-secret'), false);
  assert.equal(status.authMode, 'api_key');
  assert.equal(status.tokenExpiresAt, null);
  assert.deepEqual(authentication, {
    credential: 'admin-6e01-secret',
    headers: { 'X-API-Key': 'admin-6e01-secret' },
  });
});

test('Sub2API gateway invalidates and retries a rejected service token once', async () => {
  const invalidated = [];
  const requested = [];
  let tokenCalls = 0;
  const provider = {
    async getAccessToken({ force = false } = {}) {
      tokenCalls += 1;
      return force ? 'refreshed-token' : 'expired-token';
    },
    async invalidateAccessToken(token) {
      invalidated.push(token);
    },
  };
  const gateway = new Sub2ApiReadonlyGateway(config, console, async (_url, options) => {
    requested.push(options.headers.Authorization);
    if (requested.length === 1) {
      return new Response(JSON.stringify({ code: 401 }), { status: 401 });
    }
    return new Response(JSON.stringify({ code: 0, data: [{ id: 7 }] }), { status: 200 });
  });
  gateway.setAccessTokenProvider(provider);

  const groups = await gateway.listGroups();

  assert.deepEqual(groups, [{ id: 7 }]);
  assert.deepEqual(requested, ['Bearer expired-token', 'Bearer refreshed-token']);
  assert.deepEqual(invalidated, ['expired-token']);
  assert.equal(tokenCalls, 2);
});

test('Sub2API gateway sends the administrator API Key without a bearer token', async () => {
  const gateway = new Sub2ApiReadonlyGateway(config, console, async (_url, options) => {
    assert.equal(options.headers['X-API-Key'], 'admin-key');
    assert.equal(options.headers.Authorization, undefined);
    return new Response(JSON.stringify({ code: 0, data: [{ id: 7 }] }), { status: 200 });
  });
  gateway.setAccessTokenProvider({
    async getAuthentication() {
      return { credential: 'admin-key', headers: { 'X-API-Key': 'admin-key' } };
    },
  });

  assert.deepEqual(await gateway.listGroups(), [{ id: 7 }]);
});
