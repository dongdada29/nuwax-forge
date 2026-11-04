// Suites outside npm workspaces: fixtures and local client contracts only.
// Real hosts, upstream preparation and browser/model acceptance remain opt-in.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env };
// Keep the default entry offline even if a developer has this variable exported.
// Use the direct pilot.test.mjs command for explicit upstream acceptance.
delete env.DUET_UPSTREAM;

const result = spawnSync(process.execPath, [
  '--test',
  'packages/voice-duet/tests/pilot.test.mjs',
  'integrations/dsh-dashboard/test/client.test.mjs',
  'integrations/ds-bot-forge/bridge.test.mjs',
  'integrations/personal-agent-forge/test/bridge.test.mjs',
], { cwd: root, env, shell: false, stdio: 'inherit' });

if (result.error) {
  process.stderr.write(`Offline integration test runner failed (${result.error.code ?? 'unknown'}).\n`);
}
process.exitCode = result.status ?? 1;
