// 公开 crew 执行入口；同安装 Python + Node budget bridge，不自动创建会话/重试/恢复。
import { spawn } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { delimiter, join, resolve } from 'node:path';
import { allDevkitRoots, resolvePackage } from './resolve.mjs';
import { isInside, realpathNearestExisting, resolveStateReal } from './paths.mjs';
import { UsageError } from './args.mjs';
import { readBoundedJson } from './budget/execution.mjs';

function declared(holder) {
  return holder?.mode === 'model' || holder?.mode === 'no-model' || typeof holder?.modelTask === 'boolean'
    || Boolean(holder?.model) || holder?.budgetSpec?.mode === 'model'
    || ['fresh-exec', 'no-model'].includes(holder?.runtime?.contextMode) || Boolean(holder?.runtime?.model);
}

export async function runPlan(opts) {
  if (!opts.plan || !opts.project || !opts.state || !opts['brief-file']) throw new UsageError('run 需要 --plan --project --state --brief-file');
  const project = realpathNearestExisting(resolve(opts.project)).real;
  resolveStateReal(resolve(opts.state)); // 失效链接先拒绝；保留全部尚不存在的后缀
  const state = realpathNearestExisting(resolve(opts.state)).real;
  for (const root of [project, ...allDevkitRoots()]) {
    const real = realpathNearestExisting(root).real;
    if (isInside(real, state) || isInside(state, real)) throw new UsageError('--state 必须仓外，且不能覆盖项目/devkit 安装目录');
  }
  const brief = resolve(opts['brief-file']), plan = resolve(opts.plan);
  for (const file of [brief, plan]) {
    if (!statSync(file).isFile() || statSync(file).size > 1048576) throw new UsageError('--plan/--brief-file 必须是 ≤1MiB 的普通文件');
  }
  const planData = readBoundedJson(plan, 'plan');
  if (!declared(planData) && !(planData.assignments?.length && planData.assignments.every(declared))) {
    const blocked = { status: 'blocked', reason: 'missing-execution-declaration', processPassed: false, budgetPassed: false,
      note: '公开 run 入口需要显式声明 mode=model/modelTask=true 或 mode=no-model；旧 Python 内部 legacy 兼容不等于预算治理' };
    mkdirSync(state, { recursive: true });
    const entryFile = join(state, `blocked-declaration-${randomUUID()}.json`);
    writeFileSync(entryFile, JSON.stringify(blocked, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ ...blocked, entryFile }, null, 2) + '\n');
    process.exitCode = 3;
    return;
  }
  const timeout = opts.timeout === undefined ? 900 : Number(opts.timeout);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw new UsageError('--timeout 必须是 1..3600 整数');
  const crew = resolvePackage('@nuwax-ai/devkit-crew');
  if (!crew) throw new Error('未找到同安装 @nuwax-ai/devkit-crew');
  const child = spawn(opts.python || process.env.NUWAX_DEVKIT_PYTHON || 'python3', ['-B', '-m', 'crew', 'run', '--plan', plan, '--worktree', project,
    '--brief', '@' + brief, '--ledger', join(state, 'ledger.jsonl'), '--artifacts', join(state, 'artifacts'), '--timeout', String(timeout)], {
    cwd: crew.root, stdio: 'inherit', env: { ...process.env, NUWAX_DEVKIT_NODE: process.execPath,
      PYTHONPATH: crew.root + (process.env.PYTHONPATH ? delimiter + process.env.PYTHONPATH : '') },
  });
  const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    process.exitCode = await new Promise((resolve_, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve_(signal ? 1 : code));
    });
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
  }
}
