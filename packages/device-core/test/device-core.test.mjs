import assert from 'node:assert/strict';
import { test } from 'node:test';
import { declareCapabilities, connect, health, disconnect, evaluateStepEvidence, hostReadiness, DeviceError } from '../index.mjs';

const base = { deviceId: 'm1', platform: 'macos', transport: 'ssh', abilities: ['shell'] };

test('能力声明：合法配置冻结输出，非法变体拒绝', () => {
  const caps = declareCapabilities(base);
  assert.equal(caps.deviceId, 'm1');
  assert.equal(Object.isFrozen(caps), true);
  assert.equal(Object.isFrozen(caps.limits), true);
  assert.equal(caps.limits.maxSessions, 1);
  assert.equal(caps.limits.commandTimeoutMs, 30000);
  assert.throws(() => declareCapabilities({ ...base, platform: 'plan9' }), DeviceError);
  assert.throws(() => declareCapabilities({ ...base, abilities: ['teleport'] }), DeviceError);
  assert.throws(() => declareCapabilities({ ...base, deviceId: '../etc' }), DeviceError);
  assert.throws(() => declareCapabilities({ ...base, limits: { commandTimeoutMs: 0 } }), DeviceError);
});

test('生命周期：同参连接复用句柄；探活/close 结构化', () => {
  const sessions = new Map();
  let opened = 0, closed = 0;
  const transport = {
    open: () => { opened += 1; return { ok: true, handle: { id: opened } }; },
    probe: () => ({ ok: true }),
    close: () => { closed += 1; return { ok: true }; },
  };
  const deps = { transport, sessions };
  const h1 = connect(base, deps);
  const h2 = connect(base, deps);
  assert.equal(h1.reused, false);
  assert.equal(h2.reused, true);
  assert.equal(opened, 1);
  assert.deepEqual(health(h1, deps), { alive: true, latencyMs: h1 && health(h1, deps).latencyMs, error: null });
  assert.deepEqual(disconnect(h2, deps), { closed: true, error: null });
  assert.equal(closed, 1);
  assert.deepEqual(disconnect(h2, deps), { closed: true, error: null }); // 幂等
  assert.equal(health(h1, deps).alive, false); // 会话表已删，句柄失效化
});

test('生命周期：无传输/探活失败都走结构化错误，不抛异常', () => {
  const h = connect(base, {});
  assert.equal(h.ready, false);
  assert.equal(h.error.code, 'DEVICE_NO_TRANSPORT');
  const sessions = new Map();
  const bad = connect(base, { transport: { open: () => ({ ok: false, error: { code: 'SSH_AUTH', message: 'denied' } }) }, sessions });
  assert.equal(bad.ready, false);
  assert.equal(bad.error.code, 'SSH_AUTH');
  assert.deepEqual(health(bad, { transport: { probe: () => ({ ok: true }) } }), { alive: false, latencyMs: null, error: bad.error });
});

test('步骤证据：process 门控 + verify 回执 unknown 保留', () => {
  const step = { stepId: 'probe', verify: (o) => (o.stdout?.trim() === 'ok' ? { echoed: true } : { echoed: false }) };
  const ok = evaluateStepEvidence(step, { status: 0, signal: null, error: null, stdout: 'ok\n' });
  assert.equal(ok.processPassed, true);
  assert.equal(ok.stepPassed, true);
  assert.deepEqual(ok.evidence, { echoed: true });
  const noStdout = evaluateStepEvidence(step, { status: 0, signal: null, error: null });
  assert.equal(noStdout.stepPassed, true);
  assert.deepEqual(noStdout.evidence, { echoed: false });
  const crashed = evaluateStepEvidence(step, { status: null, signal: 'SIGSEGV', error: null });
  assert.equal(crashed.processPassed, false);
  assert.equal(crashed.stepPassed, false);
  assert.equal(evaluateStepEvidence({ stepId: '' }, { status: 0, signal: null, error: null }).reason, 'invalid-step-id');
  assert.equal(evaluateStepEvidence({ stepId: 'x', verify: () => 42 }, { status: 0, signal: null, error: null }).reason, 'invalid-evidence');
});

test('宿主就绪检查：三检查项全过才 ready，未知宿主拒绝', () => {
  const good = { entryLoaded: true, versionMatched: true, toolsRegistered: true };
  assert.deepEqual(hostReadiness('forge', good), { host: 'forge', ready: true, checks: [{ name: 'entry-loaded', passed: true, detail: null }, { name: 'version-matched', passed: true, detail: null }, { name: 'tools-registered', passed: true, detail: null }] });
  assert.equal(hostReadiness('dsh', { ...good, versionMatched: false }).ready, false);
  assert.equal(hostReadiness('plan9', good).ready, false);
});
