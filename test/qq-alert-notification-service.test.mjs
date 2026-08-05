import test from 'node:test';
import assert from 'node:assert/strict';
import { QqAlertNotificationService } from '../src/services/qq-alert-notification-service.mjs';

const config = {
  supplierCredentialsKey: '5c'.repeat(32),
  qqAlertDeliveryIntervalSeconds: 60,
  qqAlertRequestTimeoutMs: 1_000,
  qqAlertMaxResponseBytes: 65_536,
};

test('QQ alert service sends a deduplicated OneBot private message with encrypted authentication', async () => {
  const deliveries = [];
  const repository = {
    settings: null,
    async getAlertNotificationSettings() { return this.settings; },
    async listPendingSupplierAlertDeliveries(limit) {
      assert.equal(limit, 20);
      return [{
        id: 9,
        severity: 'critical',
        title: '供应商连接同步失败',
        message: '上游返回 503',
        lastSeenAt: '2026-08-05T08:00:00.000Z',
        connectionName: '主连接',
        supplierName: '供应商 A',
        payloadHash: 'payload-1',
      }];
    },
    async recordSupplierAlertDelivery(...args) { deliveries.push(args); },
  };
  const requests = [];
  const service = new QqAlertNotificationService(repository, config, {
    fetchImpl: async (url, options) => {
      requests.push({ url:String(url),options });
      return new Response(JSON.stringify({ status:'ok',retcode:0 }), {
        status:200,
        headers:{ 'Content-Type':'application/json' },
      });
    },
  });
  repository.settings = {
    enabled:true,
    qqNumber:'123456789',
    onebotEndpoint:'http://127.0.0.1:3000',
    accessTokenCiphertext:service.encryptAccessToken('onebot-secret'),
  };

  await service.runDue();

  assert.equal(requests[0].url, 'http://127.0.0.1:3000/send_private_msg');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer onebot-secret');
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.user_id, 123456789);
  assert.match(payload.message, /供应商 A \/ 主连接/);
  assert.match(payload.message, /上游返回 503/);
  assert.deepEqual(deliveries, [[9, 'payload-1', { delivered:true }]]);
});

test('QQ alert delivery failures are recorded without failing the monitoring cycle', async () => {
  const deliveries = [];
  const repository = {
    async getAlertNotificationSettings() {
      return {
        enabled:true,
        qqNumber:'123456789',
        onebotEndpoint:'http://127.0.0.1:3000/send_private_msg',
        accessTokenCiphertext:'',
      };
    },
    async listPendingSupplierAlertDeliveries() {
      return [{
        id:10,severity:'warning',title:'余额不足',message:'余额低于阈值',
        lastSeenAt:'2026-08-05T08:00:00.000Z',connectionName:'备用',supplierName:'供应商 B',
        payloadHash:'payload-2',
      }];
    },
    async recordSupplierAlertDelivery(...args) { deliveries.push(args); },
  };
  const service = new QqAlertNotificationService(repository, config, {
    fetchImpl: async () => new Response(JSON.stringify({
      status:'failed',retcode:1404,message:'recipient unavailable',
    }), { status:200 }),
  });

  await service.runDue();

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0][0], 10);
  assert.equal(deliveries[0][1], 'payload-2');
  assert.equal(deliveries[0][2].delivered, false);
  assert.match(deliveries[0][2].error, /recipient unavailable/);
});
