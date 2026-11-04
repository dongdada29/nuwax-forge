// Run only by bots-memory.test.mjs after SRI and original-file verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { memoryRuntime } from './bots-memory-runtime.mjs';

const packageDir = process.env.FORGE_BOT_MEMORY_PACKAGE;
const root = process.env.FORGE_BOT_MEMORY_ROOT;
assert.ok(packageDir && root, 'use the verified parent test, not this helper directly');
const fixture = async t => {
  const home = mkdtempSync(join(root, 'team-'));
  const runtime = await memoryRuntime(packageDir, home);
  t.after(() => runtime.close());
  return { ...runtime, home };
};
const texts = panel => panel.entries.map(entry => entry.text).sort();
const denied = (call, message) => assert.rejects(call, error => error.code === 'memory/refused' && message.test(error.message));
const execute = promisify(execFile);
const restartProcess = async (home, mode) => {
  const { stdout, stderr } = await execute(process.execPath, [fileURLToPath(new URL('./bots-memory-reopen.mjs', import.meta.url)), home, mode], { env: process.env, timeout: 10000 });
  assert.equal(stderr, '');
  return JSON.parse(stdout);
};

test('original tools scope remember/recall/forget to Bot Sessions; nonempty own memory stays separate', async t => {
  const f = await fixture(t);
  for (const id of ['alpha', 'red-alpha']) for (const name of ['remember', 'recall', 'forget']) assert.ok(f.agent(id).registered.has(name));
  for (const id of ['unowned-session', 'red']) for (const name of ['remember', 'recall', 'forget']) assert.equal(f.agent(id).registered.has(name), false);
  await f.call('alpha', 'remember', { text: 'Alpha keeps the amber notebook.' });
  await f.call('beta', 'remember', { text: 'Beta keeps the blue notebook.' });
  assert.match(await f.call('alpha', 'recall'), /amber notebook/);
  assert.doesNotMatch(await f.call('alpha', 'recall'), /blue notebook/);
  assert.doesNotMatch(await f.call('beta', 'recall'), /amber notebook/);
  assert.deepEqual(texts(await f.view({ botId: 'alpha' })), ['Alpha keeps the amber notebook.']);
  assert.deepEqual(texts(await f.view({ botId: 'beta' })), ['Beta keeps the blue notebook.']);
  assert.deepEqual(texts(await f.view({ roomId: 'red' })), []);
  await assert.rejects(f.view({ botId: 'nonexistent' }), /Unknown Bot/);
});

test('team memory is shared; original role checks allow Chief/admin and reject ordinary or demoted Bots', async t => {
  const f = await fixture(t);
  await f.call('chief', 'remember', { scope: 'team', text: 'The team writes release notes in Chinese.' });
  await f.call('admin', 'remember', { scope: 'team', text: 'The team records acceptance evidence.' });
  for (const id of ['chief', 'alpha', 'beta', 'private']) {
    const recall = await f.call(id, 'recall', { scope: 'team' });
    assert.match(recall, /release notes in Chinese/); assert.match(recall, /acceptance evidence/);
  }
  const before = texts(await f.view({ botId: 'alpha' }));
  await denied(() => f.call('alpha', 'remember', { scope: 'team', text: 'Unauthorized team entry.' }), /Main Bots and group admins/);
  await denied(() => f.call('beta', 'forget', { scope: 'team', entry: 'release notes' }), /Main Bots and group admins/);
  f.rt.state.rooms.red.admin = 'chief'; await f.rt.save({ required: true });
  await denied(() => f.call('admin', 'remember', { scope: 'team', text: 'Demoted admin entry.' }), /Main Bots and group admins/);
  assert.deepEqual(texts(await f.view({ botId: 'alpha' })), before);
});

