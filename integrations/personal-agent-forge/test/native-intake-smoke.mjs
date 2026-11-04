// Installed DSH registry/guard/dispatch against an in-memory intake HTTP fixture.
// Explicit opt-in only; no PA DB, production instance, worker or provider.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { fingerprint } from '../admission.mjs';
import * as bridge from '../index.mjs';

const [resources] = process.argv.slice(2);
assert(resources, 'Usage: ELECTRON_RUN_AS_NODE=1 <DSH Electron> native-intake-smoke.mjs <DSH Resources>');
const root = mkdtempSync(join(tmpdir(), 'forge-pa-native-intake-'));
let server, ctx;
try {
  process.env.HOME = join(root, 'home'); process.env.DSH_HOME = join(root, 'dsh'); process.env.DSH_AGENTS_HOME = join(root, 'agents');
  for (const dir of [process.env.HOME, process.env.DSH_HOME, process.env.DSH_AGENTS_HOME]) mkdirSync(dir);
  const native = name => join(resources, 'app.asar/dsh/node_modules/@deepseek-ai', name);
  assert.equal(JSON.parse(readFileSync(join(native('dsh-tools'), 'package.json'))).version, '0.2.1-rc.5');
  const { Context, Service } = await import(pathToFileURL(join(native('cordis'), 'lib/index.js')));
  const { default: ToolRuntime } = await import(pathToFileURL(join(native('dsh-tools'), 'lib/index.js')));
  const token = 'native-intake-fixture-'.padEnd(43, 'x');
  let posts = 0, reads = 0, task, approval;
  server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`); assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.host, 'pa.fixture.test');
    if (req.method === 'POST' && req.url === '/api/tasks') {
      posts++; let body = ''; for await (const chunk of req) body += chunk;
      const command = JSON.parse(body);
      assert.deepEqual(Object.keys(command), ['commandId', 'goal', 'engine', 'workspaceId', 'source']);
      const request = { goal: command.goal, engine: 'forge', workspaceId: command.workspaceId, intakeId: 'native-intake', source: command.source, configuration: { fixture: true } };
      task = { id: 'native-pa-task', ...command, intakeId: 'native-intake', status: 'paused', deliveryStatus: 'pending', activeAttemptId: null,
        admission: { approvalId: 'native-pa-admission', fingerprint: fingerprint(request), status: 'pending' } };
      approval = { id: 'native-pa-admission', taskId: task.id, kind: 'task_admission', attemptId: null, runId: null, fingerprint: task.admission.fingerprint,
        request, status: 'pending', selectedOptionId: null, resolvedAt: null };
      res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify(task)); return;
    }
    assert.equal(req.method, 'GET'); assert.equal(req.url, '/api/tasks/native-pa-task'); reads++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ task, approvals: [approval], cursor: 0, events: [], artifacts: [], stages: [], runs: [], verifications: [] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  class PromptFixture extends Service { constructor(context) { super(context, 'systemPrompt'); } tools() { return () => {}; } }
  ctx = new Context(); await ctx.plugin(PromptFixture); await ctx.plugin(ToolRuntime, { mode: 'native' });
  const fiber = ctx.plugin(bridge, { schemaVersion: 1, origin: `http://127.0.0.1:${server.address().port}`, instanceId: 'native-fixture-instance', botId: 'native-fixture-bot',
    auth: { mode: 'intake', intakeId: 'native-intake', publicOrigin: 'https://pa.fixture.test', credentials: () => ({ intakeToken: token }) },
    submission: { enabled: true, workspaces: { fixture: 'registered-native-workspace' } } });
  await fiber;
  const args = { requestId: 'native-request', goal: 'Original PA admission required', workspace: 'fixture' };
  const call = (name, values, signal = new AbortController().signal) => ctx.tools.execute({ name, callId: 'native-tool-call', arguments: values, signal, agent: { session: { id: 'actual-native-session' } } });
  const preview = await call('personal_agent_request_preview', args); assert.equal(preview.isError, false); assert.equal(preview.value.status, 'preview_only'); assert.equal(posts, 0);
  const release = ctx.tools.guard(() => 'native-fixture-denial');
  assert.equal((await call('personal_agent_request', args)).isError, true); release(); assert.equal(posts, 0);
  const controller = new AbortController(); controller.abort(); assert.equal((await call('personal_agent_request', args, controller.signal)).isError, true); assert.equal(posts, 0);
  assert.equal((await call('personal_agent_request', { ...args, source: { sessionId: 'spoof' } })).isError, true); assert.equal(posts, 0);
  const submitted = await call('personal_agent_request', args);
  assert.equal(submitted.isError, false); assert.equal(submitted.value.status, 'awaiting_human_approval'); assert.equal(submitted.value.submission.executionAuthorized, false);
  assert.equal(submitted.value.snapshot.task.source.sessionId, 'actual-native-session'); assert.equal(submitted.value.admission.id, 'native-pa-admission');
  assert.equal(posts, 1); assert.equal(reads, 1);
  assert.equal(ctx.tools.schemas().some(row => /approve|control/.test(row.name)), false);
  await fiber.dispose(); assert.equal(ctx.tools.schemas().length, 0);
  console.log(JSON.stringify({ dshTools: '0.2.1-rc.5', fixture: 'loopback-intake-http', preview: 'passed', nativeGuard: 'passed', cancellation: 'passed',
    sourceSpoofRejection: 'passed', restrictedIntake: 'passed', originalPendingAdmission: 'passed', disposal: 'passed', httpPosts: posts, modelCalls: 0, paInstancesAccessed: 0 }));
} finally {
  await ctx?.fiber.dispose(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  rmSync(root, { recursive: true, force: true });
}
