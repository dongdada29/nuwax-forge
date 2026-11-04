import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initializeBridge, createBridge } from './bridge.mjs';
import { apply } from './index.mjs';
import { reconcile } from '../../packages/cli/lib/agent/index.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const exec = signal => ({ agent: { session: { id: 'fixture-chief-session' } }, signal: signal ?? new AbortController().signal });
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function settleFixture(config, prepared, { processPassed = true, inputTokens = 100, outputTokens = 10 } = {}) {
  const state = path.join(config.stateRoot, prepared.attemptId, 'state');
  const manifestFile = path.join(state, 'manifest.json');
  write(manifestFile, { ...read(manifestFile), processPassed, modelDispatched: true });
  const events = [
    { type: 'thread.started', thread_id: 'fixture-execution-session' }, { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'fixture result' } },
    { type: 'turn.completed', usage: { input_tokens: inputTokens, output_tokens: outputTokens, cached_input_tokens: 80 } },
  ];
  fs.writeFileSync(path.join(state, 'stdout.jsonl'), events.map(row => JSON.stringify(row)).join('\n') + '\n');
  reconcile(state); // Existing offline Forge implementation; never starts a runtime.
  return state;
}
function fixture(t, maxTokens = 20000) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bot-bridge-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const worktree = path.join(root, 'workspace'); fs.mkdirSync(worktree);
  assert.equal(spawnSync('git', ['init', '-q', worktree]).status, 0);
  const runtime = path.join(root, 'fixture-runtime.mjs'), marker = path.join(root, 'MODEL-WAS-RUN');
  fs.writeFileSync(runtime, `#!${process.execPath}\nimport fs from 'node:fs';
const a=process.argv.slice(2);
if(a.includes('--version'))console.log('codex-fixture');
else if(a.includes('--help'))console.log('--json --ephemeral --ignore-user-config --ignore-rules --sandbox --cd');
else {fs.writeFileSync(${JSON.stringify(marker)},'unexpected model dispatch');process.exit(99)}
`, { mode: 0o700 });
  const config = { schemaVersion: 1, nodeBinary: fs.realpathSync(process.execPath), forgeRoot: repo,
    forgeEntry: path.join(repo, 'packages/cli/bin/nuwax-forge.mjs'), stateRoot: path.join(root, 'states'), allowPrepare: true,
    workspaces: { sample: { worktree, runtime: { kind: 'codex', binary: runtime, model: 'fixture-model', contextMode: 'fresh-exec' },
      permissions: { mode: 'read-only' }, budget: { maxTokens, maxWallSeconds: 10, maxAttempts: 1 },
      budgetSpec: { schemaVersion: 1, id: 'fixture', mode: 'model', taskKind: 'text-implementation', model: { name: 'fixture-model' }, expectedCalls: 1,
        initialContextTokens: 1000, perCallOutputTokens: 10, budgetTokens: 20000 } } } };
  const args = { workspace: 'sample', taskKey: 'bounded-task', brief: 'Read the allowed workspace only; report findings and stop.' };
  return { root, config, args, marker, create: () => { initializeBridge(config); return createBridge(config); } };
}

test('native registration exposes status/prepare only and cleans up; real Forge prepares without dispatch', async t => {
  const f = fixture(t); initializeBridge(f.config);
  const registry = new Map();
  const dispose = apply({ tools: { register(d) { registry.set(d.name, d); return () => registry.delete(d.name); } } }, f.config);
  assert.deepEqual([...registry.keys()], ['forge_status', 'forge_prepare']);
  assert.equal(registry.get('forge_prepare').isConcurrencySafe(), false);
  const result = await registry.get('forge_prepare').execute(f.args, exec());
  assert.equal(result.status, 'prepared');
  assert.equal(result.source.callingSessionId, 'fixture-chief-session');
  assert.equal(result.source.executionSessionId, null);
  assert.equal(result.attempt, 1); assert.equal(result.modelDispatched, false);
  assert.equal(result.budget.verdict, 'unknown'); assert.equal(result.budget.chargedTokens, null);
  assert.equal(result.operatorRun.requiresOperatorAuthorization, true);
  assert.deepEqual(result.operatorRun.argv.slice(2, 4), ['agent', 'run']);
  assert.equal(fs.existsSync(f.marker), false);
  const read = await registry.get('forge_status').execute({ attemptId: result.attemptId }, exec());
  assert.equal(read.taskKey, f.args.taskKey);
  dispose(); assert.equal(registry.size, 0);
});

