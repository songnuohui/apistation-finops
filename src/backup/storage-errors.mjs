import { backupError } from '../services/backup-policy.mjs';

export function resticStorageError(code, diagnostic = '', overflow = false) {
  // Classify only known diagnostics. Never expose CLI output, URLs, or file contents.
  if (overflow) return backupError('存储工具响应过大，操作已停止，不能确认完成', 502);
  if (/ENOSPC|EDQUOT|no space left on device|disk quota exceeded/i.test(diagnostic)) {
    return backupError('备份执行器本地临时空间不足，无法完成上传；请检查备份数据卷的可用磁盘空间', 502);
  }
  if (/SignatureDoesNotMatch|signature.*does not match|InvalidAccessKeyId|BadToken|bad token/i.test(diagnostic)) {
    return backupError('七牛认证失败：请核对同一组 Access Key 和 Secret Key 是否完整、有效；此错误不是仓库加密密码错误', 502);
  }
  if (/Access[ _]?Denied|access denied|Forbidden|status(?: code)?:? 403/i.test(diagnostic)) {
    return backupError('七牛拒绝访问：请核对 AK/SK 是否配对有效，以及是否有该空间和仓库目录的访问权限；尚不能验证仓库密码或是否已初始化', 502);
  }
  if (/NoSuchBucket|specified bucket does not exist/i.test(diagnostic)) {
    return backupError('七牛空间不存在或区域不匹配，请核对控制台中的 S3 空间名称和区域', 502);
  }
  if (code === 12 || /wrong password|no key found|unable to decrypt|ciphertext verification failed/i.test(diagnostic)) {
    return backupError('无法解密备份仓库：请使用初始化该仓库时的原密码，不要重新初始化或覆盖仓库', 502);
  }
  if (code === 11 || /repository is already locked|unable to (?:create|acquire) lock|failed to (?:create|acquire) lock/i.test(diagnostic)) {
    return backupError('备份仓库被锁定，请确认其他备份或导出任务已结束；系统不会自动强制解锁', 502);
  }
  if (/x509|certificate|TLS handshake/i.test(diagnostic)) {
    return backupError('连接七牛的 TLS 证书校验失败，请检查服务器时间、证书和网络；不要关闭 HTTPS 校验', 502);
  }
  if (/no such host|lookup .*:|dial tcp|network is unreachable|connection refused|i[/]o timeout|context deadline exceeded/i.test(diagnostic)) {
    return backupError('连接七牛超时或网络不可达，请检查服务器的 DNS、出口网络和接口地址', 502);
  }
  if (code === 10 || /(?:config.*(?:NoSuchKey|specified key does not exist|no such file)|(?:NoSuchKey|specified key does not exist|no such file).*config)/is.test(diagnostic)) {
    return backupError('该目录未找到备份仓库配置：请先核对空间和目录；只有确认是新的专用空目录时才可初始化', 502);
  }
  return backupError('存储操作失败，不能确认完成；请检查备份执行器资源、网络及云存储状态', 502);
}