test('group writes default to that group and are readable only in member Sessions there', async t => {
  const f = await fixture(t);
  await f.call('red-alpha', 'remember', { text: 'Red uses the ruby checklist.' });
  await f.call('blue-beta', 'remember', { text: 'Blue uses the cobalt checklist.' });
  assert.match(await f.call('red-admin', 'recall', { scope: 'group' }), /ruby checklist/);
  assert.doesNotMatch(await f.call('red-alpha', 'recall'), /cobalt checklist/);
  assert.doesNotMatch(await f.call('blue-beta', 'recall'), /ruby checklist/);
  assert.doesNotMatch(await f.call('alpha', 'recall'), /ruby checklist/);
  assert.deepEqual(texts(await f.view({ botId: 'alpha' })), []);
  assert.deepEqual(texts(await f.view({ roomId: 'red' })), ['Red uses the ruby checklist.']);
  assert.deepEqual(Object.keys((await f.view({ roomId: 'red' })).sizes), ['group']);
  await denied(() => f.call('alpha', 'remember', { scope: 'group', text: 'Outside group context.' }), /no group memory here/);
  assert.match(await f.call('chief', 'recall', { scope: 'group' }), /no group memory here/);
  // Deliberately retain the old Session mapping: memory must recheck membership.
  f.rt.state.rooms.red.members = ['chief', 'admin']; await f.rt.save({ required: true });
  await denied(() => f.call('red-alpha', 'remember', { text: 'Former member entry.' }), /Only the members/);
  assert.match(await f.call('red-alpha', 'recall', { scope: 'group' }), /no group memory here/);
  assert.doesNotMatch(await f.call('red-alpha', 'recall'), /ruby checklist/);
  assert.deepEqual(texts(await f.view({ roomId: 'red' })), ['Red uses the ruby checklist.']);
});

test('native privacy middleware closes private memory even to Chief and keeps its journal separate', async t => {
  const f = await fixture(t);
  await f.call('alpha', 'remember', { text: 'Public alpha preference.' });
  await f.call('private', 'remember', { text: 'Private violet preference.' });
  await f.call('private-other', 'remember', { text: 'Other private silver preference.' });
  for (const caller of ['chief', 'alpha', 'private-other']) {
    for (const [name, args] of [['recall', {}], ['remember', { text: 'Blocked edit.' }], ['forget', { entry: 'violet' }]]) {
      await assert.rejects(f.call(caller, name, { scope: 'Private', ...args }), /private Bot.*cannot reach its memory/);
    }
  }
  assert.match(await f.call('private', 'recall', { scope: 'Alpha' }), /Public alpha preference/);
  assert.match(await f.call('beta', 'recall', { scope: 'Alpha' }), /Only a Main Bot can read/);
  await denied(() => f.call('beta', 'remember', { scope: 'Alpha', text: 'Other Bot edit.' }), /Only a Main Bot can change/);
  await f.call('chief', 'remember', { scope: 'Alpha', text: 'Chief approved public correction.' });
  assert.match(await f.call('chief', 'recall', { scope: 'Alpha' }), /Chief approved public correction/);
  assert.deepEqual(texts(await f.view({ botId: 'private' })), ['Private violet preference.'], 'user panel can inspect its private Bot');
  const shared = readFileSync(join(f.home, 'memory', 'journal.jsonl'), 'utf8');
  assert.doesNotMatch(shared, /violet|silver/);
  assert.match(readFileSync(join(f.home, 'memory', 'bots', 'private', 'journal.jsonl'), 'utf8'), /violet/);
  assert.doesNotMatch(JSON.stringify(await f.history({ botId: 'alpha' })), /violet|silver/);
  assert.match(JSON.stringify(await f.history({ botId: 'private' })), /violet/);
});