test('existing root, root inside workspace/Forge and changed config are refused', t => {
  const f = fixture(t); f.create();
  assert.throws(() => initializeBridge(f.config), /new nonexistent/);
  assert.throws(() => createBridge({ ...f.config, allowPrepare: false }), /configuration/);
  assert.throws(() => initializeBridge({ ...f.config, stateRoot: path.join(f.config.forgeRoot, 'states') }), /outside Forge/);
  assert.throws(() => initializeBridge({ ...f.config, stateRoot: path.join(f.config.workspaces.sample.worktree, 'states') }), /outside every workspace/);
});

test('unknown workspace, arbitrary command/argv, path traversal and missing calling Session are denied', async t => {
  const f = fixture(t), bridge = f.create();
  await assert.rejects(bridge.prepare({ ...f.args, workspace: '/tmp' }, exec()), /allowlist/);
  await assert.rejects(bridge.prepare({ ...f.args, command: 'touch bad' }, exec()), /Unsupported tool argument/);
  await assert.rejects(bridge.prepare({ ...f.args, args: ['run'] }, exec()), /Unsupported tool argument/);
  await assert.rejects(bridge.prepare({ ...f.args, taskKey: '../escape' }, exec()), /taskKey/);
  await assert.rejects(bridge.status({ attemptId: '../../escape' }, exec()), /exact attemptId/);
  await assert.rejects(bridge.prepare(f.args, { signal: new AbortController().signal }), /calling DSH Session/);
  await assert.rejects(bridge.status({ attemptId: '00000000-0000-4000-8000-000000000000' }, exec()), /ENOENT/);
  assert.equal(fs.existsSync(f.marker), false);
});

