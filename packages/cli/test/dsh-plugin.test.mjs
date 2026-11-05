import test from 'node:test';
import assert from 'node:assert/strict';
import { dshPluginArgv } from '../lib/dsh-plugin.mjs';

test('DSH 插件通过实际宿主和显式 profile 运行，参数按 argv 传递', () => {
  assert.deepEqual(dshPluginArgv({subcommand:'add',profile:'web',package:'@example/plugin'}), ['plugin','--profile','web','add','@example/plugin']);
  assert.deepEqual(dshPluginArgv({subcommand:'remove',profile:'desktop',package:'fixture'}), ['plugin','--profile','desktop','remove','fixture']);
  assert.deepEqual(dshPluginArgv({subcommand:'inspect',profile:'web'}), ['--profile','web','--dump-config']);
  assert.deepEqual(dshPluginArgv({subcommand:'run',profile:'web'}), ['--profile','web']);
  for (const opts of [{subcommand:'run'}, {subcommand:'add',profile:'../web',package:'x'}, {subcommand:'add',profile:'web',package:'--help'}, {subcommand:'run',profile:'web',package:'x'}]) assert.throws(() => dshPluginArgv(opts));
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { runDshPlugin, readStartupBinding } from '../lib/dsh-plugin.mjs';
import { DSH_RUNTIME_VERSION } from '../lib/dsh-task-evidence.mjs';

function fakeDsh(dir, report) {
  const script = path.join(dir, 'fake-dsh.mjs');
  fs.writeFileSync(script, `#!/usr/bin/env node
import fs from 'node:fs';
const bindingFile = process.env.FAKE_BINDING;
if (bindingFile && process.env.FAKE_STATUSES !== undefined) {
  const binding = JSON.parse(fs.readFileSync(bindingFile, 'utf8'));
  const report = { kind: 'dsh-plugin-startup-evidence', scope: 'startup', ...binding, observedAt: new Date().toISOString(), statuses: binding.targetEntryIds.map((id, i) => ({ entryId: id, status: process.env.FAKE_STATUSES.split(',')[i] })) };
  fs.writeFileSync(binding.reportPath, JSON.stringify(report));
}
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`);
  fs.chmodSync(script, 0o755);
  return script;
}

test('run --startup-binding：exit 0 但插件未就绪必须判失败（注入异常场景）', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-gate-')));
  const bindingPath = path.join(dir, 'binding.json');
  const binding = { schemaVersion: 1, taskRef: { source: 'test:isolated', taskKey: 'u1' }, attemptId: 'a', runId: 'r', invocationId: randomBytes(16).toString('hex'), targetEntryIds: ['include:target'], runtimeVersion: DSH_RUNTIME_VERSION, reportPath: path.join(dir, 'report.json') };
  fs.writeFileSync(bindingPath, JSON.stringify(binding));
  const fake = fakeDsh(dir);
  const env = { FAKE_BINDING: bindingPath, FAKE_EXIT: '0' };
  const run = statuses => {
    process.env.FAKE_BINDING = bindingPath;
    process.env.FAKE_STATUSES = statuses;
    try { runDshPlugin({ subcommand: 'run', profile: 'audit', binary: fake, startupBinding: bindingPath }); } finally {
      delete process.env.FAKE_BINDING; delete process.env.FAKE_STATUSES;
    }
    const code = process.exitCode; process.exitCode = 0; return code;
  };
  assert.equal(run('active'), 0, 'active 插件 exit 0 保持 0');
  assert.equal(run('failed'), 1, 'host exit 0 但插件 failed 必须 1');
  assert.equal(run('pending'), 1, 'pending 也不算就绪');
  fs.unlinkSync(binding.reportPath);
  process.env.FAKE_STATUSES = '';
  try { runDshPlugin({ subcommand: 'run', profile: 'audit', binary: fake, startupBinding: bindingPath }); } finally { delete process.env.FAKE_STATUSES; }
  const missing = process.exitCode; process.exitCode = 0;
  assert.equal(missing, 1, '证据缺失/非法时 host exit 0 也必须 1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('startup-binding 参数校验与绑定文件校验', () => {
  assert.deepEqual(dshPluginArgv({ subcommand: 'run', profile: 'web', startupBinding: '/abs/binding.json' }), ['--profile', 'web']);
  assert.throws(() => dshPluginArgv({ subcommand: 'run', profile: 'web', startupBinding: 'relative.json' }));
  assert.throws(() => dshPluginArgv({ subcommand: 'inspect', profile: 'web', startupBinding: '/abs/binding.json' }));
  assert.throws(() => readStartupBinding('/nonexistent/binding.json'));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-bind-')));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{"schemaVersion":99}');
  assert.throws(() => readStartupBinding(bad));
  fs.rmSync(dir, { recursive: true, force: true });
});
