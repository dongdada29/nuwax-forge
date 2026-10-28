import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runVerification } from '../kit/engine/verify.mjs';

const kit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function fixture(t, stages) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo'), output = path.join(base, 'proof');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/input.txt'), 'one');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'fixture']);
  const recipePath = 'recipe.json';
  const recipe = { schemaVersion: 1, id: 'fixture', level: 'source-tooling', inputs: ['src'], stages };
  fs.writeFileSync(path.join(root, recipePath), JSON.stringify(recipe));
  return { base, root, output, recipePath, run: options => runVerification({ root, output, recipePath, ...options }) };
}
const stage = (id = 'check') => ({ id, predicate: id, argv: ['{node}', '-e', 'console.log("verified")'] });

test('exit zero with ready=false fails readiness and stops later stages', async t => {
  const f = fixture(t, [{ ...stage(), argv: ['{node}', '-e', 'console.log(JSON.stringify({ready:false}))'],
    jsonEquals: { ready: true } }, stage('later')]);
  const result = await f.run();
  assert.equal(result.passed, false);
  assert.equal(result.failure, 'predicate-failed');
  assert.equal(result.stages.length, 1);
  assert.equal(fs.existsSync(path.join(f.output, 'later.log')), false);
});
test('proof reuse checks source contents, directory additions, and log integrity', async t => {
  const f = fixture(t, [stage()]);
  const first = await f.run();
  assert.equal(first.passed, true);
  assert.equal((await f.run({ reuse: true })).reused, true);
  fs.writeFileSync(path.join(f.root, 'src/added.txt'), 'new source without changing HEAD');
  const changed = await f.run({ reuse: true });
  assert.equal(changed.reused, false);
  assert.notEqual(changed.source.inputDigest, first.source.inputDigest);
  fs.appendFileSync(path.join(f.output, 'check.log'), 'tamper');
  assert.equal((await f.run({ reuse: true })).reused, false);
});
test('JSON schema inspection preserves ready=false without claiming desktop readiness', async t => {
  const f = fixture(t, [{ ...stage(), argv: ['{node}', '-e', 'console.log(JSON.stringify({ready:false,issues:[]}))'],
    jsonTypes: { ready: 'boolean', issues: 'array' } }]);
  assert.equal((await f.run()).passed, true);
});
test('output and inputs stay isolated and an active lock is preserved', async t => {
  const f = fixture(t, [stage()]);
  await assert.rejects(f.run({ output: path.join(f.root, 'proof') }), /outside repository/);
  fs.mkdirSync(f.output);
  fs.writeFileSync(path.join(f.output, '.verification.lock'), 'another owner');
  await assert.rejects(f.run(), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(f.output, '.verification.lock'), 'utf8'), 'another owner');
});
test('timeouts retain failed evidence and release the run lock', async t => {
  const f = fixture(t, [{ ...stage(), argv: ['{node}', '-e', 'setInterval(()=>{},1000)'], timeoutMs: 100 }]);
  const result = await f.run();
  assert.equal(result.passed, false);
  assert.equal(result.failure, 'timeout');
  assert.equal(fs.existsSync(path.join(f.output, '.verification.lock')), false);
  assert.equal(fs.existsSync(result.manifestPath), true);
});
test('repeated declared build commands are counted without timing heuristics', async t => {
  const f = fixture(t, [{ ...stage('first'), build: true }, { ...stage('second'), build: true }]);
  const result = await f.run();
  assert.equal(result.metrics.productBuilds, 2);
  assert.equal(result.metrics.repeatedProductBuilds, 1);
});
test('explicit installation preserves existing slim config and hooks', t => {
  const f = fixture(t, [stage()]);
  const cfg = { profile: 'slim', name: 'existing', custom: 'preserve' };
  fs.writeFileSync(path.join(f.root, '.sdlc.json'), JSON.stringify(cfg));
  fs.mkdirSync(path.join(f.root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(f.root, '.claude/settings.json'), 'owner configuration');
  execFileSync(process.execPath, [path.join(kit, 'cli.mjs'), 'verify:init', '--dir', f.root, '--recipe', f.recipePath]);
  const installed = JSON.parse(fs.readFileSync(path.join(f.root, '.sdlc.json')));
  assert.equal(installed.profile, 'slim');
  assert.equal(installed.custom, 'preserve');
  assert.equal(fs.existsSync(path.join(f.root, '.claude/hooks/plan-gate.mjs')), false);
  assert.equal(fs.existsSync(path.join(f.root, '.agents/skills/requirement-analysis/SKILL.md')), false);
  assert.equal(fs.readFileSync(path.join(f.root, '.claude/settings.json'), 'utf8'), 'owner configuration');
});
