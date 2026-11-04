import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOptions, summarizeState } from '../../../scripts/bot-real-ui-acceptance.mjs';

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
