import assert from 'node:assert/strict';
import test from 'node:test';
import { SourceUsageRepository } from '../src/repositories/source-usage-repository.mjs';
import {
  ModelAuditService,
  buildModelAuditNotifications,
  classifyModelAuditEvent,
} from '../src/services/model-audit-service.mjs';
import { DemoModelAuditRepository } from '../src/repositories/model-audit-repository.mjs';

test('model audit classifies exact matches, legal mappings, mismatches, and missing fields', () => {
  assert.equal(classifyModelAuditEvent({
    upstream_model: ' GPT-4o ',
    upstream_response_model: 'gpt-4O',
  }).status, 'matched');
  assert.equal(classifyModelAuditEvent({
    upstream_model: 'claude-sonnet',
    upstream_response_model: 'claude-sonnet-2025',
  }, [{ sourceModel: ' claude-sonnet ', allowedResponseModel: 'CLAUDE-SONNET-2025' }]).status, 'allowed_mapping');
  assert.equal(classifyModelAuditEvent({
    upstream_model: 'claude-sonnet',
    upstream_response_model: 'claude-haiku',
  }).status, 'mismatch');
  assert.equal(classifyModelAuditEvent({
    upstream_model: '',
    upstream_response_model: 'gpt-4o',
  }).status, 'unknown');
  assert.equal(classifyModelAuditEvent({
    requested_model: 'gpt-4o',
    upstream_model: null,
    upstream_response_model: 'gpt-4o',
  }).status, 'matched');
});

test('model audit notifications aggregate mismatches by user and add one admin summary', () => {
  const run = {
    periodStart: '2026-09-04T00:00:00.000Z',
    periodEnd: '2026-09-04T00:05:00.000Z',
  };
  const events = [
    {
      status: 'mismatch', userEmail: 'USER@example.com', sourceUserId: 7,
      requestedModel: 'gpt-4o', upstreamModel: 'gpt-4o', upstreamResponseModel: 'gpt-4o-mini',
      createdAt: '2026-09-04T00:01:00.000Z',
    },
    {
      status: 'mismatch', userEmail: ' user@example.com ', sourceUserId: 7,
      requestedModel: 'gpt-4o', upstreamModel: 'gpt-4o', upstreamResponseModel: 'gpt-4.1',
      createdAt: '2026-09-04T00:02:00.000Z',
    },
    {
      status: 'mismatch', userEmail: 'other@example.com', sourceUserId: 8,
      requestedModel: 'claude', upstreamModel: 'claude', upstreamResponseModel: 'haiku',
      createdAt: '2026-09-04T00:03:00.000Z',
    },
    { status: 'matched', userEmail: 'other@example.com', sourceUserId: 8 },
  ];

  const notifications = buildModelAuditNotifications({
    testMode: false,
    adminEmail: 'ADMIN@example.com',
  }, run, events);

  assert.deepEqual(
    notifications.map((item) => [item.kind, item.recipientEmail, item.eventCount]),
    [
      ['user', 'user@example.com', 2],
      ['user', 'other@example.com', 1],
      ['admin', 'admin@example.com', 3],
    ],
  );
  assert.match(notifications[0].textContent, /gpt-4o-mini/);
  assert.match(notifications[2].htmlContent, /other@example\.com/);
});

test('model audit test mode routes one email only to the configured recipient and users', async () => {
  const repository = new DemoModelAuditRepository({
    users: [{ id: 1, email: 'configured@example.com' }],
  });
  repository.usageRows.push({
    id: 700003,
    userId: 2,
    userEmail: 'other@example.com',
    requestedModel: 'gpt-4o',
    upstreamModel: 'gpt-4o',
    upstreamResponseModel: 'gpt-4.1',
    upstreamModelMismatch: true,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  });
  await repository.updateSettings({
    enabled: true,
    scanIntervalMinutes: 5,
    testMode: true,
    testUserEmails: ['configured@example.com'],
    testRecipientEmail: 'test@example.com',
    adminEmail: 'admin@example.com',
  });
  const sent = [];
  const service = new ModelAuditService(
    repository,
    repository,
    { async sendRaw(...args) { sent.push(args); } },
    {},
  );

  await service.runDue();

  assert.equal(repository.events.length, 2);
  assert.equal(repository.events.filter((item) => item.userEmail === 'configured@example.com').length, 2);
  assert.equal(repository.notifications.length, 1);
  assert.equal(repository.notifications[0].recipientEmail, 'test@example.com');
  assert.equal(repository.notifications[0].status, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'test@example.com');
});

test('model audit source SQL uses a strict created_at and id cursor in a read-only transaction', async () => {
  const queries = [];
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text === 'BEGIN TRANSACTION READ ONLY' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const repository = new SourceUsageRepository(
    { connect: async () => client },
    { sourceSchema: 'public', sub2apiUsageDatabasePoolMax: 1 },
  );
  await repository.listModelAuditUsage({
    cursorCreatedAt: '2026-09-04T00:00:00.000Z',
    cursorId: 42,
    until: '2026-09-04T00:05:00.000Z',
    limit: 5000,
  });

  const query = queries.find((item) => item.text.includes('FROM "public".usage_logs'));
  assert.ok(query);
  assert.match(query.text, /\(ul\.created_at,ul\.id\) > \(\$1::timestamptz,\$2::bigint\)/);
  assert.match(query.text, /ORDER BY ul\.created_at ASC,ul\.id ASC/);
  assert.deepEqual(query.params.slice(0, 3), [
    '2026-09-04T00:00:00.000Z',
    42,
    '2026-09-04T00:05:00.000Z',
  ]);
  assert.deepEqual(queries.slice(0, 3).map((item) => item.text), [
    'BEGIN TRANSACTION READ ONLY',
    query.text,
    'COMMIT',
  ]);
});

