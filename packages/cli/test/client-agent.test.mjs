// All execution fixtures are local marker processes; no models, credentials, or user sessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Observation, dshPatch, command, environment } from '../lib/agent/adapters.mjs';
const bin = fileURLToPath(new URL('../bin/nuwax-devkit.mjs', import.meta.url));
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const codexEvents = [
  { type: 'thread.started', thread_id: 'fixture-fresh' }, { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'fixture result' } },
  { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 80 } },
];
const dshEvents = [
  { type: 'session', sessionId: 'fixture-new' },
  { type: 'status', phase: 'step_start', turn: 0, step: 0 },
  { type: 'status', phase: 'step_end', turn: 0, step: 0, usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 80, totalTokens: 110 } },
  { type: 'status', phase: 'turn_end', turn: 0, reason: { kind: 'completed' } },
  { type: 'final', text: 'fixture result' },
];
function observe(kind, events) { const o = new Observation(kind); events.forEach(e => o.push(e)); return o.result(); }
function fixture(t, kind = 'codex', events = codexEvents, hang = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-client-agent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wt = path.join(root, 'wt'); fs.mkdirSync(wt); spawnSync('git', ['init', '-q', wt]);
  const executable = path.join(root, 'fixture.mjs'), marker = path.join(root, 'dispatches');
  fs.writeFileSync(executable, `#!${process.execPath}\nimport fs from 'node:fs';
const args=process.argv.slice(2);
if(args.includes('--version')) {console.log(${JSON.stringify(kind === 'codex' ? 'codex-cli 0.165.0' : '0.2.1-rc.5')});process.exit(0)}
if(args.includes('--help')) {console.log('--json --ephemeral --ignore-user-config --ignore-rules --sandbox --cd --patch headless');process.exit(0)}
if (${JSON.stringify(kind)} === 'codex' && args.some(arg => /^model_providers[.]openai(?:[.=]|$)/.test(arg))) {
  console.error('model_providers contains reserved built-in provider IDs: openai'); process.exit(1);
}
fs.appendFileSync(${JSON.stringify(marker)},'dispatch\\n');
for await (const chunk of process.stdin) {}
${hang === true ? '' : `for(const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));`}
${hang ? 'setInterval(()=>{},1000);' : ''}
`, { mode: 0o700 });
  const spec = { schemaVersion: 1, taskKey: 'fixture-only', worktree: wt,
    runtime: { kind, binary: executable, model: 'fixture-model', provider: 'deepseek-official', contextMode: 'fresh-exec' },
    permissions: { mode: 'read-only' }, budget: { maxTokens: 20000, maxWallSeconds: hang ? 1 : 5, maxAttempts: 1 },
    budgetSpec: { schemaVersion: 1, id: 'fixture-only', mode: 'model', taskKind: 'text-implementation', model: { name: 'fixture-model' },
      expectedCalls: 1, initialContextTokens: 1000, perCallOutputTokens: 10, budgetTokens: 20000 } };
  const specFile = path.join(root, 'spec.json'), brief = path.join(root, 'task.txt'), state = path.join(root, 'state');
  fs.writeFileSync(brief, 'deterministic fixture');
  const cli = args => spawnSync(process.execPath, [bin, 'agent', ...args], { encoding: 'utf8', timeout: 15000 });
  const prepare = () => { fs.writeFileSync(specFile, JSON.stringify(spec)); return cli(['prepare', '--spec', specFile, '--brief-file', brief, '--state', state]); };
  return { root, wt, state, spec, marker, cli, prepare, specFile, brief };
}

