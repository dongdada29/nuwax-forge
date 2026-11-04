import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateBinding, startupStatuses, writeEvidence, evaluateTaskEvidence } from '../lib/dsh-task-evidence.mjs';
export function binding(dir) { return { schemaVersion: 1, taskRef: { source: 'forge:instance-a', taskKey: 'task' }, attemptId: 'attempt', runId: 'run', invocationId: randomBytes(16).toString('hex'), targetEntryIds: ['include:target'], runtimeVersion: '0.2.1-rc.5', reportPath: path.join(dir, 'evidence.json') }; }
const ok = { status: 0, signal: null };
test('strict bindings, exclusive paths, bounded evidence and association', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-task-')));
  try {
    const b = binding(dir);
    for (const patch of [{ schemaVersion: 2 }, { runtimeVersion: '0.2.2' }, { reportPath: 'relative' }, { invocationId: 'old' }, { targetEntryIds: [] }, { targetEntryIds: ['x', 'x'] }, { taskRef: { source: 'forge', taskKey: 'x' } }]) assert.throws(() => validateBinding({ ...b, ...patch }));
    for (const taskRef of [{ source: ':', taskKey: 'x' }, { source: 'forge:', taskKey: 'x' }, { source: 'forge:a', taskKey: ' ' }]) assert.throws(() => validateBinding({ ...b, taskRef }));
    assert.equal(evaluateTaskEvidence(b, ok).passed, false);
    writeEvidence(b, [{ entryId: 'include:target', status: 'active' }]);
    assert.throws(() => writeEvidence(b, []));
    assert.equal(evaluateTaskEvidence(b, ok).passed, true);
    assert.equal(evaluateTaskEvidence({ ...b, taskRef: { taskKey: b.taskRef.taskKey, source: b.taskRef.source } }, ok).passed, true);
    assert.equal(evaluateTaskEvidence(b, { status: 1, signal: null }).passed, false);
    assert.equal(evaluateTaskEvidence(b, { ...ok, cleanupFailed: true }).passed, false);
    assert.equal(evaluateTaskEvidence(b, { status: null, signal: 'SIGTERM' }).passed, false);
    assert.throws(() => writeEvidence({ ...b, reportPath: path.join(dir, 'extra.json') }, [{ entryId: b.targetEntryIds[0], status: 'active', rawConfig: 'must-not-be-recorded' }]));
    const alias = path.join(dir, 'alias'); fs.symlinkSync(dir, alias);
    const aliased = { ...b, reportPath: path.join(alias, 'new.json') };
    assert.throws(() => writeEvidence(aliased, [{ entryId: b.targetEntryIds[0], status: 'active' }]));
    assert.equal(evaluateTaskEvidence(aliased, ok).passed, false);
    for (const patch of [{ invocationId: randomBytes(16).toString('hex') }, { attemptId: 'other' }, { runId: 'other' }, { targetEntryIds: ['target'] }, { taskRef: { source: 'forge:other', taskKey: 'task' } }]) assert.equal(evaluateTaskEvidence({ ...b, ...patch }, ok).passed, false);
    const original = fs.readFileSync(b.reportPath, 'utf8');
    for (const value of ['x'.repeat(32769), '{}', original.replace('active', 'ready'), original.replace('"statuses":', '"secret":"bad","statuses":')]) {
      fs.writeFileSync(b.reportPath, value); assert.equal(evaluateTaskEvidence(b, ok).passed, false);
    }
    fs.unlinkSync(b.reportPath); fs.symlinkSync(path.join(dir, 'elsewhere'), b.reportPath);
    assert.throws(() => writeEvidence(b, [])); assert.equal(evaluateTaskEvidence(b, ok).passed, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('snapshot states require exact IDs and all targets, with unknown kept unknown', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-task-')));
  try {
    const b = binding(dir);
    const entries = [{ id: 'include:target', fiber: { state: 2 } }];
    writeEvidence(b, startupStatuses(entries, b.targetEntryIds));
    assert.equal(evaluateTaskEvidence(b, ok).pluginReady, true);
    for (const [entry, status] of [[{ fiber: { state: 0 } }, 'pending'], [{ fiber: { state: 3 } }, 'failed'], [{ disabled: true }, 'disabled'], [{ fiber: { state: 9 } }, 'unknown']]) assert.equal(startupStatuses([{ id: 'include:target', ...entry }], b.targetEntryIds)[0].status, status);
    assert.equal(startupStatuses([{ id: 'target', fiber: { state: 2 } }], b.targetEntryIds)[0].status, 'missing');
    assert.equal(startupStatuses([...entries, ...entries], b.targetEntryIds)[0].status, 'duplicate');
    assert.equal(startupStatuses([{ id: 'include:target', fiber: { state: '2' } }], b.targetEntryIds)[0].status, 'unknown');
    assert.equal(startupStatuses([{ id: 'include:target', get disabled() { throw new Error('config failure'); } }], b.targetEntryIds)[0].status, 'unknown');
    for (const status of ['pending', 'failed', 'disabled', 'unknown', 'missing', 'duplicate']) {
      fs.unlinkSync(b.reportPath); writeEvidence(b, [{ entryId: b.targetEntryIds[0], status }]); assert.equal(evaluateTaskEvidence(b, ok).passed, false);
    }
    const multi = { ...b, targetEntryIds: ['include:target', 'include:other'] };
    fs.unlinkSync(b.reportPath); writeEvidence(multi, startupStatuses(entries, multi.targetEntryIds)); assert.equal(evaluateTaskEvidence(multi, ok).passed, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
