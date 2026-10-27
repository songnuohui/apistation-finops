import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { backupError, resticEnvironment } from '../services/backup-policy.mjs';
import { resticStorageError } from './storage-errors.mjs';

export const RESTIC_TEMP_ROOT = '/var/lib/finops-backup/tmp';

export async function restic(args, settings, secrets, signal, progress, {
  tempRoot = RESTIC_TEMP_ROOT, spawnProcess = spawn,
} = {}) {
  let directory;
  try {
    await fs.mkdir(tempRoot, { recursive: true, mode: 0o700 });
    directory = await fs.mkdtemp(path.join(tempRoot, 'restic-'));
  } catch (error) {
    if (['ENOSPC', 'EDQUOT'].includes(error.code)) throw resticStorageError(1, error.code);
    throw backupError('备份临时目录不可用，请检查执行器磁盘空间和权限', 503);
  }
  try {
    return await new Promise((resolve, reject) => {
      // Encrypted pack uploads can exceed the container's small /tmp tmpfs.
      const child = spawnProcess('restic', ['--limit-upload', String(settings.uploadLimitKiB), ...args], {
        env: { ...resticEnvironment(settings, secrets), TMPDIR: directory },
        stdio: ['ignore', 'pipe', 'pipe'], signal,
      });
      const decoder = new StringDecoder('utf8');
      let pending = '';
      let output = '';
      let summary = null;
      let overflow = false;
      let diagnostic = '';
      let processError = false;
      let exitError = false;
      const recordDiagnostic = (value) => { diagnostic = (diagnostic + value).slice(-65536); };
      const consumeLine = (line) => {
        try {
          const event = JSON.parse(line);
          if (event.message_type === 'summary') summary = event;
          if (event.message_type === 'status') progress(event);
          // Restic --json reports fatal errors on stdout, including disk exhaustion.
          if (event.message_type === 'exit_error') {
            exitError = true;
            recordDiagnostic(typeof event.message === 'string' ? event.message : '');
          }
        } catch { /* Never return CLI output or file contents to the web process. */ }
      };
      child.stdout.on('data', (chunk) => {
        if (!progress) {
          output += chunk.toString();
          if (output.length > 8 * 1024 * 1024) { overflow = true; child.kill(); }
          return;
        }
        pending += decoder.write(chunk);
        if (pending.length > 1024 * 1024) { overflow = true; child.kill(); return; }
        let index;
        while ((index = pending.indexOf('\n')) >= 0) {
          consumeLine(pending.slice(0, index));
          pending = pending.slice(index + 1);
        }
      });
      child.stderr.on('data', (chunk) => recordDiagnostic(chunk.toString('utf8')));
      child.on('error', () => { processError = true; });
      child.on('close', (code) => {
        if (progress && !overflow) consumeLine(pending + decoder.end());
        if (processError) return reject(backupError('备份工具启动失败或任务超时', 503));
        if (code !== 0 || overflow || exitError) return reject(resticStorageError(code, diagnostic, overflow));
        resolve(progress ? summary : output);
      });
    });
  } finally {
    // Wait for the child to close before removing files still used by uploads.
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