test('Codex cache is an input subset; missing token/corrupt totals are unknown, never zero', () => {
  const known = observe('codex', codexEvents);
  assert.equal(known.usage.inputTokens + known.usage.outputTokens, 110);
  assert.equal(known.usage.cachedReadTokens, 80);
  assert.equal(known.observation.known, true);
  assert.equal(observe('codex', []).usage.inputTokens, null);
  assert.equal(observe('codex', codexEvents.slice(0, 3)).usageScope, 'unknown');
  const bad = structuredClone(codexEvents); bad[3].usage.cached_input_tokens = 101;
  assert.equal(observe('codex', bad).usageScope, 'unknown');
  assert.equal(observe('codex', [...codexEvents, codexEvents[3]]).usageScope, 'unknown');
});
test('reported lower bound survives termination without claiming complete usage; invalid reports cannot prove a bound', () => {
  for (const [kind, events] of [['codex', codexEvents], ['deepseek-harness', dshEvents]]) {
    const o = new Observation(kind); events.forEach(e => o.push(e));
    const interrupted = o.result(false);
    assert.equal(interrupted.usageScope, 'unknown');
    assert.equal(interrupted.observation.known, false);
    assert.equal(interrupted.observation.reportedTokensLowerBound, 110);
    assert.equal(interrupted.usage.cachedReadTokens, 80);
    o.bad('malformed-jsonl');
    assert.equal(o.result(false).observation.reportedTokensLowerBound, null);
  }
  assert.equal(observe('codex', []).observation.reportedTokensLowerBound, null);
  assert.equal(observe('codex', codexEvents.slice(1)).observation.reportedTokensLowerBound, null);
  assert.equal(observe('codex', [...codexEvents, codexEvents[3]]).observation.reportedTokensLowerBound, null);
  const badCache = structuredClone(codexEvents); badCache[3].usage.cached_input_tokens = 101;
  assert.equal(observe('codex', badCache).observation.reportedTokensLowerBound, null);
  const partial = observe('deepseek-harness', [...dshEvents.slice(0, 3), { type: 'status', phase: 'step_start', turn: 0, step: 1 }]);
  assert.equal(partial.observation.known, false);
  assert.equal(partial.observation.reportedTokensLowerBound, 110);
});
test('DSH rc5 exact total counted once, identical step snapshots dedup; conflict/missing/truncated remain unknown', () => {
  const known = observe('deepseek-harness', [...dshEvents, dshEvents[2]]);
  assert.equal(known.observation.known, true);
  assert.equal(known.usage.inputTokens, 100); assert.equal(known.usage.outputTokens, 10);
  const bad = structuredClone(dshEvents); delete bad[2].usage;
  assert.equal(observe('deepseek-harness', bad).usageScope, 'unknown');
  const conflict = structuredClone(dshEvents[2]); conflict.usage.totalTokens++;
  assert.equal(observe('deepseek-harness', [...dshEvents, conflict]).usageScope, 'unknown');
  assert.equal(observe('deepseek-harness', dshEvents.filter(e => e.phase !== 'step_end')).usageScope, 'unknown');
  const truncated = structuredClone(dshEvents); truncated[2].truncated = true;
  assert.equal(observe('deepseek-harness', truncated).usageScope, 'unknown');
});
for (const [kind, events] of [['codex', codexEvents], ['deepseek-harness', dshEvents]]) {
  test(`${kind}: real CLI prepare/run/reconcile with marker, one-shot and separate acceptance`, t => {
    const f = fixture(t, kind, events), prepared = f.prepare(); assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(fs.existsSync(f.marker), false);
    const result = f.cli(['run', '--state', f.state]); assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'completed'); assert.equal(out.acceptancePassed, null); assert.equal(out.chargedTokens, 110);
    assert.equal(out.processPassed, true); assert.equal(out.agentCompleted, true);
    assert.equal(f.cli(['run', '--state', f.state]).status, 2);
    assert.equal(f.cli(['reconcile', '--state', f.state]).status, 0);
    assert.equal(fs.readFileSync(f.marker, 'utf8'), 'dispatch\n');
    const args = read(path.join(f.state, 'command.json'));
    assert.ok(!args.includes('resume') && !args.includes('fork') && !args.includes('--session-id'));
    if (kind === 'codex') assert.ok(args.includes('--ephemeral') && args.includes('--ignore-user-config'));
    else { const patch = read(path.join(f.state, 'dsh.patch.json')); assert.equal(patch.find(p => p.id === 'llm-retry').disabled, true); }
  });
}
test('prediction unknown/HIGH over/model mismatch block before dispatch', t => {
  for (const mutate of [s => delete s.budgetSpec, s => delete s.budgetSpec.perCallOutputTokens,
    s => s.budget.maxTokens = 1, s => s.budgetSpec.model.name = 'different',
    s => s.context = { runtimeContextTokens: 30000 }]) {
    const f = fixture(t); mutate(f.spec); const p = f.prepare(); assert.equal(p.status, 3, p.stderr);
    assert.equal(JSON.parse(p.stdout).status, 'blocked'); assert.equal(fs.existsSync(f.marker), false);
    assert.equal(f.cli(['run', '--state', f.state]).status, 2);
  }
});
test('fresh-only/permissions/attempts enforced and state inside worktree via symlink rejected', t => {
  for (const mutate of [s => s.budget.maxAttempts = 2, s => s.runtime.contextMode = 'resume',
    s => s.runtime.sessionId = 'someone-else', s => s.permissions.mode = 'danger-full-access']) {
    const f = fixture(t); mutate(f.spec); assert.equal(f.prepare().status, 2); assert.equal(fs.existsSync(f.marker), false);
  }
  const f = fixture(t); fs.writeFileSync(f.specFile, JSON.stringify(f.spec));
  const link = path.join(f.root, 'alias'); fs.symlinkSync(f.wt, link);
  const p = f.cli(['prepare', '--spec', f.specFile, '--brief-file', f.brief, '--state', path.join(link, 'bad')]);
  assert.equal(p.status, 2); assert.equal(fs.existsSync(path.join(f.wt, 'bad')), false);
});
test('unknown actual blocks budget even with exit zero; cannot retry; context mutation blocks before model', t => {
  const f = fixture(t, 'codex', codexEvents.slice(0, 3)); assert.equal(f.prepare().status, 0);
  const r = f.cli(['run', '--state', f.state]); assert.equal(r.status, 1, r.stderr);
  const out = JSON.parse(r.stdout); assert.equal(out.processPassed, true); assert.equal(out.budgetPassed, false); assert.equal(out.chargedTokens, null);
  assert.equal(f.cli(['run', '--state', f.state]).status, 2);
  const g = fixture(t); g.spec.context = { contextFiles: ['input.txt'] }; fs.writeFileSync(path.join(g.wt, 'input.txt'), 'one');
  assert.equal(g.prepare().status, 0); fs.writeFileSync(path.join(g.wt, 'input.txt'), 'two');
  assert.equal(g.cli(['run', '--state', g.state]).status, 3); assert.equal(fs.existsSync(g.marker), false);
  const h = fixture(t); h.spec.context = { runtimeContextTokens: 100 };
  assert.equal(h.prepare().status, 0);
  const request = read(path.join(h.state, 'request.json')); request.context.runtimeContextTokens = 200;
  fs.writeFileSync(path.join(h.state, 'request.json'), JSON.stringify(request));
  assert.equal(h.cli(['run', '--state', h.state]).status, 3); assert.equal(fs.existsSync(h.marker), false);
});
test('wall timeout stops owned marker process and persists unknown usage', t => {
  const f = fixture(t, 'codex', [], true); assert.equal(f.prepare().status, 0);
  const r = f.cli(['run', '--state', f.state]); assert.equal(r.status, 1, r.stderr);
  const out = JSON.parse(r.stdout); assert.equal(out.stopReason, 'wall-timeout'); assert.equal(out.processPassed, false);
  assert.equal(out.chargedTokens, null); assert.equal(out.acceptancePassed, null);
  assert.equal(out.observedBudget.reportedTokensLowerBound, null);
  assert.equal(out.observedBudget.verdict, 'unknown');
});
test('reported overflow stays explicit after forced termination and repeat reconciliation, with complete billing unknown', t => {
  const events = structuredClone(codexEvents);
  events[3].usage = { input_tokens: 25000, output_tokens: 50, cached_input_tokens: 24000 };
  const f = fixture(t, 'codex', events, 'after-events');
  assert.equal(f.prepare().status, 0);
  const r = f.cli(['run', '--state', f.state]); assert.equal(r.status, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.stopReason, 'observed-token-budget-exceeded');
  assert.equal(out.processPassed, false); assert.equal(out.agentCompleted, true);
  assert.equal(out.usageKnown, false); assert.equal(out.chargedTokens, null);
  assert.equal(out.budgetPassed, false); assert.equal(out.acceptancePassed, null);
  assert.equal(out.cleanupFailed, false);
  assert.deepEqual(out.observedBudget, read(path.join(f.state, 'budget-reconcile.json')).observedBudget);
  assert.equal(out.observedBudget.verdict, 'exceeds');
  assert.equal(out.observedBudget.reportedTokensLowerBound, 25050);
  const usage = read(path.join(f.state, 'usage.json'));
  assert.equal(usage.usageScope, 'unknown');
  assert.equal(usage.usage.cachedReadTokens, 24000);
  assert.deepEqual(usage.observation.rawUsage, [events[3].usage]);
  const bill = read(path.join(f.state, 'budget-reconcile.json'));
  assert.equal(bill.reconciliation.budget.verdict, 'unknown');
  assert.equal(bill.reconciliation.usableForCalibration, false);
  const repeated = f.cli(['reconcile', '--state', f.state]); assert.equal(repeated.status, 1);
  assert.deepEqual(JSON.parse(repeated.stdout).observedBudget, out.observedBudget);
  assert.equal(fs.readFileSync(f.marker, 'utf8'), 'dispatch\n');
  fs.appendFileSync(path.join(f.state, 'stdout.jsonl'), 'not-json\n');
  const corrupted = f.cli(['reconcile', '--state', f.state]); assert.equal(corrupted.status, 1);
  assert.equal(JSON.parse(corrupted.stdout).observedBudget.reportedTokensLowerBound, null);
  assert.equal(JSON.parse(corrupted.stdout).budgetPassed, false);
});
test('partial reported usage below the limit cannot pass the budget gate', t => {
  const f = fixture(t, 'deepseek-harness', dshEvents.slice(0, 3));
  assert.equal(f.prepare().status, 0);
  const r = f.cli(['run', '--state', f.state]); assert.equal(r.status, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.processPassed, true); assert.equal(out.usageKnown, false);
  assert.equal(out.observedBudget.reportedTokensLowerBound, 110);
  assert.equal(out.observedBudget.verdict, 'unknown');
  assert.equal(out.budgetPassed, false); assert.equal(out.chargedTokens, null);
});
test('DSH scoped env and patch avoid global settings/session adoption', () => {
  const env = environment('deepseek-harness', '/fixture'); assert.equal(env.DSH_HOME, '/fixture/dsh-home');
  const spec = { runtime: { kind: 'deepseek-harness', binary: '/dsh', provider: 'deepseek-official', model: 'deepseek-flash' }, permissions: { mode: 'workspace-write' }, worktree: '/work' };
  assert.equal(dshPatch(spec, '/state').find(p => p.id === 'sandbox-policy').config.workspaceRoot, '/work');
  assert.deepEqual(command(spec, '/state'), ['/dsh', '--profile', 'headless', '--patch', '/state/dsh.patch.json', '--json', '-']);
});

