import test from 'node:test';
import assert from 'node:assert/strict';
import { OAuthSupplyAuthService } from '../src/services/oauth-supply-auth-service.mjs';
import { OAuthSupplyClient } from '../src/services/oauth-supply-client.mjs';

const now = Date.parse('2026-08-10T08:00:00.000Z');
const config = {
  demoMode: false,
  supplierCredentialsKey: '4a'.repeat(32),
  supplierBlockedHosts: [],
  supplierRequestTimeoutMs: 1_000,
  supplierMaxResponseBytes: 65_536,
};

function repositoryStub() {
  const settings = {
    enabled: false,
    baseUrl: 'https://sogouedu.cc',
    username: '',
    credentialsCiphertext: '',
    tokenCiphertext: '',
    tokenConfigured: false,
    lastAuthenticatedAt: null,
    tokenExpiresAt: null,
    lastError: '',
    updatedBy: 'system',
    updatedAt: null,
  };
  return {
    settings,
    async getOAuthSupplyAuthSettings({ includeCiphertext = false } = {}) {
      const value = { ...settings };
      if (!includeCiphertext) {
        delete value.credentialsCiphertext;
        delete value.tokenCiphertext;
      }
      return value;
    },
    async updateOAuthSupplyAuthSettings(input, credentialsCiphertext, actor) {
      Object.assign(settings, {
        enabled: input.enabled,
        baseUrl: input.baseUrl,
        username: input.username,
        credentialsCiphertext,
        tokenCiphertext: '',
        tokenConfigured: false,
        lastAuthenticatedAt: null,
        tokenExpiresAt: null,
        lastError: '',
        updatedBy: actor,
        updatedAt: new Date(now).toISOString(),
      });
    },
    async recordOAuthSupplyAuthResult(result) {
      if (result.tokenCiphertext !== null) {
        settings.tokenCiphertext = result.tokenCiphertext;
        settings.tokenConfigured = Boolean(result.tokenCiphertext);
        settings.tokenExpiresAt = result.tokenExpiresAt;
      }
      if (result.lastAuthenticatedAt) settings.lastAuthenticatedAt = result.lastAuthenticatedAt;
      settings.lastError = result.lastError || '';
    },
  };
}

test('OAuth Supply client posts customer credentials and derives the documented 30-day token lifetime', async () => {
  const requests = [];
  const client = new OAuthSupplyClient(config, console, async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ token: 'oauth-token' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }, () => now, async () => [{ address: '93.184.216.34', family: 4 }]);

  const result = await client.login({
    baseUrl: 'https://sogouedu.cc/',
    username: 'customer-1',
    password: 'secret',
  });

  assert.equal(requests[0].url, 'https://sogouedu.cc/api/customer/login');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    username: 'customer-1',
    password: 'secret',
  });
  assert.equal(result.token, 'oauth-token');
  assert.equal(result.expiresAt.getTime(), now + 30 * 24 * 60 * 60 * 1000);
});

test('OAuth Supply authentication encrypts credentials and token without exposing either one in status', async () => {
  const repository = repositoryStub();
  const service = new OAuthSupplyAuthService(repository, config, console, {
    now: () => now,
    client: {
      async login() {
        return {
          token: 'oauth-secret-token',
          expiresAt: new Date(now + 600_000),
        };
      },
    },
  });

  const status = await service.updateSettings({
    enabled: true,
    baseUrl: 'https://sogouedu.cc',
    username: 'customer-1',
    password: 'customer-password',
    clearCredentials: false,
  }, 'finops-admin');

  assert.equal(status.authenticated, true);
  assert.equal(status.tokenConfigured, true);
  assert.equal(status.username, 'customer-1');
  assert.equal(status.tokenExpiresAt, new Date(now + 600_000).toISOString());
  assert.equal('token' in status, false);
  assert.equal('password' in status, false);
  assert.equal(repository.settings.credentialsCiphertext.includes('customer-password'), false);
  assert.equal(repository.settings.tokenCiphertext.includes('oauth-secret-token'), false);
});

test('OAuth Supply authentication records an upstream login error and clears the cached token', async () => {
  const repository = repositoryStub();
  const service = new OAuthSupplyAuthService(repository, config, console, {
    now: () => now,
    client: {
      async login() {
        throw Object.assign(new Error('账号或密码错误'), { statusCode: 401 });
      },
    },
  });

  await assert.rejects(
    service.updateSettings({
      enabled: true,
      baseUrl: 'https://sogouedu.cc',
      username: 'customer-1',
      password: 'wrong-password',
    }),
    /账号或密码错误/,
  );
  assert.equal(repository.settings.tokenConfigured, false);
  assert.equal(repository.settings.lastError, '账号或密码错误');
});
