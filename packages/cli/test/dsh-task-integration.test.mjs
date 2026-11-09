import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { supervise } from '../lib/agent/lifecycle.mjs';
import { DSH_RUNTIME_VERSION, evaluateTaskEvidence } from '../lib/dsh-task-evidence.mjs';

const binary = process.env.NUWAX_DSH_BINARY;
const cli = fileURLToPath(new URL('../bin/nuwax-forge.mjs', import.meta.url));
const cases = ['success', 'failure', 'missing-service', 'missing-entry', 'disabled'];
for (const surface of ['native', 'forge']) for (const fixture of cases) {
  test(['real DSH', surface, fixture].join(': '), { skip: !binary }, async t => {
    assert.ok(path.isAbsolute(binary), 'NUWAX_DSH_BINARY must be an absolute trusted binary');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-task-integration-')));
    try {
      const home = path.join(root, 'home');
      const dshHome = path.join(root, 'dsh');
      const agentsHome = path.join(root, 'agents');
      const profile = path.join(dshHome, 'profiles', 'audit');
      for (const dir of [home, agentsHome, profile]) fs.mkdirSync(dir, { recursive: true });
      // No provider/model/credential/SSH/network services are composed.
      const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome, DSH_TELEMETRY_DISABLED: 'true', NO_COLOR: '1' };
      const version = spawnSync(binary, ['--version'], { cwd: root, env, encoding: 'utf8', timeout: 3000 });
      assert.equal(version.status, 0);
      const runtimeVersion = version.stdout.trim();
      assert.ok(['0.2.1-rc.5', '0.2.2-rc.1'].includes(runtimeVersion));
      const binding = { schemaVersion: 1, taskRef: { source: 'test:isolated', taskKey: fixture }, attemptId: 'attempt', runId: 'run', invocationId: randomBytes(16).toString('hex'), targetEntryIds: ['include:target'], runtimeVersion, reportPath: path.join(root, 'report.json') };
      const targetFixture = ['success', 'failure', 'missing-service'].includes(fixture) ? fixture : 'success';
      const entries = fixture === 'missing-entry' ? [] : [{ id: 'target', name: fileURLToPath(new URL('./fixtures/dsh-task-' + targetFixture + '.mjs', import.meta.url)), disabled: fixture === 'disabled' }];
      entries.push({ id: 'observer', name: fileURLToPath(new URL('../lib/dsh-task-observer.mjs', import.meta.url)), config: binding });
      fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-audit', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }));
      fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: entries }]));
      const command = surface === 'native' ? [binary, '--profile', 'audit'] : [process.execPath, cli, 'dsh-plugin', 'run', '--profile', 'audit', '--binary', binary];
      let stderr = '';
      // Reuse Forge's bounded supervisor, including descendant cleanup on timeout.
      const lifecycle = await supervise(command, { cwd: root, env, wallMs: 5000, onStderr: chunk => { stderr += chunk; } });
      assert.equal(lifecycle.cleanupFailed, false, 'test process cleanup must be confirmed');
      assert.equal(lifecycle.stopReason, null, 'fixture must settle without timing out');
      const outcome = { status: lifecycle.returnCode, signal: lifecycle.signal, error: lifecycle.launchError, cleanupFailed: lifecycle.cleanupFailed };
      const result = evaluateTaskEvidence(binding, outcome);
      assert.equal(result.evidenceValid, true, stderr);
      assert.equal(result.processPassed, true, 'exit0 alone is insufficient');
      assert.equal(result.passed, fixture === 'success');
      assert.equal(result.pluginReady, fixture === 'success');
      assert.equal(result.acceptancePassed, null);
      assert.equal(result.usage, null);
      assert.equal(result.budget, null);
      const expected = { success: 'active', failure: 'failed', 'missing-service': 'pending', 'missing-entry': 'missing', disabled: 'disabled' }[fixture];
      assert.equal(result.statuses[0].status, expected);
      t.diagnostic(JSON.stringify({ surface, fixture, reportSha256: createHash('sha256').update(fs.readFileSync(binding.reportPath)).digest('hex'), ...result }));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
