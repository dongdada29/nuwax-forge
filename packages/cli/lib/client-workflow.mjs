import { readFileSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allDevkitRoots, resolvePackage } from './resolve.mjs';
import { UsageError } from './args.mjs';
export async function runClientWorkflow(opts) {
  if (!opts.spec || !opts.state) throw new UsageError('client-workflow 需要 --spec 和 --state');
  const spec = JSON.parse(readFileSync(opts.spec, 'utf8'));
  if (typeof spec.python !== 'string' || !spec.python.startsWith('/')) throw new UsageError('spec.python 必须显式绝对路径');
  const runtime = fileURLToPath(new URL('./client_workflow/workflow.py', import.meta.url));
  const validator = resolvePackage('@nuwax-ai/devkit-stack')?.root;
  if (!validator) throw new Error('stack 未安装');
  const args = ['-B', runtime, opts.subcommand ?? 'run', '--spec', realpathSync(opts.spec), '--state', opts.state,
    '--cli', fileURLToPath(new URL('../bin/nuwax-forge.mjs', import.meta.url)), '--validator', validator + '/skills/nuwax-stack/scripts/verification.py',
    '--roots', JSON.stringify(allDevkitRoots())];
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const code = await new Promise((resolve, reject) => {
    const p = spawn(spec.python, args, { stdio: 'inherit', env });
    p.once('error', reject); p.once('close', resolve);
  });
  process.exitCode = code ?? 1;
}
