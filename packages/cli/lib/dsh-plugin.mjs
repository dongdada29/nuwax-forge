// Use the real DSH/Cordis host; no plugin is loaded into the Forge process.
import { spawnSync } from 'node:child_process';
import { UsageError } from './args.mjs';

export function dshPluginArgv(opts) {
  const { subcommand, profile, package: pkg } = opts;
  if (!['add', 'remove', 'inspect', 'run'].includes(subcommand)) throw new UsageError('dsh-plugin 需要 add、remove、inspect 或 run');
  if (!profile || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profile)) throw new UsageError('dsh-plugin 需要合法的 --profile');
  if (['add', 'remove'].includes(subcommand)) {
    if (!pkg || pkg.startsWith('-') || /[\0\r\n]/.test(pkg)) throw new UsageError('add/remove 需要合法的 --package');
    return ['plugin', '--profile', profile, subcommand, pkg];
  }
  if (pkg) throw new UsageError('inspect/run 不接受 --package');
  return ['--profile', profile, ...(subcommand === 'inspect' ? ['--dump-config'] : [])];
}

export function runDshPlugin(opts) {
  const args = dshPluginArgv(opts);
  const result = spawnSync(opts.binary || 'dsh', args, { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
