import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridgeReport, inspectBridge, prepareBridge } from '../lib/bots/composition.mjs';
import { botPaths, botPlan } from '../lib/bots/profile.mjs';
import { parseBotArgs } from '../lib/bots/entry.mjs';
import { bridgeFixture, copyBotCli } from './helpers/bots-bridge-fixture.mjs';

function compositionFixture(t) {
  const f = bridgeFixture(t), paths = botPaths(path.join(f.parent, 'bots'));
  fs.mkdirSync(paths.profileDir, { recursive: true });
  fs.writeFileSync(path.join(paths.profileDir, 'cordis.patch.yml'), JSON.stringify([{ id: 'bot', config: { home: paths.team, workspace: paths.workspace, memory: true, updateCheck: false } }]));
  const marker = { state: 'preparing' };
  const save = value => fs.writeFileSync(paths.marker, JSON.stringify(value));
  const localFile = (_paths, file) => assert.ok(file.startsWith(paths.root + path.sep));
  return { ...f, paths, marker, prepare: (module = { prepareBridge }) => module.prepareBridge(paths, marker, f.configPath, save, localFile) };
}

test('bridge opt-in is explicit, absolute and shared by public/legacy argument parsing; plan remains read-only', t => {
  const f = bridgeFixture(t), root = path.join(f.parent, 'new-bots');
  const argv = ['--root', root, '--dsh', '/explicit/dsh'];
  for (const command of ['plan', 'prepare', 'check', 'run']) {
    assert.equal(parseBotArgs([command, ...argv, '--forge-config', f.configPath]).options.forgeConfig, f.configPath);
    assert.equal(parseBotArgs([command, ...argv]).options.forgeConfig, undefined);
  }
  for (const bad of ['relative.json', '/tmp/file\n.json', '/tmp/file\0.json']) {
    assert.throws(() => parseBotArgs(['prepare', ...argv, '--forge-config', bad]), /absolute/);
  }
  assert.throws(() => parseBotArgs(['prepare', ...argv, '--forge-config', f.configPath, '--forge-config', f.configPath]), /duplicate/);
  assert.equal(botPlan({ root, binary: '/explicit/dsh' }).bridge.enabled, false);
  assert.equal(botPlan({ root, binary: '/explicit/dsh', forgeConfig: f.configPath }).bridge.requested, true);
  assert.equal(fs.existsSync(root), false); assert.equal(fs.existsSync(f.config.stateRoot), false);
});

test('disabled bridge does not load, initialize or write anything; ready roots cannot silently gain tools', async t => {
  const f = compositionFixture(t);
  assert.equal(await prepareBridge(f.paths, f.marker, undefined), null);
  assert.deepEqual(bridgeReport(inspectBridge(f.paths, f.marker)), { enabled: false });
  assert.deepEqual(fs.readdirSync(f.paths.root), ['dsh']); assert.equal(fs.existsSync(f.config.stateRoot), false);
  f.marker.state = 'ready';
  await assert.rejects(f.prepare(), /new Bot root/);
  assert.throws(() => inspectBridge(f.paths, f.marker, f.configPath), /not prepared/);
});

test('prepare binds exact operator config, seven native files and patch; restart reuses configuration without a flag', async t => {
  const f = compositionFixture(t), bridge = await f.prepare();
  const report = bridgeReport(bridge);
  assert.equal(report.enabled, true); assert.equal(report.allowPrepare, true);
  assert.deepEqual(report.workspaces, ['review']); assert.deepEqual(report.tools, ['forge_status', 'forge_prepare']);
  assert.equal(Object.keys(report.files).length, 7);
  assert.equal(report.configPath, f.configPath);
  assert.equal(fs.statSync(f.paths.bridgePatch).mode & 0o777, 0o600);
  const reloaded = JSON.parse(fs.readFileSync(f.paths.marker));
  assert.deepEqual(bridgeReport(inspectBridge(f.paths, reloaded)), report);
  assert.deepEqual(bridgeReport(await f.prepare()), report);
  const patch = JSON.parse(fs.readFileSync(f.paths.bridgePatch));
  assert.equal(patch[0].insert[0].name, report.entry);
  assert.equal(patch[0].insert[0].config.workspaces.review.runtime.binary, f.config.workspaces.review.runtime.binary);
  assert.equal(fs.existsSync(f.dispatched), false);
});

