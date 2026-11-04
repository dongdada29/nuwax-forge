// Opt-in installed-host contract smoke. Uses native DSH's registry, guards and
// dispatch, an isolated HOME, and an in-process HTTP fixture. No PA DB/provider.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import * as bridge from '../index.mjs';

const [resources] = process.argv.slice(2);
assert(resources, 'Usage: ELECTRON_RUN_AS_NODE=1 <DSH Electron> native-smoke.mjs <DSH Resources>');
const root = mkdtempSync(join(tmpdir(), 'forge-pa-native-fixture-'));
let server, ctx;
try {
  process.env.HOME = join(root, 'home'); process.env.DSH_HOME = join(root, 'dsh'); process.env.DSH_AGENTS_HOME = join(root, 'agents');
  for (const dir of [process.env.HOME, process.env.DSH_HOME, process.env.DSH_AGENTS_HOME]) mkdirSync(dir);
  const native = name => join(resources, 'app.asar/dsh/node_modules/@deepseek-ai', name);
  assert.equal(JSON.parse(readFileSync(join(native('dsh-tools'), 'package.json'))).version, '0.2.1-rc.5');
  const { Context, Service } = await import(pathToFileURL(join(native('cordis'), 'lib/index.js')));
  const { default: ToolRuntime } = await import(pathToFileURL(join(native('dsh-tools'), 'lib/index.js')));
  let reads = 0, mutations = 0;
  server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tasks') reads++; else mutations++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tasks: [{ id: 'native-pa-fixture-task', commandId: 'native-create', goal: 'HTTP fixture only', status: 'queued', deliveryStatus: 'pending', activeAttemptId: null }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  class PromptFixture extends Service { constructor(context) { super(context, 'systemPrompt'); } tools() { return () => {}; } }
  ctx = new Context(); await ctx.plugin(PromptFixture); await ctx.plugin(ToolRuntime, { mode: 'native' });
  const fiber = ctx.plugin(bridge, { schemaVersion: 1, origin: `http://127.0.0.1:${server.address().port}`, instanceId: 'native-fixture', botId: 'native-fixture-bot', auth: { mode: 'loopback' } });
  await fiber;
  assert.deepEqual(ctx.tools.schemas().map(row => row.name), ['personal_agent_tasks', 'personal_agent_task', 'personal_agent_request_preview']);
  const call = (name, args, signal = new AbortController().signal) => ctx.tools.execute({ name, callId: 'native-fixture-call', arguments: args, signal, agent: { session: { id: 'native-fixture-session' } } });
  const list = await call('personal_agent_tasks', {});
  assert.equal(list.isError, false); assert.equal(list.value.tasks[0].taskId, 'native-pa-fixture-task'); assert.equal(reads, 1);
  const preview = await call('personal_agent_request_preview', { requestId: 'native-preview', goal: 'Review in PA first' });
  assert.equal(preview.isError, false); assert.equal(preview.value.submission.paTaskCreated, false); assert.equal(preview.value.submission.executionAuthorized, false);
  assert.equal(preview.value.source.callingSessionId, 'native-fixture-session'); assert.equal(reads, 1);
  const release = ctx.tools.guard(() => 'native-fixture-denial');
  assert.equal((await call('personal_agent_tasks', {})).isError, true); release(); assert.equal(reads, 1);
  const controller = new AbortController(); controller.abort();
  assert.equal((await call('personal_agent_tasks', {}, controller.signal)).isError, true); assert.equal(reads, 1);
  assert.equal((await call('personal_agent_tasks', { origin: 'http://example.test' })).isError, true); assert.equal(reads, 1);
  await fiber.dispose(); assert.equal(ctx.tools.schemas().length, 0); assert.equal(mutations, 0);
  console.log(JSON.stringify({ dshTools: '0.2.1-rc.5', fixture: 'loopback-http', registration: 'passed', read: 'passed',
    unsubmittedPreview: 'passed', guardDenial: 'passed', cancellation: 'passed', argumentRejection: 'passed', disposal: 'passed',
    paInstancesAccessed: 0, paDatabasesAccessed: 0, httpMutations: mutations, modelCalls: 0 }));
} finally {
  await ctx?.fiber.dispose();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  rmSync(root, { recursive: true, force: true });
}
