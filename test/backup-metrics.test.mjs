import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../frontend/src/backup-metrics.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { backupSize, backupSizeColumns, formatBackupBytes } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('backup metrics prioritize packed blocks and distinguish them from the full export', () => {
  assert.deepEqual(backupSizeColumns.map((column) => column.key), ['addedPackedBytes', 'addedBytes', 'readBytes']);
  const job = { status: 'completed', progress: { readBytes: 826441000, addedBytes: 10590617, addedPackedBytes: 2443182 } };
  assert.equal(backupSize(job, 'addedPackedBytes').text, '2.3 MiB');
  assert.equal(backupSize(job, 'addedBytes').text, '10.1 MiB');
  assert.equal(backupSize(job, 'readBytes').text, '788.2 MiB');
  assert.equal(backupSize(job, 'readBytes').partial, '');
});

test('historical missing statistics are not inferred from other sizes', () => {
  const job = { status: 'completed', progress: { readBytes: 1024, addedBytes: 512 } };
  assert.equal(backupSize(job, 'addedPackedBytes').text, '未记录');
  assert.equal(backupSize(job, 'addedPackedBytes').missing, true);
  assert.equal(backupSize({ status: 'failed' }, 'addedBytes').text, '未记录');
  assert.equal(backupSize(null, 'addedPackedBytes').text, '暂无成功备份');
});

test('queued and running metrics are pending until supplied, including during checking', () => {
  for (const status of ['queued', 'running']) {
    assert.equal(backupSize({ status }, 'addedPackedBytes').text, '待统计');
  }
  const job = { status: 'running', progress: { phase: 'checking', addedPackedBytes: 1024 } };
  assert.equal(backupSize(job, 'addedPackedBytes').text, '1.0 KiB');
});

test('a recorded zero stays zero, while invalid or empty metrics remain missing', () => {
  for (const value of [0, '0']) {
    const metric = backupSize({ status: 'completed', progress: { addedPackedBytes: value } }, 'addedPackedBytes');
    assert.equal(metric.text, '0 B');
    assert.equal(metric.missing, false);
  }
  for (const value of [undefined, null, '', ' ', false, -1, NaN, Infinity, 'invalid']) {
    assert.equal(formatBackupBytes(value), '—');
    assert.equal(backupSize({ status: 'completed', progress: { addedPackedBytes: value } }, 'addedPackedBytes').text, '未记录');
  }
});

test('partial exports are labeled separately from completed full exports', () => {
  assert.equal(backupSize({ status: 'running', progress: { phase: 'exporting', readBytes: 512 } }, 'readBytes').partial, '导出中');
  assert.equal(backupSize({ status: 'failed', progress: { phase: 'failed', failedPhase: 'exporting', readBytes: 512 } }, 'readBytes').partial, '未完整');
  assert.equal(backupSize({ status: 'failed', progress: { phase: 'exporting', readBytes: 512 } }, 'readBytes').partial, '未完整');
  assert.equal(backupSize({ status: 'failed', progress: { phase: 'failed', failedPhase: 'uploading', readBytes: 512 } }, 'readBytes').partial, '');
});

test('size formatting accepts numeric database values and handles unit boundaries', () => {
  for (const [value, expected] of [[1, '1 B'], [1024, '1.0 KiB'], [1048576, '1.0 MiB'], [1073741824, '1.0 GiB'], ['1024', '1.0 KiB']]) {
    assert.equal(formatBackupBytes(value), expected);
  }
});
