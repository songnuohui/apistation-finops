import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_DEFAULTS, normalizeBackupSettings, mergeBackupSecrets, resticEnvironment } from '../src/services/backup-policy.mjs';
import { BackupRepository } from '../src/repositories/backup-repository.mjs';
import { BackupService } from '../src/services/backup-service.mjs';
import { resticStorageError } from '../src/backup/storage-errors.mjs';

const key = 'ab'.repeat(32);
function setup() {
  const repository = new BackupRepository(null, { finopsSchema: 'finops' });
  const service = new BackupService(repository, { backupCredentialsKey: key });
  return { service, repository };
}
const credentials = { accessKey: 'example-access-key', secretKey: 'example-secret-key', password: 'example-strong-repository-password' };

test('backup defaults are opt-in and data-source configuration is not accepted', () => {
  const value = normalizeBackupSettings({ sourceDatabaseUrl: 'postgres://unsafe', sql: 'DROP TABLE users', restoreTarget: 'production' });
  assert.equal(value.enabled, false);
  assert.equal(value.autoPrune, false);
  assert.equal(value.intervalMinutes, 60);
  assert.equal(value.sourceDatabaseUrl, undefined);
  assert.equal(value.sql, undefined);
  assert.equal(value.restoreTarget, undefined);
});

test('backup repository endpoints reject SSRF, credentials, alternate ports and mismatched regions', () => {
  for (const endpoint of ['http://127.0.0.1', 'https://s3-cn-east-1.qiniucs.com.evil.test', 'https://user:pass@s3-cn-east-1.qiniucs.com', 'https://s3-cn-east-1.qiniucs.com:8443', 'https://s3-cn-east-1.qiniucs.com/path', 'https://s3-cn-north-1.qiniucs.com']) {
    assert.throws(() => normalizeBackupSettings({ endpoint }));
  }
  assert.equal(normalizeBackupSettings({ endpoint: 'https://s3-cn-north-1.qiniucs.com', region: 'cn-north-1' }).region, 'cn-north-1');
  for (const prefix of ['', '/root', '../other', 'shared//data', 'x/']) assert.throws(() => normalizeBackupSettings({ prefix }));
  for (const intervalMinutes of [0, 1, 14, 1.5, '60', 10081]) assert.throws(() => normalizeBackupSettings({ intervalMinutes }));
  assert.throws(() => normalizeBackupSettings({ enabled: 'false' }));
});

test('documented Qiniu endpoints are accepted without silently changing legacy repositories', () => {
  assert.equal(BACKUP_DEFAULTS.endpoint, 'https://s3.cn-east-1.qiniucs.com');
  for (const region of ['cn-east-1', 'cn-east-2', 'cn-north-1', 'cn-south-1', 'us-north-1', 'ap-southeast-1']) {
    for (const separator of ['.', '-']) {
      const endpoint = `https://s3${separator}${region}.qiniucs.com`;
      assert.equal(normalizeBackupSettings({ region, endpoint }).endpoint, endpoint);
    }
  }
  for (const endpoint of [
    'http://s3.cn-south-1.qiniucs.com',
    'https://s3.cn-south-1.qiniucs.com.evil.test',
    'https://apistation-sub2api.s3.cn-south-1.qiniucs.com',
    'https://user:pass@s3.cn-south-1.qiniucs.com',
    'https://s3.cn-south-1.qiniucs.com:8443',
    'https://s3.cn-south-1.qiniucs.com/bucket',
    'https://s3.cn-south-1.qiniucs.com?query=1',
    'https://s3.cn-south-1.qiniucs.com#fragment',
    'https://s3.cn-north-1.qiniucs.com',
  ]) assert.throws(() => normalizeBackupSettings({ region: 'cn-south-1', endpoint }));
});