test('operator-disabled prepare and pre-dispatch cancellation perform no writes', async t => {
  const f = fixture(t); f.config.allowPrepare = false; const bridge = f.create();
  await assert.rejects(bridge.prepare(f.args, exec()), /not explicitly enabled/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(bridge.prepare(f.args, exec(controller.signal)), /abort/i);
  assert.deepEqual(fs.readdirSync(f.config.stateRoot), ['bridge.json']);
});

test('existing Forge budget gate blocks and never returns run authorization', async t => {
  const f = fixture(t, 1), bridge = f.create();
  const result = await bridge.prepare(f.args, exec());
  assert.equal(result.status, 'blocked'); assert.equal(result.operatorRun, null);
  assert.equal(result.modelDispatched, false); assert.equal(fs.existsSync(f.marker), false);
});

test('missing/unknown state stays unknown; lower-bound excess never becomes complete usage', async t => {
  const f = fixture(t), bridge = f.create();
  const result = await bridge.prepare(f.args, exec());
  const state = path.join(f.config.stateRoot, result.attemptId, 'state');
  fs.unlinkSync(path.join(state, 'manifest.json'));
  let value = await bridge.status({ attemptId: result.attemptId }, exec());
  assert.equal(value.status, 'unknown'); assert.equal(value.processPassed, null);
  assert.equal(value.budget.chargedTokens, null);
  write(path.join(state, 'manifest.json'), { taskKey: f.args.taskKey, status: 'invented-success', processPassed: true });
  write(path.join(state, 'budget-reconcile.json'), { reconciliation: { budget: { verdict: 'unknown' } }, observedBudget: { maxTokens: 20000, verdict: 'exceeds', reportedTokensLowerBound: 21000 } });
  value = await bridge.status({ attemptId: result.attemptId }, exec());
  assert.equal(value.status, 'unknown'); assert.equal(value.acceptancePassed, null);
  assert.equal(value.budget.verdict, 'unknown'); assert.equal(value.budget.observedVerdict, 'exceeds');
  assert.equal(value.budget.usageKnown, null); assert.equal(value.budget.reportedTokensLowerBound, 21000);
});

test('state symlinks, provenance mismatch and oversized JSON are refused', async t => {
  const f = fixture(t), bridge = f.create();
  const result = await bridge.prepare(f.args, exec()), a = result.attemptId;
  const state = path.join(f.config.stateRoot, a, 'state');
  const manifest = path.join(state, 'manifest.json');
  fs.unlinkSync(manifest); fs.symlinkSync(path.join(f.root, 'missing'), manifest);
  await assert.rejects(bridge.status({ attemptId: a }, exec()), /Symlink/);
  fs.unlinkSync(manifest); write(manifest, { taskKey: 'wrong', status: 'completed' });
  await assert.rejects(bridge.status({ attemptId: a }, exec()), /provenance mismatch/);
  fs.writeFileSync(manifest, ' '.repeat(262145));
  await assert.rejects(bridge.status({ attemptId: a }, exec()), /bounded regular/);
});

test('cancellation drains the started prepare group, preserving an explicit unknown attempt', async t => {
  const f = fixture(t);
  const trustedRoot = path.join(f.root, 'trusted-forge'); fs.mkdirSync(trustedRoot);
  f.config.forgeRoot = trustedRoot; f.config.forgeEntry = path.join(trustedRoot, 'fixture-entry.mjs');
  const started = path.join(f.root, 'prepare-started');
  fs.writeFileSync(f.config.forgeEntry, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(started)},'started');setInterval(()=>{},1000);`);
  const bridge = f.create(), controller = new AbortController();
  const pending = bridge.prepare(f.args, exec(controller.signal));
  // Observe readiness instead of sleeping a fixed duration before cancellation.
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(started) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(started), true); controller.abort();
  let attemptId;
  await assert.rejects(pending, error => {
    assert.match(error.message, /cancelled/);
    attemptId = error.message.match(/attemptId=([a-f0-9-]+)/)?.[1];
    return Boolean(attemptId);
  });
  const status = await bridge.status({ attemptId }, exec());
  assert.equal(status.status, 'unknown'); assert.equal(status.operatorRun, null);
  assert.equal(status.modelDispatched, null); assert.equal(fs.existsSync(f.marker), false);
});

test('missing request/budget guard cannot yield runnable state or fabricated zero usage', async t => {
  const f = fixture(t), bridge = f.create();
  const prepared = await bridge.prepare(f.args, exec());
  const state = path.join(f.config.stateRoot, prepared.attemptId, 'state');
  fs.unlinkSync(path.join(state, 'budget-guard.json'));
  assert.equal((await bridge.status({ attemptId: prepared.attemptId }, exec())).operatorRun, null);
  fs.unlinkSync(path.join(state, 'request.json'));
  const status = await bridge.status({ attemptId: prepared.attemptId }, exec());
  assert.equal(status.status, 'unknown'); assert.equal(status.operatorRun, null);
  assert.equal(status.budget.chargedTokens, null); assert.equal(status.budget.reportedTokensLowerBound, null);
});

test('incomplete manifest cannot promote a lone settlement verdict to within or known charged usage', async t => {
  const f = fixture(t), bridge = f.create();
  const prepared = await bridge.prepare(f.args, exec());
  const state = path.join(f.config.stateRoot, prepared.attemptId, 'state');
  const manifest = path.join(state, 'manifest.json');
  write(manifest, { ...read(manifest), usageKnown: false, chargedTokens: 100 });
  write(path.join(state, 'budget-reconcile.json'), { reconciliation: { budget: { verdict: 'within' } } });
  const status = await bridge.status({ attemptId: prepared.attemptId }, exec());
  assert.equal(status.budget.usageKnown, false); assert.equal(status.budget.chargedTokens, null);
  assert.equal(status.budget.verdict, 'unknown');
});

test('real Forge complete settlement displays known usage, while source or numeric conflicts degrade to unknown', async t => {
  const f = fixture(t), bridge = f.create();
  const prepared = await bridge.prepare(f.args, exec()), args = { attemptId: prepared.attemptId };
  const state = settleFixture(f.config, prepared);
  let status = await bridge.status(args, exec());
  assert.equal(status.status, 'completed'); assert.equal(status.budget.usageKnown, true);
  assert.equal(status.budget.chargedTokens, 110); assert.equal(status.budget.verdict, 'within');
  assert.equal(status.budget.consistency, 'verified'); assert.equal(status.source.executionSessionId, 'fixture-execution-session');
  const settlementFile = path.join(state, 'budget-reconcile.json'), original = read(settlementFile);
  for (const change of [
    value => { value.chargedTokens = 100; },
    value => { value.reconciliation.sample.sourceHash = 'unrelated-usage'; },
    value => { value.reconciliation.actual.completeness.complete = false; },
    value => { value.reconciliation.budget.budgetTokens = 99999; },
    value => { value.reconciliation.comparison.dimensions.find(row => row.dimension === 'totalTokens').actual = 111; },
  ]) {
    const changed = structuredClone(original); change(changed); write(settlementFile, changed);
    status = await bridge.status(args, exec());
    assert.equal(status.budget.usageKnown, null); assert.equal(status.budget.chargedTokens, null);
    assert.equal(status.budget.verdict, 'unknown'); assert.equal(status.budget.consistency, 'conflict');
  }
  write(settlementFile, original);
  const manifestFile = path.join(state, 'manifest.json');
  write(manifestFile, { ...read(manifestFile), usageKnown: false });
  status = await bridge.status(args, exec());
  assert.equal(status.budget.chargedTokens, null); assert.equal(status.budget.verdict, 'unknown');
});

test('real interrupted Forge overflow stays a lower bound, including manifest fallback; malformed observations are unknown', async t => {
  const f = fixture(t), bridge = f.create();
  const prepared = await bridge.prepare(f.args, exec()), args = { attemptId: prepared.attemptId };
  const state = settleFixture(f.config, prepared, { processPassed: false, inputTokens: 25000, outputTokens: 50 });
  let status = await bridge.status(args, exec());
  assert.equal(status.budget.usageKnown, false); assert.equal(status.budget.chargedTokens, null);
  assert.equal(status.budget.verdict, 'unknown'); assert.equal(status.budget.observedVerdict, 'exceeds');
  assert.equal(status.budget.reportedTokensLowerBound, 25050); assert.equal(status.budget.observedSource, 'settlement');
  const settlementFile = path.join(state, 'budget-reconcile.json'), originalSettlement = read(settlementFile);
  fs.unlinkSync(settlementFile);
  status = await bridge.status(args, exec());
  assert.equal(status.budget.observedVerdict, 'exceeds'); assert.equal(status.budget.reportedTokensLowerBound, 25050);
  assert.equal(status.budget.observedSource, 'manifest'); assert.equal(status.budget.chargedTokens, null);
  const manifestFile = path.join(state, 'manifest.json'), originalManifest = read(manifestFile);
  for (const change of [
    value => { value.maxTokens = 99999; }, value => { value.reportedTokensLowerBound = -1; },
    value => { value.reportedTokensLowerBound = '25050'; }, value => { value.reportedTokensLowerBound = 100; },
    value => { value.verdict = 'unknown'; },
  ]) {
    const changed = structuredClone(originalManifest); change(changed.observedBudget); write(manifestFile, changed);
    status = await bridge.status(args, exec());
    assert.equal(status.budget.observedVerdict, 'unknown'); assert.equal(status.budget.reportedTokensLowerBound, null);
  }
  write(manifestFile, originalManifest);
  const conflicting = structuredClone(originalSettlement); conflicting.observedBudget.reportedTokensLowerBound = 25051;
  write(settlementFile, conflicting);
  status = await bridge.status(args, exec());
  assert.equal(status.budget.observedVerdict, 'unknown'); assert.equal(status.budget.consistency, 'conflict');
});
