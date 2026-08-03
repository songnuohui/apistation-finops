import test from 'node:test';
import assert from 'node:assert/strict';
import { ResponseCacheService } from '../src/services/response-cache-service.mjs';
import { Sub2ApiRedisRuntimeReader } from '../src/services/sub2api-redis-runtime-reader.mjs';

function fakeRedisClient() {
  const values = new Map();
  return {
    isReady: false,
    isOpen: false,
    on() {},
    async connect() {
      this.isReady = true;
      this.isOpen = true;
    },
    async get(key) {
      return values.get(key) || null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async *scanIterator({ MATCH }) {
      const prefix = MATCH.replace('*', '');
      yield [...values.keys()].filter((key) => key.startsWith(prefix));
    },
    async unlink(...keys) {
      assert.ok(keys.every((key) => typeof key === 'string'));
      for (const key of keys) values.delete(key);
    },
    async quit() {
      this.isReady = false;
      this.isOpen = false;
    },
    values,
  };
}

test('response cache uses only its own prefix and invalidates cached reads', async () => {
  const client = fakeRedisClient();
  const cache = new ResponseCacheService({
    finopsRedisUrl: 'redis://:test@localhost:6379/15',
    finopsRedisKeyPrefix: 'finops:cache:',
  }, console, () => client);
  client.values.set('sub2api:unchanged', 'source-data');
  let loads = 0;

  assert.deepEqual(await cache.remember('overview', '7d', 5, async () => ({ value: ++loads })), { value: 1 });
  assert.deepEqual(await cache.remember('overview', '7d', 5, async () => ({ value: ++loads })), { value: 1 });
  assert.equal(loads, 1);
  await cache.invalidate();
  assert.equal(client.values.get('sub2api:unchanged'), 'source-data');
  assert.deepEqual(await cache.remember('overview', '7d', 5, async () => ({ value: ++loads })), { value: 2 });
  await cache.close();
});

test('Sub2API Redis reader counts only unexpired user concurrency members', async () => {
  const calls = [];
  const client = {
    isReady: false,
    isOpen: false,
    on() {},
    async connect() {
      this.isReady = true;
      this.isOpen = true;
    },
    async zRangeByScore(key, min, max) {
      calls.push({ command: 'ZRANGEBYSCORE', key, min, max });
      return ['3', '117', 'invalid'];
    },
    async zCount(key, min, max) {
      calls.push({ command: 'ZCOUNT', key, min, max });
      return key === 'concurrency:user:3' ? 2 : 0;
    },
    async quit() {
      this.isReady = false;
      this.isOpen = false;
    },
  };
  const reader = new Sub2ApiRedisRuntimeReader({
    sub2apiRedisUrl: 'redis://:test@localhost:6379/0',
    sub2apiRedisRuntimeUserLimit: 500,
  }, console, () => client);

  assert.deepEqual(await reader.listActiveUserConcurrency(), [{ sourceUserId: 3, currentConcurrency: 2 }]);
  assert.equal(calls[0].command, 'ZRANGEBYSCORE');
  assert.equal(calls[0].key, 'concurrency:user:active_index');
  assert.deepEqual(calls.slice(1).map((call) => call.command), ['ZCOUNT', 'ZCOUNT']);
  await reader.close();
});
