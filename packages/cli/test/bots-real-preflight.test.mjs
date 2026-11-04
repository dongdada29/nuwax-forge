import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePreflightArgs, summarizeAuthorization, summarizeAccountState, preflight } from '../../../scripts/bot-real-preflight.mjs';

test('real preflight refuses existing-root/provider/credential arguments and requires explicit fixed inputs', () => {
  assert.deepEqual(parsePreflightArgs([]), { help: true });
  assert.deepEqual(parsePreflightArgs(['--help']), { help: true });
  for (const argv of [
    ['--dsh', 'relative', '--tarball', '/pinned.tgz'],
    ['--dsh', '/dsh'],
    ['--dsh', '/dsh', '--tarball', '/pinned.tgz', '--root', '/existing'],
    ['--dsh', '/dsh', '--tarball', '/pinned.tgz', '--key', 'never-accepted'],
    ['--dsh', '/dsh', '--tarball', '/pinned.tgz', 'toString', '/unknown'],
    ['--dsh', '/dsh', '--dsh', '/other', '--tarball', '/pinned.tgz'],
  ]) assert.throws(() => parsePreflightArgs(argv));
});

test('native metadata summary excludes unknown fields, private conversations and credential-shaped content', () => {
  const state = {
    bots: [{ id: 'DO_NOT_PRINT', waiting: true, chat: 'PRIVATE_CHAT_SENTINEL' }],
    models: [{ ref: 'private-provider/model', needsKey: true }],
    token: 'PRIVATE_TOKEN_SENTINEL',
  };
  const providers = { available: true, providers: [{ key: { configured: false, value: 'SECRET_KEY_SENTINEL' }, error: 'SECRET_ERROR_SENTINEL' }] };
  const summary = summarizeAuthorization(state, providers);
  assert.equal(summary.authorization, 'not-validated');
  assert.equal(summary.modelSetup, 'no-usable-route-reported');
  assert.equal(summary.routesWithoutNeedsKeyFlag, 0);
  assert.equal(summary.modelMessagesSent, 0);
  assert.equal(summary.billingUsage, 'unknown');
  assert.doesNotMatch(JSON.stringify(summary), /SENTINEL|DO_NOT_PRINT|private-provider/);
});

test('a usable native model is reported without claiming model or business acceptance', () => {
  const summary = summarizeAuthorization({ bots: [{ waiting: true }], models: [{ ref: 'route/model' }] }, { available: true, providers: [] });
  assert.equal(summary.authorization, 'not-validated');
  assert.equal(summary.modelSetup, 'route-reported-usable-not-exercised');
  assert.equal(summary.routesWithoutNeedsKeyFlag, 1);
  assert.equal(summary.catalogSufficesForAuthorization, false);
  assert.equal(summary.realModelAcceptance, 'not-run');
  assert.equal(summary.billingUsage, 'unknown');
});

test('unavailable or malformed authorization metadata cannot become ready', () => {
  for (const [state, providers] of [
    [{ bots: [], models: [] }, { available: false }],
    [{ bots: [{ waiting: true }], models: [] }, { available: true }],
    [{ bots: [{ waiting: true }], models: [{ needsKey: false }] }, { available: true, providers: [] }],
  ]) assert.throws(() => summarizeAuthorization(state, providers));
});

test('account RPC summary keeps only local grant presence and refuses unrelated or failed envelopes', () => {
  const envelope = { type: 'server-response', rpcId: 'expected', result: { ok: true, value: {
    status: 'credential-stored', token: 'SECRET_SENTINEL', attempt: { authorizeUrl: 'PRIVATE_URL_SENTINEL' },
  } } };
  assert.deepEqual(summarizeAccountState(envelope, 'expected'), { accountMetadata: 'available', accountStatus: 'credential-stored', accountGrantStored: true });
  assert.doesNotMatch(JSON.stringify(summarizeAccountState(envelope, 'expected')), /SENTINEL/);
  for (const value of [null, { ...envelope, rpcId: 'other' }, { ...envelope, result: { ok: false } }, { ...envelope, type: 'unexpected' }]) {
    assert.deepEqual(summarizeAccountState(value, 'expected'), { accountMetadata: 'unavailable', accountGrantStored: null });
  }
  envelope.result.value.status = 'signed-out';
  assert.equal(summarizeAccountState(envelope, 'expected').accountGrantStored, false);
});

test('a pre-cancelled preflight refuses before touching paths or starting a binary', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel-before-side-effects');
  controller.abort(reason);
  await assert.rejects(preflight({ binary: '/must-not-execute', tarball: '/must-not-read' }, { signal: controller.signal }), error => error === reason);
});
