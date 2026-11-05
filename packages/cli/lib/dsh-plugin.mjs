// Use the real DSH/Cordis host; no plugin is loaded into the Forge process.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from './args.mjs';
import { evaluateTaskEvidence, validateBinding } from './dsh-task-evidence.mjs';

export function dshPluginArgv(opts) {
  const { subcommand, profile, package: pkg, startupBinding } = opts;
  if (!['add', 'remove', 'inspect', 'run'].includes(subcommand)) throw new UsageError('dsh-plugin 需要 add、remove、inspect 或 run');
  if (!profile || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profile)) throw new UsageError('dsh-plugin 需要合法的 --profile');
  if (startupBinding !== undefined) {
    if (subcommand !== 'run') throw new UsageError('--startup-binding 仅 run 支持');
    if (typeof startupBinding !== 'string' || !path.isAbsolute(startupBinding) ||
        startupBinding.length > 4096 || /[\x00-\x1f\x7f]/.test(startupBinding)) {
      throw new UsageError('--startup-binding 需要绝对路径');
    }
  }
  if (['add', 'remove'].includes(subcommand)) {
    if (!pkg || pkg.startsWith('-') || /[\0\r\n]/.test(pkg)) throw new UsageError('add/remove 需要合法的 --package');
    return ['plugin', '--profile', profile, subcommand, pkg];
  }
  if (pkg) throw new UsageError('inspect/run 不接受 --package');
  return ['--profile', profile, ...(subcommand === 'inspect' ? ['--dump-config'] : [])];
}

// Exit code alone cannot certify plugin startup: a plugin init exception only
// produces a host warning and the host still exits 0. With --startup-binding
// the operator's binding file gates `run` on the observer's startup evidence.
export function readStartupBinding(file) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    throw new UsageError(`--startup-binding 无法读取或解析: ${error.message}`);
  }
  try { return validateBinding(parsed); } catch (error) {
    throw new UsageError(`--startup-binding 结构不合法: ${error.message}`);
  }
}

export function runDshPlugin(opts) {
  const args = dshPluginArgv(opts);
  const binding = opts.startupBinding !== undefined ? readStartupBinding(opts.startupBinding) : null;
  const result = spawnSync(opts.binary || 'dsh', args, { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (binding) {
    const evaluation = evaluateTaskEvidence(binding, { status: result.status, signal: result.signal, error: null });
    if (!evaluation.passed) {
      const detail = evaluation.evidenceValid
        ? `plugin not ready: ${evaluation.statuses.map(s => `${s.entryId}=${s.status}`).join(', ')}`
        : 'missing-or-invalid startup evidence';
      process.stderr.write(`forge dsh-plugin: plugin startup failed (host exit ${result.status}); ${detail}\n`);
      if (process.exitCode === 0) process.exitCode = 1;
    }
  }
}