test('lifecycle: normal exit sends no signals; TERM success never KILLs an empty group', async () => {
  const { supervise } = await import('../lib/agent/lifecycle.mjs');
  const sent = [];
  const signalProcess = (pid, sig) => { sent.push(sig); process.kill(pid, sig); };
  const normal = await supervise([process.execPath, '-e', 'process.exit(0)'], { signalProcess });
  assert.equal(normal.returnCode, 0); assert.equal(normal.cleanupFailed, false); assert.deepEqual(sent, []);
  const term = await supervise([process.execPath, '-e', 'console.log("ready");setTimeout(()=>process.exit(0),3000)'], {
    signalProcess, onStdout: (chunk, stop) => { if (chunk.includes('ready')) stop('fixture-stop'); },
  });
  assert.equal(term.cleanupFailed, false); assert.deepEqual(sent, ['SIGTERM']);
  assert.deepEqual(term.remainingPids, []);
});

test('lifecycle: denied TERM/KILL returns bounded failure without awaiting close', async () => {
  const { supervise } = await import('../lib/agent/lifecycle.mjs');
  const deny = () => { throw Object.assign(new Error('synthetic denial'), { code: 'EPERM' }); };
  const began = Date.now();
  const result = await supervise([process.execPath, '-e', 'console.log("ready");setTimeout(()=>process.exit(0),3000)'], {
    wallMs: 1000, graceMs: 80, pollMs: 10, signalProcess: deny,
    onStdout: (chunk, stop) => { if (chunk.includes('ready')) stop('fixture-stop'); },
  });
  try {
    assert.ok(Date.now() - began < 1800, 'must return while close is still unavailable');
    assert.equal(result.cleanupFailed, true); assert.equal(result.closed, false);
    assert.ok(result.cleanupErrors.some(e => e.includes('EPERM')));
    assert.ok(result.cleanupErrors.includes('client-close-deadline-exceeded'));
    assert.ok(result.remainingPids.includes(result.pid));
  } finally { try { process.kill(-result.pid, 'SIGKILL'); } catch {} }
});

