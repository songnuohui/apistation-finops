import { createClient } from 'redis';

const ACTIVE_USER_INDEX = 'concurrency:user:active_index';
const ACTIVE_ACCOUNT_INDEX = 'concurrency:account:active_index';

function nowSeconds() {
  return Math.floor(Date.now() / 1_000);
}

export class Sub2ApiRedisRuntimeReader {
  constructor(config, logger = console, clientFactory = createClient) {
    this.config = config;
    this.logger = logger;
    this.clientFactory = clientFactory;
    this.enabled = Boolean(config.sub2apiRedisUrl);
    this.client = null;
    this.connectPromise = null;
    this.lastErrorAt = 0;
  }

  logError(error) {
    const now = Date.now();
    if (now - this.lastErrorAt < 30_000) return;
    this.lastErrorAt = now;
    this.logger.warn('[sub2api-redis] read-only concurrency read failed', error?.code || error?.message || error);
  }

  async connect() {
    if (!this.enabled) return false;
    if (this.client?.isReady) return true;
    if (this.connectPromise) return this.connectPromise;
    const client = this.clientFactory({
      url: this.config.sub2apiRedisUrl,
      socket: {
        connectTimeout: this.config.sub2apiRedisConnectTimeoutMs || 1_500,
        reconnectStrategy: () => false,
      },
    });
    client.on?.('error', (error) => this.logError(error));
    this.connectPromise = client.connect()
      .then(() => {
        this.client = client;
        return true;
      })
      .catch((error) => {
        this.logError(error);
        try { client.disconnect?.(); } catch {}
        return false;
      })
      .finally(() => {
        this.connectPromise = null;
      });
    return this.connectPromise;
  }

  async listRuntimeConcurrency() {
    if (!(await this.connect()) || !this.client?.isReady) return [];
    const timestamp = nowSeconds();
    try {
      const [userValues, accountValues] = await Promise.all([
        this.client.zRangeByScore(ACTIVE_USER_INDEX, timestamp, '+inf'),
        this.client.zRangeByScore(ACTIVE_ACCOUNT_INDEX, timestamp, '+inf'),
      ]);
      const userIds = userValues
        .map((value) => Number(value))
        .filter((value) => Number.isSafeInteger(value) && value > 0)
        .slice(0, this.config.sub2apiRedisRuntimeUserLimit || 500);
      const accountIds = accountValues
        .map((value) => Number(value))
        .filter((value) => Number.isSafeInteger(value) && value > 0)
        .slice(0, this.config.sub2apiRedisRuntimeAccountLimit || 500);
      const users = await Promise.all(userIds.map(async (sourceUserId) => ({
        sourceUserId,
        currentConcurrency: Number(await this.client.zCount(`concurrency:user:${sourceUserId}`, timestamp, '+inf')) || 0,
        waitingCount: Math.max(0, Number(
          typeof this.client.get === 'function'
            ? await this.client.get(`concurrency:wait:${sourceUserId}`)
            : 0,
        ) || 0),
      })));
      const accounts = await Promise.all(accountIds.map(async (sourceAccountId) => ({
        sourceAccountId,
        currentConcurrency: Number(await this.client.zCount(`concurrency:account:${sourceAccountId}`, timestamp, '+inf')) || 0,
        waitingCount: Math.max(0, Number(
          typeof this.client.get === 'function'
            ? await this.client.get(`wait:account:${sourceAccountId}`)
            : 0,
        ) || 0),
      })));
      return {
        users: users.filter((row) => row.currentConcurrency > 0 || row.waitingCount > 0),
        accounts: accounts.filter((row) => row.currentConcurrency > 0 || row.waitingCount > 0),
      };
    } catch (error) {
      this.logError(error);
      return { users: [], accounts: [] };
    }
  }

  async listActiveUserConcurrency() {
    if (!(await this.connect()) || !this.client?.isReady) return [];
    const timestamp = nowSeconds();
    try {
      const values = await this.client.zRangeByScore(ACTIVE_USER_INDEX, timestamp, '+inf');
      const userIds = values
        .map((value) => Number(value))
        .filter((value) => Number.isSafeInteger(value) && value > 0)
        .slice(0, this.config.sub2apiRedisRuntimeUserLimit || 500);
      const rows = await Promise.all(userIds.map(async (sourceUserId) => ({
        sourceUserId,
        currentConcurrency: Number(await this.client.zCount(`concurrency:user:${sourceUserId}`, timestamp, '+inf')) || 0,
      })));
      return rows.filter((row) => row.currentConcurrency > 0);
    } catch (error) {
      this.logError(error);
      return [];
    }
  }

  async close() {
    if (!this.client) return;
    try {
      if (this.client.isOpen) await this.client.quit();
    } catch (error) {
      this.logError(error);
      try { this.client.disconnect?.(); } catch {}
    } finally {
      this.client = null;
    }
  }
}
