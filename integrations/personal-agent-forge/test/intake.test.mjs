import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBridge } from '../bridge.mjs';
import { createClient } from '../client.mjs';
import { canonical, fingerprint } from '../admission.mjs';
import { apply } from '../index.mjs';

const token = 'fixture_intake_token_'.padEnd(43, 'x');
const args = { requestId: 'request-1', goal: 'Implement a bounded fixture task.', workspace: 'sample' };
const execute = (session = 'real-dsh-session', signal = new AbortController().signal) => ({ agent: { session: { id: session } }, callId: 'actual-tool-call', signal });
const code = expected => failure => { assert.equal(failure.code, expected); return true; };
const send = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };

async function fixture(t, transform = (_stage, value) => value) {
  const requests = [], tasks = new Map(); let counter = 0, override;
  const server = http.createServer(async (req, res) => {
    let bytes = ''; for await (const chunk of req) bytes += chunk;
    const body = bytes ? JSON.parse(bytes) : undefined;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (override && override(req, res) !== false) return;
    if (req.headers.authorization !== `Bearer ${token}` || req.headers.cookie !== undefined || req.headers.host !== 'pa.fixture.test') { send(res, {}, 401); return; }
    if (req.method === 'POST' && req.url === '/api/tasks') {
      const previous = tasks.get(body.commandId);
      if (previous) {
        if (canonical(previous.body) !== canonical(body)) { send(res, { code: 'COMMAND_CONFLICT' }, 409); return; }
        send(res, transform('post', structuredClone(previous.created)), 200); return;
      }
      const request = { goal: body.goal, engine: 'forge', workspaceId: body.workspaceId, intakeId: 'fixture-intake', source: body.source,
        verificationCommands: [{ command: 'operator-fixed-verifier', args: [] }], configuration: { operator: 'fixed-template' }, forge: { fingerprint: 'fixed-server-template' } };
      const admission = { approvalId: `native-approval-${++counter}`, fingerprint: fingerprint(request), status: 'pending' };
      const task = { id: `native-task-${counter}`, commandId: body.commandId, goal: body.goal, engine: 'forge', workspaceId: body.workspaceId, intakeId: 'fixture-intake', source: body.source,
        admission, status: 'paused', activeAttemptId: null, deliveryStatus: 'pending', pauseRequested: false, createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z' };
      const approval = { id: admission.approvalId, taskId: task.id, attemptId: null, runId: null, kind: 'task_admission', fingerprint: admission.fingerprint, request,
        status: 'pending', selectedOptionId: null, resolvedAt: null };
      tasks.set(body.commandId, { body: structuredClone(body), created: structuredClone(task), task, approval });
      send(res, transform('post', structuredClone(task)), 201); return;
    }
    if (req.method === 'GET' && req.url === '/api/tasks') { send(res, transform('list', { tasks: [...tasks.values()].map(row => row.task) })); return; }
    if (req.method === 'GET') {
      const row = [...tasks.values()].find(row => req.url === `/api/tasks/${row.task.id}`);
      if (row) { send(res, transform('snapshot', structuredClone({ task: row.task, approvals: [row.approval], cursor: 0, events: [], stages: [], runs: [], artifacts: [], verifications: [] }))); return; }
    }
    send(res, {}, 403);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const config = { schemaVersion: 1, origin: `http://127.0.0.1:${server.address().port}`, instanceId: 'operator-pa-instance', botId: 'operator-bot',
    auth: { mode: 'intake', intakeId: 'fixture-intake', publicOrigin: 'https://pa.fixture.test', credentials: () => ({ intakeToken: token }) },
    submission: { enabled: true, workspaces: { sample: 'registered-workspace-id' } } };
  return { config, requests, tasks, bridge: () => createBridge(config), override: value => { override = value; } };
}

test('explicit native intake submits only fixed fields, then confirms original paused admission and source', async t => {
  const f = await fixture(t), registry = new Map();
  const dispose = apply({ tools: { register(definition) { registry.set(definition.name, definition); return () => registry.delete(definition.name); } } }, f.config);
  const result = await registry.get('personal_agent_request').execute(args, execute());
  assert.equal(result.status, 'awaiting_human_approval'); assert.equal(result.submission.submitted, true); assert.equal(result.submission.paTaskCreated, true); assert.equal(result.submission.executionAuthorized, false);
  assert.equal(result.submission.paTaskId, 'native-task-1'); assert.equal(result.admission.id, 'native-approval-1'); assert.equal(result.admission.kind, 'task_admission'); assert.equal(result.admission.status, 'pending');
  assert.equal(result.snapshot.task.status, 'paused'); assert.equal(result.snapshot.task.usage.chargedTokens, null); assert.equal(result.snapshot.task.sourceAuthenticated, false);
  const post = f.requests[0]; assert.deepEqual(Object.keys(post.body), ['commandId', 'goal', 'engine', 'workspaceId', 'source']);
  assert.deepEqual(post.body.source, { kind: 'dsh-bot', instanceId: 'operator-pa-instance', sessionId: 'real-dsh-session', requestId: 'request-1' });
  assert.equal(post.body.engine, 'forge'); assert.equal(post.body.workspaceId, 'registered-workspace-id');
  assert.match(post.body.commandId, /^forge_[a-f0-9]{64}$/);
  assert.deepEqual(f.requests.map(row => [row.method, row.url]), [['POST', '/api/tasks'], ['GET', '/api/tasks/native-task-1']]);
  for (const row of f.requests) { assert.equal(row.headers.authorization, `Bearer ${token}`); assert.equal(row.headers.cookie, undefined); assert.equal(row.headers['x-csrf-token'], undefined); assert.equal(row.headers.host, 'pa.fixture.test'); }
  assert.equal(JSON.stringify(result).includes(token), false); dispose();
});

test('default/native request stays preview and direct submit stays closed; paired Cookie can never enable writes', async t => {
  const f = await fixture(t); f.config.submission.enabled = false;
  const result = f.bridge().request(args, execute());
  assert.equal(result.status, 'preview_only'); assert.equal(result.submission.paTaskCreated, false); assert.equal(result.submission.nativeCommandId, null); assert.match(result.notice, /未提交/);
  assert.throws(() => f.bridge().submitTask(args, execute()), code('PA_TASK_AUTHORIZATION_UNAVAILABLE'));
  f.config.auth = { mode: 'paired', publicOrigin: 'https://pa.fixture.test', credentials: () => ({ deviceToken: token }) }; f.config.submission.enabled = true;
  assert.throws(() => f.bridge(), code('PA_INVALID_CONFIG')); assert.equal(f.requests.length, 0);
});

test('command identity is stable across calls/goals and changes only with instance/session/request identity', async t => {
  const f = await fixture(t); const first = await f.bridge().submitTask(args, execute());
  const repeated = await f.bridge().submitTask(args, { ...execute(), callId: 'another-tool-call' });
  assert.equal(repeated.commandId, first.commandId); assert.equal(repeated.submission.paTaskId, first.submission.paTaskId); assert.equal(repeated.replayed, true); assert.equal(f.tasks.size, 1);
  await assert.rejects(f.bridge().submitTask({ ...args, goal: 'Changed content under same requestId' }, execute()), code('PA_COMMAND_CONFLICT'));
  assert.equal(f.requests.filter(row => row.method === 'POST')[2].body.commandId, first.commandId); assert.equal(f.tasks.size, 1);
  const session = await f.bridge().submitTask(args, execute('another-real-session')); assert.notEqual(session.commandId, first.commandId);
  const request = await f.bridge().submitTask({ ...args, requestId: 'request-2' }, execute()); assert.notEqual(request.commandId, first.commandId);
  f.config.instanceId = 'another-operator-instance'; const instance = await f.bridge().submitTask(args, execute()); assert.notEqual(instance.commandId, first.commandId);
  f.config.instanceId = '操作者实例/一';
  const unicode = await f.bridge().submitTask({ ...args, requestId: '请求/一' }, execute('真实会话/一'));
  assert.equal(unicode.snapshot.task.source.sessionId, '真实会话/一'); assert.equal(unicode.snapshot.task.source.instanceId, '操作者实例/一');
});

test('200 replay returns authoritative approved/running/completed/rejected state rather than inventing pending', async t => {
  const f = await fixture(t); const first = await f.bridge().submitTask(args, execute()); const row = [...f.tasks.values()][0];
  row.task.admission.status = 'approved'; row.approval.status = 'resolved'; row.approval.selectedOptionId = 'approve'; row.approval.resolvedAt = '2026-11-04T01:00:00Z';
  for (const state of ['queued', 'running', 'completed']) {
    row.task.status = state; row.task.activeAttemptId = state === 'queued' ? null : 'real-native-attempt';
    const result = await f.bridge().submitTask(args, execute());
    assert.equal(result.status, 'existing_task'); assert.equal(result.snapshot.task.status, state); assert.equal(result.admission.status, 'approved'); assert.equal(result.submission.executionAuthorized, true); assert.equal(result.submission.paTaskId, first.submission.paTaskId);
  }
  row.task.status = 'cancelled'; row.task.activeAttemptId = null; row.task.admission.status = 'rejected'; row.approval.selectedOptionId = 'reject';
  const rejected = await f.bridge().submitTask(args, execute()); assert.equal(rejected.admission.status, 'rejected'); assert.equal(rejected.submission.executionAuthorized, false);
});

test('unknown fields, workspace IDs/aliases, long source IDs and oversized encoded payload are blocked before HTTP', async t => {
  const f = await fixture(t), bridge = f.bridge();
  for (const key of ['source', 'sessionId', 'commandId', 'workspaceId', 'engine', 'verificationCommands', 'profileIds', 'runtime', 'binary', 'budget', 'state', 'env', 'argv', 'approved', 'cookie', 'url']) {
    assert.throws(() => bridge.submitTask({ ...args, [key]: 'forbidden' }, execute()), code('PA_INVALID_INPUT'));
  }
  for (const workspace of ['unknown', 'registered-workspace-id', '__proto__']) assert.throws(() => bridge.submitTask({ ...args, workspace }, execute()), code('PA_WORKSPACE_DENIED'));
  for (const requestId of ['', 'x'.repeat(201), 'x\n']) assert.throws(() => bridge.submitTask({ ...args, requestId }, execute()), code('PA_INVALID_INPUT'));
  assert.throws(() => bridge.submitTask(args, execute('s'.repeat(201))), code('PA_INVALID_INPUT'));
  await assert.rejects(bridge.submitTask({ ...args, goal: '\u0001'.repeat(9999) + 'x' }, execute()), code('PA_REQUEST_TOO_LARGE'));
  assert.equal(f.requests.length, 0);
});

test('intake rejects device credential substitution and never reads ambient environment', async t => {
  const f = await fixture(t); f.config.auth.credentials = () => ({ deviceToken: token });
  await assert.rejects(f.bridge().submitTask(args, execute()), code('PA_CREDENTIALS_REQUIRED')); assert.equal(f.requests.length, 0);
  assert.throws(() => createClient({ ...f.config, auth: { ...f.config.auth, tokenFile: '/tmp/forbidden' } }), code('PA_INVALID_CONFIG'));
  assert.throws(() => createClient({ ...f.config, auth: { ...f.config.auth, tokenEnv: 'PERSONAL_AGENT_INTAKE_TOKEN' } }), code('PA_INVALID_CONFIG'));
});

test('401/403/409, redirects, 202 and 500 never become submitted facts or automatic retries', async t => {
  const f = await fixture(t);
  for (const [status, expected] of [[401, 'PA_AUTH_REQUIRED'], [403, 'PA_ACCESS_REJECTED'], [409, 'PA_COMMAND_CONFLICT'], [302, 'PA_HTTP_ERROR'], [202, 'PA_HTTP_ERROR'], [500, 'PA_HTTP_ERROR']]) {
    f.override((_req, res) => { res.writeHead(status, { 'content-type': 'application/json', location: 'http://127.0.0.1:1/no-follow' }); res.end(JSON.stringify({ secret: token })); });
    await assert.rejects(f.bridge().submitTask(args, execute()), failure => { assert.equal(failure.code, expected); assert.equal(failure.submissionState, 'unknown'); assert.match(failure.commandId, /^forge_/); assert.equal(String(failure).includes(token), false); return true; });
  }
  assert.equal(f.requests.length, 6);
});

test('new task cannot be accepted without paused/pending admission, matching immutable source and original fingerprint', async t => {
  let corrupt = () => {};
  const f = await fixture(t, (stage, value) => { corrupt(stage, value); return value; });
  const cases = [
    (stage, v) => { if (stage === 'post') v.status = 'running'; },
    (stage, v) => { if (stage === 'post') v.intakeId = 'other-intake'; },
    (stage, v) => { if (stage === 'snapshot') v.task.source.sessionId = 'spoofed-session'; },
    (stage, v) => { if (stage === 'snapshot') v.approvals[0].request.source.instanceId = 'another-instance'; },
    (stage, v) => { if (stage === 'snapshot') v.approvals[0].kind = 'tool_permission'; },
    (stage, v) => { if (stage === 'snapshot') v.approvals[0].fingerprint = 'a'.repeat(64); },
    (stage, v) => { if (stage === 'snapshot') v.approvals[0].taskId = 'other-task'; },
    (stage, v) => { if (stage === 'snapshot') v.approvals = []; },
    (stage, v) => { if (stage === 'snapshot') v.task.activeAttemptId = 'unexpected-attempt'; },
  ];
  for (let i = 0; i < cases.length; i++) { corrupt = cases[i]; await assert.rejects(f.bridge().submitTask({ ...args, requestId: `mismatch-${i}` }, execute()), code('PA_ADMISSION_MISMATCH')); }
});

test('cancellation, POST body timeout and response size limit preserve unknown submission and stable retry identity', async t => {
  const f = await fixture(t); f.config.timeoutMs = 30;
  let started = () => {};
  f.override((_req, res) => { res.writeHead(201, { 'content-type': 'application/json' }); res.write('{'); started(); });
  await assert.rejects(f.bridge().submitTask(args, execute()), code('PA_TIMEOUT'));
  const ready = new Promise(resolve => { started = resolve; }); const controller = new AbortController();
  const pending = f.bridge().submitTask(args, execute('real-dsh-session', controller.signal)); await ready; controller.abort(); await assert.rejects(pending, code('PA_ABORTED'));
  assert.equal(f.requests[0].body.commandId, f.requests[1].body.commandId);
  f.config.maxResponseBytes = 256;
  f.override((_req, res) => { res.writeHead(201, { 'content-type': 'application/json' }); res.end('x'.repeat(300)); });
  await assert.rejects(f.bridge().submitTask(args, execute()), code('PA_RESPONSE_TOO_LARGE'));
  const count = f.requests.length; assert.throws(() => f.bridge().submitTask(args, execute('real-dsh-session', controller.signal)), code('PA_ABORTED')); assert.equal(f.requests.length, count);
});

test('intake GET refuses foreign intake records and still exposes no approval/control transport', async t => {
  const f = await fixture(t, (stage, value) => { if (stage === 'list') value.tasks[0].intakeId = 'foreign-intake'; return value; });
  await f.bridge().submitTask(args, execute()); await assert.rejects(f.bridge().tasks({}, execute()), code('PA_INVALID_RESPONSE'));
  assert.deepEqual(Object.keys(createClient(f.config)), ['listTasks', 'taskSnapshot', 'submitTask']);
  assert.equal(f.requests.every(row => row.url === '/api/tasks' || /^\/api\/tasks\/native-task-\d+$/.test(row.url)), true);
});

test('a committed POST followed by a lost confirmation GET recovers the same original task by stable replay', async t => {
  const f = await fixture(t); f.config.timeoutMs = 30;
  f.override((req, res) => {
    if (req.method !== 'GET') return false;
    res.writeHead(200, { 'content-type': 'application/json' }); res.write('{');
  });
  let originalCommand;
  await assert.rejects(f.bridge().submitTask(args, execute()), failure => {
    assert.equal(failure.code, 'PA_TIMEOUT'); assert.equal(failure.submissionState, 'unknown'); originalCommand = failure.commandId; return true;
  });
  assert.equal(f.tasks.size, 1); assert.equal(f.requests.filter(row => row.method === 'POST').length, 1);
  f.override(undefined);
  const recovered = await f.bridge().submitTask(args, execute());
  assert.equal(recovered.commandId, originalCommand); assert.equal(recovered.replayed, true); assert.equal(recovered.submission.paTaskId, 'native-task-1');
  assert.equal(f.tasks.size, 1); assert.equal(f.requests.filter(row => row.method === 'POST').length, 2);
});