test('storage errors distinguish authentication, missing repository, password and lock without exposing diagnostics', () => {
  const cases = [
    [1, 'write /tmp/restic-temp-pack: no space left on device', /本地临时空间不足/],
    [1, 'disk quota exceeded', /本地临时空间不足/],
    [1, 'ENOSPC', /本地临时空间不足/],
    [1, 'EDQUOT', /本地临时空间不足/],
    [1, 'SignatureDoesNotMatch', /七牛认证失败/],
    [1, 'InvalidAccessKeyId', /七牛认证失败/],
    [1, 'BadToken', /七牛认证失败/],
    [1, 'Stat(<config\/>) failed: Stat: Access Denied.', /七牛拒绝访问/],
    [10, 'Access Denied. Is there a repository?', /七牛拒绝访问/],
    [1, 'NoSuchBucket', /空间不存在/],
    [10, 'repository does not exist', /未找到备份仓库配置/],
    [1, 'config: The specified key does not exist', /未找到备份仓库配置/],
    [12, 'wrong password or no key found', /无法解密/],
    [11, 'repository is already locked', /仓库被锁定/],
    [1, 'x509: certificate expired', /TLS 证书/],
    [10, 'unable to open config: x509: certificate expired', /TLS 证书/],
    [1, 'lookup example: no such host', /网络不可达/],
    [10, 'unable to open config: i/o timeout', /网络不可达/],
    [1, 'unknown failure', /存储操作失败/],
  ];
  const sensitive = 'secret-access-key signed-url database-row';
  for (const [code, diagnostic, expected] of cases) {
    const error = resticStorageError(code, `${diagnostic} ${sensitive}`);
    assert.equal(error.statusCode, 502);
    assert.match(error.message, expected);
    assert.ok(!error.message.includes(sensitive));
  }
  assert.match(resticStorageError(0, sensitive, true).message, /响应过大/);
});

test('secrets preserve blanks, reject control characters and are not passed in process arguments', () => {
  assert.deepEqual(mergeBackupSecrets({ accessKey: '', password: '' }, credentials), credentials);
  assert.throws(() => mergeBackupSecrets({ password: 'short' }));
  assert.throws(() => mergeBackupSecrets({ secretKey: 'bad\nvalue' }));
  assert.throws(() => mergeBackupSecrets(null));
  const env = resticEnvironment({ ...BACKUP_DEFAULTS, bucket: 'test-bucket' }, credentials, { PATH: '/bin', UNRELATED_SECRET: 'must-not-leak' });
  assert.equal(env.RESTIC_PASSWORD, credentials.password);
  assert.equal(env.UNRELATED_SECRET, undefined);
  assert.equal(env.RESTIC_REPOSITORY, 's3:https://s3.cn-east-1.qiniucs.com/test-bucket/sub2api-backup');
});

test('settings encrypt all secrets at rest and never return them to the browser', async () => {
  const { service, repository } = setup();
  const value = await service.save({ bucket: 'test-bucket', ...credentials }, 'test-admin');
  for (const secret of Object.values(credentials)) {
    assert.ok(!JSON.stringify(await repository.settings()).includes(secret));
    assert.ok(!JSON.stringify(value).includes(secret));
  }
  assert.equal(value.enabled, false);
  assert.equal(value.passwordConfigured, true);
  assert.equal(value.accessKey, undefined);
  assert.equal(value.password, undefined);
  await service.save({ secretKey: '' }, 'test-admin');
  assert.deepEqual((await service.context()).secrets, credentials);
  await assert.rejects(service.save({ password: 'replacement-password-123456' }, 'test-admin'), /密码不能直接更改/);
  await assert.rejects(service.save({ prefix: 'another-repository' }, 'test-admin'), /明确确认/);
  await service.save({ prefix: 'another-repository', password: 'replacement-password-123456', confirmRepositoryChange: true }, 'test-admin');
});

test('credential rotation preserves distinct AK/SK through encrypted storage and worker requests', async () => {
  const { service } = setup();
  await service.save({ bucket: 'test-bucket', ...credentials }, 'test-admin');
  const rotated = { accessKey: 'new-independent-access-key', secretKey: 'new-independent-secret-key' };
  await service.save(rotated, 'test-admin');
  await service.save({ accessKey: '', secretKey: '', password: '', uploadLimitKiB: 4096 }, 'test-admin');
  let calls = 0;
  service.request = async (route, payload) => {
    calls++;
    assert.equal(route, '/storage/test');
    assert.deepEqual(payload.secrets, { ...credentials, ...rotated });
    const env = resticEnvironment(payload.settings, payload.secrets, { PATH: '/bin' });
    assert.equal(env.AWS_ACCESS_KEY_ID, rotated.accessKey);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, rotated.secretKey);
    assert.equal(env.RESTIC_PASSWORD, credentials.password);
    return { ok: true };
  };
  await service.action('test');
  assert.equal(calls, 1);
});

