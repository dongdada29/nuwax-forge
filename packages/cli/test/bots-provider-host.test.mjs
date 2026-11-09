// Real DSH + original DS-Bot, with a loopback-only deterministic wire provider.
// This proves transport/routing, not a real model's reasoning or paid-provider support.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareBot, startBot } from '../lib/bots/profile.mjs';

async function until(check, label) {
  for (let n = 0; n < 200; n++) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  assert.fail(label);
}

test('real DSH routes two original Bots to distinct local fixture models', {
  skip: process.env.FORGE_BOT_TEST_PROVIDER_HOST !== '1', timeout: 120000,
}, async t => {
  assert.ok(process.env.FORGE_BOT_TEST_DSH, 'explicit real DSH binary required');
  assert.ok(process.env.FORGE_BOT_TEST_TARBALL, 'explicit pinned archive required');
  const requests = [];
  const wireErrors = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/chat/completions');
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        assert.ok(raw.length < 2 * 1024 * 1024, 'fixture request size bound');
      }
      const body = JSON.parse(raw);
      assert.ok(['route-a', 'route-b'].includes(body.model));
      assert.ok(requests.length < 12, 'fixture request count bound');
      requests.push({ model: body.model, messages: body.messages });
      const marker = 'FORGE_PRIVATE_MARKER_' + (body.model === 'route-a' ? 'a' : 'b');
      const answer = 'LOCAL_FIXTURE_REPLY_' + body.model + (JSON.stringify(body.messages).includes(marker) ? '_MESSAGE_ACK' : '_GREETING');
      const base = { id: 'fixture-' + requests.length, object: 'chat.completion.chunk', created: 1, model: body.model };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const chunk of [
          { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ]) res.write('data: ' + JSON.stringify(chunk) + '\n\n');
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      }
    } catch (error) {
      wireErrors.push(error.message);
      res.writeHead(400); res.end('Fixture protocol rejected');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const parent = mkdtempSync(join(tmpdir(), 'forge-bots-provider-'));
  const options = { root: join(parent, 'team'), binary: process.env.FORGE_BOT_TEST_DSH, tarball: process.env.FORGE_BOT_TEST_TARBALL };
  let child;
  let closed;
  let startup = '';
  t.after(async () => {
    if (child) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 8000); timer.unref();
      await closed; clearTimeout(timer);
    }
    startup = '';
    requests.length = 0;
    rmSync(parent, { recursive: true, force: true });
  });
  await prepareBot(options);
  child = startBot(options, ['ignore', 'pipe', 'pipe']);
  closed = new Promise(resolve => { child.once('close', resolve); child.once('error', resolve); });
  let spawnError;
  child.once('error', error => { spawnError = error; });
  const append = chunk => { startup = (startup + chunk).slice(-1024 * 1024); };
  child.stdout.on('data', append); child.stderr.on('data', append);
  const launch = await until(() => {
    assert.ok(!spawnError && child.exitCode === null, 'host must remain running (raw output withheld)');
    return startup.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
  }, 'host launch URL missing');
  const origin = new URL(launch).origin;
  const login = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  assert.equal(login.status, 303);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.ok(cookie);
  const api = async (endpoint, payload = {}) => {
    const response = await fetch(origin + '/api/bot', {
      method: 'POST', headers: { 'content-type': 'application/json', origin, cookie },
      body: JSON.stringify({ endpoint, payload }), signal: AbortSignal.timeout(35000),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true, endpoint + ': ' + (result.error?.message ?? 'refused'));
    return result.value;
  };
  const initial = await api('state');
  assert.equal(initial.models.filter(model => !model.needsKey).length, 0, 'no existing usable provider allowed');
  assert.ok(initial.bots.every(bot => !bot.model));
  await api('provider-add', {
    provider: 'forge-local-fixture', custom: true, api: 'openai-completions',
    baseURL: `http://127.0.0.1:${server.address().port}/v1`, key: 'local-fixture-only',
    models: ['route-a', 'route-b'],
  });
  await until(async () => {
    await api('models');
    const state = await api('state');
    return state.models.filter(model => model.ref.startsWith('forge-local-fixture/')).length === 2;
  }, 'local provider did not register');
  const bots = [];
  for (const suffix of ['a', 'b']) bots.push(await api('create-bot', { name: 'Route-' + suffix, model: 'forge-local-fixture/route-' + suffix }));
  assert.notEqual(bots[0].id, bots[1].id);
  for (const [index, bot] of bots.entries()) {
    const suffix = index === 0 ? 'a' : 'b';
    await api('send', { sessionId: bot.id, text: 'FORGE_PRIVATE_MARKER_' + suffix });
    try {
      await until(() => requests.some(request => request.model === 'route-' + suffix && JSON.stringify(request.messages).includes('FORGE_PRIVATE_MARKER_' + suffix)), 'Bot message did not reach its configured local model');
    } catch (error) {
      const sessionRoot = join(options.root, 'dsh', 'sessions');
      const sessions = readdirSync(sessionRoot, {recursive:true}).filter(f => f.endsWith('.jsonl.zstd')).map(f => {
        const rows = zstdDecompressSync(readFileSync(join(sessionRoot,f))).toString().trim().split('\n').map(JSON.parse);
        return {file:f,events:rows.slice(-12).map(r=>({type:r.type,seq:r.seq,reason:r.data?.reason}))};
      });
      t.diagnostic(JSON.stringify({sessions, requests: requests.map(r => r.model), wireErrors,
        chat: await api('chat', {botId: bot.id}),
        bots: (await api('state')).bots,
        errors: startup.split('\n').filter(line => /error|Error|failed/.test(line)).map(line => line.replace(/token=[^\s]+/g, 'token=[redacted]')) }));
      throw error;
    }
    await until(async () => {
      const chat = JSON.stringify(await api('chat', { botId: bot.id }));
      return chat.includes('LOCAL_FIXTURE_REPLY_route-' + suffix + '_MESSAGE_ACK') && chat.includes('FORGE_PRIVATE_MARKER_' + suffix);
    }, 'original chat API did not return the fixture response and user message');
  }
  assert.deepEqual(wireErrors, []);
  for (const request of requests) {
    const other = request.model === 'route-a' ? 'b' : 'a';
    assert.ok(!JSON.stringify(request.messages).includes('FORGE_PRIVATE_MARKER_' + other), 'private marker crossed Bot model routes');
  }
  const final = await api('state');
  for (const bot of bots) {
    const observed = final.bots.find(item => item.id === bot.id);
    assert.equal(observed.model, bot.model);
    assert.equal(observed.blocked, undefined);
  }
  t.diagnostic(JSON.stringify({ realDsh: true, originalBotApi: true, configuredModelRoutesObserved: 2, fixtureRepliesReadFromOriginalChat: true, privateMarkersCrossedRoutes: false, localFixtureRequests: requests.length, realModelAcceptance: 'not-tested', fixtureUsageIsBillableEvidence: false }));
});
