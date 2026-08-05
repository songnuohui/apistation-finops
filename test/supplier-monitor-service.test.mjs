import test from 'node:test';
import assert from 'node:assert/strict';
import { SupplierMonitorService } from '../src/services/supplier-monitor-service.mjs';

const config = {
  supplierCredentialsKey: '5c'.repeat(32),
  supplierMonitorIntervalSeconds: 60,
  supplierRequestTimeoutMs: 1_000,
  supplierMaxResponseBytes: 1024 * 1024,
};

function connection(id = 1, overrides = {}) {
  return {
    id,
    adapterType: 'sub2api',
    authMode: 'access_token',
    baseUrl: 'https://supplier.example.test',
    enabled: true,
    activeCheckEnabled: true,
    activeCheckLimit: 2,
    ...overrides,
  };
}

function snapshot() {
  return {
    adapterType: 'sub2api',
    accessToken: 'portal-access-token',
    identity: 'ad***@example.test',
    balance: 10,
    balanceCurrency: 'USD',
    keys: [
      { externalId: 'one', status: 'active', rawKey: 'sk-one', name: 'first', sourceData: {} },
      { externalId: 'two', status: 'active', rawKey: 'sk-two', name: 'second', sourceData: {} },
      { externalId: 'three', status: 'disabled', rawKey: 'sk-three', name: 'third', sourceData: {} },
    ],
  };
}

test('supplier monitor limits active checks and passes only sanitized inventory to storage', async () => {
  const successes = [];
  const repository = {
    recordSupplierSyncSuccess: async (...args) => successes.push(args),
    recordSupplierSyncFailure: async () => assert.fail('unexpected sync failure'),
  };
  const service = new SupplierMonitorService(repository, config);
  const inventory = snapshot();
  const checks = [];
  service.adapters = {
    snapshot: async () => inventory,
    check: async (_connection, _credentials, _snapshot, key) => {
      checks.push(key.externalId);
      return { status: 'ok', method: 'portal_status', httpStatus: 200, latencyMs: 4 };
    },
  };
  const supplierConnection = connection(9);
  supplierConnection.credentialsCiphertext = service.encryptCredentials({ accessToken: 'portal-access-token' });

  const result = await service.syncConnection(9, { connection: supplierConnection });

  assert.deepEqual(result, { ok: true, adapterType: 'sub2api', keyCount: 3, checked: 2 });
  assert.deepEqual(checks, ['one', 'two']);
  assert.equal(successes.length, 1);
  const [, recordedSnapshot, recordedChecks] = successes[0];
  assert.equal(recordedSnapshot.accessToken, undefined);
  assert.equal('rawKey' in recordedSnapshot.keys[0], false);
  assert.equal(recordedSnapshot.keys[0].keyFingerprint.length, 64);
  assert.deepEqual(recordedChecks.map((item) => item.externalId), ['one', 'two']);
  assert.equal(inventory.keys[0].rawKey, '');
  assert.equal(inventory.accessToken, '');
});

test('supplier monitor shares simultaneous syncs for one connection', async () => {
  const repository = {
    recordSupplierSyncSuccess: async () => {},
    recordSupplierSyncFailure: async () => assert.fail('unexpected sync failure'),
  };
  const service = new SupplierMonitorService(repository, config);
  let calls = 0;
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  service.adapters = {
    snapshot: async () => {
      calls += 1;
      await ready;
      return { adapterType: 'newapi', balance: null, balanceCurrency: 'QUOTA', keys: [] };
    },
    check: async () => assert.fail('no keys should be checked'),
  };
  const supplierConnection = connection(10, { adapterType: 'newapi', activeCheckEnabled: false });
  supplierConnection.credentialsCiphertext = service.encryptCredentials({ accessToken: 'portal-access-token' });

  const first = service.syncConnection(10, { connection: supplierConnection });
  const second = service.syncConnection(10, { connection: supplierConnection });
  release();
  await Promise.all([first, second]);

  assert.equal(calls, 1);
});

