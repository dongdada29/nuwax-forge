import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBridge } from '../bridge.mjs';
import { createClient } from '../client.mjs';
import { apply } from '../index.mjs';

const full = prefix => `${prefix}-${'a'.repeat(240)}`;
const ids = { task: full('task'), attempt: full('attempt'), run: full('run'), stage: full('stage'), bot: full('bot'), session: full('session'), call: full('call') };
const execute = signal => ({ agent: { session: { id: ids.session } }, callId: ids.call, signal: signal ?? new AbortController().signal });
const task = () => ({ id: ids.task, commandId: 'native-command', goal: 'Original PA task', status: 'completed', deliveryStatus: 'pending',
  activeAttemptId: ids.attempt, pauseRequested: false, engine: 'claude', createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T01:00:00Z',
  configSnapshot: { profiles: { developer: { model: 'configured-only', instructions: 'private-instructions' } } },
  usage: { chargedTokens: 0, known: true }, acceptancePassed: true });
const snapshot = () => ({ task: task(), cursor: 2,
  events: [1, 2].map(seq => ({ seq, taskId: ids.task, attemptId: seq === 1 ? null : ids.attempt, type: 'task.updated', createdAt: '2026-11-04T01:00:00Z', data: { arbitrary: 'private-event-payload' } })),
  stages: [{ id: ids.stage, taskId: ids.task, attemptId: ids.attempt, name: 'development', status: 'completed' }],
  runs: [{ id: ids.run, taskId: ids.task, attemptId: ids.attempt, stageId: ids.stage, role: 'developer', status: 'completed', actualModel: 'invented-model', chargedTokens: 0 }],
  artifacts: [{ id: 'artifact-full-id', taskId: ids.task, attemptId: ids.attempt, kind: 'text', name: 'original artifact', content: 'private-artifact-body' }],
  verifications: [{ id: 'verification-full-id', taskId: ids.task, attemptId: ids.attempt, stageId: ids.stage, exitCode: 0, timedOut: false, cancelled: false, command: { command: 'never-execute', args: ['private-argv'] } }],
  approvals: [{ id: 'approval-full-id', taskId: ids.task, attemptId: ids.attempt, runId: ids.run, status: 'resolved', toolCall: { rawInput: { secret: 'private-approval-payload' } } }],
});
const json = (res, value, status = 200, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };

async function fixture(t, handler) {
  const calls = []; let mutations = 0;
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie });
    if (req.method !== 'GET') { mutations++; json(res, { forbidden: true }, 500); return; }
    if (handler) { handler(req, res); return; }
    if (req.url === '/api/tasks') json(res, { tasks: [task()] });
    else if (req.url === `/api/tasks/${ids.task}`) json(res, snapshot());
    else json(res, { code: 'NOT_FOUND' }, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.equal(mutations, 0); });
  const config = { schemaVersion: 1, origin: `http://127.0.0.1:${server.address().port}`, instanceId: 'isolated-pa-fixture', botId: ids.bot, auth: { mode: 'loopback' } };
  return { config, calls, bridge: () => createBridge(config) };
}
const code = expected => failure => { assert.equal(failure.code, expected); return true; };

test('native tools register only reads and explicit preview; complete native IDs survive projection', async t => {
  const f = await fixture(t), registry = new Map();
  const dispose = apply({ tools: { register(definition) { registry.set(definition.name, definition); return () => registry.delete(definition.name); } } }, f.config);
  assert.deepEqual([...registry.keys()], ['personal_agent_tasks', 'personal_agent_task', 'personal_agent_request_preview', 'personal_agent_request']);
  assert.equal(registry.get('personal_agent_request').isConcurrencySafe(), false);
  assert.ok([...registry.values()].filter(row => row.name !== 'personal_agent_request').every(row => row.isConcurrencySafe()));
  const list = await registry.get('personal_agent_tasks').execute({}, execute());
  assert.equal(list.source.botId, ids.bot); assert.equal(list.source.callingSessionId, ids.session); assert.equal(list.source.toolCallId, ids.call);
  assert.equal(list.tasks[0].taskId, ids.task);
  assert.deepEqual(list.tasks[0].taskRef, { source: 'personal-agent:isolated-pa-fixture', taskKey: ids.task });
  const detail = await registry.get('personal_agent_task').execute({ taskId: ids.task }, execute());
  assert.equal(detail.snapshot.task.activeAttemptId, ids.attempt); assert.equal(detail.snapshot.runs[0].id, ids.run);
  assert.equal(detail.snapshot.runs[0].stageId, ids.stage); assert.equal(detail.snapshot.approvals[0].runId, ids.run);
  assert.equal(detail.snapshot.task.status, 'completed'); assert.equal(detail.snapshot.task.deliveryStatus, 'pending');
  assert.equal(detail.snapshot.task.productAcceptancePassed, null); assert.equal(detail.snapshot.historyComplete, null);
  assert.deepEqual(detail.snapshot.runs[0].usage, { known: null, inputTokens: null, outputTokens: null, chargedTokens: null, actualModel: null, executionSessionId: null });
  for (const withheld of ['configured-only', 'private-instructions', 'private-argv', 'private-event-payload', 'private-approval-payload', 'private-artifact-body', 'invented-model']) assert.equal(JSON.stringify(detail).includes(withheld), false);
  assert.equal(detail.snapshot.verifications[0].exitCode, 0);
  dispose(); assert.equal(registry.size, 0); assert.equal(f.calls.length, 2);
});

