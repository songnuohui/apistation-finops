type SizeKey = 'addedPackedBytes' | 'addedBytes' | 'readBytes';
type BackupJob = {
  status?: string;
  progress?: Partial<Record<SizeKey, unknown>> & { phase?: string; failedPhase?: string };
};

export const backupSizeColumns: { key: SizeKey; label: string; description: string }[] = [
  { key: 'addedPackedBytes', label: '新增块（压缩后）', description: '本轮去重后新增块的压缩大小，由 Restic 统计。不是完整恢复点大小，也不等于网络流量、七牛空间占用增量或计费量。' },
  { key: 'addedBytes', label: '新增块（压缩前）', description: '本轮去重后新增块的未压缩大小。已有数据的更新也会产生新块，不代表这段时间的业务数据净增长。' },
  { key: 'readBytes', label: '本轮导出量', description: '本轮从选定业务表完整导出的 data.sql 大小，未经压缩、去重。不是数据库物理大小，也不是本轮上传量；未完成导出的任务仅显示已导出部分。' },
];

function byteValue(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function formatBackupBytes(value: unknown): string {
  const number = byteValue(value);
  if (number === null) return '—';
  const unit = number >= 1073741824 ? 1073741824 : number >= 1048576 ? 1048576 : number >= 1024 ? 1024 : 1;
  return `${(number / unit).toFixed(unit === 1 ? 0 : 1)} ${{ 1: 'B', 1024: 'KiB', 1048576: 'MiB', 1073741824: 'GiB' }[unit]}`;
}

export function backupSize(job: BackupJob | null | undefined, key: SizeKey) {
  if (!job) return { text: '暂无成功备份', missing: true, partial: '', detail: '当前没有成功备份的统计数据。' };
  const active = job.status === 'queued' || job.status === 'running';
  if (byteValue(job.progress?.[key]) === null) {
    return {
      text: active ? '待统计' : '未记录', missing: true, partial: '',
      detail: active ? '任务尚未提供此项统计，不能按 0 B 计算。' : '此任务未记录该项统计，不代表 0 B，也不根据其他指标推算。',
    };
  }
  const partial = key === 'readBytes' && (job.progress?.failedPhase || job.progress?.phase) === 'exporting';
  return {
    text: formatBackupBytes(job.progress?.[key]), missing: false,
    partial: partial ? active ? '导出中' : '未完整' : '',
    detail: partial ? '仅统计已导出的部分，不能作为本轮完整导出大小。' : '',
  };
}
