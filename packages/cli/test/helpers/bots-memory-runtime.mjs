import assert from 'node:assert/strict';
import { register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { modelAttempts, refuseModel } from './bots-memory-sdk.mjs';

register('./bots-memory-loader.mjs', import.meta.url);

// Session identities are declared fixture inputs, not Bots created by a model or
// by the real roster API. Store ownership, privacy, tool scoping and all memory
// operations below are the unmodified modules from the verified npm archive.
export async function memoryRuntime(packageDir, home, { seed = true, expectReadOnly = false } = {}) {
  const modules = await Promise.all(['store', 'privacy', 'tools', 'memory'].map(name => import(pathToFileURL(join(packageDir, 'src', 'host', `${name}.js`)).href)));
  const listeners = new Map(); const disposers = []; const guards = []; const agents = new Map(); const sections = new Map(); const warnings = [];
  const on = (event, listener) => {
    const list = listeners.get(event) ?? []; list.push(listener); listeners.set(event, list);
    return () => list.splice(list.indexOf(listener), 1);
  };
  const rt = {
    home, statePath: join(home, 'state.json'), dshHome: join(home, 'dsh'), config: { memory: true, timeZone: 'UTC' }, teamTools: [],
    warn: (...args) => warnings.push(args),
    clock: () => 'fixture-clock', uiLanguage: () => 'English',
    desiredModel: refuseModel, defaultModel: refuseModel,
    partsOf: id => [{ sessionId: rt.chatOf(id) }],
    eventsBackwards: async function* () {},
    ctx: {
      on,
      effect(run) { const dispose = run(); if (typeof dispose === 'function') disposers.push(dispose); },
      get: service => service === 'agents' ? { list: () => [...agents.values()] } : undefined,
      tools: { guard: guard => guards.push(guard), schemas: agent => [...agent.registered.values()] },
      systemPrompt: { section(def) { sections.set(def.name, def); return () => sections.delete(def.name); } },
      llm: new Proxy({}, { get: () => refuseModel }),
    },
  };
  modules[0].install(rt);
  await rt.load();
  if (seed) {
    assert.equal(Object.keys(rt.state.bots).length, 0, 'fixture only seeds a new native store');
    rt.state.mainBotIds = ['chief'];
    rt.state.bots = Object.fromEntries([
      ['chief', 'Chief'], ['alpha', 'Alpha'], ['beta', 'Beta'], ['admin', 'Admin'], ['private', 'Private'], ['private-other', 'PrivateOther'],
    ].map(([id, name]) => [id, { id, name, capabilities: [], segments: [], ...(id.startsWith('private') ? { private: true, workDir: join(home, 'folders', id) } : {}) }]));
    rt.state.rooms = {
      red: { id: 'red', name: 'Red', named: true, members: ['chief', 'alpha', 'admin'], admin: 'admin', mode: 'admin', sessions: { alpha: 'red-alpha', admin: 'red-admin' }, log: [] },
      blue: { id: 'blue', name: 'Blue', named: true, members: ['chief', 'beta'], admin: 'chief', mode: 'admin', sessions: { beta: 'blue-beta' }, log: [] },
    };
    await rt.save({ required: true });
  }
  for (const module of modules.slice(1)) module.install(rt);

  const agent = id => {
    if (!agents.has(id)) {
      const registered = new Map();
      agents.set(id, {
        id, session: { id }, registered,
        ctx: { on: () => () => {}, tools: {
          register(def) { assert.ok(!registered.has(def.name)); registered.set(def.name, def); return () => registered.delete(def.name); },
          restrict: () => () => {},
        } },
      });
    }
    const value = agents.get(id);
    rt.hideBotUnusedTools(value);
    return value;
  };
  const call = async (id, name, args = {}) => {
    const caller = agent(id);
    const def = caller.registered.get(name);
    assert.ok(def, `${name} is not served to fixture Session ${id}`);
    const exec = { agent: caller, name, arguments: args };
    for (const guard of guards) { const denied = await guard(exec); if (denied) throw new Error(denied); }
    const middleware = listeners.get('tools/execute') ?? [];
    const next = index => index === middleware.length ? def.execute(args, exec) : middleware[index](exec, () => next(index + 1));
    return next(0);
  };
  return {
    rt, agent, call,
    view: target => rt.memoryEndpoint('memory-view', target),
    history: target => rt.memoryEndpoint('memory-history', target),
    section: id => sections.get('bot-memory').text({ agent: agent(id) }),
    async close() {
      // A settled native read drains the memory write/recovery queue first.
      await rt.memoryEndpoint('memory-view', { botId: 'chief' });
      for (const dispose of disposers.reverse()) await dispose();
      assert.equal(modelAttempts, 0, 'no model/provider service may be requested');
      assert.deepEqual(warnings, expectReadOnly ? [['ds-bot: %s', rt.readOnly()]] : [], 'native warnings must match the explicit lock expectation');
    },
  };
}
