import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolvePackage } from './resolve.mjs';
import { UsageError } from './args.mjs';
export function runStack(opts) {
  const pkg = resolvePackage('@nuwax-ai/devkit-stack');
  if (!pkg) throw Error('Stack module unavailable');
  const root = path.join(pkg.root, 'modules', 'stack');
  if (opts.subcommand === 'module') {
    const name = opts.name ?? 'index';
    if (!/^[a-z][a-z-]*$/.test(name)) throw new UsageError('Invalid Stack module');
    const file = name === 'index' ? path.join(root, 'MODULE.md') : path.join(root, 'references', name + '.md');
    process.stdout.write(fs.readFileSync(file, 'utf8')); return;
  }
  const scripts = {runtime:'runtime_guard.py', workflow:'workflow.py', 'task-state':'task_state.py', ledger:'ledger.py', 'im-mentions':'im_mentions.py', 'append-record':'append_record.py', 'commit-attribution':'commit_attribution.py'};
  const script = scripts[opts.subcommand];
  if (!script) throw new UsageError('Unknown Stack operation');
  // Fixed script allowlist, argv only. Existing runtime_guard owns lease/context/backoff,
  // dispatch goes through the installed crew/TaskStore and existing budget gate.
  const args = [];
  if (opts.command) args.push(opts.command);
  for (const [key,value] of Object.entries(opts)) if (!['subcommand','command','name'].includes(key)) args.push('--' + key, String(value));
  const p = spawnSync(process.env.NUWAX_DEVKIT_PYTHON || 'python3', ['-B', path.join(root, 'scripts', script), ...args], {stdio:'inherit'});
  if (p.error) throw p.error;
  process.exitCode = p.status ?? 1;
}
