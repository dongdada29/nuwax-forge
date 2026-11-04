import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { extractMemoryArtifact } from './helpers/bots-memory-archive.mjs';

const execute = promisify(execFile);
const temporary = t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-bots-memory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

test('native memory acceptance rejects missing/changed archives before extraction', t => {
  const root = temporary(t); const destination = join(root, 'extracted');
  assert.throws(() => extractMemoryArtifact('relative.tgz', destination), /absolute path/);
  assert.throws(() => extractMemoryArtifact(join(root, 'missing.tgz'), destination), /ENOENT/);
  const corrupt = join(root, 'corrupt.tgz'); writeFileSync(corrupt, 'not the pinned DS-Bot artifact');
  assert.throws(() => extractMemoryArtifact(corrupt, destination), /integrity mismatch/);
  assert.equal(existsSync(destination), false, 'unverified bytes must never be extracted');
});

test('pinned original DS-Bot nonempty memory contract with fixture host services (opt-in)', {
  skip: !process.env.FORGE_BOT_TEST_TARBALL && 'set FORGE_BOT_TEST_TARBALL to the original ds-bot@0.2.7 archive; nothing is downloaded',
  timeout: 60000,
}, async t => {
  const root = temporary(t);
  const packageDir = extractMemoryArtifact(process.env.FORGE_BOT_TEST_TARBALL, join(root, 'source'));
  const home = join(root, 'fixture-home'); mkdirSync(home);
  const { stdout, stderr } = await execute(process.execPath, ['--test', fileURLToPath(new URL('./helpers/bots-memory-native.mjs', import.meta.url))], {
    cwd: root,
    // No provider credentials, NODE_OPTIONS, DSH config or existing user HOME.
    env: { PATH: process.env.PATH, LANG: 'C', HOME: home, USERPROFILE: home, TMPDIR: root, FORGE_BOT_MEMORY_PACKAGE: packageDir, FORGE_BOT_MEMORY_ROOT: root },
    timeout: 45000, maxBuffer: 1024 * 1024,
  });
  assert.equal(stderr, '', 'native fixture must not hide warnings');
  t.diagnostic(stdout.trim());
});
