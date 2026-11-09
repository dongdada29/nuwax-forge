// Loaded in the installed DSH Electron's Node mode. The bridge entry/config are
// exactly the patch produced by public bots prepare, rather than a hand patch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [resources, patchFile, modelMarker] = process.argv.slice(2);
assert(resources && patchFile && modelMarker);
const row = JSON.parse(fs.readFileSync(patchFile))[0].insert[0];
const native = name => path.join(resources, 'app.asar/dsh/node_modules/@deepseek-ai', name);
const nativeVersion = JSON.parse(fs.readFileSync(path.join(native('dsh-tools'), 'package.json'))).version;
assert.ok(['0.2.1-rc.5', '0.2.2-rc.1'].includes(nativeVersion));
const { Context, Service } = await import(pathToFileURL(path.join(native('cordis'), 'lib/index.js')));
const { default: ToolRuntime } = await import(pathToFileURL(path.join(native('dsh-tools'), 'lib/index.js')));
const bridge = await import(pathToFileURL(row.name));
class PromptFixture extends Service { constructor(ctx) { super(ctx, 'systemPrompt'); } tools() { return () => {}; } }
const ctx = new Context();
try {
  await ctx.plugin(PromptFixture);
  await ctx.plugin(ToolRuntime, nativeVersion === '0.2.1-rc.5' ? { mode: 'native' } : {});
  if (nativeVersion === '0.2.2-rc.1') {
    await ctx.plugin(await import(pathToFileURL(path.join(native('dsh-tool-executor-native'), 'lib/index.js'))));
  }
  const fiber = ctx.plugin(bridge, row.config); await fiber;
  assert.deepEqual(ctx.tools.schemas().map(tool => tool.name), ['forge_status', 'forge_prepare']);
  const call = async (name, args, signal = new AbortController().signal) => {
    const agent = { session: { id: 'composed-native-session' } };
    if (nativeVersion === '0.2.1-rc.5') {
      return ctx.tools.execute({ name, callId: 'composed-native', arguments: args, signal, agent });
    }
    const batch = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: 'composed-native', name, arguments: JSON.stringify(args) }],
      signal, agent,
    });
    return batch.results[0].result;
  };
  const args = { workspace: 'review', taskKey: 'composed-native', brief: 'Read only the explicit fixture workspace; report and stop.' };
  const result = await call('forge_prepare', args);
  assert.equal(result.isError, false); assert.equal(result.value.status, 'prepared');
  assert.equal(result.value.modelDispatched, false); assert.equal(result.value.source.executionSessionId, null);
  assert.equal(result.value.operatorRun.requiresOperatorAuthorization, true);
  const status = await call('forge_status', { attemptId: result.value.attemptId });
  assert.equal(status.isError, false); assert.equal(status.value.source.callingSessionId, 'composed-native-session');
  assert.equal(status.value.budget.chargedTokens, null);
  const deny = ctx.tools.guard(() => 'composed-native-denial');
  assert.equal((await call('forge_prepare', args)).isError, true); deny();
  const controller = new AbortController(); controller.abort();
  assert.equal((await call('forge_prepare', args, controller.signal)).isError, true);
  assert.equal(fs.readdirSync(row.config.stateRoot).length, 2);
  await fiber.dispose(); assert.equal(ctx.tools.schemas().length, 0);
  assert.equal(fs.existsSync(modelMarker), false);
  console.log(JSON.stringify({ nativeTools: nativeVersion, tools: ['forge_status', 'forge_prepare'], prepare: 'passed', status: 'passed', guard: 'passed', cancellation: 'passed', disposal: 'passed', modelCalls: 0 }));
} finally { await ctx.fiber.dispose(); }
