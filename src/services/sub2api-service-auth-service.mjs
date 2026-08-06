import { completeSub2ApiAdministratorTwoFactor, loginSub2ApiAdministrator } from './sub2api-auth-service.mjs';
import { SupplierCredentialVault, totpCode } from './supplier-credentials.mjs';

function authError(message, statusCode = 503) {
  return Object.assign(new Error(message), { statusCode });
}

function tokenExpiry(token) {
  try {
    const payload = String(token || '').split('.')[1];
    if (!payload) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const expiresAt = Number(parsed?.exp) * 1000;
    return Number.isFinite(expiresAt) && expiresAt > Date.now() ? new Date(expiresAt) : null;
  } catch {
    return null;
  }
}

function configured(settings) {
  return Boolean(settings?.credentialsCiphertext);
}

export class Sub2ApiServiceAuthService {
  constructor(repository, config, logger = console, {
    login = loginSub2ApiAdministrator,
    completeTwoFactor = completeSub2ApiAdministratorTwoFactor,
    now = () => Date.now(),
  } = {}) {
    this.repository = repository;
    this.config = config;
    this.logger = logger;
    this.login = login;
    this.completeTwoFactor = completeTwoFactor;
    this.now = now;
    this.vault = new SupplierCredentialVault(config.supplierCredentialsKey);
    this.settings = null;
    this.accessToken = '';
    this.tokenExpiresAt = null;
    this.nextRefreshAt = 0;
    this.refreshPromise = null;
    this.timer = null;
  }

  async loadSettings() {
    this.settings = await this.repository.getSub2ApiServiceAuthSettings({ includeCiphertext: true });
    return this.settings;
  }

  status() {
    const settings = this.settings || {};
    return {
      enabled: Boolean(settings.enabled),
      email: settings.email || '',
      credentialsConfigured: configured(settings),
      authenticated: Boolean(this.accessToken),
      lastAuthenticatedAt: settings.lastAuthenticatedAt || null,
      tokenExpiresAt: this.tokenExpiresAt?.toISOString() || settings.tokenExpiresAt || null,
      lastError: settings.lastError || '',
      updatedBy: settings.updatedBy || '',
      updatedAt: settings.updatedAt || null,
    };
  }

  start() {
    if (this.timer || this.config.demoMode) return;
    const tick = async () => {
      try {
        await this.getAccessToken();
      } catch (error) {
        this.logger.warn('[sub2api-service-auth] refresh failed', error?.message || error);
      }
    };
    void this.loadSettings().then(tick).catch((error) => {
      this.logger.warn('[sub2api-service-auth] settings load failed', error?.message || error);
    });
    this.timer = setInterval(tick, this.config.sub2apiServiceAuthRefreshSeconds * 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.accessToken = '';
    this.tokenExpiresAt = null;
    this.nextRefreshAt = 0;
  }

  async getAccessToken({ force = false } = {}) {
    if (this.config.demoMode) return '';
    if (!this.settings) await this.loadSettings();
    if (!this.settings?.enabled) return '';
    if (!configured(this.settings)) throw authError('Sub2API service account credentials are not configured');
    if (!force && this.accessToken && this.now() < this.nextRefreshAt) return this.accessToken;
    return this.refresh({ force });
  }

  async invalidateAccessToken(token = '') {
    if (token && this.accessToken && token !== this.accessToken) return;
    this.accessToken = '';
    this.tokenExpiresAt = null;
    this.nextRefreshAt = 0;
  }

  async refresh({ force = false } = {}) {
    if (!force && this.accessToken && this.now() < this.nextRefreshAt) return this.accessToken;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.authenticate().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async authenticate() {
    if (!this.settings) await this.loadSettings();
    const settings = this.settings;
    if (!settings?.enabled) return '';
    if (!configured(settings)) throw authError('Sub2API service account credentials are not configured');
    if (!this.vault.available) throw authError('service credential encryption is not configured');
    try {
      const credentials = this.vault.decrypt(settings.credentialsCiphertext);
      const email = String(credentials.email || settings.email || '').trim();
      const password = String(credentials.password || '');
      if (!email || !password) throw authError('Sub2API service account email and password are required', 400);
      let result = await this.login({ email, password }, this.config);
      if (result.requiresTwoFactor) {
        const secret = String(credentials.totpSecret || '').trim();
        if (!secret) throw authError('Sub2API service account requires a TOTP secret', 400);
        result = await this.completeTwoFactor({ tempToken: result.tempToken, totpCode: totpCode(secret) }, this.config);
      }
      this.accessToken = String(result.accessToken || '').trim();
      if (!this.accessToken) throw authError('Sub2API service account did not issue an access token');
      const now = this.now();
      this.tokenExpiresAt = tokenExpiry(this.accessToken)
        || new Date(now + this.config.sub2apiServiceAuthRefreshSeconds * 1000 * 2);
      const refreshAt = Math.min(
        this.tokenExpiresAt.getTime() - 60_000,
        now + this.config.sub2apiServiceAuthRefreshSeconds * 1000,
      );
      this.nextRefreshAt = Math.max(now + 30_000, refreshAt);
      await this.repository.recordSub2ApiServiceAuthResult({
        lastAuthenticatedAt: new Date(now).toISOString(),
        tokenExpiresAt: this.tokenExpiresAt.toISOString(),
        lastError: '',
      });
      this.settings = await this.repository.getSub2ApiServiceAuthSettings({ includeCiphertext: true });
      return this.accessToken;
    } catch (error) {
      await this.invalidateAccessToken();
      this.nextRefreshAt = this.now() + 30_000;
      const message = String(error?.message || error).slice(0, 1000);
      await this.repository.recordSub2ApiServiceAuthResult({ lastError: message });
      this.settings = await this.repository.getSub2ApiServiceAuthSettings({ includeCiphertext: true });
      throw error;
    }
  }

  async updateSettings(input, actor = 'admin') {
    const current = await this.repository.getSub2ApiServiceAuthSettings({ includeCiphertext: true });
    let existing = {};
    if (current.credentialsCiphertext) {
      if (!this.vault.available) throw authError('service credential encryption is not configured');
      existing = this.vault.decrypt(current.credentialsCiphertext);
    }
    const credentials = input.clearCredentials ? {} : {
      ...existing,
      email: String(input.email || existing.email || '').trim(),
      password: input.password || existing.password || '',
      totpSecret: input.totpSecret || existing.totpSecret || '',
    };
    const hasCredentials = Boolean(credentials.email && credentials.password);
    if (input.enabled && !hasCredentials) {
      throw authError('enabled Sub2API service authentication requires email and password', 400);
    }
    const ciphertext = input.clearCredentials
      ? ''
      : hasCredentials
        ? this.config.demoMode ? 'demo-encrypted' : this.vault.encrypt(credentials)
        : current.credentialsCiphertext || '';
    await this.repository.updateSub2ApiServiceAuthSettings({
      enabled: Boolean(input.enabled),
      email: credentials.email || '',
    }, ciphertext, actor);
    await this.invalidateAccessToken();
    await this.loadSettings();
    if (this.settings.enabled) await this.getAccessToken({ force: true });
    return this.status();
  }
}
