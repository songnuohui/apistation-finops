import { OAuthSupplyClient } from './oauth-supply-client.mjs';
import { SupplierCredentialVault } from './supplier-credentials.mjs';

function authError(message, statusCode = 503) {
  return Object.assign(new Error(message), { statusCode });
}

function configured(settings) {
  return Boolean(settings?.credentialsCiphertext);
}

export class OAuthSupplyAuthService {
  constructor(repository, config, logger = console, {
    client = new OAuthSupplyClient(config, logger),
    now = () => Date.now(),
  } = {}) {
    this.repository = repository;
    this.config = config;
    this.logger = logger;
    this.client = client;
    this.now = now;
    this.vault = new SupplierCredentialVault(config.supplierCredentialsKey);
    this.settings = null;
    this.accessToken = '';
    this.tokenExpiresAt = null;
    this.refreshPromise = null;
  }

  async loadSettings() {
    this.settings = await this.repository.getOAuthSupplyAuthSettings({ includeCiphertext: true });
    return this.settings;
  }

  status() {
    const settings = this.settings || {};
    const tokenExpiresAt = this.tokenExpiresAt?.toISOString() || settings.tokenExpiresAt || null;
    const tokenActive = Boolean(
      (this.accessToken || settings.tokenCiphertext)
      && (!tokenExpiresAt || new Date(tokenExpiresAt).getTime() > this.now()),
    );
    return {
      enabled: Boolean(settings.enabled),
      baseUrl: settings.baseUrl || 'https://sogouedu.cc',
      username: settings.username || '',
      credentialsConfigured: configured(settings),
      tokenConfigured: Boolean(settings.tokenConfigured || settings.tokenCiphertext || this.accessToken),
      authenticated: tokenActive,
      lastAuthenticatedAt: settings.lastAuthenticatedAt || null,
      tokenExpiresAt,
      lastError: settings.lastError || '',
      updatedBy: settings.updatedBy || '',
      updatedAt: settings.updatedAt || null,
    };
  }

  async getAccessToken({ force = false } = {}) {
    if (this.config.demoMode) return 'demo-oauth-supply-token';
    if (!this.settings) await this.loadSettings();
    if (!this.settings?.enabled) return '';
    if (!configured(this.settings)) throw authError('OAuth Supply 账号密码尚未配置', 400);
    const expiresAtMs = this.tokenExpiresAt?.getTime() || new Date(this.settings.tokenExpiresAt || 0).getTime();
    if (!force && this.accessToken && (!expiresAtMs || this.now() < expiresAtMs - 60_000)) return this.accessToken;
    if (!force && this.settings.tokenCiphertext && (!expiresAtMs || this.now() < expiresAtMs - 60_000)) {
      this.accessToken = this.vault.decrypt(this.settings.tokenCiphertext).token || '';
      this.tokenExpiresAt = expiresAtMs ? new Date(expiresAtMs) : null;
      if (this.accessToken) return this.accessToken;
    }
    return this.authenticate();
  }

  async authenticate() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.#authenticate().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async #authenticate() {
    if (!this.settings) await this.loadSettings();
    const settings = this.settings;
    if (!settings?.enabled) return '';
    if (!configured(settings)) throw authError('OAuth Supply 账号密码尚未配置', 400);
    if (!this.vault.available && !this.config.demoMode) throw authError('服务端未配置 SUPPLIER_CREDENTIALS_KEY');
    try {
      const credentials = this.config.demoMode
        ? { username: settings.username || 'demo', password: 'demo' }
        : this.vault.decrypt(settings.credentialsCiphertext);
      const result = this.config.demoMode
        ? { token: 'demo-oauth-supply-token', expiresAt: new Date(this.now() + 30 * 24 * 60 * 60 * 1000) }
        : await this.client.login({
          baseUrl: settings.baseUrl,
          username: credentials.username || settings.username,
          password: credentials.password,
        });
      this.accessToken = String(result.token || '').trim();
      if (!this.accessToken) throw authError('OAuth Supply 登录没有返回 Token');
      this.tokenExpiresAt = result.expiresAt || null;
      const tokenCiphertext = this.config.demoMode ? 'demo-token' : this.vault.encrypt({ token: this.accessToken });
      await this.repository.recordOAuthSupplyAuthResult({
        tokenCiphertext,
        lastAuthenticatedAt: new Date(this.now()).toISOString(),
        tokenExpiresAt: this.tokenExpiresAt?.toISOString() || null,
        lastError: '',
      });
      await this.loadSettings();
      return this.accessToken;
    } catch (error) {
      this.accessToken = '';
      this.tokenExpiresAt = null;
      const message = String(error?.message || error).slice(0, 1000);
      await this.repository.recordOAuthSupplyAuthResult({
        tokenCiphertext: '',
        lastAuthenticatedAt: null,
        tokenExpiresAt: null,
        lastError: message,
      });
      await this.loadSettings();
      throw error;
    }
  }

  async updateSettings(input, actor = 'admin') {
    const current = await this.repository.getOAuthSupplyAuthSettings({ includeCiphertext: true });
    let existing = {};
    if (current.credentialsCiphertext && !input.clearCredentials) {
      if (!this.vault.available && !this.config.demoMode) throw authError('服务端未配置 SUPPLIER_CREDENTIALS_KEY');
      existing = this.config.demoMode ? {} : this.vault.decrypt(current.credentialsCiphertext);
    }
    const credentials = {
      username: String(input.username || existing.username || '').trim(),
      password: input.password || existing.password || '',
    };
    if (input.enabled && (!credentials.username || !credentials.password)) {
      throw authError('启用 OAuth Supply 前需要填写账号和密码', 400);
    }
    const hasCredentials = Boolean(credentials.username && credentials.password);
    const ciphertext = input.clearCredentials
      ? ''
      : hasCredentials
        ? this.config.demoMode ? 'demo-encrypted' : this.vault.encrypt(credentials)
        : current.credentialsCiphertext || '';
    await this.repository.updateOAuthSupplyAuthSettings({
      enabled: Boolean(input.enabled),
      baseUrl: input.baseUrl,
      username: credentials.username,
    }, ciphertext, actor);
    this.accessToken = '';
    this.tokenExpiresAt = null;
    await this.loadSettings();
    if (this.settings.enabled) await this.getAccessToken({ force: true });
    return this.status();
  }

  async test() {
    await this.getAccessToken({ force: true });
    return this.status();
  }
}