test('identical AK/SK are rejected without saving or sending cloud requests, including legacy settings', async () => {
  const { service, repository } = setup();
  await service.save({ bucket: 'test-bucket', ...credentials }, 'test-admin');
  const previous = await repository.settings();
  let calls = 0;
  service.request = async () => { calls++; return { ok: true }; };
  const same = 'same-value-in-both-access-key-fields';
  await assert.rejects(service.save({ accessKey: same, secretKey: same }, 'test-admin'), /Access Key 和 Secret Key 不能相同/);
  await assert.rejects(service.save({ secretKey: credentials.accessKey }, 'test-admin'), /Access Key 和 Secret Key 不能相同/);
  assert.deepEqual(await repository.settings(), previous);
  repository.memory.credentials_encrypted = service.vault.encrypt({ ...credentials, accessKey: same, secretKey: same });
  await assert.rejects(service.action('test'), /Access Key 和 Secret Key 不能相同/);
  await assert.rejects(service.action('init', { confirm: true }), /Access Key 和 Secret Key 不能相同/);
  await assert.rejects(service.run('test-admin'), /Access Key 和 Secret Key 不能相同/);
  assert.equal((await repository.list()).length, 0);
  assert.equal(calls, 0);
  assert.throws(() => mergeBackupSecrets({ accessKey: same, secretKey: same }), /不能相同/);
  await service.save({ secretKey: 'corrected-independent-secret-key' }, 'test-admin');
  assert.equal((await service.context()).secrets.secretKey, 'corrected-independent-secret-key');
});

test('changing only the endpoint preserves secrets and still requires repository confirmation', async () => {
  const { service } = setup();
  await service.save({ bucket: 'test-bucket', region: 'cn-south-1', endpoint: 'https://s3-cn-south-1.qiniucs.com', ...credentials }, 'test-admin');
  const endpoint = 'https://s3.cn-south-1.qiniucs.com';
  await assert.rejects(service.save({ endpoint }, 'test-admin'), /明确确认/);
  await service.save({ endpoint, confirmRepositoryChange: true }, 'test-admin');
  const value = await service.context();
  assert.equal(value.settings.endpoint, endpoint);
  assert.deepEqual(value.secrets, credentials);
  assert.equal(value.settings.enabled, false);
  assert.equal(value.settings.autoPrune, false);
});

test('cannot enable a backup or run one without a configured worker/repository', async () => {
  const { service } = setup();
  await assert.rejects(service.run('test-admin'), /先保存/);
  await service.save({ bucket: 'test-bucket', ...credentials }, 'test-admin');
  await assert.rejects(service.save({ enabled: true }, 'test-admin'), /执行器尚未配置/);
  assert.equal((await service.status()).enabled, false);
});

test('active tasks block configuration changes and duplicate task creation', async () => {
  const { service, repository } = setup();
  await service.save({ bucket: 'test-bucket', ...credentials }, 'test-admin');
  const item = await repository.create('manual', 'test-admin');
  await assert.rejects(repository.create('manual', 'other-admin'), /已有备份/);
  await assert.rejects(service.save({ intervalMinutes: 30 }, 'test-admin'), /任务执行期间/);
  await assert.rejects(service.action('init', { confirm: true }), /等待当前备份/);
  await repository.update(item.id, { status: 'completed', progress: {}, completedAt: new Date().toISOString() });
  assert.equal(await repository.active(), null);
});

test('scheduler polls existing tasks and never starts source work by default', async () => {
  const { service, repository } = setup();
  let calls = 0;
  service.request = async () => { calls++; return { status: 'completed', progress: { sourceAt: '2026-10-22T00:00:00Z' } }; };
  await service.tick();
  assert.equal(calls, 0);
  const item = await repository.create('manual', 'test-admin');
  await service.tick();
  assert.equal((await repository.list())[0].status, 'completed');
  assert.equal((await repository.list())[0].id, item.id);
  assert.equal(calls, 1);
});

test('source inspection needs no cloud credentials; init and downloads are guarded', async () => {
  const { service } = setup();
  service.request = async (route) => ({ route });
  assert.equal((await service.action('source')).route, '/source');
  await assert.rejects(service.action('restore'), /先保存/);
  await service.save({ bucket: 'test-bucket', ...credentials }, 'test-admin');
  await assert.rejects(service.action('init'), /确认初始化/);
  assert.equal((await service.action('init', { confirm: true })).route, '/storage/init');
  await assert.rejects(service.download('../production', {}), /恢复点 ID/);
});

