import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { BRIDGE_RUNTIME_FILES, copyBridgeRuntime } from './bridge-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function temp(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'forge-runtime-distribution-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('bridge distribution refuses missing resources, redirected files and an existing target', t => {
  const directory = temp(t), source = path.join(directory, 'source');
  fs.cpSync(path.join(root, 'integrations/ds-bot-forge'), path.join(source, 'integrations/ds-bot-forge'), { recursive: true });
  const resource = path.join(source, 'integrations/ds-bot-forge/projection.mjs');
  fs.unlinkSync(resource);
  const target = path.join(directory, 'runtime');
  assert.throws(() => copyBridgeRuntime(source, target), /ENOENT/);
  assert.equal(fs.existsSync(target), false);
  fs.symlinkSync(path.join(root, 'integrations/ds-bot-forge/projection.mjs'), resource);
  assert.throws(() => copyBridgeRuntime(source, target), /symlink/);
  fs.unlinkSync(resource);
  fs.copyFileSync(path.join(root, 'integrations/ds-bot-forge/projection.mjs'), resource);
  copyBridgeRuntime(source, target);
  assert.throws(() => copyBridgeRuntime(source, target), /must be new/);
});

test('ordinary CLI tarball carries the exact bridge runtime and loads without the source checkout', async t => {
  const directory = temp(t), output = path.join(directory, 'tarballs');
  const run = spawnSync(process.execPath, [path.join(root, 'scripts/pack.mjs'), '--out', output],
    { cwd: directory, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60000 });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const packages = fs.readdirSync(output);
  assert.equal(packages.length, 6);
  const cli = packages.find(name => name.startsWith('nuwax-ai-devkit-cli-'));
  const extracted = path.join(directory, 'installed'); fs.mkdirSync(extracted);
  const unpack = spawnSync('tar', ['-xzf', path.join(output, cli), '-C', extracted], { encoding: 'utf8' });
  assert.equal(unpack.status, 0, unpack.stderr);
  const runtime = path.join(extracted, 'package/lib/bots/bridge-runtime');
  for (const file of BRIDGE_RUNTIME_FILES) {
    assert.deepEqual(fs.readFileSync(path.join(runtime, file)), fs.readFileSync(path.join(root, 'integrations/ds-bot-forge', file)), file);
  }
  const plugin = await import(pathToFileURL(path.join(runtime, 'index.mjs')));
  assert.equal(plugin.name, 'forge-bot-bridge');
  assert.deepEqual(plugin.inject, ['tools']);
  const projection = await import(pathToFileURL(path.join(runtime, 'projection.mjs')));
  assert.equal(projection.projectBudget({}).verdict, 'unknown');
  assert.equal(fs.existsSync(path.join(root, 'packages/cli/lib/bots/bridge-runtime')), false, 'pack must not generate source files');
});
