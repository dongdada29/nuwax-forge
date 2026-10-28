#!/usr/bin/env node
// Python 实际执行入口的 JSON stdin bridge；源码与五包安装共用本 CLI 内算法，无 shell/prompt argv。
import { readFileSync } from 'node:fs';
import { prepareExecution, settleExecution } from './execution.mjs';
try {
  const raw = readFileSync(0, 'utf8');
  if (Buffer.byteLength(raw) > 4 * 1048576) throw new Error('bridge request 超过 4MiB');
  const request = JSON.parse(raw);
  const result = request.operation === 'prepare' ? prepareExecution(request)
    : request.operation === 'settle' ? settleExecution(request) : (() => { throw new Error('未知 bridge operation'); })();
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ managed: true, allowed: false, reason: 'budget-bridge-error', error: error.message }) + '\n');
  process.exitCode = 1;
}
