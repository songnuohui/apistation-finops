import { SupplierAdapterRegistry } from './supplier-adapters.mjs';
import { SupplierCredentialVault } from './supplier-credentials.mjs';

function publicError(error) {
  return {
    code: error?.code || 'sync_failed',
    httpStatus: Number(error?.httpStatus || 0),
    message: String(error?.message || '供应商同步失败').slice(0, 1000),
  };
}

async function mapConcurrent(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export class SupplierMonitorService {
  constructor(repository, config) {
    this.repository = repository;
    this.config = config;
    this.vault = new SupplierCredentialVault(config.supplierCredentialsKey);
    this.adapters = new SupplierAdapterRegistry(config);
    this.running = new Map();
    this.timer = null;
    this.cycleRunning = false;
  }

  status() {
    return { available: this.vault.available, running: this.running.size };
  }

  encryptCredentials(credentials) {
    return this.vault.encrypt(credentials);
  }

  decryptCredentials(ciphertext) {
    return this.vault.decrypt(ciphertext);
  }

  start() {
    if (this.timer || !this.vault.available) return;
    this.timer = setInterval(() => this.runDue().catch((error) => {
      console.warn('[supplier-monitor] cycle failed', error?.message || error);
    }), this.config.supplierMonitorIntervalSeconds * 1000);
    this.timer.unref?.();
    setTimeout(() => this.runDue().catch((error) => {
      console.warn('[supplier-monitor] initial cycle failed', error?.message || error);
    }), 5_000).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runDue() {
    if (this.cycleRunning || !this.vault.available) return;
    this.cycleRunning = true;
    try {
      const connections = await this.repository.listDueSupplierConnections(5);
      await mapConcurrent(connections, 2, (connection) => this.syncConnection(connection.id, { connection }));
    } finally {
      this.cycleRunning = false;
    }
  }

  async syncConnection(connectionId, { connection = null, throwOnError = false } = {}) {
    const id = Number(connectionId);
    if (this.running.has(id)) return this.running.get(id);
    const task = this.#sync(id, connection, throwOnError).finally(() => this.running.delete(id));
    this.running.set(id, task);
    return task;
  }

  async #sync(connectionId, loadedConnection, throwOnError) {
    const connection = loadedConnection || await this.repository.getSupplierConnection(connectionId, { includeCiphertext: true });
    if (!connection.enabled) return { ok: false, status: 'disabled' };
    try {
      const credentials = this.decryptCredentials(connection.credentialsCiphertext);
      const snapshot = await this.adapters.snapshot(connection, credentials);
      for (const key of snapshot.keys) key.keyFingerprint = this.vault.fingerprint(key.rawKey || `${connection.id}:${key.externalId}`);
      const candidates = connection.activeCheckEnabled
        ? snapshot.keys.filter((key) => key.status === 'active').slice(0, connection.activeCheckLimit)
        : [];
      const checkResults = await mapConcurrent(candidates, 4, async (key) => {
        try {
          const check = await this.adapters.check(connection, credentials, snapshot, key);
          return { ...check, externalId: key.externalId };
        } catch (error) {
          const failure = publicError(error);
          return { externalId:key.externalId,status:'failed',method:'metadata',httpStatus:failure.httpStatus,errorCode:failure.code,errorMessage:failure.message };
        }
      });
      // The repository only needs sanitized inventory data. Do not pass portal
      // credentials or raw API keys across that ownership boundary.
      const sanitizedSnapshot = {
        ...snapshot,
        keys: snapshot.keys.map(({ rawKey, ...key }) => key),
      };
      delete sanitizedSnapshot.accessToken;
      await this.repository.recordSupplierSyncSuccess(connectionId, sanitizedSnapshot, checkResults);
      for (const key of snapshot.keys) key.rawKey = '';
      if ('accessToken' in snapshot) snapshot.accessToken = '';
      return { ok: true, adapterType: snapshot.adapterType, keyCount: snapshot.keys.length, checked: checkResults.length };
    } catch (error) {
      const failure = publicError(error);
      await this.repository.recordSupplierSyncFailure(connectionId, failure);
      if (throwOnError) throw Object.assign(new Error(failure.message), { statusCode: error?.statusCode || 502, code: failure.code });
      return { ok: false, error: failure.code };
    }
  }
}
