import assert from 'node:assert/strict';
import test from 'node:test';
import { SourceUsageRepository } from '../src/repositories/source-usage-repository.mjs';
import {
  ModelAuditService,
  buildModelAuditNotifications,
  classifyModelAuditEvent,
} from '../src/services/model-audit-service.mjs';
import {
  DemoModelAuditRepository,
  ModelAuditRepository,
} from '../src/repositories/model-audit-repository.mjs';
import {
  normalizeModelAuditClear,
  normalizeModelAuditNotificationIds,
  normalizeModelAuditSettings,
  normalizeModelAuditTestRun,
  normalizeModelAuditTimeRange,
} from '../src/http/validation.mjs';

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

test('model audit can notify only the administrator when user emails are disabled', () => {
  const run = {
    periodStart: '2026-09-04T00:00:00.000Z',
    periodEnd: '2026-09-04T00:05:00.000Z',
  };
  const events = [{
    status: 'mismatch',
    userEmail: 'user@example.com',
    sourceUserId: 7,
    requestedModel: 'gpt-4o',
    upstreamModel: 'gpt-4o',
    upstreamResponseModel: 'gpt-4o-mini',
    createdAt: '2026-09-04T00:01:00.000Z',
  }];
  const notifications = buildModelAuditNotifications({
    testMode: false,
    notifyUserEmails: false,
    adminEmail: 'admin@example.com',
  }, run, events);

  assert.deepEqual(
    notifications.map((item) => [item.kind, item.recipientEmail, item.eventCount]),
    [['admin', 'admin@example.com', 1]],
  );
  assert.match(notifications[0].htmlContent, /user@example\.com/);
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

  assert.equal(repository.events.length, 1);
  assert.equal(repository.events.filter((item) => item.userEmail === 'configured@example.com').length, 1);
  assert.equal(repository.notifications.length, 1);
  assert.equal(repository.notifications[0].recipientEmail, 'test@example.com');
  assert.equal(repository.notifications[0].status, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'test@example.com');
  assert.equal((await repository.getSettings()).cursorId, 700003);
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

test('model audit historical SQL includes the start row only for the first diagnostic batch', async () => {
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
    { sourceSchema: 'sub2api', sub2apiUsageDatabasePoolMax: 1 },
  );
  await repository.listModelAuditUsage({
    cursorCreatedAt: '2026-09-04T00:00:00.000Z',
    cursorId: -1,
    until: '2026-09-04T00:05:00.000Z',
    inclusiveCursor: true,
    limit: 5000,
  });

  const query = queries.find((item) => item.text.includes('FROM "sub2api".usage_logs'));
  assert.ok(query);
  assert.match(query.text, /\(ul\.created_at,ul\.id\) >= \(\$1::timestamptz,\$2::bigint\)/);
});

test('switching test mode preserves the formal cursor to avoid overlapping scheduled windows', async () => {
  const repository = new DemoModelAuditRepository({ users: [] });
  await repository.updateSettings({
    enabled: true,
    scanIntervalMinutes: 5,
    testMode: false,
    testUserEmails: [],
    testRecipientEmail: '',
    adminEmail: 'admin@example.com',
  });
  const before = await repository.getSettings();
  await new Promise((resolve) => setTimeout(resolve, 2));
  const after = await repository.updateSettings({
    enabled: true,
    scanIntervalMinutes: 5,
    testMode: true,
    testUserEmails: ['configured@example.com'],
    testRecipientEmail: 'test@example.com',
    adminEmail: 'admin@example.com',
  });

  assert.equal(after.cursorCreatedAt, before.cursorCreatedAt);
  assert.equal(after.cursorId, before.cursorId);
  assert.equal(after.lastScanStatus, before.lastScanStatus);
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

test('model audit historical test scans only configured users and do not advance the formal cursor', async () => {
  const repository = new DemoModelAuditRepository({
    users: [{ id: 1, email: 'configured@example.com' }],
  });
  await repository.updateSettings({
    enabled: true,
    scanIntervalMinutes: 5,
    testMode: true,
    testUserEmails: ['configured@example.com'],
    testRecipientEmail: 'test@example.com',
    adminEmail: 'admin@example.com',
  });
  const before = await repository.getSettings();
  const sent = [];
  const service = new ModelAuditService(
    repository,
    repository,
    { async sendRaw(...args) { sent.push(args); } },
    {},
  );

  const start = new Date(Date.now() - 10 * 60_000);
  const end = new Date();
  await service.runTest({ periodStart: start.toISOString(), periodEnd: end.toISOString() });

  const after = await repository.getSettings();
  assert.equal(after.cursorCreatedAt, before.cursorCreatedAt);
  assert.equal(after.cursorId, before.cursorId);
  assert.equal(after.lastScanStatus, before.lastScanStatus);
  assert.equal(repository.runs[0].runType, 'test');
  assert.equal(repository.runs[0].mismatchCount, 1);
  assert.equal(repository.events.length, 1);
  assert.equal(repository.events[0].userEmail, 'configured@example.com');
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'test@example.com');
});

test('model audit test scan validation rejects reversed, future, and oversized ranges', () => {
  const now = Date.now();
  const iso = (offset) => new Date(now + offset).toISOString();
  assert.throws(
    () => normalizeModelAuditTestRun({ periodStart: iso(1_000), periodEnd: iso(2_000) }),
    /periodEnd cannot be in the future/,
  );
  assert.throws(
    () => normalizeModelAuditTestRun({ periodStart: iso(-1_000), periodEnd: iso(-2_000) }),
    /periodStart must be before periodEnd/,
  );
  assert.throws(
    () => normalizeModelAuditTestRun({
      periodStart: iso(-32 * 86_400_000),
      periodEnd: iso(-1_000),
    }),
    /cannot exceed 31 days/,
  );
});

test('model audit mappings return independent paginated results', async () => {
  const repository = new DemoModelAuditRepository({ users: [] });
  for (let index = 0; index < 25; index += 1) {
    await repository.createMapping({
      sourceModel: `source-${String(index).padStart(2, '0')}`,
      allowedResponseModel: `response-${index}`,
    });
  }
  const first = await repository.listMappings({ page: 1, pageSize: 10 });
  const third = await repository.listMappings({ page: 3, pageSize: 10 });
  assert.equal(first.total, 25);
  assert.equal(first.items.length, 10);
  assert.equal(first.items[0].sourceModel, 'source-00');
  assert.equal(third.items.length, 5);
  assert.equal(third.page, 3);
});

test('model audit list filters use an inclusive start and exclusive end', async () => {
  const repository = new DemoModelAuditRepository({ users: [] });
  const start = '2026-09-04T00:00:00.000Z';
  const middle = '2026-09-04T00:05:00.000Z';
  const end = '2026-09-04T00:10:00.000Z';
  repository.events = [
    {
      id: 1, scanRunId: 1, status: 'mismatch', userEmail: 'first@example.com',
      requestedModel: 'gpt-4o', upstreamModel: 'gpt-4o',
      upstreamResponseModel: 'gpt-4o-mini', createdAt: start,
    },
    {
      id: 2, scanRunId: 2, status: 'mismatch', userEmail: 'second@example.com',
      requestedModel: 'claude', upstreamModel: 'claude',
      upstreamResponseModel: 'haiku', createdAt: middle,
    },
    {
      id: 3, scanRunId: 3, status: 'mismatch', userEmail: 'third@example.com',
      requestedModel: 'gemini', upstreamModel: 'gemini',
      upstreamResponseModel: 'flash', createdAt: end,
    },
  ];
  repository.runs = [
    { id: 1, periodStart: start },
    { id: 2, periodStart: middle },
    { id: 3, periodStart: end },
  ];
  repository.notifications = [
    { id: 1, createdAt: start, status: 'sent' },
    { id: 2, createdAt: middle, status: 'sent' },
    { id: 3, createdAt: end, status: 'sent' },
  ];

  const range = { startAt: start, endAt: end };
  assert.deepEqual(
    (await repository.listEvents({ ...range, page: 1, pageSize: 20 })).items
      .map((item) => item.id),
    [2, 1],
  );
  assert.equal((await repository.listScanRuns({ ...range })).total, 2);
  assert.equal((await repository.listNotifications({ ...range })).total, 2);
});

test('model audit clearing events respects search and clearing runs removes linked records', async () => {
  const repository = new DemoModelAuditRepository({ users: [] });
  repository.runs = [
    { id: 1, periodStart: '2026-09-04T00:00:00.000Z' },
    { id: 2, periodStart: '2026-09-04T01:00:00.000Z' },
  ];
  repository.events = [
    {
      id: 1, scanRunId: 1, status: 'mismatch', userEmail: 'keep@example.com',
      requestedModel: 'gpt-4o', upstreamModel: 'gpt-4o',
      upstreamResponseModel: 'gpt-4o-mini', createdAt: '2026-09-04T00:01:00.000Z',
    },
    {
      id: 2, scanRunId: 1, status: 'mismatch', userEmail: 'remove@example.com',
      requestedModel: 'gpt-4o', upstreamModel: 'gpt-4o',
      upstreamResponseModel: 'gpt-4.1', createdAt: '2026-09-04T00:02:00.000Z',
    },
    {
      id: 3, scanRunId: 2, status: 'mismatch', userEmail: 'later@example.com',
      requestedModel: 'claude', upstreamModel: 'claude',
      upstreamResponseModel: 'haiku', createdAt: '2026-09-04T01:01:00.000Z',
    },
  ];
  repository.notifications = [
    { id: 1, scanRunId: 1, createdAt: '2026-09-04T00:03:00.000Z', status: 'sent' },
    { id: 2, scanRunId: 2, createdAt: '2026-09-04T01:03:00.000Z', status: 'sent' },
  ];

  const filtered = await repository.clearAuditData({
    scope: 'events',
    search: 'remove@example.com',
    startAt: '2026-09-04T00:00:00.000Z',
    endAt: '2026-09-04T00:10:00.000Z',
  });
  assert.deepEqual(filtered.deleted, { events: 1, runs: 0, notifications: 0 });
  assert.deepEqual(repository.events.map((item) => item.userEmail), [
    'keep@example.com',
    'later@example.com',
  ]);

  const linked = await repository.clearAuditData({
    scope: 'runs',
    startAt: '2026-09-04T00:00:00.000Z',
    endAt: '2026-09-04T01:00:00.000Z',
  });
  assert.deepEqual(linked.deleted, { events: 1, runs: 1, notifications: 1 });
  assert.deepEqual(repository.runs.map((item) => item.id), [2]);
  assert.deepEqual(repository.notifications.map((item) => item.id), [2]);
});

test('model audit clear and time range validation reject incomplete or reversed ranges', () => {
  assert.deepEqual(normalizeModelAuditTimeRange({}), { startAt: null, endAt: null });
  assert.throws(
    () => normalizeModelAuditTimeRange({ startAt: '2026-09-04T00:00:00.000Z' }),
    /must be provided together/,
  );
  assert.throws(
    () => normalizeModelAuditTimeRange({
      startAt: '2026-09-04T01:00:00.000Z',
      endAt: '2026-09-04T00:00:00.000Z',
    }),
    /startAt must be before endAt/,
  );
  assert.deepEqual(
    normalizeModelAuditClear({ scope: 'events', search: 'user@example.com' }),
    { scope: 'events', search: 'user@example.com', startAt: null, endAt: null },
  );
});

test('model audit accepts a one-minute interval and rejects zero', () => {
  assert.equal(normalizeModelAuditSettings({
    enabled: false,
    scanIntervalMinutes: 1,
    testMode: false,
    notifyUserEmails: true,
    adminEmail: '',
  }).scanIntervalMinutes, 1);
  assert.throws(
    () => normalizeModelAuditSettings({ scanIntervalMinutes: 0 }),
    /invalid scanIntervalMinutes/,
  );
});

test('model audit notification confirmations are idempotent and record the actor', async () => {
  const repository = new DemoModelAuditRepository({ users: [] });
  repository.notifications = [
    { id: 1, status: 'sending', createdAt: '2026-09-04T00:01:00.000Z', sentAt: null, errorMessage: 'unknown' },
    { id: 2, status: 'pending', createdAt: '2026-09-04T00:02:00.000Z', sentAt: null, errorMessage: '' },
    { id: 3, status: 'needs_confirmation', createdAt: '2026-09-04T00:03:00.000Z', sentAt: null, errorMessage: 'unknown' },
    { id: 4, status: 'sent', createdAt: '2026-09-04T00:04:00.000Z', sentAt: '2026-09-04T00:04:01.000Z', confirmedBy: '', confirmedAt: null },
    { id: 5, status: 'failed', createdAt: '2026-09-04T00:05:00.000Z', sentAt: null, errorMessage: 'smtp failed' },
  ];

  const first = await repository.confirmNotification(1, 'admin@example.com');
  const repeated = await repository.confirmNotification(1, 'other@example.com');
  assert.equal(first.status, 'sent');
  assert.equal(first.confirmedBy, 'admin@example.com');
  assert.ok(first.confirmedAt);
  assert.equal(repeated.confirmedBy, 'admin@example.com');

  const batch = await repository.confirmNotifications([2, 4, 5], 'admin@example.com');
  assert.equal(batch.updated, 1);
  assert.deepEqual(batch.ids, [2]);
  assert.equal(repository.notifications.find((item) => item.id === 4).status, 'sent');
  assert.equal(repository.notifications.find((item) => item.id === 5).status, 'failed');
});

test('model audit confirm-all only confirms pending delivery states in the requested time range', async () => {
  const repository = new DemoModelAuditRepository({ users: [] });
  repository.notifications = [
    { id: 1, status: 'pending', createdAt: '2026-09-04T00:01:00.000Z' },
    { id: 2, status: 'needs_confirmation', createdAt: '2026-09-04T00:05:00.000Z' },
    { id: 3, status: 'sending', createdAt: '2026-09-04T00:09:00.000Z' },
    { id: 4, status: 'sent', createdAt: '2026-09-04T00:05:00.000Z' },
  ];

  const result = await repository.confirmAllNotifications({
    startAt: '2026-09-04T00:00:00.000Z',
    endAt: '2026-09-04T00:06:00.000Z',
  }, 'admin@example.com');

  assert.equal(result.updated, 2);
  assert.deepEqual(result.ids, [1, 2]);
  assert.equal(repository.notifications.find((item) => item.id === 3).status, 'sending');
  assert.equal(repository.notifications.find((item) => item.id === 4).status, 'sent');
});

test('model audit recovery marks uncertain delivery for manual confirmation and never queues it again', async () => {
  const repository = new DemoModelAuditRepository({ users: [] });
  repository.notifications = [
    { id: 1, status: 'sending', errorMessage: '', createdAt: '2026-09-04T00:01:00.000Z' },
    { id: 2, status: 'pending', errorMessage: 'FinOps 服务重启，邮件待重新投递', createdAt: '2026-09-04T00:02:00.000Z' },
    { id: 3, status: 'pending', errorMessage: '', createdAt: '2026-09-04T00:03:00.000Z' },
  ];

  assert.equal(await repository.recoverSendingNotifications(), 2);
  assert.equal(repository.notifications.find((item) => item.id === 1).status, 'needs_confirmation');
  assert.equal(repository.notifications.find((item) => item.id === 2).status, 'needs_confirmation');
  assert.deepEqual((await repository.listPendingNotifications()).map((item) => item.id), [3]);
});

test('model audit notification id validation requires positive safe integer ids', () => {
  assert.deepEqual(normalizeModelAuditNotificationIds({ ids: [1, '2', 2] }), { ids: [1, 2] });
  assert.throws(
    () => normalizeModelAuditNotificationIds({ ids: [] }),
    /invalid ids/,
  );
});

test('model audit clearing refuses active scans and in-flight email delivery', async () => {
  const repository = new DemoModelAuditRepository({ users: [] });
  repository.runs.push({ id: 1, status: 'running', periodStart: '2026-09-04T00:00:00.000Z' });
  await assert.rejects(
    () => repository.clearAuditData({ scope: 'events' }),
    /扫描正在执行/,
  );
  repository.runs[0].status = 'completed';
  repository.notifications.push({ id: 1, status: 'sending', createdAt: '2026-09-04T00:00:00.000Z' });
  await assert.rejects(
    () => repository.clearAuditData({ scope: 'notifications' }),
    /邮件正在发送/,
  );
});

test('model audit notification completion pins PostgreSQL parameter types', async () => {
  const queries = [];
  const pool = {
    async query(text, params) {
      queries.push({ text, params });
      return {
        rowCount: 1,
        rows: [{
          id: 1,
          status: 'sent',
          error_message: '',
          sent_at: '2026-09-04T00:00:00.000Z',
        }],
      };
    },
  };
  const repository = new ModelAuditRepository(pool, { finopsSchema: 'finops' });
  const result = await repository.finishNotification(1, 'sent');

  assert.equal(result.status, 'sent');
  assert.match(queries[0].text, /status=\$2::varchar/);
  assert.match(queries[0].text, /error_message=\$3::text/);
  assert.match(queries[0].text, /CASE WHEN \$2::varchar='sent'/);
  assert.match(queries[0].text, /WHERE id=\$1 AND status='sending'/);
});
