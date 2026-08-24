import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { NapcatService } from '../src/services/napcat-service.mjs';

const config = {
  napcatWebuiUrl: 'http://napcat:6099',
  napcatWebuiToken: 'webui-secret',
  napcatWebuiTimeoutMs: 1_000,
  onebotEndpoint: 'http://napcat:3000',
  onebotAccessToken: 'onebot-secret',
  onebotRequestTimeoutMs: 1_000,
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('NapCat service returns a proxied QR image without exposing its source URL', async () => {
  const requests = [];
  const service = new NapcatService(config, {
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url) === 'http://napcat:6099/api/auth/login') {
        return json({ code: 0, data: { Credential: 'webui-credential' } });
      }
      if (String(url) === 'http://napcat:6099/api/QQLogin/CheckLoginStatus') {
        return json({
          code: 0,
          data: { isLogin: false, qrcodeurl: 'https://qq.example.test/qr-secret' },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });

  const status = await service.status();

  assert.equal(status.configured, true);
  assert.equal(status.available, true);
  assert.equal(status.loggedIn, false);
  assert.match(status.qrcode, /^data:image\/png;base64,/);
  assert.equal(status.qrcode.includes('qq.example.test'), false);
  assert.equal(requests.some((request) => request.url === 'https://qq.example.test/qr-secret'), false);
  assert.equal(
    JSON.parse(requests[0].options.body).hash,
    createHash('sha256').update('webui-secret.napcat').digest('hex'),
  );
  assert.equal(requests[1].options.headers.Authorization, 'Bearer webui-credential');
});

test('NapCat service reads the logged-in QQ information and verifies private OneBot access', async () => {
  const requests = [];
  const service = new NapcatService(config, {
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      switch (String(url)) {
        case 'http://napcat:6099/api/auth/login':
          return json({ code: 0, data: { Credential: 'webui-credential' } });
        case 'http://napcat:6099/api/QQLogin/CheckLoginStatus':
          return json({ code: 0, data: { isLogin: true } });
        case 'http://napcat:6099/api/QQLogin/GetQQLoginInfo':
          return json({ code: 0, data: { uin: '123456789', nick: '告警机器人' } });
        case 'http://napcat:3000/get_status':
          return json({ status: 'ok', retcode: 0 });
        default:
          throw new Error(`unexpected request: ${url}`);
      }
    },
  });

  const status = await service.status();

  assert.deepEqual(status, {
    configured: true,
    available: true,
    loggedIn: true,
    qqNumber: '123456789',
    nickname: '告警机器人',
    qrcode: '',
    onebotConfigured: true,
    onebotReady: true,
    error: '',
  });
  assert.equal(requests.at(-1).options.headers.Authorization, 'Bearer onebot-secret');
});

test('NapCat service refreshes QR codes and restarts NapCat for a new login', async () => {
  const requests = [];
  let restarted = false;
  const service = new NapcatService(config, {
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url) === 'http://napcat:6099/api/auth/login') {
        return json({ code: 0, data: { Credential: 'webui-credential' } });
      }
      if (String(url) === 'http://napcat:6099/api/QQLogin/RefreshQRcode') {
        return json({ code: 0, data: {} });
      }
      if (String(url) === 'http://napcat:6099/api/QQLogin/CheckLoginStatus') {
        return json({
          code: 0,
          data: {
            isLogin: false,
            qrcodeurl: restarted
              ? 'https://qq.example.test/fresh'
              : 'https://qq.example.test/expired',
          },
        });
      }
      if (String(url) === 'http://napcat:6099/api/QQLogin/GetQQLoginQrcode') {
        return json({ code: 0, data: { qrcode: 'https://qq.example.test/expired' } });
      }
      if (String(url) === 'http://napcat:6099/api/QQLogin/RestartNapCat') {
        restarted = true;
        return json({ code: 0, data: {} });
      }
      throw new Error(`unexpected request: ${url}`);
    },
    sleepImpl: async () => {},
  });

  const refreshed = await service.refresh();
  const loggedOut = await service.logout();

  assert.match(refreshed.qrcode, /^data:image\/png;base64,/);
  assert.deepEqual(loggedOut, { accepted: true });
  assert.equal(
    requests.some((request) => request.url.endsWith('/QQLogin/RestartNapCat')),
    true,
  );
});
