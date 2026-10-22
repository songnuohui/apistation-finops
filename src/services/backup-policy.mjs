export const BACKUP_DEFAULTS = Object.freeze({
  enabled: false,
  endpoint: 'https://s3-cn-east-1.qiniucs.com',
  region: 'cn-east-1',
  bucket: '',
  prefix: 'sub2api-backup',
  intervalMinutes: 60,
  timeoutMinutes: 30,
  uploadLimitKiB: 2048,
  keepHourly: 48,
  keepDaily: 30,
  keepWeekly: 8,
  autoPrune: false,
});

export function backupError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw backupError(`${name}必须是 ${min} 至 ${max} 之间的整数`);
  }
  return value;
}

export function normalizeBackupSettings(input, previous = BACKUP_DEFAULTS) {
  const result = { ...BACKUP_DEFAULTS, ...previous };
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw backupError('备份设置格式错误');
  for (const key of ['enabled', 'autoPrune']) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') throw backupError(`${key}必须是布尔值`);
      result[key] = input[key];
    }
  }
  for (const [key, min, max] of [
    ['intervalMinutes', 15, 10080], ['timeoutMinutes', 5, 120],
    ['uploadLimitKiB', 128, 102400], ['keepHourly', 1, 720],
    ['keepDaily', 1, 365], ['keepWeekly', 1, 104],
  ]) {
    if (input[key] !== undefined) result[key] = integer(input[key], key, min, max);
  }
  for (const key of ['endpoint', 'region', 'bucket', 'prefix']) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string') throw backupError(`${key}格式错误`);
      result[key] = input[key].trim();
    }
  }
  let endpoint;
  try { endpoint = new URL(result.endpoint); } catch { throw backupError('七牛 S3 接口地址错误'); }
  const host = /^s3-(cn-east-[12]|cn-north-1|cn-south-1|us-north-1|ap-southeast-1)\.qiniucs\.com$/.exec(endpoint.hostname);
  if (!host || endpoint.protocol !== 'https:' || endpoint.port || endpoint.username || endpoint.password
    || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || host[1] !== result.region) {
    throw backupError('仅允许区域匹配的七牛官方 HTTPS S3 接口');
  }
  result.endpoint = endpoint.origin;
  if (result.bucket && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(result.bucket)) throw backupError('空间名称格式错误');
  if (!/^[A-Za-z0-9][A-Za-z0-9_/-]{0,120}$/.test(result.prefix)
    || result.prefix.endsWith('/') || result.prefix.includes('//')) throw backupError('请使用非空、独立的仓库目录');
  return Object.fromEntries(Object.keys(BACKUP_DEFAULTS).map((key) => [key, result[key]]));
}

export function mergeBackupSecrets(input, previous = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw backupError('密钥格式错误');
  const result = { ...previous };
  for (const key of ['accessKey', 'secretKey', 'password']) {
    if (input[key] === undefined || input[key] === '') continue;
    if (typeof input[key] !== 'string' || input[key].length > 1024 || /[\x00-\x1f\x7f]/.test(input[key])) {
      throw backupError('密钥格式错误');
    }
    result[key] = input[key];
  }
  if (input.password && input.password.length < 16) throw backupError('仓库密码至少需要 16 个字符，请独立保管');
  return result;
}

export function assertBackupConfigured(settings, secrets) {
  if (!settings.bucket || !secrets.accessKey || !secrets.secretKey || !secrets.password) {
    throw backupError('请先保存七牛空间、访问密钥和仓库密码');
  }
}

export function publicBackupSettings(settings, secrets = {}) {
  return { ...settings, accessKeyConfigured: Boolean(secrets.accessKey), secretKeyConfigured: Boolean(secrets.secretKey), passwordConfigured: Boolean(secrets.password) };
}

export function repositoryId(settings) {
  return `${settings.endpoint}/${settings.bucket}/${settings.prefix}`;
}

export function resticEnvironment(settings, secrets, base = process.env) {
  assertBackupConfigured(settings, secrets);
  return {
    PATH: base.PATH,
    HOME: base.HOME || '/tmp',
    TMPDIR: base.TMPDIR || '/tmp',
    RESTIC_REPOSITORY: `s3:${repositoryId(settings)}`,
    RESTIC_PASSWORD: secrets.password,
    AWS_ACCESS_KEY_ID: secrets.accessKey,
    AWS_SECRET_ACCESS_KEY: secrets.secretKey,
    AWS_DEFAULT_REGION: settings.region,
    RESTIC_CACHE_DIR: '/var/lib/finops-backup/cache',
    GOMAXPROCS: '1',
  };
}
