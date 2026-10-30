import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fileMap, read, write, verifyBundle, safePath, snapshot } from './bundle-lib.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'devkit offline '));
const bundle = path.join(base, 'bundle');
const env = { ...process.env, NUWAX_DEVKIT_RESOLVE_ROOT: path.join(base, 'must-not-resolve-source') };
delete env.DSH_HOME;
function run(script, args, ok = true, extraEnv = {}) {
  const p = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...env, ...extraEnv }, timeout: 30000, cwd: base });
  assert.ifError(p.error);
  if (ok) assert.equal(p.status, 0, p.stderr + p.stdout);
  else assert.notEqual(p.status, 0, 'operation unexpectedly succeeded');
  return ok ? JSON.parse(p.stdout) : p;
}
function install(host, root, hostRoot, from = bundle, extraEnv = {}) {
  return run(path.join(from, 'install.mjs'), ['install', '--host', host, '--root', root, host === 'nuwax' ? '--workspace' : '--host-root', hostRoot], true, extraEnv);
}
function action(name, root, from = bundle, ok = true) { return run(path.join(from, 'install.mjs'), [name, '--root', root], ok); }
function fixture(name) {
  const root = path.join(base, name, 'managed'), hostRoot = path.join(base, name, 'host');
  fs.mkdirSync(hostRoot, { recursive: true }); return { root, hostRoot };
}
function nuwax(hostRoot, format = 'nested') {
  const agents = Buffer.from('# Existing workspace\r\nOnly existing platform skill: nuwax-stack.\r\n');
  const config = { agentId: 33300105, loop: 19346, runtime: { workerConversationId: 1741445, sandboxId: 4256 }, notification: { senderId: 1790767767, senderType: 2 }, credentials: { reference: 'keep-existing-reference' }, runtimeGuard: { devkitCli: '/old/cli', devkitCrewRoot: '/old/crew', leaseSeconds: 120 }, tasks: { db: 'state/tasks/tasks.sqlite', cursor: 73 } };
  if (format === 'nested') config.runtimeGuard.tools = { devkitCli: { path: '/old/nested/cli', required: true, minVersion: '0.1.0' }, python: { path: '/usr/bin/python3' } };
  fs.writeFileSync(path.join(hostRoot, 'AGENTS.md'), agents, { mode: 0o640 });
  fs.writeFileSync(path.join(hostRoot, 'work-computer.json'), JSON.stringify(config) + '\n', { mode: 0o600 });
  fs.mkdirSync(path.join(hostRoot, 'state', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(hostRoot, 'state', 'tasks', 'tasks.sqlite'), Buffer.from([0, 19, 2, 254]));
  fs.writeFileSync(path.join(hostRoot, 'state', 'cursor.json'), '{"cursor":73}');
  return config;
}
function checkedDoctor(installed, skill) {
  const d = run(path.join(skill, 'scripts', 'devkit.mjs'), ['doctor', '--json']);
  assert.equal(d.ok, true); assert.equal(d.problems.length, 0);
  assert.equal(d.checks.filter(c => c.check.startsWith('package:')).length, 5);
  for (const c of d.checks) { assert.equal(c.ok, true); if (c.artifact) assert.ok(c.artifact.startsWith(installed.release + path.sep), c.artifact); }
  return d;
}

try {
  await test('clean offline build has an exact SHA256 inventory and refuses existing output', () => {
    const build = run(path.join(source, 'scripts', 'build-bundle.mjs'), ['--out', bundle]);
    const m = verifyBundle(bundle); assert.equal(m.version, build.versions['@nuwax-ai/devkit-cli']);
    const files = fileMap(bundle); delete files['manifest.json']; assert.deepEqual(files, m.files);
    assert.equal(Object.keys(m.packages).length, 5);
    assert.ok(!Object.keys(files).some(f => f.includes('node_modules/') || f.includes('__pycache__') || f.includes('/test/') || f.includes('/tests/') || f.startsWith('payload/') && f.includes('/docs/')));
    for (const rel of Object.keys(files)) {
      const data = fs.readFileSync(path.join(bundle, rel));
      assert.ok(!data.includes('/Users/apple/') && !data.includes('/home/apple/'), rel);
      assert.ok(!/(^|\/)(?:\.env(?:\.|$)|[^/]*credential)/i.test(rel), rel);
    }
    const before = fileMap(bundle); run(path.join(source, 'scripts', 'build-bundle.mjs'), ['--out', bundle], false); assert.deepEqual(fileMap(bundle), before);
  });

  const upgraded = path.join(base, 'bundle-v2');
  fs.cpSync(bundle, upgraded, { recursive: true });
  fs.appendFileSync(path.join(upgraded, 'docs', 'INSTALLATION.md'), '\nFixture release 2.\n');
  const manifest = read(path.join(upgraded, 'manifest.json')); manifest.files = fileMap(upgraded); delete manifest.files['manifest.json']; write(path.join(upgraded, 'manifest.json'), manifest);

  for (let host of ['codex', 'deepseek-harness', 'nuwax', 'nuwax-legacy']) await test(`${host}: installed CLI, idempotence, upgrade, rollback and byte-exact uninstall`, () => {
    const format = host === 'nuwax-legacy' ? 'legacy' : 'nested';
    const f = fixture(host); if (host === 'nuwax-legacy') host = 'nuwax';
    const originalConfig = host === 'nuwax' ? nuwax(f.hostRoot, format) : null;
    const original = snapshot(f.hostRoot, 'dir');
    const one = install(host, f.root, f.hostRoot); assert.equal(one.status, 'installed');
    const skill = host === 'nuwax' ? one.skill : path.join(f.hostRoot, 'skills', 'nuwax-devkit');
    checkedDoctor(one, skill);
    assert.equal(read(path.join(skill, 'installation.json')).cli, one.cli);
    if (host === 'nuwax') {
      const now = read(path.join(f.hostRoot, 'work-computer.json'));
      assert.equal(now.runtimeGuard.devkitCli, one.cli);
      assert.equal(now.runtimeGuard.devkitCrewRoot, path.join(one.release, 'node_modules', '@nuwax-ai', 'devkit-crew'));
      const restored = structuredClone(now); restored.runtimeGuard.devkitCli = originalConfig.runtimeGuard.devkitCli; restored.runtimeGuard.devkitCrewRoot = originalConfig.runtimeGuard.devkitCrewRoot;
      if (format === 'nested') {
        assert.equal(now.runtimeGuard.tools.devkitCli.path, one.cli);
        restored.runtimeGuard.tools.devkitCli.path = originalConfig.runtimeGuard.tools.devkitCli.path;
      }
      assert.deepEqual(restored, originalConfig);
      const old = Buffer.from(original.files['AGENTS.md'].data, 'base64'); const nowAgents = fs.readFileSync(path.join(f.hostRoot, 'AGENTS.md'));
      assert.deepEqual(nowAgents.subarray(0, old.length), old);
      for (const rel of ['state/tasks/tasks.sqlite', 'state/cursor.json']) assert.deepEqual(snapshot(f.hostRoot, 'dir').files[rel], original.files[rel]);
    }
    const stateBefore = fs.readFileSync(path.join(f.root, 'managed.json'));
    const hostBefore = snapshot(f.hostRoot, 'dir');
    assert.equal(install(host, f.root, f.hostRoot).status, 'unchanged');
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'managed.json')), stateBefore);
    assert.deepEqual(snapshot(f.hostRoot, 'dir'), hostBefore);
    const two = install(host, f.root, f.hostRoot, upgraded); assert.notEqual(two.release, one.release);
    assert.equal(read(path.join(skill === one.skill ? two.skill : skill, 'installation.json')).cli, two.cli);
    assert.equal(action('rollback', f.root).status, 'rolled-back');
    assert.deepEqual(snapshot(f.hostRoot, 'dir'), hostBefore);
    checkedDoctor(one, skill);
    assert.equal(action('uninstall', f.root).status, 'uninstalled');
    const after = snapshot(f.hostRoot, 'dir');
    // Skill parent directories can remain; file contents and modes must match exactly.
    assert.deepEqual(after, original);
    const state = read(path.join(f.root, 'managed.json')); assert.equal(state.active, false);
    for (const t of state.originals) assert.deepEqual(snapshot(t.path, t.kind), t.content);
    assert.equal(install(host, f.root, f.hostRoot).status, 'installed');
    action('uninstall', f.root); assert.deepEqual(snapshot(f.hostRoot, 'dir'), original);
  });

  await test('unowned roots, Skills, managed markers and edited registrations are preserved', () => {
    const f = fixture('conflicts'); const skill = path.join(f.hostRoot, 'skills', 'nuwax-devkit');
    fs.mkdirSync(skill, { recursive: true }); fs.writeFileSync(path.join(skill, 'owned-by-user'), 'preserve');
    const before = snapshot(f.hostRoot, 'dir');
    run(path.join(bundle, 'install.mjs'), ['install', '--host', 'codex', '--root', f.root, '--host-root', f.hostRoot], false);
    assert.deepEqual(snapshot(f.hostRoot, 'dir'), before); assert.ok(!fs.existsSync(f.root));
    fs.mkdirSync(f.root); fs.writeFileSync(path.join(f.root, 'unowned'), 'preserve');
    const rootBefore = snapshot(f.root, 'dir');
    run(path.join(bundle, 'install.mjs'), ['install', '--host', 'codex', '--root', f.root, '--host-root', f.hostRoot], false); assert.deepEqual(snapshot(f.root, 'dir'), rootBefore);
    const n = fixture('marker'); nuwax(n.hostRoot); fs.appendFileSync(path.join(n.hostRoot, 'AGENTS.md'), '<!-- nuwax-devkit:begin -->');
    const nb = snapshot(n.hostRoot, 'dir'); run(path.join(bundle, 'install.mjs'), ['install', '--host', 'nuwax', '--root', n.root, '--workspace', n.hostRoot], false); assert.deepEqual(snapshot(n.hostRoot, 'dir'), nb);
    const e = fixture('edited'); install('codex', e.root, e.hostRoot); fs.appendFileSync(path.join(e.hostRoot, 'skills', 'nuwax-devkit', 'SKILL.md'), '\nuser edit');
    const eb = snapshot(e.hostRoot, 'dir'); const sb = fs.readFileSync(path.join(e.root, 'managed.json'));
    action('uninstall', e.root, bundle, false);
    run(path.join(upgraded, 'install.mjs'), ['install', '--host', 'codex', '--root', e.root, '--host-root', e.hostRoot], false);
    assert.deepEqual(snapshot(e.hostRoot, 'dir'), eb); assert.deepEqual(fs.readFileSync(path.join(e.root, 'managed.json')), sb);
  });

  await test('symlink/realpath, traversal, overlap and unknown DSH home are rejected without writes', () => {
    const f = fixture('paths'); const alias = path.join(base, 'host-alias'); fs.symlinkSync(f.hostRoot, alias, 'dir');
    for (const [root, target] of [[f.root, alias], [path.join(alias, 'managed'), f.hostRoot], [f.hostRoot, f.hostRoot], [f.root, f.hostRoot + '/../host']]) {
      run(path.join(bundle, 'install.mjs'), ['install', '--host', 'codex', '--root', root, '--host-root', target], false);
    }
    assert.ok(!fs.existsSync(f.root)); assert.deepEqual(fs.readdirSync(f.hostRoot), []);
    if (fs.realpathSync(os.tmpdir()) !== os.tmpdir()) assert.throws(() => safePath(path.join(os.tmpdir(), 'devkit', 'root')));
    run(path.join(bundle, 'install.mjs'), ['install', '--host', 'deepseek-harness', '--root', f.root], false); assert.ok(!fs.existsSync(f.root));
    const a = install('codex', f.root, f.hostRoot); const releaseBefore = fileMap(a.release);
    const script = path.join(f.hostRoot, 'skills', 'nuwax-devkit', 'SKILL.md'); fs.unlinkSync(script); fs.symlinkSync(path.join(a.release, 'skill', 'SKILL.md'), script);
    action('uninstall', f.root, bundle, false); assert.deepEqual(fileMap(a.release), releaseBefore);
    const v = fixture('version-symlink'); const versionInstall = install('codex', v.root, v.hostRoot); action('uninstall', v.root);
    fs.renameSync(path.join(v.root, 'versions'), path.join(v.root, 'saved-versions')); fs.symlinkSync(path.join(v.root, 'saved-versions'), path.join(v.root, 'versions'), 'dir');
    run(path.join(bundle, 'install.mjs'), ['install', '--host', 'codex', '--root', v.root, '--host-root', v.hostRoot], false); assert.ok(fs.existsSync(versionInstall.release));
  });

  await test('tampered, extra or symlinked bundle files fail inventory; installed/rollback tampering is refused', () => {
    const bad = path.join(base, 'bad-bundle'); fs.cpSync(bundle, bad, { recursive: true });
    const f = fixture('tampered'); const args = ['install', '--host', 'codex', '--root', f.root, '--host-root', f.hostRoot];
    fs.writeFileSync(path.join(bad, 'extra'), 'extra'); assert.throws(() => verifyBundle(bad)); run(path.join(bad, 'install.mjs'), args, false); assert.ok(!fs.existsSync(f.root));
    fs.unlinkSync(path.join(bad, 'extra')); fs.appendFileSync(path.join(bad, 'payload', 'skill', 'SKILL.md'), '\ntamper');
    assert.throws(() => verifyBundle(bad)); run(path.join(bad, 'install.mjs'), args, false); assert.ok(!fs.existsSync(f.root));
    const file = path.join(bad, 'payload', 'skill', 'SKILL.md'); fs.unlinkSync(file); fs.symlinkSync(path.join(bundle, 'payload', 'skill', 'SKILL.md'), file);
    assert.throws(() => verifyBundle(bad)); run(path.join(bad, 'install.mjs'), args, false); assert.ok(!fs.existsSync(f.root));
    const one = install('codex', f.root, f.hostRoot); install('codex', f.root, f.hostRoot, upgraded);
    fs.appendFileSync(path.join(one.release, 'skill', 'SKILL.md'), '\ntamper old version');
    const before = snapshot(f.hostRoot, 'dir'); action('rollback', f.root, bundle, false); assert.deepEqual(snapshot(f.hostRoot, 'dir'), before);
    run(path.join(bundle, 'install.mjs'), args, false); assert.deepEqual(snapshot(f.hostRoot, 'dir'), before);
  });

  await test('doctor failure never registers; interrupted host writes restore originals and retain recovery journal', () => {
    const f = fixture('bad-python'); const before = snapshot(f.hostRoot, 'dir');
    run(path.join(bundle, 'install.mjs'), ['install', '--host', 'codex', '--root', f.root, '--host-root', f.hostRoot], false, { NUWAX_DEVKIT_PYTHON: path.join(base, 'nonexistent-python') });
    assert.deepEqual(snapshot(f.hostRoot, 'dir'), before); assert.ok(!fs.existsSync(path.join(f.root, 'managed.json')));
    const n = fixture('transaction'); nuwax(n.hostRoot);
    fs.writeFileSync(path.join(n.hostRoot, 'work-computer.json.devkit-tmp'), 'preserve stale temp');
    const nb = snapshot(n.hostRoot, 'dir');
    run(path.join(bundle, 'install.mjs'), ['install', '--host', 'nuwax', '--root', n.root, '--workspace', n.hostRoot], false);
    assert.deepEqual(snapshot(n.hostRoot, 'dir'), nb);
    const journal = read(path.join(n.root, 'managed.json.transaction'));
    for (const t of journal.before) assert.deepEqual(snapshot(t.path, t.kind), t.content);
    const rb = snapshot(n.root, 'dir');
    run(path.join(bundle, 'install.mjs'), ['install', '--host', 'nuwax', '--root', n.root, '--workspace', n.hostRoot], false);
    assert.deepEqual(snapshot(n.root, 'dir'), rb); assert.deepEqual(snapshot(n.hostRoot, 'dir'), nb);
  });
} finally { fs.rmSync(base, { recursive: true, force: true }); }
