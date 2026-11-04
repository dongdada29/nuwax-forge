// Explicit opt-in against an operator-selected PA source clone. All PA data,
// pairing, repositories and marker execution are newly created under tmpdir.
// Run with that clone's tsx loader; never uses a production data directory.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBridge } from '../bridge.mjs';

const [paRoot] = process.argv.slice(2);
assert(paRoot && isAbsolute(paRoot), 'Pass the explicit isolated PA source clone path.');
const { buildApp } = await import(pathToFileURL(join(paRoot, 'apps/server/src/app.ts')));
const { EngineError } = await import(pathToFileURL(join(paRoot, 'packages/runtime/src/index.ts')));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-intake-original-pa-')));
let instance;
try {
  const dataDir = join(root, 'data'), repo = join(root, 'repo'); mkdirSync(repo);
  const git = (...values) => execFileSync('git', values, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); writeFileSync(join(repo, 'feature.txt'), 'fixture baseline\n'); git('add', 'feature.txt');
  git('-c', 'user.name=Isolated Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture baseline');
  const security = { mode: 'paired', publicOrigin: 'https://pa.fixture.test' };
  const intake = { id: 'isolated-forge-intake', token: randomBytes(32).toString('base64url') };
  instance = await buildApp({ dataDir, security, intake, autoRun: true, webRoot: join(root, 'no-web-build') });
  const workspace = instance.store.registerWorkspace(repo, 'Isolated Forge fixture', 'fixture-register');
  await instance.app.close(); instance = undefined;
  const forgeRoot = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
  const runtime = join(root, 'never-run-model.mjs'), marker = join(root, 'authorized-marker');
  writeFileSync(runtime, '#!/usr/bin/env node\nthrow new Error("The fixture must never dispatch a provider");\n', { mode: 0o700 });
  const forbidden = { probe: async () => { throw new Error('Unexpected provider probe'); }, open: async () => { throw new Error('Unexpected provider open'); } };
  let opened = 0;
  const markerAdapter = { ...forbidden, open: async () => { opened++; writeFileSync(marker, 'human-authorized marker only\n'); throw new EngineError('ENGINE_FAILED', 'Intentional marker fixture stop'); } };
  const forge = { schemaVersion: 1, nodeBinary: process.execPath, forgeRoot, prepareEntry: join(forgeRoot, 'packages/cli/bin/nuwax-forge.mjs'),
    ownedEntry: join(forgeRoot, 'packages/cli/lib/agent/owned-entry.mjs'), workspaces: { [workspace.id]: {
      runtime: { kind: 'codex', binary: runtime, model: 'fixture-model', contextMode: 'fresh-exec' }, permissions: { mode: 'workspace-write' },
      budget: { maxTokens: 20000, maxWallSeconds: 5, maxAttempts: 1 },
      budgetSpec: { schemaVersion: 1, id: 'isolated-pa-fixture', mode: 'model', taskKind: 'text-implementation', model: { name: 'fixture-model' }, expectedCalls: 1,
        initialContextTokens: 1000, perCallOutputTokens: 10, budgetTokens: 20000 },
      context: { maxBytes: 32768, maxTokens: 5000, maxFiles: 4, contextFiles: [] }, verificationCommands: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
    } } };
  instance = await buildApp({ dataDir, security, intake, forge, forgeAdapter: markerAdapter, adapter: forbidden, realAdapter: forbidden, autoRun: true, webRoot: join(root, 'no-web-build') });
  await instance.app.listen({ host: '127.0.0.1', port: 0 });
  const port = instance.app.server.address().port;
  const config = { schemaVersion: 1, origin: `http://127.0.0.1:${port}`, instanceId: 'isolated-original-pa', botId: 'isolated-bot',
    auth: { mode: 'intake', intakeId: intake.id, publicOrigin: security.publicOrigin, credentials: () => ({ intakeToken: intake.token }) },
    submission: { enabled: true, workspaces: { fixture: workspace.id } } };
  const bridge = createBridge(config), execution = { agent: { session: { id: 'actual-isolated-dsh-session' } }, callId: 'isolated-tool-call', signal: new AbortController().signal };
  const args = { requestId: 'isolated-request-1', goal: 'A marker can run only after native human admission.', workspace: 'fixture' };
  const preview = bridge.requestPreview(args, execution); assert.equal(preview.status, 'preview_only'); assert.equal(instance.store.list().length, 0);
  const result = await bridge.request(args, execution); await instance.runner.idle();
  assert.equal(result.status, 'awaiting_human_approval'); assert.equal(result.snapshot.task.status, 'paused'); assert.equal(result.submission.executionAuthorized, false);
  assert.equal(result.admission.kind, 'task_admission'); assert.equal(result.admission.status, 'pending'); assert.equal(opened, 0); assert.equal(existsSync(marker), false);
  const replay = await bridge.request(args, execution); assert.equal(replay.replayed, true); assert.equal(replay.submission.paTaskId, result.submission.paTaskId); assert.equal(instance.store.list().length, 1);
  await assert.rejects(bridge.request({ ...args, goal: 'Changed request goal' }, execution), error => error.code === 'PA_COMMAND_CONFLICT');
  const original = (await bridge.task({ taskId: result.submission.paTaskId }, execution)).snapshot;
  assert.equal(original.task.source.sessionId, execution.agent.session.id); assert.equal(original.approvals[0].id, result.admission.id);
  const intakeHeaders = { host: 'pa.fixture.test', origin: security.publicOrigin, authorization: `Bearer ${intake.token}` };
  for (const [url, payload] of [[`/api/approvals/${result.admission.id}/resolve`, { commandId: 'bot-cannot-approve', optionId: 'approve' }],
    [`/api/tasks/${result.submission.paTaskId}/control`, { commandId: 'bot-cannot-resume', action: 'resume' }]]) {
    assert.equal((await instance.app.inject({ method: 'POST', url, headers: intakeHeaders, payload })).statusCode, 403);
  }
  assert.equal(opened, 0); assert.equal(existsSync(marker), false);
  const ticket = instance.authStore.issueTicket();
  const pair = await instance.app.inject({ method: 'POST', url: '/api/pair', headers: { host: 'pa.fixture.test', origin: security.publicOrigin }, payload: { ticket: ticket.ticket, name: 'Independent fixture human' } });
  assert.equal(pair.statusCode, 200);
  const cookie = pair.headers['set-cookie'].split(';', 1)[0], csrf = pair.json().csrfToken;
  const approval = await instance.app.inject({ method: 'POST', url: `/api/approvals/${result.admission.id}/resolve`,
    headers: { host: 'pa.fixture.test', origin: security.publicOrigin, cookie, 'x-csrf-token': csrf }, payload: { commandId: 'human-fixture-approve', optionId: 'approve' } });
  assert.equal(approval.statusCode, 200); await instance.runner.idle();
  assert.equal(opened, 1); assert.equal(existsSync(marker), true);
  const after = await bridge.request(args, execution); assert.equal(after.status, 'existing_task'); assert.equal(after.admission.status, 'approved'); assert.equal(after.snapshot.task.status, 'failed');
  assert.equal(after.submission.paTaskId, result.submission.paTaskId);
  console.log(JSON.stringify({ paSourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: paRoot, encoding: 'utf8' }).trim(), fixture: 'fresh-original-pa-data-and-git',
    originalPausedAdmission: 'passed', nativeSource: 'passed', replay: 'passed', changedGoalConflict: 'passed', intakeCannotApproveOrControl: 'passed',
    independentPairedHuman: 'passed', markerOpensBeforeApproval: 0, markerOpensAfterApproval: opened, replayAfterHumanDecision: 'passed', modelCalls: 0, productionInstancesAccessed: 0 }));
} finally { try { await instance?.app.close(); } finally { rmSync(root, { recursive: true, force: true }); } }
