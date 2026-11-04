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
