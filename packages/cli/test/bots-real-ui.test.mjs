import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSignalCancellation, parseOptions, startAcceptanceHost, summarizeState } from '../../../scripts/bot-real-ui-acceptance.mjs';

test('real browser acceptance is explicit and rejects implicit/duplicate paths', () => {
  const args = ['--open', '--root', '/tmp/new-team', '--dsh', '/dsh', '--tarball', '/bot.tgz', '--output', '/tmp/report.json'];
  assert.equal(parseOptions(args).open, true);
  assert.throws(() => parseOptions(args.slice(1)));
  assert.throws(() => parseOptions([...args, '--root', '/other']));
  assert.throws(() => parseOptions(args.map(value => value === '/dsh' ? 'dsh' : value)));
});

test('catalog summaries exclude secret values and do not equate needsKey with authorization', () => {
  const result = summarizeState({ models: [{ ref: 'private-model-name', token: 'secret-sentinel' }, { needsKey: true }], bots: [{ name: 'private-bot', waiting: true }] });
  assert.equal(result.modelCatalogCount, 2);
  assert.equal(result.modelsWithoutNeedsKeyFlag, 1);
  assert.equal(result.providerAuthorization, 'not-proven');
  assert.equal(result.allBotsWaitingWithoutModel, true);
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('SIGINT and SIGTERM abort before host creation and remove only owned handlers', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'forge-ui-cancel-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  for (const name of ['SIGINT', 'SIGTERM']) {
    const source = new EventEmitter(); const existing = () => {};
    source.on(name, existing);
    const cancellation = createSignalCancellation(source);
    source.emit(name);
    assert.equal(cancellation.signal.aborted, true);
    assert.equal(cancellation.signal.reason, name);
    const root = join(parent, name);
    await assert.rejects(startAcceptanceHost({ root, dsh: '/must-not-run' }, true, cancellation.signal), reason => reason === name);
    assert.equal(existsSync(root), false);
    cancellation.dispose();
    assert.deepEqual(source.listeners(name), [existing]);
    assert.equal(source.listenerCount(name === 'SIGINT' ? 'SIGTERM' : 'SIGINT'), 0);
  }
});
