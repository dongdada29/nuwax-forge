import { spawnSync } from 'node:child_process';
import { delimiter } from 'node:path';
import { resolvePackage } from './resolve.mjs';
import { UsageError } from './args.mjs';

// Crew owns the subcommand-specific validation. Model execution continues to
// enter through the public run command and its budget/context checks.
export function parseCrewArgs(argv) {
  if (!['route', 'patrol', 'trigger', 'usage', 'ledger', 'health', 'verify'].includes(argv[0])) {
    throw new UsageError('crew 需要 route / patrol / trigger / usage / ledger / health / verify');
  }
  return { argv };
}

export function runCrew({ argv }) {
  const crew = resolvePackage('@nuwax-ai/devkit-crew');
  if (!crew) throw new Error('未找到同安装 @nuwax-ai/devkit-crew');
  const result = spawnSync('python3', ['-B', '-m', 'crew.cli', ...argv], {
    stdio: 'inherit', shell: false,
    env: { ...process.env, PYTHONPATH: [crew.root, process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
