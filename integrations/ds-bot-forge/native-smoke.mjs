// Run with the installed Electron in Node mode; never opens a user profile.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initializeBridge } from './bridge.mjs';
import * as bridge from './index.mjs';

const [resources, nodeBinary] = process.argv.slice(2);
assert(resources && nodeBinary, 'Usage: ELECTRON_RUN_AS_NODE=1 <DSH Electron> native-smoke.mjs <DSH Resources> <trusted Node binary>');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-native-tools-')));
const repo = fileURLToPath(new URL('../../', import.meta.url));
try {
  process.env.HOME = path.join(root, 'home');
  process.env.DSH_HOME = path.join(root, 'dsh');
  process.env.DSH_AGENTS_HOME = path.join(root, 'agents');
  for (const key of ['HOME', 'DSH_HOME', 'DSH_AGENTS_HOME']) fs.mkdirSync(process.env[key]);
  const native = packageName => path.join(resources, 'app.asar/dsh/node_modules/@deepseek-ai', packageName);
  assert.equal(JSON.parse(fs.readFileSync(path.join(native('dsh-tools'), 'package.json'))).version, '0.2.1-rc.5');
  const { Context, Service } = await import(pathToFileURL(path.join(native('cordis'), 'lib/index.js')));
  const { default: ToolRuntime } = await import(pathToFileURL(path.join(native('dsh-tools'), 'lib/index.js')));
  const worktree = path.join(root, 'wt'); fs.mkdirSync(worktree);
  assert.equal(spawnSync('git', ['init', '-q', worktree]).status, 0);
  const runtime = path.join(root, 'runtime.mjs'), marker = path.join(root, 'unexpected-model');
  fs.writeFileSync(runtime, `#!${nodeBinary}\nimport fs from 'node:fs';
if(process.argv.includes('--version'))console.log('codex-fixture');
else if(process.argv.includes('--help'))console.log('--json --ephemeral --ignore-user-config --ignore-rules --sandbox --cd');
else {fs.writeFileSync(${JSON.stringify(marker)},'unexpected');process.exit(99)}
`, { mode: 0o700 });
  const config = { schemaVersion: 1, nodeBinary, forgeRoot: repo, forgeEntry: path.join(repo, 'packages/cli/bin/nuwax-forge.mjs'),
    stateRoot: path.join(root, 'states'), allowPrepare: true, workspaces: { fixture: { worktree,
      runtime: { kind: 'codex', model: 'fixture-model', binary: runtime, contextMode: 'fresh-exec' }, permissions: { mode: 'read-only' },
      budget: { maxTokens: 20000, maxWallSeconds: 5, maxAttempts: 1 }, budgetSpec: { schemaVersion: 1, id: 'native-fixture', mode: 'model', taskKind: 'text-implementation',
        model: { name: 'fixture-model' }, expectedCalls: 1, initialContextTokens: 1000, perCallOutputTokens: 10, budgetTokens: 20000 } } } };
  initializeBridge(config);
  // Only system-prompt ownership is a fixture; Cordis lifecycle, registry,
  // schema validation, policy guard and dispatch are the actual shipped code.
  class PromptFixture extends Service { constructor(ctx) { super(ctx, 'systemPrompt'); } tools() { return () => {}; } }
  const ctx = new Context();
  await ctx.plugin(PromptFixture); await ctx.plugin(ToolRuntime, { mode: 'native' });
  const fiber = ctx.plugin(bridge, config); await fiber;
  assert.deepEqual(ctx.tools.schemas().map(row => row.name), ['forge_status', 'forge_prepare']);
  const call = (name, args, signal = new AbortController().signal) => ctx.tools.execute({ name, callId: 'native-fixture', arguments: args, signal, agent: { session: { id: 'native-fixture-session' } } });
  const args = { workspace: 'fixture', taskKey: 'native-test', brief: 'Read allowed fixture workspace and stop.' };
  const prepared = await call('forge_prepare', args);
  assert.equal(prepared.isError, false); assert.equal(prepared.value.status, 'prepared');
  const status = await call('forge_status', { attemptId: prepared.value.attemptId });
  assert.equal(status.value.source.callingSessionId, 'native-fixture-session');
  const deny = ctx.tools.guard(() => 'fixture-denial');
  assert.equal((await call('forge_prepare', args)).isError, true); deny();
  const controller = new AbortController(); controller.abort();
  assert.equal((await call('forge_prepare', args, controller.signal)).isError, true);
  assert.equal(fs.readdirSync(config.stateRoot).length, 2);
  assert.equal(fs.existsSync(marker), false);
  await fiber.dispose(); assert.equal(ctx.tools.schemas().length, 0); await ctx.fiber.dispose();
  console.log(JSON.stringify({ dshTools: '0.2.1-rc.5', registration: 'passed', prepare: 'passed', status: 'passed', guardDenial: 'passed', cancellation: 'passed', disposal: 'passed', modelCalls: 0 }));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