test('linked supplier keys are always checked even when optional active checks are disabled', async () => {
  const checked = [];
  const repository = {
    listLinkedSupplierKeyExternalIds: async () => ['two'],
    recordSupplierSyncSuccess: async () => {},
    recordSupplierSyncFailure: async () => assert.fail('unexpected sync failure'),
  };
  const service = new SupplierMonitorService(repository, config);
  service.adapters = {
    snapshot: async () => snapshot(),
    check: async (_connection, _credentials, _snapshot, key) => {
      checked.push(key.externalId);
      return { status: 'ok', method: 'billing_metadata', httpStatus: 200, latencyMs: 4 };
    },
  };
  const supplierConnection = connection(12, { activeCheckEnabled: false });
  supplierConnection.credentialsCiphertext = service.encryptCredentials({ accessToken: 'portal-access-token' });

  const result = await service.syncConnection(12, { connection: supplierConnection });

  assert.deepEqual(checked, ['two']);
  assert.equal(result.checked, 1);
});

test('supplier monitor records failures and supports scheduled due connections', async () => {
  const failures = [];
  const successes = [];
  const due = connection(11);
  const repository = {
    listDueSupplierConnections: async (limit) => {
      assert.equal(limit, 5);
      return [due];
    },
    recordSupplierSyncSuccess: async (...args) => successes.push(args),
    recordSupplierSyncFailure: async (...args) => failures.push(args),
  };
  const service = new SupplierMonitorService(repository, config);
  due.credentialsCiphertext = service.encryptCredentials({ accessToken: 'portal-access-token' });
  service.adapters = {
    snapshot: async () => ({ adapterType: 'sub2api', balance: null, balanceCurrency: 'USD', keys: [] }),
    check: async () => assert.fail('no keys should be checked'),
  };

  await service.runDue();
  assert.equal(successes.length, 1);

  service.adapters.snapshot = async () => {
    throw Object.assign(new Error('supplier unavailable'), { code: 'request_failed', statusCode: 502, httpStatus: 503 });
  };
  const result = await service.syncConnection(11, { connection: due });
  assert.deepEqual(result, { ok: false, error: 'request_failed' });
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0][1], { code: 'request_failed', httpStatus: 503, message: 'supplier unavailable' });
});

test('passive quality failures do not fail supplier inventory synchronization', async () => {
  let success = false;
  const repository = {
    recordSupplierSyncSuccess: async () => { success = true; },
    recordSupplierSyncFailure: async () => assert.fail('passive quality must not fail inventory sync'),
  };
  const service = new SupplierMonitorService(repository, config);
  service.adapters = {
    snapshot: async () => snapshot(),
    check: async () => ({ status: 'ok', method: 'metadata', httpStatus: 200 }),
    collectPassiveQuality: async () => { throw new Error('usage history unavailable'); },
  };
  const supplierConnection = connection(15, { qualityMonitorMode: 'passive' });
  supplierConnection.credentialsCiphertext = service.encryptCredentials({ accessToken: 'portal-access-token' });

  const result = await service.syncConnection(15, { connection: supplierConnection });

  assert.equal(result.ok, true);
  assert.equal(success, true);
});

test('due active quality targets wake their supplier connection and probe only the selected key and model', async () => {
  const recorded = [];
  const dueConnection = connection(16, {
    qualityMonitorMode: 'active', activeCheckEnabled: false,
  });
  const repository = {
    listDueSupplierConnections: async () => [],
    listDueSupplierQualityTargets: async () => [{
      id: 51, connectionId: 16, externalKeyId: 'two', model: 'gpt-4o-mini',
      maxOutputTokens: 1, connection: dueConnection,
    }],
    listLinkedSupplierKeyExternalIds: async () => [],
    recordSupplierSyncSuccess: async () => {},
    recordSupplierSyncFailure: async () => assert.fail('unexpected sync failure'),
    recordSupplierQualityTargetResult: async (targetId, observation) => recorded.push({ targetId, observation }),
  };
  const service = new SupplierMonitorService(repository, config);
  dueConnection.credentialsCiphertext = service.encryptCredentials({ accessToken: 'portal-access-token' });
  service.adapters = {
    snapshot: async () => snapshot(),
    check: async () => assert.fail('inventory checks are disabled'),
    activeQualityProbe: async (_connection, _snapshot, key, target) => ({
      sourceKind: 'active_probe', status: 'ok', availabilitySample: true,
      model: target.model, groupName: key.groupName || '', ttftMs: 420, durationMs: 900,
      observedAt: new Date().toISOString(), metadata: {},
    }),
  };

  await service.runDue();

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].targetId, 51);
  assert.equal(recorded[0].observation.model, 'gpt-4o-mini');
  assert.equal(recorded[0].observation.ttftMs, 420);
});
