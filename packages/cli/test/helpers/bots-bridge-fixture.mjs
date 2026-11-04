import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function copyBotCli(repo, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const name of ['package.json', 'bin', 'lib']) fs.cpSync(path.join(repo, 'packages/cli', name), path.join(target, name), { recursive: true });
  const dependencies = JSON.parse(fs.readFileSync(path.join(target, 'package.json'))).dependencies;
  for (const name of Object.keys(dependencies)) fs.cpSync(fs.realpathSync(path.join(repo, 'node_modules', name)), path.join(path.dirname(target), path.basename(name)), { recursive: true });
  const bridge = path.join(target, 'lib/bots/bridge-runtime'); fs.mkdirSync(bridge, { recursive: true });
  for (const name of ['package.json', 'index.mjs', 'bridge.mjs', 'projection.mjs', 'locale/en.json', 'locale/zh.json', 'icon.svg']) {
    const out = path.join(bridge, name); fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(path.join(repo, 'integrations/ds-bot-forge', name), out);
  }
  return path.join(target, 'bin/nuwax-forge.mjs');
}

// --version/--help are permitted; every other runtime invocation leaves a
// failing marker. This fixture cannot dispatch a model or inherit credentials.
export function bridgeFixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bots-compose-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const repo = fs.realpathSync(fileURLToPath(new URL('../../../../', import.meta.url)));
  const worktree = path.join(parent, 'allowed-worktree'); fs.mkdirSync(worktree);
  assert.equal(spawnSync('git', ['init', '-q', worktree]).status, 0);
  const runtime = path.join(parent, 'runtime.mjs'), dispatched = path.join(parent, 'MODEL-WAS-RUN');
  fs.writeFileSync(runtime, `#!${process.execPath}\nimport fs from 'node:fs';
if(process.argv.includes('--version'))console.log('codex-fixture');
else if(process.argv.includes('--help'))console.log('--json --ephemeral --ignore-user-config --ignore-rules --sandbox --cd');
else {fs.writeFileSync(${JSON.stringify(dispatched)},'unexpected');process.exit(99)}\n`, { mode: 0o700 });
  const config = {
    schemaVersion: 1, nodeBinary: fs.realpathSync(process.execPath), forgeRoot: repo,
    forgeEntry: path.join(repo, 'packages/cli/bin/nuwax-forge.mjs'), stateRoot: path.join(parent, 'bridge-states'), allowPrepare: true,
    workspaces: { review: { worktree, runtime: { kind: 'codex', binary: runtime, model: 'fixture-model', contextMode: 'fresh-exec' },
      permissions: { mode: 'read-only' }, budget: { maxTokens: 20000, maxWallSeconds: 5, maxAttempts: 1 },
      budgetSpec: { schemaVersion: 1, id: 'composition-fixture', mode: 'model', taskKind: 'text-implementation',
        model: { name: 'fixture-model' }, expectedCalls: 1, initialContextTokens: 1000, perCallOutputTokens: 10, budgetTokens: 20000 } } },
  };
  const configPath = path.join(parent, 'operator-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  return { parent, repo, config, configPath, dispatched };
}
