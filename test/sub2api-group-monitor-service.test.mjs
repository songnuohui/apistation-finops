import test from 'node:test';
import assert from 'node:assert/strict';
import { Sub2ApiGroupMonitorService } from '../src/services/sub2api-group-monitor-service.mjs';

test('group monitor starts from the current FinOps configuration boundary', async () => {
  const startedAt = '2026-09-02T10:00:00.000Z';
  const service = new Sub2ApiGroupMonitorService({
    async listMonitorGroups() {
      return [{
        id: 1,
        name: '主力分组',
        sourceGroupId: 10,
        sourceGroupName: '主力分组',
        provider: 'openai',
        displayMultiplier: null,
        sourceGroupMultiplier: 0.08,
        refreshIntervalSeconds: 45,
        historyStartedAt: startedAt,
        enabled: true,
      }];
    },
  }, {
    async read() {
      return {
        todayDate: '2026-09-02',
        monitors: [{ id: 7, groupName: '主力分组', provider: 'openai', enabled: true }],
        latest: [{ monitorId: 7, status: 'failed', latencyMs: 9999, pingLatencyMs: 999, checkedAt: '2026-09-02T09:59:00.000Z' }],
        histories: [
          { id: 1, monitorId: 7, status: 'failed', latencyMs: 9999, pingLatencyMs: 999, checkedAt: '2026-09-02T09:59:00.000Z' },
          { id: 2, monitorId: 7, status: 'operational', latencyMs: 222, pingLatencyMs: 20, checkedAt: '2026-09-02T10:01:00.000Z' },
        ],
        todayStats: [{ monitorId: 7, totalChecks: 99, okCount: 98 }],
        rollups: [],
      };
    },
  }, { sub2apiUsageCacheTtlSeconds: 30 });

  const [group] = await service.listAdminGroups();
  assert.equal(group.status, 'unknown');
  assert.equal(group.lastObservedAt, null);
  assert.equal(group.history.length, 1);
  assert.equal(group.history[0].latencyMs, 222);
  assert.equal(group.availabilitySampleCount['7d'], 1);
  assert.equal(group.availabilityByWindow['7d'], 100);

  const dashboard = await service.getPublicDashboard();
  assert.equal(dashboard.refreshIntervalSeconds, 45);
  assert.equal(dashboard.groups[0].historyStartedAt, startedAt);
});

test('a shorter group refresh interval bounds the shared Sub2API read cache', async () => {
  let reads = 0;
  const service = new Sub2ApiGroupMonitorService({
    async listMonitorGroups() {
      return [{
        id: 1,
        name: '主力分组',
        sourceGroupId: 10,
        sourceGroupName: '主力分组',
        provider: 'openai',
        displayMultiplier: null,
        sourceGroupMultiplier: 0.08,
        refreshIntervalSeconds: 15,
        historyStartedAt: '2026-09-02T00:00:00.000Z',
        enabled: true,
      }];
    },
  }, {
    async read() {
      reads += 1;
      return { todayDate: '2026-09-02', monitors: [], latest: [], histories: [], todayStats: [], rollups: [] };
    },
  }, { sub2apiUsageCacheTtlSeconds: 60 });

  await service.listAdminGroups();
  assert.equal(service.cacheTtlMs(), 15_000);
  await service.listAdminGroups();
  assert.equal(reads, 1);
});
