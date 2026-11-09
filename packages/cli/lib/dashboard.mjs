// 本地 Crew 看板：显式输入、无模型调用，不读取默认用户状态。
import { spawnSync } from 'node:child_process';
import { delimiter } from 'node:path';
import { resolvePackage } from './resolve.mjs';
import { UsageError } from './args.mjs';

export function runDashboard(opts) {
  if (!opts.ledger || !opts.registry || (!opts.out && !opts.serve) || (opts.out && opts.serve)) throw new UsageError('dashboard 需要 --ledger --registry 和 --out 或 --serve');
  const crew = resolvePackage('@nuwax-ai/devkit-crew');
  if (!crew) throw new Error('未找到同安装 @nuwax-ai/devkit-crew');
  const dashboard = resolvePackage('@nuwax-ai/devkit-dashboard');
  if (!dashboard) throw new Error('未找到同安装 @nuwax-ai/devkit-dashboard');
  const args = ['-B', '-m', 'forge_dashboard'];
  for (const key of ['alerts', 'ledger', 'registry', 'health', 'matrix', 'task-store', 'agent-state', 'agent-state-root', 'host-budget', 'approval-store', 'personal-agent-snapshot', 'embed-origin', 'out', 'port', 'refresh-seconds']) {
    if (opts[key]) args.push('--' + key, opts[key]);
  }
  if (opts.serve) args.push('--serve');
  const result = spawnSync(opts.python || 'python3', args, {
    cwd: process.cwd(), stdio: 'inherit',
    env: { ...process.env, PYTHONPATH: [dashboard.root, crew.root, process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
