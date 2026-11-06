// SSH 传输适配器（U3 试点）。spawnSync 无常驻连接：open 只规范化配置，
// 真连通性由 probe 验证；exec 逐命令超时。凭据走操作者本机 ssh 配置
// （identityFile/known_hosts），本模块不读不存任何密钥。
// 满足 device-core 传输契约：open/probe/close + exec(handle, argv, timeoutMs)。

import { spawnSync } from 'node:child_process';

const HOST_RE = /^[A-Za-z0-9._-]{1,253}$/;
const USER_RE = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/;
const SHK = new Set(['accept-new', 'yes', 'no']);

export function createSshTransport(options = {}) {
  const sshPath = typeof options.sshPath === 'string' && options.sshPath.length > 0 ? options.sshPath : 'ssh';
  const strictHostKeyChecking = SHK.has(options.strictHostKeyChecking) ? options.strictHostKeyChecking : 'accept-new';

  const checkDevice = (device) => {
    if (device === null || typeof device !== 'object') return 'device required';
    if (!HOST_RE.test(device.host ?? '')) return 'host must be a plain hostname or IP';
    if (!USER_RE.test(device.user ?? '')) return 'user must be 1-32 safe chars';
    if (device.port !== undefined && !(Number.isInteger(device.port) && device.port >= 1 && device.port <= 65535)) return 'port must be 1..65535';
    if (device.identityFile !== undefined && !(typeof device.identityFile === 'string' && device.identityFile.startsWith('/') && device.identityFile.length <= 4096 && !device.identityFile.includes('\0'))) return 'identityFile must be an absolute path';
    return null;
  };

  const baseArgs = (handle) => {
    const args = ['-o', 'BatchMode=yes', '-o', `StrictHostKeyChecking=${handle.strictHostKeyChecking}`, '-o', 'ClearAllForwardings=yes', '-o', `ConnectTimeout=${Math.ceil(handle.connectTimeoutMs / 1000)}`];
    if (handle.port !== 22 && handle.port !== undefined) args.push('-p', String(handle.port));
    if (handle.identityFile) args.push('-i', handle.identityFile);
    args.push(`${handle.user}@${handle.host}`);
    return args;
  };

  const run = (handle, argv, timeoutMs) => {
    const spawned = spawnSync(sshPath, [...baseArgs(handle), '--', ...argv], { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (spawned.error) {
      if (spawned.error.code === 'ETIMEDOUT') return { status: null, signal: 'SIGTERM', error: { code: 'SSH_TIMEOUT', message: `Command exceeded ${timeoutMs}ms.` }, stdout: '', stderr: '' };
      if (String(spawned.error.message ?? '').includes('maxBuffer')) return { status: null, signal: null, error: { code: 'SSH_OUTPUT_OVERFLOW', message: 'Command output exceeded the 4MiB capture buffer.' }, stdout: '', stderr: '' };
      return { status: null, signal: null, error: { code: 'SSH_SPAWN', message: `ssh binary unavailable: ${spawned.error.code ?? 'unknown'}` }, stdout: '', stderr: '' };
    }
    return { status: spawned.status, signal: spawned.signal, error: null, stdout: spawned.stdout ?? '', stderr: spawned.stderr ?? '' };
  };

  return {
    open(spec) {
      const invalid = checkDevice(spec);
      if (invalid) return { ok: false, error: { code: 'SSH_INVALID_DEVICE', message: invalid } };
      return { ok: true, handle: { host: spec.host, port: spec.port ?? 22, user: spec.user, identityFile: spec.identityFile ?? null, strictHostKeyChecking, connectTimeoutMs: spec.connectTimeoutMs ?? 5000 } };
    },
    probe(handle) {
      const outcome = run(handle, ['true'], handle.connectTimeoutMs);
      return outcome.status === 0 ? { ok: true } : { ok: false, error: outcome.error ?? { code: 'SSH_PROBE_FAILED', message: `probe exit ${outcome.status ?? 'n/a'} signal ${outcome.signal ?? 'n/a'}` } };
    },
    close() { return { ok: true }; },
    exec(handle, argv, timeoutMs) {
      if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string' && a.length > 0 && !a.includes('\0'))) return { status: null, signal: null, error: { code: 'SSH_INVALID_ARGV', message: 'argv must be non-empty strings' }, stdout: '', stderr: '' };
      return run(handle, argv, timeoutMs);
    },
  };
}
