import test from 'node:test';
import assert from 'node:assert/strict';
import { OAuthSupplyClient } from '../src/services/oauth-supply-client.mjs';

const config = {
  supplierBlockedHosts: [],
  supplierRequestTimeoutMs: 1_000,
  supplierMaxResponseBytes: 65_536,
};

test('OAuth Supply customer endpoints use X-Customer-Token and preserve order idempotency', async () => {
  const requests = [];
  const responses = [
    { status: 200, body: { products: [{ product: 'oauth_30d' }] } },
    { status: 200, body: { available: 4, estimated_total_fen: 1200 } },
    { status: 201, body: { order: { id: 'order-7', status: 'queued' } } },
    { status: 200, body: { order: { id: 'order-7', status: 'ready' } } },
    { status: 200, body: { balance_fen: 5000, available_fen: 5000 } },
  ];
  const client = new OAuthSupplyClient(
    config,
    console,
    async (url, options) => {
      requests.push({ url, options });
      const next = responses.shift();
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      });
    },
    Date.now,
    async () => [{ address: '93.184.216.34', family: 4 }],
  );

  await client.products({ baseUrl: 'https://sogouedu.cc', token: 'customer-token' });
  await client.inventory({ baseUrl: 'https://sogouedu.cc', token: 'customer-token', product: 'oauth_30d', quantity: 4 });
  await client.createOrder({
    baseUrl: 'https://sogouedu.cc',
    token: 'customer-token',
    product: 'oauth_30d',
    quantity: 4,
    idempotencyKey: 'finops-order-key',
  });
  await client.getOrder({ baseUrl: 'https://sogouedu.cc', token: 'customer-token', orderId: 'order-7' });
  await client.balance({ baseUrl: 'https://sogouedu.cc', token: 'customer-token' });

  assert.equal(requests[0].options.headers['X-Customer-Token'], 'customer-token');
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.match(requests[1].url, /\/api\/customer\/inventory\?product=oauth_30d&quantity=4$/);
  assert.equal(requests[2].options.headers['Idempotency-Key'], 'finops-order-key');
  assert.deepEqual(JSON.parse(requests[2].options.body), { product: 'oauth_30d', quantity: 4 });
  assert.match(requests[3].url, /\/api\/customer\/pickup\/orders\/order-7$/);
});

test('OAuth Supply claim accepts same-origin relative URLs and rejects other origins', async () => {
  const requests = [];
  const client = new OAuthSupplyClient(
    config,
    console,
    async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ credential_version: 'v2', credentials: { access_token: 'new' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    Date.now,
    async () => [{ address: '93.184.216.34', family: 4 }],
  );

  await client.claimRecovery({
    baseUrl: 'https://sogouedu.cc',
    token: 'customer-token',
    claimUrl: '/api/customer/recoveries/3/claim?ticket=ticket-3',
  });
  assert.equal(requests[0].url, 'https://sogouedu.cc/api/customer/recoveries/3/claim?ticket=ticket-3');

  await assert.rejects(
    client.claimRecovery({
      baseUrl: 'https://sogouedu.cc',
      token: 'customer-token',
      claimUrl: 'https://evil.example/steal',
    }),
    /不属于已配置的站点/,
  );
});