test('lifecycle: EPERM termination probe blocks actual adapter dispatch and leaves usage unknown', async t => {
  const { run } = await import('../lib/agent/index.mjs');
  const f = fixture(t); assert.equal(f.prepare().status, 0);
  const began = Date.now();
  const out = await run(f.state, { graceMs: 80, pollMs: 10,
    signalProcess: () => { throw Object.assign(new Error('synthetic denial'), { code: 'EPERM' }); } });
  try {
    assert.ok(Date.now() - began < 1800);
    assert.equal(out.status, 'blocked'); assert.equal(out.reason, 'termination-probe-blocked');
    assert.equal(out.modelDispatched, false); assert.equal(out.cleanupFailed, true);
    assert.equal(out.chargedTokens, null); assert.equal(out.usageKnown, false);
    assert.equal(fs.existsSync(f.marker), false);
    assert.equal(read(path.join(f.state, 'termination-probe.json')).modelRequests, 0);
    assert.equal(fs.existsSync(path.join(f.state, 'stdout.jsonl')), false);
  } finally { try { process.kill(-out.terminationProbe.pid, 'SIGKILL'); } catch {} }
});

test('lifecycle: cleanup permission changes after probe still return failed manifest with unknown usage', async t => {
  const { run } = await import('../lib/agent/index.mjs');
  const f = fixture(t, 'codex', [], true); assert.equal(f.prepare().status, 0);
  let probeSignalled = false;
  const began = Date.now();
  const out = await run(f.state, { graceMs: 80, pollMs: 10, signalProcess: (pid, sig) => {
    if (!probeSignalled) { probeSignalled = true; process.kill(pid, sig); }
    else throw Object.assign(new Error('permission changed after probe'), { code: 'EPERM' });
  } });
  try {
    assert.ok(Date.now() - began < 5000);
    assert.equal(out.terminationProbe.passed, true); assert.equal(out.modelDispatched, true);
    assert.equal(out.status, 'failed'); assert.equal(out.stopReason, 'wall-timeout');
    assert.equal(out.cleanupFailed, true); assert.equal(out.usageKnown, false); assert.equal(out.chargedTokens, null);
    assert.equal(out.processPassed, false); assert.equal(out.acceptancePassed, null);
    assert.equal(read(path.join(f.state, 'usage.json')).usageScope, 'unknown');
  } finally { try { process.kill(-out.pid, 'SIGKILL'); } catch {} }
});
