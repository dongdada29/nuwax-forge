import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, UsageError } from '../lib/args.mjs';
import { nodeMajor, pythonMinor } from '../lib/doctor.mjs';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(pkg, 'bin', 'nuwax-devkit.mjs');

function run(args, env = {}) {
  return new Promise(resolvePromise => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => resolvePromise({ code: error ? error.code : 0, stdout, stderr }));
  });
}

test('help：无参/显式 help 均输出用法并退出 0', async () => {
  for (const args of [[], ['help']]) {
    const result = await run(args);
    assert.equal(result.code, 0);
    for (const keyword of ['doctor', 'init --project', 'verify --project', 'state']) assert.ok(result.stdout.includes(keyword));
  }
});

test('未知命令/未知 flag/缺值参数一律拒绝且非 0', async () => {
  assert.equal((await run(['frobnicate'])).code, 2);
  assert.match((await run(['verify', '--project', '/tmp'])).stderr, /--state/);
  const unknownFlag = await run(['verify', '--project', '/tmp', '--state', '/tmp/x', '--task-key', 'k', '--wat']);
  assert.notEqual(unknownFlag.code, 0);
  assert.match(unknownFlag.stderr, /不支持 --wat/);
  const missingValue = await run(['verify', '--project']);
  assert.notEqual(missingValue.code, 0);
  assert.match(missingValue.stderr, /需要一个非空值/);
  const positional = await run(['doctor', 'extra']);
  assert.notEqual(positional.code, 0);
});

test('doctor：monorepo 安装下通过，--json 结构完整', async () => {
  const text = await run(['doctor']);
  assert.equal(text.code, 0);
  for (const name of ['@nuwax-ai/devkit-stack', '@nuwax-ai/devkit-crew', '@nuwax-ai/nuwa-sdlc-kit', '@nuwax-ai/devkit-contracts']) {
    assert.ok(text.stdout.includes(name), name);
  }
  const jsonRun = await run(['doctor', '--json']);
  assert.equal(jsonRun.code, 0);
  const report = JSON.parse(jsonRun.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.checks.filter(c => c.check.startsWith('package:')).length, 5);
});

test('doctor：包不可解析（缺依赖）时非 0 且给出清晰诊断', async () => {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'devkit-empty-root-'));
  try {
    const result = await run(['doctor'], { NUWAX_DEVKIT_RESOLVE_ROOT: empty });
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /未安装或不可解析/);
    assert.match(result.stdout, /@nuwax-ai\/devkit-stack/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('doctor：缺 python 时非 0 诊断（指向不存在的解释器）', async () => {
  const result = await run(['doctor'], { NUWAX_DEVKIT_PYTHON: '/nonexistent/python-for-test' });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /不可用|未找到/);
});

test('版本解析辅助：Node 低于 22 / Python 低于 3.10 判不满足', () => {
  assert.equal(nodeMajor('v24.18.0'), 24);
  assert.equal(nodeMajor('v21.7.0') >= 22, false);
  assert.equal(nodeMajor('garbage'), null);
  assert.deepEqual(pythonMinor('Python 3.9.18'), [3, 9]);
  assert.deepEqual(pythonMinor('Python 3.15.0'), [3, 15]);
  assert.equal(pythonMinor('nope'), null);
});

test('parseArgs：布尔 flag 不吃值，值不能是 -- 开头', () => {
  const commands = { verify: { flags: { reuse: 'boolean', 'task-key': 'value' } } };
  const [, options] = parseArgs(['verify', '--reuse', '--task-key', 'k1'], commands);
  assert.deepEqual(options, { reuse: true, 'task-key': 'k1' });
  assert.throws(() => parseArgs(['verify', '--task-key', '--reuse'], commands), UsageError);
  assert.throws(() => parseArgs(['verify', '--task-key', ''], commands), UsageError);
});