test('configuration updates and task submission cannot overlap across awaited I/O', async () => {
  const { service, repository } = setup();
  await service.save({ bucket: 'test-bucket', ...credentials }, 'test-admin');
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const active = repository.active.bind(repository);
  repository.active = async () => { await waiting; return active(); };
  const saving = service.save({ intervalMinutes: 30 }, 'test-admin');
  await assert.rejects(service.run('test-admin'), /备份操作进行中/);
  await assert.rejects(service.save({ intervalMinutes: 90 }, 'test-admin'), /备份操作进行中/);
  release();
  await saving;
  service.request = async () => { await waiting; return {}; };
  const running = service.run('test-admin');
  await assert.rejects(service.save({ intervalMinutes: 90 }, 'test-admin'), /备份操作进行中/);
  await running;
  assert.equal((await repository.list()).length, 1);
  assert.equal((await service.status()).intervalMinutes, 30);
});

test('backup history pages expose every record beyond the former 100-job limit', async () => {
  const { repository } = setup();
  repository.jobs = Array.from({ length: 125 }, (_, index) => ({
    id: String(index).padStart(3, '0'), status: 'completed', progress: {},
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
  }));
  const seen = [];
  for (let page = 1; page <= 7; page++) {
    const result = await repository.listPage({ page, pageSize: 20 });
    assert.equal(result.total, 125);
    assert.equal(result.page, page);
    assert.equal(result.pageSize, 20);
    assert.equal(result.items.length, page === 7 ? 5 : 20);
    seen.push(...result.items.map((item) => item.id));
  }
  assert.deepEqual(seen, repository.jobs.map((item) => item.id).reverse());
  assert.equal(new Set(seen).size, 125);
  assert.deepEqual((await repository.listPage({ page: 8, pageSize: 20 })).items, []);
});

test('backup history orders timestamp ties deterministically and keeps global status off-page', async () => {
  const { repository } = setup();
  repository.jobs = [
    { id: 'a', status: 'completed', progress: { addedBytes: 13000000, addedPackedBytes: 700000 }, createdAt: '2026-10-27T00:00:00Z' },
    { id: 'c', status: 'running', progress: {}, createdAt: '2026-10-27T01:00:00Z' },
    { id: 'b', status: 'failed', progress: {}, createdAt: '2026-10-27T00:00:00Z' },
    { id: '0', status: 'completed', progress: { addedBytes: 42 }, createdAt: '2026-10-26T00:00:00Z' },
  ];
  const result = await repository.listPage({ page: 2, pageSize: 1 });
  assert.deepEqual(result.items.map((item) => item.id), ['b']);
  assert.equal(result.activeJob.id, 'c');
  assert.equal(result.lastSuccess.id, 'a');
  assert.equal(result.lastSuccess.progress.addedPackedBytes, 700000);
  const historical = await repository.listPage({ page: 4, pageSize: 1 });
  assert.equal(historical.items[0].progress.addedPackedBytes, undefined);
});

test('empty backup history returns empty summaries and pagination metadata', async () => {
  const { repository } = setup();
  assert.deepEqual(await repository.listPage(), {
    items: [], total: 0, page: 1, pageSize: 20, activeJob: null, lastSuccess: null,
  });
});

test('database-backed backup pagination uses bounded parameters and independent global summaries', async () => {
  const row = { id: 'page-item', kind: 'scheduled', status: 'completed',
    progress: { addedBytes: 13000000, addedPackedBytes: 700000 }, created_by: 'test-admin',
    created_at: '2026-10-27T00:00:00Z', completed_at: '2026-10-27T00:01:00Z' };
  const calls = [];
  const repository = new BackupRepository({ async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('COUNT(*)')) return { rows: [{ total: '125' }] };
    if (sql.includes('LIMIT $1 OFFSET $2')) return { rows: [row] };
    if (sql.includes("status IN ('queued','running')")) return { rows: [{ ...row, id: 'active', status: 'running' }] };
    if (sql.includes("status='completed'")) return { rows: [{ ...row, id: 'latest' }] };
    assert.fail('Unexpected query');
  } }, { finopsSchema: 'finops' });
  const result = await repository.listPage({ page: 3, pageSize: 50 });
  assert.equal(result.total, 125);
  assert.equal(result.page, 3);
  assert.equal(result.pageSize, 50);
  assert.equal(result.items[0].createdAt, row.created_at);
  assert.equal(result.items[0].progress.addedPackedBytes, 700000);
  assert.equal(result.activeJob.id, 'active');
  assert.equal(result.lastSuccess.id, 'latest');
  assert.match(calls[1].sql, /ORDER BY created_at DESC, id DESC/);
  assert.deepEqual(calls[1].params, [50, 100]);
  assert.ok(calls.every(({ sql }) => sql.startsWith('SELECT ') && sql.includes('"finops".backup_jobs')));
});
