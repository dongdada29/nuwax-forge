// Fresh process: no memory file fixture writes, no inherited runtime/module caches.
import assert from 'node:assert/strict';
import { memoryRuntime } from './bots-memory-runtime.mjs';
import { modelAttempts } from './bots-memory-sdk.mjs';

const [home, mode] = process.argv.slice(2);
const f = await memoryRuntime(process.env.FORGE_BOT_MEMORY_PACKAGE, home, { seed: false, expectReadOnly: mode === 'locked' });
try {
  if (mode === 'locked') {
    assert.match(f.rt.readOnly(), /open in another dsh/);
    await assert.rejects(f.call('alpha', 'remember', { text: 'Second process must not persist this.' }), error => error.code === 'memory/failed' && /Memory cannot change now/.test(error.message));
    process.stdout.write(JSON.stringify({ readOnly: true, writeRefused: true, modelCalls: modelAttempts }));
  } else {
    assert.equal(mode, 'reopen'); assert.equal(f.rt.readOnly(), undefined);
    const views = await Promise.all([{ botId: 'alpha' }, { botId: 'private' }, { roomId: 'red' }].map(f.view));
    assert.match(await f.call('alpha', 'recall', { scope: 'own' }), /Persistent own amber entry/);
    assert.match(await f.call('beta', 'recall', { scope: 'team' }), /Persistent team green entry/);
    assert.match(await f.call('red-admin', 'recall', { scope: 'group' }), /Persistent group ruby entry/);
    assert.match(await f.call('private', 'recall'), /Persistent private violet entry/);
    assert.doesNotMatch(await f.call('beta', 'recall'), /amber|ruby|violet|Second process/);
    await assert.rejects(f.call('chief', 'recall', { scope: 'Private' }), /private Bot/);
    process.stdout.write(JSON.stringify({ pid: process.pid, views, nonemptyScopes: 4, modelCalls: modelAttempts }));
  }
} finally { await f.close(); }
