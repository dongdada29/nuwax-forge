// Test-only service boundary. Routing, roster, tools, privacy checks and own-chat
// indexing come from the integrity-checked, unmodified upstream npm artifact.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyBotArchive } from '../../lib/bots/profile.mjs';
import { BOT_FILES, BOT_PIN } from '../../lib/bots/pin.mjs';

export async function originalModules(t, tarball) {
  const bytes = readFileSync(tarball);
  verifyBotArchive(bytes); // Verify before invoking tar or importing anything.
  const root = mkdtempSync(join(tmpdir(), 'forge-bots-routing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const archive = join(root, 'verified.tgz');
  writeFileSync(archive, bytes);
  execFileSync('tar', ['-xzf', archive, '-C', root]);
  const source = join(root, 'package');
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  assert.equal(pkg.name, BOT_PIN.name);
  assert.equal(pkg.version, BOT_PIN.version);
  for (const [file, hash] of Object.entries(BOT_FILES)) {
    assert.equal(createHash('sha256').update(readFileSync(join(source, file))).digest('hex'), hash, file);
  }
  // Only external peer/deep-view APIs are supplied. Unsupported APIs fail closed;
  // no upstream module is patched, copied, evaluated as text or replaced.
  const fail = '() => { throw new Error("unsupported fixture service"); }';
  const peers = {
    '@deepseek-ai/dsh-tools': 'export const defineTool = definition => definition;',
    '@deepseek-ai/dsh-llm': `export const createUserMessage = value => ({ role: 'user', ...value }); export const BlockAssembler = ${fail};`,
    '@deepseek-ai/dsh-scope': `export const carrierKeyOf = ${fail};`,
    'deep-view': ['checkShownView', 'normalizeView', 'readViewReply', 'viewCardText', 'viewReply', 'viewReplyText'].map(name => `export const ${name} = ${fail};`).join('\n') + 'export const showViewDescription = () => \"fixture: unused view tool\"; export const showViewParameters = () => ({});',
  };
  for (const [name, code] of Object.entries(peers)) {
    const dir = join(source, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, type: 'module', exports: { '.': './index.js', './core': './index.js' } }));
    writeFileSync(join(dir, 'index.js'), code);
  }
  const modules = {};
  for (const name of ['models', 'roster', 'groups', 'tools', 'chat-index', 'privacy', 'parts']) {
    modules[name] = await import(pathToFileURL(join(source, 'src/host', `${name}.js`)));
  }
  return { modules, root };
}

