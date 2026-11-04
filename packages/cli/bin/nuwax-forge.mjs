#!/usr/bin/env node
// Nuwax Forge CLI —— 零外部依赖 Node ESM。定位安装后的同级包（require.resolve），
// 不硬编码试点目录或源码绝对路径；子进程一律 argv 数组，不经 shell 拼接。
import { runStack } from '../lib/stack.mjs';
import { runHelp } from '../lib/help.mjs';
import { runDoctor } from '../lib/doctor.mjs';
import { runInit } from '../lib/init.mjs';
import { runVerify } from '../lib/verify.mjs';
import { runClientWorkflow } from '../lib/client-workflow.mjs';
import { runClientVerify } from '../lib/client-verify.mjs';
import { runGui } from '../lib/gui.mjs';
import { runBudget } from '../lib/budget/cli.mjs';
import { runAgent } from '../lib/agent/index.mjs';
import { runPlan } from '../lib/run.mjs';
import { runDashboard } from '../lib/dashboard.mjs';
import { runDshPlugin } from '../lib/dsh-plugin.mjs';
import { parseArgs, UsageError, USAGE } from '../lib/args.mjs';

const COMMANDS = {
  'dsh-plugin': { subcommands: ['add', 'remove', 'inspect', 'run'], flags: { profile: 'value', package: 'value', binary: 'value' }, run: runDshPlugin },
  dashboard: { flags: { ledger: 'value', registry: 'value', health: 'value', matrix: 'value', 'task-store': 'value', 'agent-state': 'value', 'agent-state-root': 'value', 'host-budget': 'value', 'approval-store': 'value', 'personal-agent-snapshot': 'value', 'embed-origin': 'value', out: 'value', serve: 'boolean', port: 'value', 'refresh-seconds': 'value', python: 'value' }, run: runDashboard },
  stack: { subcommands: ['module', 'runtime', 'task-state', 'ledger', 'im-mentions', 'append-record', 'commit-attribution'], flags: { name: 'value', command: 'value', profile: 'value', input: 'value', dns: 'value', owner: 'value', action: 'value', seconds: 'value' }, run: runStack },
  agent: { subcommands: ['doctor', 'prepare', 'run', 'reconcile'],
    flags: { runtime: 'value', binary: 'value', spec: 'value', state: 'value', 'brief-file': 'value', json: 'boolean' }, run: runAgent },
  help: { run: runHelp },
  doctor: { flags: { json: 'boolean' }, run: opts => runDoctor(opts) },
  init: { flags: { project: 'value', recipe: 'value' }, run: opts => runInit(opts) },
  verify: {
    flags: { project: 'value', state: 'value', 'task-key': 'value', node: 'value', python: 'value', reuse: 'boolean' },
    run: opts => runVerify(opts),
  },
  'client-verify': {
    flags: { project: 'value', state: 'value', node: 'value', python: 'value' },
    run: opts => runClientVerify(opts),
  },
  'client-workflow': { subcommands: ['run', 'seal'], flags: { spec: 'value', state: 'value' }, run: runClientWorkflow },
  gui: {
    subcommands: ['run'],
    flags: {
      recipe: 'value', state: 'value', sdk: 'value', runtime: 'value',
      cdp: 'value', 'launch-config': 'value', json: 'boolean', 'max-wall-seconds': 'value',
      'budget-spec': 'value', 'budget-history': 'value',
    },
    run: async opts => { if (opts.subcommand !== 'run') throw new UsageError('gui 需要子命令 run（当前仅 gui run，显式 live）'); await runGui(opts); },
  },
  budget: {
    subcommands: ['estimate', 'reconcile', 'guard'],
    flags: {
      spec: 'value', history: 'value', out: 'value', json: 'boolean', estimate: 'value', actual: 'value',
      sessions: 'value', budget: 'value', marker: 'value', 'parent-id': 'value',
    },
    run: opts => runBudget(opts),
  },
  run: {
    flags: { plan: 'value', project: 'value', state: 'value', 'brief-file': 'value', python: 'value', timeout: 'value' },
    run: opts => runPlan(opts),
  },
};

try {
  const [cmd, options] = parseArgs(process.argv.slice(2), COMMANDS);
  await COMMANDS[cmd].run(options);
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`参数错误：${error.message}\n\n${USAGE}\n`);
    process.exit(2);
  }
  process.stderr.write(`错误：${error.message}\n`);
  process.exit(1);
}