test('forge delivery event imports certified usage onto task and its run; settlement notes stay withheld', async t => {
  const value = snapshot(); value.cursor = 3;
  value.events.push({ seq: 3, taskId: ids.task, attemptId: ids.attempt, type: 'forge.delivery_verified', createdAt: '2026-11-04T02:00:00Z',
    data: { runId: ids.run, usageKnown: true, chargedTokens: 110, sessionId: 'forge-sess.01', processPassed: true, agentCompleted: true,
      budgetPassed: true, acceptancePassed: null, verifiedPatchSha256: 'a'.repeat(64), verificationIds: ['v-1'],
      kind: 'client-agent-run-v1', observedBudget: { note: 'private-settlement-note' }, reportedTokensLowerBound: 55 } });
  const f = await fixture(t, (_req, res) => json(res, value));
  const result = (await f.bridge().task({ taskId: ids.task }, execute())).snapshot;
  const usage = { known: true, inputTokens: null, outputTokens: null, chargedTokens: 110, actualModel: null, executionSessionId: 'forge-sess.01' };
  assert.deepEqual(result.task.usage, usage); assert.deepEqual(result.runs[0].usage, usage);
  assert.equal(JSON.stringify(result).includes('private-settlement-note'), false);
  assert.equal(JSON.stringify(result).includes('forge.execution_bound'), false);
});

test('delivery usage stays honest: unknown degrades, inconsistent known rejects, unbound run stays unknown', async t => {
  const withDelivery = data => { const value = snapshot(); value.cursor = 3;
    value.events.push({ seq: 3, taskId: ids.task, attemptId: ids.attempt, type: 'forge.delivery_verified', createdAt: '2026-11-04T02:00:00Z', data });
    return value; };
  let value = withDelivery({ runId: ids.run, usageKnown: false, chargedTokens: 'bogus', sessionId: 42 });
  const f = await fixture(t, (_req, res) => json(res, value));
  const unknown = { known: null, inputTokens: null, outputTokens: null, chargedTokens: null, actualModel: null, executionSessionId: null };
  const result = (await f.bridge().task({ taskId: ids.task }, execute())).snapshot;
  assert.deepEqual(result.task.usage, unknown); assert.deepEqual(result.runs[0].usage, unknown);
  for (const data of [{ runId: ids.run, usageKnown: true, chargedTokens: -1, sessionId: 's' },
    { runId: ids.run, usageKnown: true, chargedTokens: 1.5, sessionId: 's' },
    { runId: ids.run, usageKnown: true, chargedTokens: 110 },
    { runId: ids.run, usageKnown: true, chargedTokens: 110, sessionId: 'bad session!' }]) {
    value = withDelivery(data);
    await assert.rejects(f.bridge().task({ taskId: ids.task }, execute()), code('PA_INVALID_RESPONSE'));
  }
  value = withDelivery({ runId: 'other-run-id', usageKnown: true, chargedTokens: 110, sessionId: 'forge-sess.01' });
  const unbound = (await f.bridge().task({ taskId: ids.task }, execute())).snapshot;
  assert.deepEqual(unbound.task.usage, { known: true, inputTokens: null, outputTokens: null, chargedTokens: 110, actualModel: null, executionSessionId: 'forge-sess.01' });
  assert.deepEqual(unbound.runs[0].usage, unknown);
  value = withDelivery({ runId: ids.run, usageKnown: true, chargedTokens: 1, sessionId: 's' });
  value.events.push({ ...value.events[2], seq: 4 });
  value.cursor = 4;
  await assert.rejects(f.bridge().task({ taskId: ids.task }, execute()), code('PA_INVALID_RESPONSE'));
});

