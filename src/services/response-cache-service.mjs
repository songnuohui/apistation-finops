import crypto from 'node:crypto';
import { createClient } from 'redis';

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export class ResponseCacheService {
  constructor(config, logger = console, clientFactory = createClient) {
    this.config = config;
    this.logger = logger;
    this.clientFactory = clientFactory;
    this.enabled = Boolean(config.finopsRedisUrl);
    this.prefix = config.finopsRedisKeyPrefix || 'finops:cache:';
    this.client = null;
    this.connectPromise = null;
    this.inflight = new Map();
    this.generation = 0;
    this.lastErrorAt = 0;
  }

  logRedisError(error) {
    const now = Date.now();
    if (now - this.lastErrorAt < 30_000) return;
    this.lastErrorAt = now;
    this.logger.warn('[redis-cache] unavailable; continuing with PostgreSQL', error?.code || error?.message || error);
  }

  async connect() {
    if (!this.enabled) return false;
    if (this.client?.isReady) return true;
    if (this.connectPromise) return this.connectPromise;
    const client = this.clientFactory({
      url: this.config.finopsRedisUrl,
      socket: {
        connectTimeout: this.config.finopsRedisConnectTimeoutMs || 1_500,
        reconnectStrategy: () => false,
      },
    });
    client.on?.('error', (error) => this.logRedisError(error));
    this.connectPromise = client.connect()
      .then(() => {
        this.client = client;
        return true;
      })
      .catch((error) => {
        this.logRedisError(error);
        try { client.disconnect?.(); } catch {}
        return false;
      })
      .finally(() => {
        this.connectPromise = null;
      });
    return this.connectPromise;
  }

  cacheKey(scope, key) {
    return `${this.prefix}response:${scope}:${digest(key)}`;
  }

  async remember(scope, key, ttlSeconds, loader) {
    const ttl = positiveInteger(ttlSeconds, 5);
    const cacheKey = this.cacheKey(scope, key);
    const generation = this.generation;
    const existing = this.inflight.get(cacheKey);
    if (existing) return existing;

    const operation = (async () => {
      const connected = await this.connect();
      if (generation === this.generation && connected && this.client?.isReady) {
        try {
          const cached = await this.client.get(cacheKey);
          if (cached !== null) return JSON.parse(cached);
        } catch (error) {
          this.logRedisError(error);
        }
      }

      const value = await loader();
      if (generation === this.generation && connected && this.client?.isReady) {
        try {
          await this.client.set(cacheKey, JSON.stringify(value), {
            expiration: { type: 'EX', value: ttl },
          });
        } catch (error) {
          this.logRedisError(error);
        }
      }
      return value;
    })();
    this.inflight.set(cacheKey, operation);
    try {
      return await operation;
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  async invalidate() {
    this.inflight.clear();
    this.generation += 1;
    if (!this.enabled || !(await this.connect()) || !this.client?.isReady) return;
    try {
      const keys = [];
      for await (const batch of this.client.scanIterator({
        MATCH: `${this.prefix}response:*`,
        COUNT: 100,
      })) {
        keys.push(...batch);
        if (keys.length >= 100) await this.client.unlink(...keys.splice(0, keys.length));
      }
      if (keys.length) await this.client.unlink(...keys);
    } catch (error) {
      this.logRedisError(error);
    }
  }

  async close() {
    if (!this.client) return;
    try {
      if (this.client.isOpen) await this.client.quit();
    } catch (error) {
      this.logRedisError(error);
      try { this.client.disconnect?.(); } catch {}
    } finally {
      this.client = null;
    }
  }

  status() {
    return {
      configured: this.enabled,
      connected: Boolean(this.client?.isReady),
      keyPrefix: this.prefix,
    };
  }
}