test('config content/path, generated patch and native root marker drift are refused without rebinding', async t => {
  const f = compositionFixture(t); await f.prepare();
  const source = fs.readFileSync(f.configPath);
  fs.appendFileSync(f.configPath, ' ');
  assert.throws(() => inspectBridge(f.paths, f.marker), /config drifted/);
  fs.writeFileSync(f.configPath, source);
  const other = path.join(f.parent, 'other.json'); fs.writeFileSync(other, source);
  assert.throws(() => inspectBridge(f.paths, f.marker, other), /another operator config path/);
  const patch = fs.readFileSync(f.paths.bridgePatch);
  fs.appendFileSync(f.paths.bridgePatch, ' ');
  assert.throws(() => inspectBridge(f.paths, f.marker), /patch drifted/);
  fs.writeFileSync(f.paths.bridgePatch, patch);
  const profileFile = path.join(f.paths.profileDir, 'cordis.patch.yml'), profile = fs.readFileSync(profileFile);
  fs.appendFileSync(profileFile, ' ');
  assert.throws(() => inspectBridge(f.paths, f.marker), /profile patch drifted/);
  fs.writeFileSync(profileFile, profile);
  const stateMarker = path.join(f.config.stateRoot, 'bridge.json'), original = fs.readFileSync(stateMarker);
  fs.writeFileSync(stateMarker, JSON.stringify({ kind: 'forge-bot-bridge-v1', configHash: 'wrong' }));
  assert.throws(() => inspectBridge(f.paths, f.marker), /bound operator configuration/);
  fs.writeFileSync(stateMarker, original);
  assert.equal(inspectBridge(f.paths, f.marker).binding.configPath, f.configPath);
});

test('operator config, managed patch and trusted runtime symlinks are refused', async t => {
  const f = compositionFixture(t);
  const source = fs.readFileSync(f.configPath), target = path.join(f.parent, 'config-target.json');
  fs.writeFileSync(target, source); fs.unlinkSync(f.configPath); fs.symlinkSync(target, f.configPath);
  await assert.rejects(f.prepare(), /regular file/);
  assert.equal(fs.existsSync(f.config.stateRoot), false);
  fs.unlinkSync(f.configPath); fs.writeFileSync(f.configPath, source); await f.prepare();
  const patchTarget = path.join(f.parent, 'patch-target.json'); fs.renameSync(f.paths.bridgePatch, patchTarget); fs.symlinkSync(patchTarget, f.paths.bridgePatch);
  assert.throws(() => inspectBridge(f.paths, f.marker), /regular file/);
  fs.unlinkSync(f.paths.bridgePatch); fs.renameSync(patchTarget, f.paths.bridgePatch);
  const binary = f.config.workspaces.review.runtime.binary, binaryTarget = binary + '-target';
  fs.renameSync(binary, binaryTarget); fs.symlinkSync(binaryTarget, binary);
  assert.throws(() => inspectBridge(f.paths, f.marker), /trusted path changed/);
});

test('native config validation keeps root/entry/allowlist boundaries and rejects unowned existing states', async t => {
  for (const change of [
    c => { c.forgeEntry = c.nodeBinary; },
    c => { c.workspaces = {}; },
    c => { c.stateRoot = c.workspaces.review.worktree; },
    c => { c.workspaces.review.runtime.contextMode = 'inherit'; },
    c => { fs.mkdirSync(c.stateRoot); },
  ]) {
    const f = compositionFixture(t); change(f.config);
    fs.writeFileSync(f.configPath, JSON.stringify(f.config));
    await assert.rejects(f.prepare());
    assert.equal(f.marker.bridge, undefined); assert.equal(fs.existsSync(f.paths.bridgePatch), false);
    assert.equal(fs.existsSync(f.dispatched), false);
  }
});