test('original remember replace, topic recall, forget and input refusals preserve the recorded history', async t => {
  const f = await fixture(t);
  await f.call('alpha', 'remember', { text: 'User prefers concise reports.', topic: 'reporting' });
  await f.call('alpha', 'remember', { text: 'User prefers Chinese reports.', replace: 'concise reports', topic: 'reporting' });
  const recalled = await f.call('alpha', 'recall', { topic: 'reporting' });
  assert.match(recalled, /Chinese reports/); assert.doesNotMatch(recalled, /concise reports/);
  for (const args of [{ text: 'x'.repeat(301) }, { text: 'Safe entry.', topic: '../escape' }, { text: 'Safe entry.', scope: 'MissingBot' }, { text: 'sk-this-is-a-fake-fixture-key-not-a-real-credential' }]) {
    await denied(() => f.call('alpha', 'remember', args), /./);
  }
  await f.call('alpha', 'forget', { entry: 'Chinese reports', topic: 'reporting' });
  assert.deepEqual(texts(await f.view({ botId: 'alpha' })), []);
  const history = await f.history({ botId: 'alpha' });
  assert.deepEqual(history.rows.map(row => row.op), ['remove', 'replace', 'add']);
  assert.ok(history.rows.every(row => row.by === 'Alpha' && row.scope === 'own'));
  assert.equal(existsSync(join(f.home, 'memory', 'pending.json')), false, 'native writes must finish their journal transaction');
});

test('native prompt snapshot stays frozen while recall reads new entries, then renew picks them up', async t => {
  const f = await fixture(t);
  await f.call('alpha', 'remember', { text: 'Alpha prefers short reports.' });
  const frozen = f.section('alpha'); assert.match(frozen, /short reports/);
  await f.call('alpha', 'remember', { text: 'Alpha prefers detailed reports.', replace: 'short reports' });
  assert.equal(f.section('alpha'), frozen);
  assert.match(await f.call('alpha', 'recall'), /detailed reports/);
  f.rt.renewMemory('alpha');
  assert.match(f.section('alpha'), /detailed reports/);
  assert.doesNotMatch(f.section('alpha'), /short reports/);
});

test('the same fixture identities in independent native homes do not share own/team/group files', async t => {
  const one = await fixture(t); const two = await fixture(t);
  for (const [f, label] of [[one, 'First'], [two, 'Second']]) {
    await f.call('alpha', 'remember', { text: `${label} home own marker.` });
    await f.call('chief', 'remember', { scope: 'team', text: `${label} home team marker.` });
    await f.call('red-alpha', 'remember', { text: `${label} home group marker.` });
  }
  const first = await one.call('red-alpha', 'recall');
  const second = await two.call('red-alpha', 'recall');
  for (const scope of ['own', 'team', 'group']) {
    assert.match(first, new RegExp(`First home ${scope} marker`));
    assert.match(second, new RegExp(`Second home ${scope} marker`));
  }
  assert.doesNotMatch(first, /Second home/); assert.doesNotMatch(second, /First home/);
});

test('a second process cannot write under the original store lock; a fresh process reopens nonempty scopes', async t => {
  const home = mkdtempSync(join(root, 'persistent-team-'));
  const f = await memoryRuntime(packageDir, home);
  let closed = false; t.after(async () => { if (!closed) await f.close(); });
  await f.call('alpha', 'remember', { text: 'Persistent own amber entry.' });
  await f.call('chief', 'remember', { scope: 'team', text: 'Persistent team green entry.' });
  await f.call('red-alpha', 'remember', { text: 'Persistent group ruby entry.' });
  await f.call('private', 'remember', { text: 'Persistent private violet entry.' });
  const before = await Promise.all([{ botId: 'alpha' }, { botId: 'private' }, { roomId: 'red' }].map(f.view));
  assert.deepEqual(await restartProcess(home, 'locked'), { readOnly: true, writeRefused: true, modelCalls: 0 });
  await f.close(); closed = true;
  const reopened = await restartProcess(home, 'reopen');
  assert.deepEqual(reopened.views, before);
  assert.equal(reopened.nonemptyScopes, 4); assert.equal(reopened.modelCalls, 0);
  assert.notEqual(reopened.pid, process.pid, 'persistence must be checked in another Node process');
});