test('registration rollback disposes previously registered native tools', async t => {
  const f = await fixture(t); let live = 0, attempts = 0;
  assert.throws(() => apply({ tools: { register() { if (++attempts === 2) throw new Error('fixture registry failure'); live++; return () => live--; } } }, f.config), /fixture registry/);
  assert.equal(live, 0); assert.equal(f.calls.length, 0);
});

test('preview is stateless, explicitly unsubmitted and deterministic; submit fails without any HTTP', async t => {
  const f = await fixture(t), bridge = f.bridge();
  const args = { requestId: 'bot-request-1', goal: 'A human may review this goal.', forgeTaskKey: full('forge-task'), forgeAttemptId: full('forge-attempt') };
  const first = bridge.requestPreview(args, execute()), repeat = bridge.requestPreview(args, execute());
  assert.deepEqual(first, repeat); assert.equal(first.status, 'preview_only'); assert.match(first.notice, /未提交；未创建 PA 任务；未获执行授权/);
  assert.deepEqual(first.submission, { submitted: false, paTaskCreated: false, executionAuthorized: false, paTaskId: null, paAttemptId: null, paRunId: null, nativeCommandId: null, nativeApprovalId: null });
  assert.equal(first.deduplicationEnforced, false); assert.equal(first.request.declaredForge.verified, false);
  assert.equal(first.request.declaredForge.taskKey, args.forgeTaskKey); assert.equal(first.request.declaredForge.attemptId, args.forgeAttemptId);
  assert.notEqual(bridge.requestPreview({ ...args, goal: 'Changed goal' }, execute()).fingerprint, first.fingerprint);
  assert.equal(bridge.requestPreview({ requestId: 'without-forge', goal: 'goal' }, execute()).request.declaredForge.attemptId, null);
  assert.throws(() => bridge.submitTask({ approved: true, engine: 'claude' }), code('PA_TASK_AUTHORIZATION_UNAVAILABLE'));
  assert.equal(f.calls.length, 0);
});

test('tool arguments cannot supply URL, auth, environment, argv, engine, approval or spoofed source', async t => {
  const f = await fixture(t), bridge = f.bridge();
  for (const key of ['url', 'origin', 'auth', 'deviceToken', 'env', 'argv', 'engine', 'approved', 'source', 'botId', 'callingSessionId']) {
    await assert.rejects(bridge.tasks({ [key]: 'bad' }, execute()), code('PA_INVALID_INPUT'));
    assert.throws(() => bridge.requestPreview({ requestId: 'safe', goal: 'goal', [key]: 'bad' }, execute()), code('PA_INVALID_INPUT'));
  }
  for (const taskId of ['../tasks', 'task?token=x', 'x/y', 'x%2fy', '', 'x'.repeat(1025)]) await assert.rejects(bridge.task({ taskId }, execute()), code('PA_INVALID_INPUT'));
  await assert.rejects(bridge.tasks({}, { callId: ids.call }), code('PA_INVALID_INPUT'));
  await assert.rejects(bridge.tasks({}, { agent: { session: { id: ids.session } } }), code('PA_INVALID_INPUT'));
  assert.equal(f.calls.length, 0);
});

test('configuration is explicit numeric loopback only and cannot carry stored token or ambient environment', async t => {
  const f = await fixture(t);
  for (const origin of ['https://example.test', 'http://localhost:47801', 'http://127.1:47801', 'http://127.0.0.2:47801', 'http://[::1]:47801', 'http://127.0.0.1:47801/', 'http://127.0.0.1:47801/x', 'http://user:secret@127.0.0.1:47801', 'http://127.0.0.1:47801?token=x']) {
    assert.throws(() => createClient({ ...f.config, origin }), code('PA_INVALID_CONFIG'));
  }
  for (const extra of [{ token: 'forbidden' }, { env: {} }, { allowSubmit: true }, { argv: [] }]) assert.throws(() => createBridge({ ...f.config, ...extra }), code('PA_INVALID_CONFIG'));
  assert.throws(() => createClient({ ...f.config, auth: { mode: 'paired', publicOrigin: 'https://pa.example.test', deviceToken: 'stored' } }), code('PA_INVALID_CONFIG'));
  assert.throws(() => createClient({ ...f.config, auth: { mode: 'paired', publicOrigin: 'https://pa.example.test' } }), code('PA_CREDENTIALS_REQUIRED'));
  assert.equal(f.calls.length, 0);
});