test('packaged bridge is preferred and every bound runtime file is checked; damaged packages never fall back', async t => {
  const f = compositionFixture(t);
  const standalone = path.join(f.parent, 'standalone'); fs.mkdirSync(standalone);
  fs.copyFileSync(new URL('../lib/bots/composition.mjs', import.meta.url), path.join(standalone, 'composition.mjs'));
  const runtime = path.join(standalone, 'bridge-runtime');
  fs.cpSync(path.join(f.repo, 'integrations/ds-bot-forge'), runtime, { recursive: true });
  const module = await import(pathToFileURL(path.join(standalone, 'composition.mjs')).href);
  await f.prepare(module);
  assert.equal(f.marker.bridge.entry, path.join(runtime, 'index.mjs'));
  for (const name of Object.keys(f.marker.bridge.files)) {
    const file = path.join(runtime, name), bytes = fs.readFileSync(file);
    fs.appendFileSync(file, '\n');
    assert.throws(() => module.inspectBridge(f.paths, f.marker), /runtime drifted/);
    fs.writeFileSync(file, bytes);
  }
  fs.unlinkSync(path.join(runtime, 'projection.mjs'));
  assert.throws(() => module.inspectBridge(f.paths, f.marker), /ENOENT/);
  const moved = runtime + '-target'; fs.renameSync(runtime, moved); fs.symlinkSync(moved, runtime);
  assert.throws(() => module.inspectBridge(f.paths, f.marker), /real directory/);
});

test('CLI relocation retains the bound old runtime and config; new teams use current code and old drift still fails', async t => {
  const f = compositionFixture(t);
  const oldVersion = path.join(f.parent, 'versions/old/node_modules/@nuwax-ai/devkit-cli');
  copyBotCli(f.repo, oldVersion);
  const oldModule = await import(pathToFileURL(path.join(oldVersion, 'lib/bots/composition.mjs')).href);
  await f.prepare(oldModule);
  const originalBinding = structuredClone(f.marker.bridge), originalPatch = fs.readFileSync(f.paths.bridgePatch);
  const newVersion = path.join(f.parent, 'versions/new/node_modules/@nuwax-ai/devkit-cli');
  fs.cpSync(path.dirname(oldVersion), path.dirname(newVersion), { recursive: true });
  const newModule = await import(pathToFileURL(path.join(newVersion, 'lib/bots/composition.mjs')).href);
  assert.deepEqual(newModule.inspectBridge(f.paths, f.marker).binding, originalBinding);
  assert.deepEqual((await f.prepare(newModule)).binding, originalBinding);
  assert.deepEqual(fs.readFileSync(f.paths.bridgePatch), originalPatch);
  // Even different code in the new CLI cannot silently rebind an old team.
  fs.appendFileSync(path.join(newVersion, 'lib/bots/bridge-runtime/index.mjs'), '\n// new runtime\n');
  assert.deepEqual(newModule.inspectBridge(f.paths, f.marker).binding, originalBinding);
  const fresh = compositionFixture(t); await fresh.prepare(newModule);
  assert.equal(fresh.marker.bridge.entry, path.join(newVersion, 'lib/bots/bridge-runtime/index.mjs'));
  const oldEntry = originalBinding.entry, bytes = fs.readFileSync(oldEntry);
  fs.appendFileSync(oldEntry, '\n// drift\n');
  assert.throws(() => newModule.inspectBridge(f.paths, f.marker), /runtime drifted/);
  fs.writeFileSync(oldEntry, bytes); fs.unlinkSync(oldEntry);
  assert.throws(() => newModule.inspectBridge(f.paths, f.marker), /ENOENT/);
  assert.deepEqual(f.marker.bridge, originalBinding);
});
