// Opt-in integration acceptance against the real, installed DSH executable.
// No mock Cordis host, API keys, messages, model calls, or UI simulation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { checkBot, prepareBot, startBot } from '../lib/bots/profile.mjs';

async function host(options) {
  const child = startBot(options, ['ignore', 'pipe', 'pipe']);
  let log = ''; let failure;
  child.on('error', error => { failure = error; });
  const closed = new Promise(resolve => child.once('close', resolve));
  const add = chunk => { log = (log + chunk.toString()).slice(-1024 * 1024); };
  child.stdout.on('data', add); child.stderr.on('data', add);
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000); timer.unref();
    await closed; clearTimeout(timer);
    // Do not persist startup tokens/cookies or raw host output.
    log = '';
  };
  try {
    let launch;
    for (let n = 0; n < 150; n++) {
      launch = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
      if (launch || failure || child.exitCode !== null) break;
      await delay(100);
    }
    assert.ok(!failure && launch, 'real DSH did not provide a loopback launch URL (raw output withheld)');
    const origin = new URL(launch).origin;
    const unauthorized = await fetch(origin + '/api/bot', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ endpoint: 'state' }) });
    assert.equal(unauthorized.status, 401, 'native authentication must remain active');
    const auth = await fetch(launch, { redirect: 'manual' });
    assert.equal(auth.status, 303);
    const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    assert.ok(cookie);
    const headers = { 'content-type': 'application/json', origin, cookie };
    const rawApi = async (endpoint, payload = {}) => {
      const response = await fetch(origin + '/api/bot', { method: 'POST', headers, body: JSON.stringify({ endpoint, payload }), signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200);
      return response.json();
    };
    const api = async (...args) => { const result = await rawApi(...args); assert.equal(result.ok, true, 'original Bot endpoint refused request'); return result.value; };
    const html = await (await fetch(origin + '/', { headers })).text();
    const moduleUrl = html.match(/"id":"ds-bot","url":"([^"]+)"/)?.[1];
    assert.ok(moduleUrl, 'original DS-Bot client must be discoverable in DSH module catalog');
    const client = await fetch(new URL(moduleUrl, origin + '/'), { headers });
    assert.equal(client.status, 200);
    assert.ok((await client.text()).length > 10000, 'original compiled client must actually be served');
    return { api, rawApi, stop };
  } catch (error) { await stop(); throw error; }
}

test('real DSH mounts original client/Chief, persists Bots/groups, and refuses invalid targets without a model', { skip: !process.env.FORGE_BOT_TEST_DSH, timeout: 120000 }, async t => {
  const parent = mkdtempSync(join(tmpdir(), 'forge-bots-host-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const options = { root: join(parent, 'team'), binary: process.env.FORGE_BOT_TEST_DSH, tarball: process.env.FORGE_BOT_TEST_TARBALL };
  const prepared = await prepareBot(options);
  assert.equal(prepared.acceptance.installation, 'verified');
  assert.equal(prepared.acceptance.host, 'not-run');
  assert.equal(prepared.package.originalFilesVerified, 7);
  assert.equal(existsSync(join(prepared.paths.dshHome, '.credentials.yaml')), false);
  // Re-running prepare checks its root, rather than resetting native profiles/data.
  assert.equal((await prepareBot(options)).acceptance.composition, 'verified');

  const patch = join(prepared.paths.profileDir, 'cordis.patch.yml');
  const original = readFileSync(patch, 'utf8');
  const disabled = JSON.parse(original); disabled[0].disabled = true;
  writeFileSync(patch, JSON.stringify(disabled));
  assert.throws(() => checkBot(options), /entry is disabled/);
  writeFileSync(patch, original);
  assert.equal(checkBot(options).acceptance.composition, 'verified');

  let running = await host(options);
  let chiefId; let botIds; let roomId;
  try {
    const state = await running.api('state', { locale: 'zh' });
    assert.equal(state.bots.length, 1);
    assert.equal(state.bots[0].name, 'Chief');
    assert.equal(state.bots[0].waiting, true);
    assert.equal(state.bots[0].model, undefined);
    assert.equal(state.memory, true);
    assert.equal(state.readOnly, null);
    assert.equal(state.models.filter(model => !model.needsKey).length, 0, 'stop if any model is usable; this test must never trigger a greeting');
    chiefId = state.mainBotId;
    const bots = [await running.api('create-bot', { name: 'Forge-A' }), await running.api('create-bot', { name: 'Forge-B' })];
    assert.ok(bots.every(bot => !bot.model && bot.kickoff), 'all greetings must remain held behind model setup');
    botIds = bots.map(bot => bot.id);
    assert.equal(new Set([chiefId, ...botIds]).size, 3);
    const room = await running.api('create-room', { name: 'Forge-QA', admin: chiefId, members: [chiefId, ...botIds], greet: false });
    assert.equal(room.mode, 'admin');
    assert.equal(room.admin, chiefId);
    assert.equal(room.members.length, 3);
    roomId = room.id;
    const own = await running.api('memory-view', { botId: botIds[0] });
    const other = await running.api('memory-view', { botId: botIds[1] });
    const group = await running.api('memory-view', { roomId });
    assert.deepEqual(Object.keys(own.sizes).sort(), ['own', 'team']);
    assert.deepEqual(Object.keys(group.sizes), ['group']);
    assert.notEqual(own.botId, other.botId);
    assert.equal(own.entries.length + other.entries.length + group.entries.length, 0);
    assert.equal((await running.rawApi('memory-view', { botId: 'nonexistent-bot' })).ok, false);
    assert.equal((await running.rawApi('create-room', { name: 'Invalid', members: ['nonexistent-bot'] })).ok, false);
  } finally { await running.stop(); }
  running = await host(options);
  try {
    const restored = await running.api('state', { locale: 'zh' });
    assert.equal(restored.mainBotId, chiefId);
    assert.deepEqual(restored.bots.map(bot => bot.id).sort(), [chiefId, ...botIds].sort());
    assert.equal(restored.rooms[0].id, roomId);
    assert.ok(restored.bots.every(bot => bot.waiting && !bot.model));
    t.diagnostic(JSON.stringify({ realDsh: prepared.dshVersion, originalClientServed: true, chiefWaitingForModel: true, independentBotSessions: 3, adminFirstGroupPersisted: true, memoryScopesListed: true, unauthenticatedAndInvalidTargetsRefused: true, modelCallsRequested: 0, memoryWriteIsolation: 'not-tested', browserRendering: 'not-tested', mentionDispatch: 'not-tested' }));
  } finally { await running.stop(); }
});