test('paired cookie comes only from runtime, respects exact public Host/Origin and is removed from echoed output', async t => {
  const token = 's'.repeat(43); let lookups = 0, escaped = false;
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const body = JSON.stringify({ tasks: [{ ...task(), goal: `echoed ${token}` }] });
    res.end(escaped ? body.replaceAll(token, '\\u0073'.repeat(43)) : body);
  });
  f.config.auth = { mode: 'paired', publicOrigin: 'https://pa.example.test', credentials: async () => { lookups++; return { deviceToken: token }; } };
  const result = await f.bridge().tasks({}, execute());
  assert.equal(lookups, 1); assert.equal(f.calls[0].host, 'pa.example.test'); assert.equal(f.calls[0].origin, 'https://pa.example.test');
  assert.equal(f.calls[0].cookie, `__Host-pa-device=${token}`); assert.equal(JSON.stringify(result).includes(token), false); assert.match(result.tasks[0].goal, /REDACTED/);
  // Credential rotation is consulted on every GET, never cached in output/config.
  escaped = true;
  const escapedResult = await f.bridge().tasks({}, execute()); assert.equal(lookups, 2);
  assert.equal(JSON.stringify(escapedResult).includes(token), false); assert.match(escapedResult.tasks[0].goal, /REDACTED/);
});

test('paired localhost development cookie uses original PA cookie name', async t => {
  const f = await fixture(t); const token = 'd'.repeat(43);
  f.config.auth = { mode: 'paired', publicOrigin: 'http://localhost:4000', credentials: () => ({ deviceToken: token }) };
  await f.bridge().tasks({}, execute()); assert.equal(f.calls[0].cookie, `pa-device-dev=${token}`); assert.equal(f.calls[0].host, 'localhost:4000');
});

test('missing/rejected/slow credential provider makes no connection and never leaks its diagnostics', async t => {
  const f = await fixture(t); f.config.timeoutMs = 20;
  for (const credentials of [() => { throw new Error('sensitive diagnostic'); }, () => ({ deviceToken: 'invalid' }), () => ({ deviceToken: 'x'.repeat(43), secret: 'extra' })]) {
    f.config.auth = { mode: 'paired', publicOrigin: 'https://pa.example.test', credentials };
    await assert.rejects(f.bridge().tasks({}, execute()), failure => { assert.equal(failure.code, 'PA_CREDENTIALS_REQUIRED'); assert.equal(failure.message.includes('sensitive'), false); return true; });
  }
  let release;
  f.config.auth = { mode: 'paired', publicOrigin: 'https://pa.example.test', credentials: () => new Promise(resolve => { release = resolve; }) };
  await assert.rejects(f.bridge().tasks({}, execute()), code('PA_TIMEOUT'));
  release({ deviceToken: 'x'.repeat(43) }); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 0);
});

test('authentication rejection and 404 withholds error bodies, headers and cookies, and never retries', async t => {
  let status = 401;
  const f = await fixture(t, (_req, res) => json(res, { message: 'SECRET_ERROR_BODY' }, status, { 'set-cookie': 'SECRET_COOKIE' }));
  for (const [value, expected] of [[401, 'PA_AUTH_REQUIRED'], [403, 'PA_ACCESS_REJECTED'], [404, 'PA_NOT_FOUND'], [503, 'PA_HTTP_ERROR']]) {
    status = value;
    await assert.rejects(f.bridge().tasks({}, execute()), failure => { assert.equal(failure.code, expected); assert.equal(String(failure).includes('SECRET'), false); return true; });
  }
  assert.equal(f.calls.length, 4);
});

test('redirect is rejected without contacting its target or forwarding credentials', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/credential-sink' }); res.end(); });
  await assert.rejects(f.bridge().tasks({}, execute()), code('PA_HTTP_ERROR')); assert.equal(f.calls.length, 1);
});

test('response deadline includes the body; cancellation destroys an inflight read', async t => {
  let started = () => {};
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); started(); });
  f.config.timeoutMs = 30;
  await assert.rejects(f.bridge().tasks({}, execute()), code('PA_TIMEOUT'));
  const ready = new Promise(resolve => { started = resolve; });
  const controller = new AbortController(), pending = f.bridge().tasks({}, execute(controller.signal));
  await ready; controller.abort(); await assert.rejects(pending, code('PA_ABORTED'));
  assert.equal(f.calls.length, 2);
  const count = f.calls.length; controller.abort(); await assert.rejects(f.bridge().tasks({}, execute(controller.signal)), code('PA_ABORTED'));
  assert.equal(f.calls.length, count);
});

