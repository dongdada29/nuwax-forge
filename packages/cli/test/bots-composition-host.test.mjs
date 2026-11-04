import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { botEnvironment, botPaths, checkBot } from '../lib/bots/profile.mjs';
import { bridgeFixture, copyBotCli } from './helpers/bots-bridge-fixture.mjs';

test('public prepare/check/run compose the native bridge on real DSH and restart without config; no model', {
  skip: !process.env.FORGE_BOT_TEST_DSH || !process.env.FORGE_BOT_TEST_ELECTRON || !process.env.FORGE_BOT_TEST_RESOURCES,
  timeout: 180000,
}, async t => {
  const f = bridgeFixture(t), root = path.join(f.parent, 'bots');
  const binary = process.env.FORGE_BOT_TEST_DSH;
  const oldVersion = path.join(f.parent, 'versions/old/node_modules/@nuwax-ai/devkit-cli');
  let cli = copyBotCli(f.repo, oldVersion);
  const common = ['--root', root, '--dsh', binary];
  const command = argv => {
    const result = spawnSync(process.execPath, [cli, 'bots', ...argv], { encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const prepared = command(['prepare', ...common, '--forge-config', f.configPath, '--json',
    ...(process.env.FORGE_BOT_TEST_TARBALL ? ['--tarball', process.env.FORGE_BOT_TEST_TARBALL] : [])]);
  assert.equal(prepared.bridge.enabled, true); assert.equal(prepared.package.originalFilesVerified, 7);
  assert.equal(prepared.acceptance.host, 'not-run');
  assert.equal(command(['plan', ...common, '--json']).bridge.configHash, prepared.bridge.configHash);
  assert.equal(command(['check', ...common, '--json']).bridge.configHash, prepared.bridge.configHash);
  assert.equal(command(['prepare', ...common, '--json']).bridge.configHash, prepared.bridge.configHash);
  assert.equal(fs.existsSync(path.join(prepared.paths.dshHome, '.credentials.yaml')), false);
  const profilePatch = JSON.parse(fs.readFileSync(path.join(prepared.paths.profileDir, 'cordis.patch.yml')));
  assert.equal(profilePatch.length, 2); assert.equal(profilePatch[0].id, 'bot');
  assert.equal(profilePatch[1].insert[0].id, 'forge-bot-bridge');
  assert.equal(prepared.bridge.entry, path.join(oldVersion, 'lib/bots/bridge-runtime/index.mjs'));
  const boundMarker = fs.readFileSync(prepared.paths.marker), boundConfig = fs.readFileSync(f.configPath);
  let chiefId;

  // Public foreground run must reuse the bound profile patch on each restart.
  for (let cycle = 0; cycle < 2; cycle++) {
    if (cycle === 1) {
      const newVersion = path.join(f.parent, 'versions/new/node_modules/@nuwax-ai/devkit-cli');
      fs.cpSync(path.dirname(oldVersion), path.dirname(newVersion), { recursive: true });
      cli = path.join(newVersion, 'bin/nuwax-forge.mjs');
      assert.equal(command(['check', ...common, '--json']).bridge.entry, prepared.bridge.entry);
      assert.equal(command(['prepare', ...common, '--json']).bridge.entry, prepared.bridge.entry);
      assert.deepEqual(fs.readFileSync(prepared.paths.marker), boundMarker);
      assert.deepEqual(fs.readFileSync(f.configPath), boundConfig);
    }
    const child = spawn(process.execPath, [cli, 'bots', 'run', ...common], { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; let failure;
    child.once('error', error => { failure = error; });
    const closed = new Promise(resolve => child.once('close', code => resolve(code)));
    const collect = chunk => { log = (log + chunk.toString()).slice(-1024 * 1024); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    try {
      let launch;
      for (let n = 0; n < 200; n++) {
        launch = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
        if (launch || failure || child.exitCode !== null) break;
        await delay(100);
      }
      assert.ok(!failure && launch, 'native DSH did not provide a loopback link (raw output withheld)');
      const origin = new URL(launch).origin;
      const denied = await fetch(origin + '/api/bot', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ endpoint: 'state' }) });
      assert.equal(denied.status, 401);
      const auth = await fetch(launch, { redirect: 'manual' }); assert.equal(auth.status, 303);
      const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      const headers = { 'content-type': 'application/json', origin, cookie };
      const response = await fetch(origin + '/api/bot', { method: 'POST', headers, body: JSON.stringify({ endpoint: 'state', payload: {} }), signal: AbortSignal.timeout(10000) });
      const state = await response.json(); assert.equal(state.ok, true);
      assert.equal(state.value.bots.length, 1); assert.equal(state.value.bots[0].name, 'Chief');
      if (cycle === 0) chiefId = state.value.mainBotId;
      else assert.equal(state.value.mainBotId, chiefId, 'CLI upgrade must retain the same team identity');
      assert.equal(state.value.bots[0].waiting, true); assert.equal(state.value.bots[0].model, undefined);
      assert.equal(state.value.models.filter(model => !model.needsKey).length, 0);
      const html = await (await fetch(origin + '/', { headers })).text();
      assert.match(html, /"id":"ds-bot"/);
    } finally {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 8000); timer.unref();
      await closed; clearTimeout(timer); log = '';
    }
    assert.equal(fs.existsSync(path.join(root, '.forge-bots-lock')), false);
  }

  // Same generated row, real shipped Cordis registry/guard/dispatch. Only the
  // systemPrompt owner and calling Session are fixtures; no Agent loop starts.
  const native = spawnSync(process.env.FORGE_BOT_TEST_ELECTRON, [fileURLToPath(new URL('./helpers/bots-bridge-native.mjs', import.meta.url)),
    process.env.FORGE_BOT_TEST_RESOURCES, prepared.paths.bridgePatch, f.dispatched], {
    env: { ...botEnvironment(botPaths(root)), ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60000,
  });
  assert.equal(native.status, 0, native.stderr);
  const result = JSON.parse(native.stdout.trim()); assert.equal(result.modelCalls, 0);
  const markerFile = prepared.paths.marker, markerBytes = fs.readFileSync(markerFile), patchBytes = fs.readFileSync(prepared.paths.bridgePatch);
  const unbound = JSON.parse(markerBytes); delete unbound.bridge;
  fs.writeFileSync(markerFile, JSON.stringify(unbound)); fs.unlinkSync(prepared.paths.bridgePatch);
  assert.throws(() => checkBot({ root, binary }), /Unbound native Forge bridge entry/);
  fs.writeFileSync(markerFile, markerBytes); fs.writeFileSync(prepared.paths.bridgePatch, patchBytes);
  fs.appendFileSync(f.configPath, ' ');
  assert.throws(() => checkBot({ root, binary }), /config drifted/);
  assert.equal(fs.existsSync(path.join(root, '.forge-bots-lock')), false);
  assert.equal(fs.existsSync(f.dispatched), false);
  t.diagnostic(JSON.stringify({ publicPrepareCheck: 'passed', nativeWebRestarts: 2, originalDsBotFiles: 7, nativeRegistry: result,
    cliVersionRelocation: 'passed', boundRuntimeRetained: true, chiefIdRetained: true,
    configDrift: 'refused', originalBotRow: 'unchanged', credentialsImported: false, browserRendering: 'not-tested', chiefModelToolChoice: 'not-tested' }));
});