test('model audit validates only the required source columns through the read-only usage connection', async () => {
  const queries = [];
  const requiredRows = [
    ['usage_logs', 'id'],
    ['usage_logs', 'user_id'],
    ['usage_logs', 'model'],
    ['usage_logs', 'requested_model'],
    ['usage_logs', 'upstream_model'],
    ['usage_logs', 'upstream_response_model'],
    ['usage_logs', 'upstream_model_mismatch'],
    ['usage_logs', 'created_at'],
    ['users', 'id'],
    ['users', 'email'],
  ].map(([table_name, column_name]) => ({ table_name, column_name }));
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text === 'BEGIN TRANSACTION READ ONLY' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      return { rows: requiredRows, rowCount: requiredRows.length };
    },
    release() {},
  };
  const repository = new SourceUsageRepository(
    { connect: async () => client },
    { sourceSchema: 'sub2api', sub2apiUsageDatabasePoolMax: 1 },
  );

  assert.deepEqual(await repository.validateModelAuditSchema(), {
    sourceSchema: 'sub2api',
    tables: ['usage_logs', 'users'],
  });
  const query = queries.find((item) => item.text.includes('information_schema.columns'));
  assert.ok(query);
  assert.deepEqual(query.params, ['sub2api', ['usage_logs', 'users']]);
  assert.deepEqual(queries.map((item) => item.text), [
    'BEGIN TRANSACTION READ ONLY',
    query.text,
    'COMMIT',
  ]);
});

test('model audit schema validation fails closed when a required source field is missing', async () => {
  const client = {
    async query(text) {
      if (text === 'BEGIN TRANSACTION READ ONLY' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [{ table_name: 'usage_logs', column_name: 'id' }],
        rowCount: 1,
      };
    },
    release() {},
  };
  const repository = new SourceUsageRepository(
    { connect: async () => client },
    { sourceSchema: 'sub2api' },
  );

  await assert.rejects(
    () => repository.validateModelAuditSchema(),
    /Sub2API model audit schema is incompatible; missing: usage_logs\.user_id/,
  );
});

test('model audit paginates at 5000 rows and advances the source high-water mark', async () => {
  const firstBatch = Array.from({ length: 5000 }, (_, index) => ({
    id: index + 1,
    userId: 1,
    userEmail: 'user@example.com',
    requestedModel: 'gpt-4o',
    upstreamModel: 'gpt-4o',
    upstreamResponseModel: 'gpt-4o',
    createdAt: '2026-09-04T00:01:00.000Z',
  }));
  const lastRow = {
    id: 5001,
    userId: 1,
    userEmail: 'user@example.com',
    requestedModel: 'gpt-4o',
    upstreamModel: 'gpt-4o',
    upstreamResponseModel: 'gpt-4o',
    createdAt: '2026-09-04T00:01:00.000Z',
  };
  const calls = [];
  let completed;
  const repository = {
    async listMappings() { return []; },
    async completeScan(_runId, payload) { completed = payload; return payload; },
    async failScan() { throw new Error('unexpected failure'); },
    async listPendingNotifications() { return []; },
  };
  const source = {
    async listModelAuditUsage(input) {
      calls.push(input);
      if (input.cursorId === 0) return firstBatch;
      if (input.cursorId === 5000) return [lastRow];
      return [];
    },
  };
  const service = new ModelAuditService(repository, source, {}, {});
  await service.execute({
    settings: { testMode: false, testUserEmails: [], adminEmail: '' },
    run: {
      id: 1,
      periodStart: '2026-09-04T00:00:00.000Z',
      periodEnd: '2026-09-04T00:05:00.000Z',
      cursorBeforeCreatedAt: '2026-09-04T00:00:00.000Z',
      cursorBeforeId: 0,
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].cursorId, 5000);
  assert.equal(completed.counts.scanned, 5001);
  assert.equal(completed.cursorAfterId, 5001);
  assert.equal(completed.lastRecordId, 5001);
});

test('model audit empty windows advance to the scan end without creating notifications', async () => {
  let completed;
  const repository = {
    async listMappings() { return []; },
    async completeScan(_runId, payload) { completed = payload; return payload; },
    async failScan() { throw new Error('unexpected failure'); },
    async listPendingNotifications() { return []; },
  };
  const source = { async listModelAuditUsage() { return []; } };
  const service = new ModelAuditService(repository, source, {}, {});
  await service.execute({
    settings: { testMode: false, testUserEmails: [], adminEmail: '' },
    run: {
      id: 2,
      periodStart: '2026-09-04T00:00:00.000Z',
      periodEnd: '2026-09-04T00:05:00.000Z',
      cursorBeforeCreatedAt: '2026-09-04T00:00:00.000Z',
      cursorBeforeId: 0,
    },
  });

  assert.equal(completed.cursorAfterCreatedAt, '2026-09-04T00:05:00.000Z');
  assert.equal(completed.cursorAfterId, 0);
  assert.equal(completed.lastRecordCreatedAt, null);
  assert.equal(completed.lastRecordId, null);
  assert.deepEqual(completed.notifications, []);
});
