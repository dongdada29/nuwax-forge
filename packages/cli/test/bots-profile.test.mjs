import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { botEnvironment, botPaths, botPlan, checkBot, prepareBot, verifyBotArchive, verifyBotComposition } from '../lib/bots/profile.mjs';
import { parseBotArgs } from '../lib/bots/entry.mjs';

function temporary(t) {
  const parent = mkdtempSync(join(tmpdir(), 'forge-bots-unit-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return parent;
}

function versionFixture(parent) {
  const binary = join(parent, 'dsh-fixture');
  writeFileSync(binary, '#!/usr/bin/env node\nprocess.stdout.write("0.0.0-test\\n");\n', { mode: 0o700 });
  chmodSync(binary, 0o700);
  return binary;
}

test('plan is read-only and pins the original artifact and native host entry', t => {
  const root = join(temporary(t), 'new bot root');
  const plan = botPlan({ root, binary: '/explicit/dsh' });
  assert.equal(existsSync(root), false);
  assert.equal(plan.pin.version, '0.2.7');
  assert.equal(plan.pin.commit, '71d344bf193f3f18185f25de3d8e5c483046910a');
  assert.ok(plan.prepare.includes('--ignore-scripts'));
  assert.ok(plan.prepare.includes(join(root, 'cache', 'pnpm-store')));
  assert.ok(plan.prepare.includes(join(root, 'cache', 'pnpm')));
  assert.ok(plan.prepare.includes('--config.state-dir=' + join(root, 'state', 'pnpm')));
  assert.deepEqual(plan.run, ['--profile', 'forge-bots', '--host', '127.0.0.1', '--port', '0', '--no-open']);
  assert.equal(plan.acceptance.modelBehavior, 'not-run');
});

test('no ambient provider credentials, DSH overrides, agent homes or Node injection reach DSH', t => {
  const paths = botPaths(join(temporary(t), 'root'));
  const env = botEnvironment(paths, { PATH: '/bin', LANG: 'C', DEEPSEEK_API_KEY: 'secret-sentinel', DSH_HOME: '/existing', HOME: '/user', NODE_OPTIONS: '--require=untrusted', DSH_SECRET_TEST: 'secret-sentinel', NPM_TOKEN: 'secret-sentinel' });
  assert.equal(env.PATH, '/bin');
  for (const key of ['DEEPSEEK_API_KEY', 'NODE_OPTIONS', 'DSH_SECRET_TEST', 'NPM_TOKEN']) assert.equal(env[key], undefined);
  for (const key of ['HOME', 'USERPROFILE', 'DSH_HOME', 'DSH_AGENTS_HOME', 'PNPM_HOME', 'TMPDIR', 'XDG_STATE_HOME', 'npm_config_store_dir', 'npm_config_userconfig']) assert.ok(env[key].startsWith(paths.root + '/'));
  assert.equal(env.DSH_PERMISSION_MODE, 'workspace-write');
  assert.equal(env.DSH_TELEMETRY_MODE, 'DISABLED');
});

test('unmanaged directories and profile/path argument injection are refused', async t => {
  const parent = temporary(t);
  const sentinel = join(parent, 'keep'); writeFileSync(sentinel, 'unchanged');
  await assert.rejects(prepareBot({ root: parent, binary: '/explicit/dsh' }), /without a Forge Bot marker/);
  assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged');
  for (const root of ['relative', '/', '/tmp/bot\nroot']) assert.throws(() => botPaths(root));
  for (const args of [
    ['prepare', '--root', parent, '--dsh', 'dsh'],
    ['run', '--root', parent, '--dsh', '/dsh', '--port', '1;echo'],
    ['run', '--root', parent, '--dsh', '/dsh', '--port', '65536'],
    ['run', '--root', parent, '--dsh', '/dsh', '--profile', 'desktop'],
    ['check', '--root', parent, '--dsh', '/dsh', '--root', '/other'],
    ['run', '--root', parent, '--dsh', '/dsh', '--json'],
  ]) assert.throws(() => parseBotArgs(args));
});

test('wrong host version stops before plugin installation and releases the lock', async t => {
  const parent = temporary(t); const root = join(parent, 'root');
  const binary = versionFixture(parent);
  await assert.rejects(prepareBot({ root, binary }), /version mismatch/);
  assert.equal(existsSync(join(root, '.forge-bots-lock')), false);
  assert.equal(existsSync(join(root, 'artifacts')), false);
  assert.equal(existsSync(join(root, 'dsh', 'profiles', 'forge-bots')), false);
  mkdirSync(join(root, '.forge-bots-lock'));
  assert.throws(() => checkBot({ root, binary }), /busy/);
});

test('managed profile and config symlinks are refused without changing their targets', async t => {
  const parent = temporary(t); const root = join(parent, 'root'); const binary = versionFixture(parent);
  await assert.rejects(prepareBot({ root, binary }), /version mismatch/);
  const outside = join(parent, 'existing-profile'); mkdirSync(outside);
  writeFileSync(join(outside, 'keep'), 'unchanged');
  symlinkSync(outside, join(root, 'dsh', 'profiles', 'forge-bots'));
  await assert.rejects(prepareBot({ root, binary }), /must not be a symlink/);
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'unchanged');
});

test('artifact corruption cannot pass the fixed npm integrity check', () => {
  assert.throws(() => verifyBotArchive(Buffer.from('not the npm artifact')), /integrity mismatch/);
  assert.throws(() => verifyBotArchive(Buffer.alloc(8 * 1024 * 1024 + 1)), /size limit/);
});

test('composition parser distinguishes original active entries from disabled, nested or escaped config', t => {
  const paths = botPaths(join(temporary(t), 'root with spaces'));
  const dump = `- id: bot\n  name: ds-bot\n  config:\n    home: ${JSON.stringify(paths.team)}\n    workspace: ${JSON.stringify(paths.workspace)}\n    memory: true\n    updateCheck: false\n- id: web-search-auto\n  name: ds-bot/web-search\n`;
  assert.equal(verifyBotComposition(dump, paths).memory, true);
  assert.equal(verifyBotComposition(dump.replace(JSON.stringify(paths.team), '>-\n      ' + paths.team).replace(JSON.stringify(paths.workspace), '>-\n      ' + paths.workspace), paths).memory, true);
  for (const changed of [
    dump.replace('  name: ds-bot\n', '  name: ds-bot\n  disabled: true\n'),
    dump.replace('  name: ds-bot\n', "  name: ds-bot\n  disabled: !!js 'true'\n"),
    dump.replace('    memory: true', '    memory: false'),
    dump.replace(JSON.stringify(paths.team), '/existing/team'),
    dump.replace('- id: bot', '    - id: bot'),
    dump.replace('ds-bot/web-search', 'other/plugin'),
  ]) assert.throws(() => verifyBotComposition(changed, paths));
});