test('declared and streamed byte limits both fail closed before parsing', async t => {
  let declared = true;
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', ...(declared ? { 'content-length': '100000' } : {}) });
    res.end(' '.repeat(2048));
  });
  f.config.maxResponseBytes = 1024;
  await assert.rejects(f.bridge().tasks({}, execute()), code('PA_RESPONSE_TOO_LARGE'));
  declared = false; await assert.rejects(f.bridge().tasks({}, execute()), code('PA_RESPONSE_TOO_LARGE'));
});

test('invalid JSON, UTF8, content type and compressed bodies never become task facts', async t => {
  let body = 'not-json', headers = {};
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json', ...headers }); res.end(body); });
  for (const [bytes, extra] of [['not-json', {}], [Buffer.from([0xff]), {}], ['{}', { 'content-type': 'text/html' }], ['{}', { 'content-encoding': 'gzip' }]]) {
    body = bytes; headers = extra; await assert.rejects(f.bridge().tasks({}, execute()), code('PA_INVALID_RESPONSE'));
  }
});

test('cross-task identities, contradictory relationships and replayed event sequences are rejected', async t => {
  let value;
  const f = await fixture(t, (_req, res) => json(res, value));
  const changes = [v => { v.task.id = 'foreign-task'; }, v => { v.runs[0].taskId = 'foreign-task'; },
    v => { v.runs[0].stageId = 'foreign-stage'; }, v => { v.approvals[0].attemptId = 'foreign-attempt'; },
    v => { v.events[1].seq = 1; }, v => { v.cursor = 1; }, v => { v.runs.push(v.runs[0]); }];
  for (const change of changes) { value = snapshot(); change(value); await assert.rejects(f.bridge().task({ taskId: ids.task }, execute()), code('PA_INVALID_RESPONSE')); }
});

test('absent native attempt/collections remain unknown, separate delivery status remains native', async t => {
  let value = snapshot(); delete value.runs[0].attemptId; delete value.stages; delete value.task.activeAttemptId;
  value.task.deliveryStatus = 'accepted';
  const f = await fixture(t, (_req, res) => json(res, value));
  const result = (await f.bridge().task({ taskId: ids.task }, execute())).snapshot;
  assert.equal(result.runs[0].attemptId, null); assert.equal(result.stages, null); assert.equal(result.task.activeAttemptId, null); assert.equal(result.task.activeAttemptKnown, false);
  assert.equal(result.task.deliveryStatus, 'accepted'); assert.equal(result.task.productAcceptancePassed, null);
  value.task.deliveryStatus = 'returned'; assert.equal((await f.bridge().task({ taskId: ids.task }, execute())).snapshot.task.deliveryStatus, 'returned');
});

test('duplicate task list, unknown state and excessive item count reject whole response', async t => {
  let value = { tasks: [task(), task()] };
  const f = await fixture(t, (_req, res) => json(res, value));
  await assert.rejects(f.bridge().tasks({}, execute()), code('PA_INVALID_RESPONSE'));
  value = { tasks: [{ ...task(), status: 'success-guaranteed' }] }; await assert.rejects(f.bridge().tasks({}, execute()), code('PA_INVALID_RESPONSE'));
  f.config.maxItems = 1; value = { tasks: [task(), { ...task(), id: 'another-task' }] }; await assert.rejects(f.bridge().tasks({}, execute()), code('PA_INVALID_RESPONSE'));
});

test('instance identity never joins by title, and client exposes only fixed GET operations', async t => {
  const f = await fixture(t), first = await f.bridge().tasks({}, execute());
  f.config.instanceId = 'second-fixture-instance';
  const second = await f.bridge().tasks({}, execute());
  assert.notEqual(first.tasks[0].taskRef.source, second.tasks[0].taskRef.source); assert.equal(first.tasks[0].taskRef.taskKey, second.tasks[0].taskRef.taskKey);
  assert.deepEqual(Object.keys(createClient(f.config)), ['listTasks', 'taskSnapshot']);
  assert.equal(f.calls.every(call => call.method === 'GET' && call.url === '/api/tasks'), true);
});
