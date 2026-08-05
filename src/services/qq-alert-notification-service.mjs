import { SupplierCredentialVault } from './supplier-credentials.mjs';

function oneBotUrl(endpoint) {
  const url = new URL(endpoint);
  const normalizedPath = url.pathname.replace(/\/+$/, '');
  url.pathname = normalizedPath.endsWith('/send_private_msg')
    ? normalizedPath
    : `${normalizedPath}/send_private_msg`.replace(/^\/\//, '/');
  return url;
}

async function limitedText(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('OneBot response is too large');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function alertMessage(alert) {
  const severity = {
    critical: '严重',
    warning: '警告',
    info: '提示',
  }[alert.severity] || '告警';
  const connection = [alert.supplierName, alert.connectionName].filter(Boolean).join(' / ');
  return [
    `[ApiStation FinOps][${severity}]`,
    connection || '供应商连接',
    alert.title,
    alert.message,
    `时间：${new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(alert.lastSeenAt || Date.now()))}`,
  ].filter(Boolean).join('\n');
}

export class QqAlertNotificationService {
  constructor(repository, config, { fetchImpl = globalThis.fetch } = {}) {
    this.repository = repository;
    this.config = config;
    this.fetch = fetchImpl;
    this.vault = new SupplierCredentialVault(config.supplierCredentialsKey);
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer || !this.repository.listPendingSupplierAlertDeliveries) return;
    this.timer = setInterval(() => this.runDue().catch((error) => {
      console.warn('[qq-alert] delivery cycle failed', error?.message || error);
    }), this.config.qqAlertDeliveryIntervalSeconds * 1000);
    this.timer.unref?.();
    setTimeout(() => this.runDue().catch((error) => {
      console.warn('[qq-alert] initial delivery cycle failed', error?.message || error);
    }), 7_000).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  encryptAccessToken(accessToken) {
    if (!accessToken) return '';
    return this.vault.encrypt({ accessToken });
  }

  decryptAccessToken(ciphertext) {
    if (!ciphertext) return '';
    return String(this.vault.decrypt(ciphertext).accessToken || '');
  }

  async send(settings, message) {
    const accessToken = this.decryptAccessToken(settings.accessTokenCiphertext);
    const headers = { 'Content-Type': 'application/json' };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const response = await this.fetch(oneBotUrl(settings.onebotEndpoint), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        user_id: Number(settings.qqNumber),
        message,
      }),
      signal: AbortSignal.timeout(this.config.qqAlertRequestTimeoutMs),
    });
    const raw = await limitedText(response, this.config.qqAlertMaxResponseBytes);
    let result = {};
    if (raw) {
      try { result = JSON.parse(raw); }
      catch { throw new Error(`OneBot returned invalid JSON (HTTP ${response.status})`); }
    }
    if (!response.ok || (result.retcode !== undefined && Number(result.retcode) !== 0) || result.status === 'failed') {
      const detail = result.message || result.wording || raw || `HTTP ${response.status}`;
      throw new Error(`OneBot send failed: ${String(detail).slice(0, 500)}`);
    }
    return { ok: true };
  }

  async test() {
    const settings = await this.repository.getAlertNotificationSettings({ includeCiphertext: true });
    if (!settings.qqNumber || !settings.onebotEndpoint) {
      throw Object.assign(new Error('请先配置接收 QQ 号和 OneBot HTTP 地址'), { statusCode: 400 });
    }
    await this.send(settings, `[ApiStation FinOps]\nQQ 告警通道测试成功\n时间：${new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      dateStyle: 'medium',
      timeStyle: 'medium',
      hour12: false,
    }).format(new Date())}`);
    return { ok: true };
  }

  async runDue() {
    if (this.running) return;
    this.running = true;
    try {
      const settings = await this.repository.getAlertNotificationSettings({ includeCiphertext: true });
      if (!settings.enabled || !settings.qqNumber || !settings.onebotEndpoint) return;
      const alerts = await this.repository.listPendingSupplierAlertDeliveries(20);
      for (const alert of alerts) {
        try {
          await this.send(settings, alertMessage(alert));
          await this.repository.recordSupplierAlertDelivery(alert.id, alert.payloadHash, { delivered: true });
        } catch (error) {
          await this.repository.recordSupplierAlertDelivery(alert.id, alert.payloadHash, {
            delivered: false,
            error: String(error?.message || error).slice(0, 1000),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
