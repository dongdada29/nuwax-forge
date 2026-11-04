import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { BOT_FILES, BOT_PIN } from '../../lib/bots/pin.mjs';
import { verifyBotArchive } from '../../lib/bots/profile.mjs';

export function extractMemoryArtifact(tarball, destination) {
  assert.ok(isAbsolute(tarball), 'FORGE_BOT_TEST_TARBALL must be an absolute path');
  const bytes = readFileSync(tarball);
  verifyBotArchive(bytes); // Fail before mkdir/extraction; this is the Forge pin.
  mkdirSync(destination, { recursive: true });
  // Extract the bytes just verified, not a caller-controlled path read twice.
  const archive = join(destination, 'verified.tgz');
  writeFileSync(archive, bytes);
  execFileSync('tar', ['-xzf', archive, '-C', destination], { stdio: 'pipe' });
  const packageDir = join(destination, 'package');
  const metadata = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  assert.equal(metadata.name, BOT_PIN.name); assert.equal(metadata.version, BOT_PIN.version);
  for (const [file, expected] of Object.entries(BOT_FILES)) {
    assert.equal(createHash('sha256').update(readFileSync(join(packageDir, file))).digest('hex'), expected, `original artifact changed: ${file}`);
  }
  return packageDir;
}
