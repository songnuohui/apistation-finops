import { createHash } from 'node:crypto';

const MAX_QR_BYTES = 1_048_576;

function text(value) {
  return String(value || '').trim();
}

function apiUrl(baseUrl, pathname) {
  return `${baseUrl.replace(/\/+$/, '')}/api/${pathname.replace(/^\/+/, '')}`;
}

function oneBotUrl(endpoint, pathname) {
  const url = new URL(endpoint);
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}/${pathname.replace(/^\/+/, '')}`.replace(/^\/\//, '/');
  return url;
}

function apiError(message, statusCode = 502) {
  return Object.assign(new Error(message), { statusCode });
}

function responseData(payload) {
  return payload?.data && typeof payload.data === 'object' ? payload.data : payload || {};
}

export class NapcatService {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.credential = '';
    this.qrCache = null;
  }

  configured() {
    return Boolean(this.config.napcatWebuiUrl && this.config.napcatWebuiToken);
  }

  async authenticate() {
    if (!this.configured()) throw apiError('QQ 机器人服务尚未配置', 503);
    const hash = createHash('sha256')
      .update(`${this.config.napcatWebuiToken}.napcat`)
      .digest('hex');
    const result = await this.request('/auth/login', { hash }, {
      authenticated: false,
    });
    const data = responseData(result);
    const credential = text(data.Credential || data.credential);
    if (!credential) throw apiError('QQ 机器人管理服务认证失败');
    this.credential = credential;
    return credential;
  }

  async request(pathname, payload = {}, { authenticated = true, retry = true } = {}) {
    if (authenticated && !this.credential) await this.authenticate();
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (authenticated && this.credential) headers.Authorization = `Bearer ${this.credential}`;
    let response;
    try {
      response = await this.fetch(apiUrl(this.config.napcatWebuiUrl, pathname), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.config.napcatWebuiTimeoutMs),
      });
    } catch (error) {
      throw apiError(error?.name === 'TimeoutError' ? 'QQ 机器人管理服务响应超时' : 'QQ 机器人管理服务暂时不可用', 503);
    }
    let result = {};
    try {
      const raw = await response.text();
      if (raw.length > MAX_QR_BYTES) throw apiError('QQ 机器人管理服务返回内容过大');
      if (raw) result = JSON.parse(raw);
    } catch (error) {
      if (error.statusCode) throw error;
      throw apiError('QQ 机器人管理服务返回了无效数据');
    }
    if (response.status === 401 && authenticated && retry) {
      this.credential = '';
      await this.authenticate();
      return this.request(pathname, payload, { authenticated, retry: false });
    }
    if (!response.ok) {
      throw apiError(response.status >= 500 ? 'QQ 机器人管理服务暂时不可用' : 'QQ 机器人管理请求被拒绝', response.status >= 500 ? 503 : response.status);
    }
    if (result && result.code !== undefined && Number(result.code) !== 0) {
      throw apiError(text(result.message) || 'QQ 机器人管理请求失败', Number(result.code) === 401 ? 401 : 502);
    }
    return result;
  }

  async getQrSource() {
    const result = await this.request('/QQLogin/GetQQLoginQrcode');
    const data = responseData(result);
    return text(data.qrcode || data.qrcodeurl || data.url);
  }

  async refreshQrSource() {
    const result = await this.request('/QQLogin/RefreshQRcode');
    const data = responseData(result);
    return text(data.qrcode || data.qrcodeurl || data.url);
  }

  async qrImage(source) {
    if (!source) return '';
    if (this.qrCache?.source === source && this.qrCache.expiresAt > Date.now()) {
      return this.qrCache.value;
    }
    try {
      const parsed = new URL(source);
      if (!['http:', 'https:'].includes(parsed.protocol)) return '';
      const response = await this.fetch(parsed, {
        method: 'GET',
        headers: { Accept: 'image/*' },
        signal: AbortSignal.timeout(this.config.napcatWebuiTimeoutMs),
      });
      const contentType = text(response.headers.get('content-type')).split(';')[0].toLowerCase();
      const bytes = Buffer.from(await response.arrayBuffer());
      if (response.ok && contentType.startsWith('image/') && bytes.length <= MAX_QR_BYTES) {
        const value = `data:${contentType};base64,${bytes.toString('base64')}`;
        this.qrCache = { source, value, expiresAt: Date.now() + 60_000 };
        return value;
      }
    } catch {
      // The QR credential must not be sent to the browser as a remote URL.
    }
    return '';
  }

  async checkOnebot() {
    if (!this.config.onebotEndpoint) return false;
    const headers = { Accept: 'application/json' };
    if (this.config.onebotAccessToken) headers.Authorization = `Bearer ${this.config.onebotAccessToken}`;
    try {
      const response = await this.fetch(oneBotUrl(this.config.onebotEndpoint, '/get_status'), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.config.onebotRequestTimeoutMs),
      });
      if (!response.ok) return false;
      const result = await response.json();
      return result?.retcode === undefined || Number(result.retcode) === 0;
    } catch {
      return false;
    }
  }

  async status() {
    const base = {
      configured: this.configured(),
      available: false,
      loggedIn: false,
      qqNumber: '',
      nickname: '',
      qrcode: '',
      onebotConfigured: Boolean(this.config.onebotEndpoint),
      onebotReady: false,
      error: '',
    };
    if (!base.configured) {
      base.error = 'QQ 机器人服务尚未配置';
      return base;
    }
    try {
      const result = await this.request('/QQLogin/CheckLoginStatus');
      const data = responseData(result);
      base.available = true;
      base.loggedIn = Boolean(data.isLogin ?? data.is_login);
      let qrSource = text(data.qrcodeurl || data.qrcode || data.url);
      if (base.loggedIn) {
        try {
          const info = responseData(await this.request('/QQLogin/GetQQLoginInfo'));
          base.qqNumber = text(info.uin || info.qq || info.account || info.user_id);
          base.nickname = text(info.nick || info.nickname || info.name);
        } catch {
          base.error = 'QQ 已登录，但账号信息暂时读取失败';
        }
        base.onebotReady = await this.checkOnebot();
      } else {
        if (!qrSource) qrSource = await this.getQrSource();
        base.qrcode = await this.qrImage(qrSource);
      }
    } catch (error) {
      base.error = text(error?.message) || 'QQ 机器人管理服务暂时不可用';
    }
    return base;
  }

  async refresh() {
    this.qrCache = null;
    await this.refreshQrSource();
    return this.status();
  }

  async logout() {
    await this.request('/QQLogin/RestartNapCat');
    this.credential = '';
    this.qrCache = null;
    return { accepted: true };
  }
}
