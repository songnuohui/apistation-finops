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
    this.profitGuardService = null;
    this.costRefreshHandler = null;
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
      const [scheduledConnections, dueTargets] = await Promise.all([
        this.repository.listDueSupplierConnections(5),
        this.repository.listDueSupplierQualityTargets?.(20) || [],
      ]);
      const connectionById = new Map(scheduledConnections.map((connection) => [Number(connection.id), connection]));
      for (const target of dueTargets) {
        if (target.connection) connectionById.set(Number(target.connectionId), target.connection);
      }
      const connections = [...connectionById.values()];
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

  setProfitGuardService(service) {
    this.profitGuardService = service || null;
  }

  setCostRefreshHandler(handler) {
    this.costRefreshHandler = typeof handler === 'function' ? handler : null;
  }

  async listSupplierKeyModels(keyId) {
    const context = await this.repository.getSupplierKeyContext(keyId, { includeCiphertext: true });
    const credentials = this.decryptCredentials(context.connection.credentialsCiphertext);
    const snapshot = await this.adapters.snapshot(context.connection, credentials);
    try {
      const key = snapshot.keys.find((item) => String(item.externalId) === String(context.externalKeyId));
      if (!key) throw Object.assign(new Error('selected supplier key is no longer available upstream'), { statusCode: 404 });
      return {
        keyId: Number(keyId),
        models: await this.adapters.listProbeModels(context.connection, snapshot, key),
      };
    } finally {
      for (const key of snapshot.keys || []) key.rawKey = '';
      snapshot.accessToken = '';
      snapshot.sessionCookie = '';
      snapshot.userId = '';
    }
  }

  async probeSupplierQualityTarget(targetId, { throwOnError = false } = {}) {
    const target = await this.repository.getSupplierQualityTargetContext(targetId, { includeCiphertext: true });
    if (!target.connection?.enabled) {
      throw Object.assign(new Error('supplier connection is disabled'), { statusCode: 409 });
    }
    if (target.connection.qualityMonitorMode === 'off') {
      throw Object.assign(new Error('quality monitoring is disabled for this supplier connection'), { statusCode: 409 });
    }
    const credentials = this.decryptCredentials(target.connection.credentialsCiphertext);
    const snapshot = await this.adapters.snapshot(target.connection, credentials);
    const key = snapshot.keys.find((item) => String(item.externalId) === String(target.externalKeyId));
    if (!key) throw Object.assign(new Error('selected supplier key is no longer available upstream'), { statusCode: 404 });
    try {
      const observation = await this.adapters.activeQualityProbe(target.connection, snapshot, key, target);
      const saved = await this.repository.recordSupplierQualityTargetResult(targetId, observation);
      return { ok: observation.status === 'ok', observation, target: saved };
    } catch (error) {
      const failure = publicError(error);
      const observation = {
        sourceKind: 'active_probe',
        model: target.model,
        groupName: target.groupName,
        status: 'failed',
        availabilitySample: true,
        httpStatus: failure.httpStatus,
        ttftMs: null,
        durationMs: null,
        rateMultiplier: target.rateMultiplier,
        errorCode: failure.code,
        errorMessage: failure.message,
        observedAt: new Date().toISOString(),
        metadata: {},
      };
      await this.repository.recordSupplierQualityTargetResult(targetId, observation);
      if (throwOnError) throw Object.assign(new Error(failure.message), { statusCode: error?.statusCode || 502, code: failure.code });
      return { ok: false, observation };
    } finally {
      for (const keyItem of snapshot.keys || []) keyItem.rawKey = '';
      snapshot.accessToken = '';
      snapshot.sessionCookie = '';
      snapshot.userId = '';
    }
  }

  async #sync(connectionId, loadedConnection, throwOnError) {
    const connection = loadedConnection || await this.repository.getSupplierConnection(connectionId, { includeCiphertext: true });
    if (!connection.enabled) return { ok: false, status: 'disabled' };
    try {
      const credentials = this.decryptCredentials(connection.credentialsCiphertext);
      const snapshot = await this.adapters.snapshot(connection, credentials);
      // Portal access tokens are short lived. Keep the latest token encrypted
      // in the FinOps connection so the next cycle can reuse it. Passwords
      // remain the recovery path after expiry or a 401/403 response.
      if (connection.authMode === 'password'
        && (snapshot.accessToken || snapshot.sessionCookie)
        && this.repository.updateSupplierConnectionAccessToken) {
        const nextCredentials = {
          ...credentials,
          accessToken: snapshot.accessToken || '',
          sessionCookie: snapshot.sessionCookie || '',
          userId: snapshot.userId || '',
          accessTokenExpiresAt: snapshot.accessTokenExpiresAt || null,
        };
        await this.repository.updateSupplierConnectionAccessToken(
          connectionId,
          this.encryptCredentials(nextCredentials),
        );
      }
      for (const key of snapshot.keys) key.keyFingerprint = this.vault.fingerprint(key.rawKey || `${connection.id}:${key.externalId}`);
      const linkedExternalIds = new Set(
        await this.repository.listLinkedSupplierKeyExternalIds?.(connection.id) || [],
      );
      const activeKeys = snapshot.keys.filter((key) => key.status === 'active');
      const linkedKeys = activeKeys.filter((key) => linkedExternalIds.has(String(key.externalId)));
      const optionalKeys = connection.activeCheckEnabled
        ? activeKeys
          .filter((key) => !linkedExternalIds.has(String(key.externalId)))
          .slice(0, Math.max(0, connection.activeCheckLimit - linkedKeys.length))
        : [];
      const candidates = [...linkedKeys, ...optionalKeys];
      const checkResults = await mapConcurrent(candidates, 4, async (key) => {
        try {
          const check = await this.adapters.check(connection, credentials, snapshot, key);
          return { ...check, externalId: key.externalId };
        } catch (error) {
          const failure = publicError(error);
          return { externalId:key.externalId,status:'failed',method:'metadata',httpStatus:failure.httpStatus,errorCode:failure.code,errorMessage:failure.message };
        }
      });
      let passiveObservations = [];
      if (['passive', 'hybrid'].includes(connection.qualityMonitorMode || 'passive')
        && this.adapters.collectPassiveQuality) {
        try {
          passiveObservations = await this.adapters.collectPassiveQuality(connection, snapshot);
        } catch (error) {
          console.warn(`[supplier-monitor] passive quality collection failed for ${connectionId}:`, error?.message || error);
        }
      }
      const activeResults = [];
      if (['active', 'hybrid'].includes(connection.qualityMonitorMode || 'passive')
        && this.repository.listDueSupplierQualityTargets) {
        const dueTargets = (await this.repository.listDueSupplierQualityTargets(50))
          .filter((target) => Number(target.connectionId) === Number(connectionId));
        await mapConcurrent(dueTargets, 2, async (target) => {
          const key = snapshot.keys.find((item) => String(item.externalId) === String(target.externalKeyId));
          if (!key) {
            activeResults.push({
              targetId: target.id,
              observation: {
                sourceKind: 'active_probe', model: target.model, groupName: target.groupName,
                status: 'failed', availabilitySample: true, httpStatus: 0, ttftMs: null,
                durationMs: null, rateMultiplier: target.rateMultiplier,
                errorCode: 'key_not_found', errorMessage: 'selected supplier key is not present in the latest inventory',
                observedAt: new Date().toISOString(), metadata: {},
              },
            });
            return;
          }
          try {
            activeResults.push({
              targetId: target.id,
              observation: await this.adapters.activeQualityProbe(connection, snapshot, key, target),
            });
          } catch (error) {
            const failure = publicError(error);
            activeResults.push({
              targetId: target.id,
              observation: {
                sourceKind: 'active_probe', model: target.model, groupName: target.groupName,
                status: 'failed', availabilitySample: true, httpStatus: failure.httpStatus,
                ttftMs: null, durationMs: null, rateMultiplier: target.rateMultiplier,
                errorCode: failure.code, errorMessage: failure.message,
                observedAt: new Date().toISOString(), metadata: {},
              },
            });
          }
        });
      }
      // The repository only needs sanitized inventory data. Do not pass portal
      // credentials or raw API keys across that ownership boundary.
      const sanitizedSnapshot = {
        ...snapshot,
        keys: snapshot.keys.map(({ rawKey, ...key }) => key),
      };
      delete sanitizedSnapshot.accessToken;
      delete sanitizedSnapshot.sessionCookie;
      delete sanitizedSnapshot.userId;
      await this.repository.recordSupplierSyncSuccess(connectionId, sanitizedSnapshot, checkResults);
      if (this.costRefreshHandler) {
        try {
          await this.costRefreshHandler({ connectionId });
        } catch (error) {
          console.warn(`[supplier-monitor] linked cost refresh failed for ${connectionId}:`, error?.message || error);
        }
      }
      if (this.profitGuardService) {
        try {
          await this.profitGuardService.evaluateSupplierConnection(connectionId);
        } catch (error) {
          // Profit protection must never turn a successful inventory sync into
          // a supplier-sync failure. The policy records its own error state.
          console.warn(`[supplier-monitor] profit guard failed for ${connectionId}:`, error?.message || error);
        }
      }
      if (passiveObservations.length && this.repository.recordSupplierQualityObservations) {
        try {
          await this.repository.recordSupplierQualityObservations(connectionId, passiveObservations);
        } catch (error) {
          console.warn(`[supplier-monitor] passive quality persistence failed for ${connectionId}:`, error?.message || error);
        }
      }
      for (const result of activeResults) {
        try {
          await this.repository.recordSupplierQualityTargetResult(result.targetId, result.observation);
        } catch (error) {
          console.warn(`[supplier-monitor] active quality persistence failed for target ${result.targetId}:`, error?.message || error);
        }
      }
      for (const key of snapshot.keys) key.rawKey = '';
      if ('accessToken' in snapshot) snapshot.accessToken = '';
      if ('sessionCookie' in snapshot) snapshot.sessionCookie = '';
      if ('userId' in snapshot) snapshot.userId = '';
      return { ok: true, adapterType: snapshot.adapterType, keyCount: snapshot.keys.length, checked: checkResults.length };
    } catch (error) {
      const failure = publicError(error);
      await this.repository.recordSupplierSyncFailure(connectionId, failure);
      if (throwOnError) throw Object.assign(new Error(failure.message), { statusCode: error?.statusCode || 502, code: failure.code });
      return { ok: false, error: failure.code };
    }
  }
}
