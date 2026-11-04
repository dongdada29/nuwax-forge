import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originalModules, routingFixture } from './helpers/bots-routing-fixture.mjs';

const tarball = process.env.FORGE_BOT_ROUTING_TARBALL;

test('routing fixture refuses an unpinned archive before extraction or import', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-bots-routing-invalid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const archive = join(root, 'invalid.tgz');
  writeFileSync(archive, 'not the pinned upstream artifact');
  await assert.rejects(originalModules(t, archive), /integrity mismatch/);
});

test('pinned native DS-Bot routing contracts with local fixture services', { skip: !tarball, timeout: 30000 }, async t => {
  const original = await originalModules(t, tarball);
  async function team(t) {
    const f = await routingFixture(t, original);
    const chief = await f.bot('Chief', 'fixture-a', 'alpha', true);
    const bravo = await f.bot('Bravo', 'fixture-b', 'beta');
    const charlie = await f.bot('Charlie', 'fixture-c', 'gamma');
    const reply = await f.tool('create_group', chief.id, { name: 'Routing QA', members: ['Bravo', 'Charlie'] });
    assert.match(reply, /Created group/);
    const room = Object.values(f.state.rooms)[0];
    assert.deepEqual([...f.agents.get(room.id).registered.keys()], ['group_relay']);
    return { ...f, chief, bravo, charlie, room };
  }

  await t.test('native createBot/applyModel route each kickoff and group turn to its own model', async t => {
    const f = await team(t);
    assert.deepEqual(f.calls.map(call => [call.name, call.route.provider, call.route.model, call.route.reasoningEffort]), [
      ['Chief', 'fixture-a', 'alpha', 'high'], ['Bravo', 'fixture-b', 'beta', 'high'], ['Charlie', 'fixture-c', 'gamma', 'high'],
    ]);
    f.clear();
    const result = await f.relay(f.room, '@all please answer');
    assert.equal(result.replies.length, 3);
    assert.deepEqual(f.calls.map(call => [call.name, call.route.provider, call.route.model]).sort(), [
      ['Bravo', 'fixture-b', 'beta'], ['Charlie', 'fixture-c', 'gamma'], ['Chief', 'fixture-a', 'alpha'],
    ]);
    assert.deepEqual(f.defaultSelection(), f.initialDefault);
    assert.equal(new Set([f.chief.id, f.bravo.id, f.charlie.id, f.room.id, ...Object.values(f.room.sessions)]).size, 7);
    // Re-select an existing Bot: native applyModel must update its own and group
    // Session without changing another Bot or the user's profile default.
    f.bravo.model = await f.rt.resolveModel('fixture-c/gamma');
    await f.rt.applyModel(f.bravo, { force: true });
    assert.equal(f.selections.get(f.bravo.id).model, 'gamma');
    assert.equal(f.selections.get(f.room.sessions[f.bravo.id]).model, 'gamma');
    assert.equal(f.selections.get(f.room.sessions[f.chief.id]).model, 'alpha');
    f.clear();
    await f.relay(f.room, '@Bravo prove new route');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].route.model, 'gamma');
    assert.deepEqual(f.defaultSelection(), f.initialDefault);
  });

  await t.test('admin mode calls only admin; everyone mode waits for each reply, admin first', async t => {
    const f = await team(t);
    // Put admin last in membership order to make admin-first non-vacuous.
    f.room.members = [f.bravo.id, f.charlie.id, f.chief.id];
    f.clear();
    await f.relay(f.room, 'plain admin request');
    assert.deepEqual(f.events, ['start:Chief', 'finish:Chief']);
    assert.match(await f.tool('update_group', f.chief.id, { group: f.room.name, mode: 'everyone' }), /Updated/);
    f.clear();
    await f.relay(f.room, 'plain everyone request');
    assert.deepEqual(f.events, ['start:Chief', 'finish:Chief', 'start:Bravo', 'finish:Bravo', 'start:Charlie', 'finish:Charlie']);
    assert.match(f.calls[1].text, /Chief: Fixture reply by Chief/);
    assert.match(f.calls[2].text, /Bravo: Fixture reply by Bravo/);
  });

  await t.test('@members start concurrently, deduplicate, and override admin/everyone mode', async t => {
    const f = await team(t);
    for (const mode of ['admin', 'everyone']) {
      await f.tool('update_group', f.chief.id, { group: f.room.name, mode });
      let release; let rejectBarrier; let timer;
      const barrier = new Promise((resolve, reject) => { release = resolve; rejectBarrier = reject; });
      const started = new Set();
      f.respond(async call => {
        started.add(call.name);
        timer ??= setTimeout(() => rejectBarrier(new Error('two @members did not start concurrently')), 2000);
        if (started.size === 2) release();
        await barrier;
        return `Parallel fixture reply by ${call.name}`;
      });
      f.clear();
      try {
        const result = await f.relay(f.room, '@Bravo @Charlie @Bravo coordinate');
        assert.deepEqual([...started].sort(), ['Bravo', 'Charlie']);
        assert.equal(result.replies.length, 2);
        assert.deepEqual(f.events.slice(0, 2).sort(), ['start:Bravo', 'start:Charlie']);
        assert.equal(f.calls.length, 2);
      } finally { clearTimeout(timer); release(); }
    }
  });

  await t.test('admin reply @dispatch and conversation-reference labels follow native entry', async t => {
    const f = await team(t);
    f.respond(async call => call.name === 'Chief' ? '@Bravo perform the fixture task' : 'Task fixture result');
    f.clear();
    await f.relay(f.room, 'please ask a member');
    assert.deepEqual(f.events, ['start:Chief', 'finish:Chief', 'start:Bravo', 'finish:Bravo']);
    assert.equal(f.calls[1].askedBy, f.chief.id);
    f.respond(async () => 'Reference acknowledged');
    f.clear();
    await f.relay(f.room, 'Read @Bravo context', { references: [{ labels: ['Bravo'], text: 'A referenced conversation, not a member call' }] });
    assert.deepEqual(f.calls.map(call => call.name), ['Chief']);
  });

  await t.test('independent group Sessions still import OWN private brief on first use: observed privacy boundary', async t => {
    const f = await team(t);
    f.clear();
    await f.relay(f.room, '@Bravo first group turn FIRST_GROUP_ONLY_SENTINEL');
    const first = f.calls[0];
    assert.notEqual(first.sessionId, f.bravo.id);
    assert.equal(first.sessionId, f.room.sessions[f.bravo.id]);
    // Record actual native behavior; independent Sessions do not imply zero
    // own-chat context. Whether that behavior fits the product is a separate decision.
    assert.deepEqual(f.reads, [f.bravo.id]);
    assert.match(first.text, /PRIVATE_Bravo_SENTINEL/);
    assert.doesNotMatch(first.text, /PRIVATE_(Chief|Charlie)_SENTINEL/);
    assert.equal(f.room.log.some(line => line.text?.includes('PRIVATE_')), false, 'fixture reply did not repeat the private brief');
    f.clear();
    await f.relay(f.room, '@Bravo next group turn');
    assert.equal(f.calls[0].sessionId, first.sessionId);
    assert.deepEqual(f.reads, []);
    assert.doesNotMatch(f.calls[0].text, /PRIVATE_/);
    assert.match(await f.tool('create_group', f.chief.id, { name: 'Other QA', members: ['Bravo'] }), /Created group/);
    const otherRoom = Object.values(f.state.rooms).find(room => room.name === 'Other QA');
    f.clear();
    await f.relay(otherRoom, '@Bravo another group');
    assert.notEqual(f.calls[0].sessionId, first.sessionId);
    assert.notEqual(f.calls[0].sessionId, f.bravo.id);
    assert.doesNotMatch(f.calls[0].text, /FIRST_GROUP_ONLY_SENTINEL/);
    assert.match(f.calls[0].text, /PRIVATE_Bravo_SENTINEL/);
    // Explicit native read_own_chat can still read it and logs a visible lookup.
    const own = await f.tool('read_own_chat', first.sessionId);
    assert.match(own, /PRIVATE_Bravo_SENTINEL/);
    assert.equal(f.room.log.at(-1).kind, 'lookup');
    assert.equal(f.room.log.at(-1).botId, f.bravo.id);
    t.diagnostic('firstGroupTurnImportsOwnPrivateBrief=true; fixtureDidNotEchoBrief=true; otherBotsPrivateChatsRead=0; productPrivacySemantics=not-decided');
  });

  await t.test('native registered tools reject unauthorized creation/update and out-of-group dispatch', async t => {
    const f = await team(t);
    const before = JSON.stringify(f.state.rooms);
    assert.match(await f.tool('create_group', f.bravo.id, { members: ['Charlie'] }), /Only a Main Bot/);
    assert.match(await f.tool('create_group', f.chief.id, { members: ['Missing'] }), /No Bot named Missing/);
    assert.match(await f.tool('update_group', f.bravo.id, { group: f.room.name, mode: 'everyone' }), /Only the user, a Main Bot, or the admin/);
    assert.match(await f.tool('update_group', f.chief.id, { group: f.room.name, mode: 'invalid' }), /Reply mode must be/);
    await assert.rejects(f.rt.updateRoom(f.room.id, { permission: 'full-access' }, f.chief.id), /Only the user can set the permissions/);
    assert.equal(JSON.stringify(f.state.rooms), before);
    assert.match(await f.tool('update_group', f.chief.id, { group: f.room.name, admin: 'Bravo' }), /Updated/);
    assert.match(await f.tool('update_group', f.bravo.id, { group: f.room.name, mode: 'everyone' }), /Updated/);
    assert.match(await f.tool('update_group', f.bravo.id, { group: f.room.name, work_dir: '/unused' }), /Only a Main Bot/);
    assert.match(await f.tool('update_group', f.bravo.id, { group: f.room.name, admin: 'none' }), /Hand the admin role/);
    const outsider = await f.bot('Outsider', 'fixture-c', 'gamma');
    f.clear();
    await f.relay(f.room, '@Bravo establish group Session');
    f.clear();
    await assert.rejects(f.tool('message_bot', f.room.sessions[f.bravo.id], { to: outsider.name, message: 'leave group' }), /not in.*work for this group stays in it/);
    assert.deepEqual(f.calls, []);
    assert.match(await f.tool('read_group_chat', outsider.id, { group: f.room.name }), /not in|cannot|No group/i);
    assert.deepEqual(JSON.parse(await f.tool('group_relay', f.bravo.id)), { error: 'Not a group chat' });
    assert.deepEqual(f.warnings, []);
  });
});