export async function routingFixture(t, originals) {
  const { modules, root } = originals;
  const home = mkdtempSync(join(root, 'team-'));
  const state = { bots: {}, rooms: {}, mainBotIds: [], prefs: {} };
  const agents = new Map(); const histories = new Map(); const selections = new Map();
  const reads = []; const calls = []; const events = []; const warnings = []; const listeners = new Map();
  const effects = []; const guards = [];
  let serial = 0;
  let defaultSelection = { provider: 'fixture-default', model: 'untouched' };
  const initialDefault = { ...defaultSelection };
  const serviceModels = { 'fixture-a': ['alpha'], 'fixture-b': ['beta'], 'fixture-c': ['gamma'] };
  const ctx = {
    on(name, fn) { const list = listeners.get(name) ?? []; list.push(fn); listeners.set(name, list); return () => {}; },
    effect(fn) { effects.push(fn()); },
    get(name) {
      if (name === 'credentials') throw new Error('credentials must never be read');
      if (name === 'agents') return { list: () => [...agents.values()] };
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ ...defaultSelection }), saveSelection: async value => { defaultSelection = { ...value }; } };
      return undefined;
    },
    llm: {
      listProviders: () => Object.keys(serviceModels).map(id => ({ id })),
      listModels: async provider => serviceModels[provider].map(id => ({ id })),
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
    },
    tools: { guard(fn) { guards.push(fn); }, schemas: agent => [...agent.registered.values()] },
    workspaceRegistry: { get: () => ({ id: 'workspace', path: home }), resolveByPath: async () => ({ id: 'workspace', path: home }), archiveSession: async () => {} },
    sessionTitle: { rename: async (session, title) => { session.title = title; } },
    sessionController: {
      async create() {
        const sessionId = `fixture-session-${++serial}`;
        const registered = new Map();
        const agent = { id: sessionId, session: { id: sessionId, seq: 1, header: { cwd: home } }, registered, inbox: { nextStep: [], nextTurn: [] }, ctx: {
          tools: { register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name); }, restrict: () => () => {} },
          on: () => () => {},
        } };
        agents.set(sessionId, agent); histories.set(sessionId, []);
        return { sessionId };
      },
      async selectModel({ sessionId, ...route }) {
        assert.ok(agents.has(sessionId));
        assert.ok(serviceModels[route.provider]?.includes(route.model), 'only local fixture routes are selectable');
        selections.set(sessionId, { ...route });
        defaultSelection = { ...route }; // Reproduce DSH's default side effect.
        return { selected: route };
      },
      async page({ address }) {
        reads.push(address.sessionId);
        return { records: histories.get(address.sessionId).map(event => ({ event })), hasMore: false };
      },
    },
  };
  const rt = {
    ctx, state, home, defaults: {}, teamTools: [], chatOwners: new Map(), groupOwners: new Map(),
    live: new Map(), roomWaiters: new Map(), roomInbox: new Map(), roomProgress: new Map(),
    readOnly: () => undefined, load: async () => {},
    async save() { for (const bot of Object.values(state.bots)) rt.chatOwners.set(bot.id, bot.id); rt.syncScopedTools?.(); },
    warn: (...args) => warnings.push(args),
    botOf: id => state.bots[id], roomOf: id => state.rooms[id], chatOf: id => id,
    selfOf: id => rt.chatOwners.get(id) ?? rt.groupOwners.get(id)?.botId,
    isBotSession: id => rt.chatOwners.has(id) || rt.groupOwners.has(id),
    isMain: id => state.mainBotIds.includes(id), isAdminOf: (room, id) => id !== undefined && room.admin === id,
    groupSessionsOf: id => Object.values(state.rooms).map(room => room.sessions?.[id]).filter(Boolean),
    findBot: name => Object.values(state.bots).find(bot => bot.name === name),
    findRooms: name => Object.values(state.rooms).filter(room => room.name === name),
    sessionOfRoom: room => room.id,
    teamFolder: () => home, defaultTeamFolder: () => home, workDirOf: () => home, isFolder: async () => true,
    async resolveAgent(id) { const agent = agents.get(id); assert.ok(agent, `missing fixture Session ${id}`); rt.hideBotUnusedTools?.(agent); return agent; },
    ensureCapabilities: async () => {}, applyPermission: async () => {},
    // Storage supplies synthetic messages; native chat-index and historyEntry do
    // all filtering, indexing, latest-message selection and brief composition.
    partsOf: id => [{ sessionId: id, number: 1, startedAt: 0 }],
    historyEntry: modules.parts.historyEntry, clock: () => 'fixture-time',
    ownRequest: () => false,
  };
  for (const name of ['models', 'roster', 'privacy', 'chat-index', 'groups', 'tools']) modules[name].install(rt);
  const pending = new Set();
  let respond = async call => `Fixture reply by ${call.name}`;
  // deliver is the external DSH turn boundary. It records the Session-selected
  // route, invokes a controlled local responder, and completes native roomWaiters.
  rt.deliver = async args => {
    const sessionId = args.sessionId ?? rt.chatOf(args.toId);
    const route = selections.get(sessionId);
    assert.ok(route, 'native model selection must precede delivery');
    const call = { ...args, sessionId, route: { ...route }, name: rt.botOf(args.toId).name };
    calls.push(call); events.push(`start:${call.name}`);
    const work = Promise.resolve().then(() => respond(call)).then(reply => {
      events.push(`finish:${call.name}`);
      if (args.role === 'room') {
        const waiter = rt.roomWaiters.get(args.exchangeId);
        assert.ok(waiter, 'original group code must own the turn waiter');
        waiter.resolve(reply);
      }
    }).catch(error => { warnings.push([error]); rt.roomWaiters.get(args.exchangeId)?.fail({ code: 'FIXTURE', message: error.message }); }).finally(() => pending.delete(work));
    pending.add(work);
  };
  async function idle() { while (pending.size) await Promise.all([...pending]); }
  async function tool(name, sessionId, args = {}) {
    const agent = await rt.resolveAgent(sessionId);
    const definition = agent.registered.get(name);
    assert.ok(definition, `original scoped registration must expose ${name}`);
    const exec = { agent, name, callId: `call-${++serial}`, signal: AbortSignal.timeout(5000) };
    for (const guard of guards) { const refusal = guard(exec); if (refusal) throw new Error(refusal); }
    return definition.execute(args, exec);
  }
  async function relay(room, text, extra = {}) {
    rt.roomInbox.set(room.id, [{ text, ...extra }]);
    const result = JSON.parse(await tool('group_relay', room.id));
    await idle();
    assert.deepEqual(warnings, [], 'upstream errors must not be swallowed as an empty successful round');
    return result;
  }
  async function bot(name, provider, model, main = false) {
    const created = await rt.createBot({ name, model: `${provider}/${model}`, effort: 'high', main });
    // createBot schedules its native model application and greeting asynchronously.
    for (let attempt = 0; attempt < 100 && !calls.some(call => call.toId === created.id); attempt++) await new Promise(resolve => setImmediate(resolve));
    await idle();
    assert.ok(calls.some(call => call.toId === created.id && call.role === 'kickoff'));
    assert.deepEqual(defaultSelection, initialDefault, 'native selectSessionModel must restore the profile default');
    const marker = `PRIVATE_${name}_SENTINEL`;
    histories.set(created.id, [{ seq: 0, time: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: marker }] } }]);
    return created;
  }
  t.after(async () => { await idle(); for (const dispose of effects.reverse()) dispose?.(); });
  return { rt, state, bot, relay, tool, agents, histories, reads, calls, events, selections, warnings,
    respond(fn) { respond = fn; }, clear() { calls.length = 0; events.length = 0; reads.length = 0; },
    defaultSelection: () => ({ ...defaultSelection }), initialDefault };
}
