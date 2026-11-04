import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bin = join(root, 'packages/cli/bin/nuwax-forge.mjs');

test('dashboard forwards explicit PA snapshot to Python; output cannot overwrite it', () => {
  const temp = mkdtempSync(join(tmpdir(), 'forge-pa-cli-'));
  try {
    const modules = join(temp, 'node_modules/@nuwax-ai');
    mkdirSync(modules, { recursive: true });
    for (const [name, directory] of [['devkit-dashboard', 'dashboard'], ['devkit-crew', 'nuwax-crew']]) {
      symlinkSync(join(root, 'packages', directory), join(modules, name), 'dir');
    }
    const snapshot = join(temp, 'pa.json');
    const original = readFileSync(join(root, 'packages/dashboard/tests/fixtures/personal-agent-snapshot.json'));
    writeFileSync(snapshot, original);
    const ledger = join(temp, 'ledger.jsonl');
    const registry = join(temp, 'registry.json');
    const output = join(temp, 'dashboard.html');
    writeFileSync(ledger, '');
    writeFileSync(registry, '{"executors":[]}');
    const env = { ...process.env, NUWAX_DEVKIT_RESOLVE_ROOT: temp };
    const args = [bin, 'dashboard', '--ledger', ledger, '--registry', registry, '--personal-agent-snapshot', snapshot, '--out'];
    execFileSync(process.execPath, [...args, output], { env, encoding: 'utf8' });
    assert.match(readFileSync(output, 'utf8'), /personal-agent:fixture-pa/);
    assert.match(readFileSync(output, 'utf8'), /来源交付状态：pending/);
    const rejected = spawnSync(process.execPath, [...args, snapshot], { env, encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /不得覆盖输入/);
    assert.deepEqual(readFileSync(snapshot), original);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
