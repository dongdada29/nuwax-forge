import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const bin = join(root, 'bin/nuwax-devkit.mjs');
const recipe = readFileSync(join(root, 'lib/client-tooling-recipe.json'));
function call(args) { return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' }); }
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'client proof ? '));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo'), state = join(base, 'state ? #');
  mkdirSync(join(repo, '.verification'), { recursive: true });
  mkdirSync(join(repo, 'scripts/client'), { recursive: true });
  writeFileSync(join(repo, '.verification/client-tooling.json'), recipe);
  writeFileSync(join(repo, '.sdlc.json'), JSON.stringify({ verification: { schemaVersion: 1, recipe: '.verification/client-tooling.json', runner: 'scripts/sdlc-verify.mjs' } }));
  writeFileSync(join(repo, 'scripts/client/cli.mjs'), 'console.log(JSON.stringify({ready:false,issues:["fixture"]}))');
  for (const n of ['cli','dev','prepare']) writeFileSync(join(repo, `scripts/client-${n}.test.mjs`), `import {test} from 'node:test'; test('${n}',()=>{});`);
  for (const n of ['client.config.mjs','package.json','pnpm-lock.yaml']) writeFileSync(join(repo, n), '{}');
  // 安装的 init 负责提供与生产一致的 runner。
  const init = call(['init', '--project', repo, '--recipe', '.verification/client-tooling.json']);
  assert.equal(init.status, 0, init.stderr);
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  return { repo, state };
}
test('client-verify 两次均新鲜运行、短结果、证据及任务落盘', t => {
  const {repo,state} = fixture(t); const args = ['client-verify','--project',repo,'--state',state];
  const a = call(args), b = call(args);
  assert.equal(a.status, 0, a.stdout + a.stderr); assert.equal(b.status, 0, b.stdout + b.stderr);
  const x = JSON.parse(a.stdout), y = JSON.parse(b.stdout);
  assert.equal(x.passed, true); assert.equal(x.reused, false); assert.equal(x.tests.total, 3); assert.equal(x.tests.passed, 3);
  assert.equal(x.doctor.ready, false); assert.equal(x.taskStore, 'done'); assert.equal(x.modelRequests, 0);
  assert.notEqual(x.taskKey, y.taskKey); assert.notEqual(x.evidence.manifest, y.evidence.manifest);
  assert.ok(existsSync(x.evidence.manifest)); assert.ok(existsSync(x.evidence.stdout));
  assert.ok(a.stdout.length < 3000);
});
test('client-verify 拒绝配方变化与仓内状态，均在创建状态前失败', t => {
  const {repo,state} = fixture(t); const args = ['client-verify','--project',repo,'--state',state];
  const altered = JSON.parse(recipe); altered.stages[1].argv.push('--malicious');
  writeFileSync(join(repo, '.verification/client-tooling.json'), JSON.stringify(altered));
  const r = call(args); assert.notEqual(r.status, 0); assert.match(JSON.parse(r.stdout).error, /固定配方/); assert.equal(existsSync(state), false);
  const inside = join(repo, 'should-not-exist');
  const r2 = call(['client-verify','--project',repo,'--state',inside]); assert.notEqual(r2.status, 0); assert.equal(existsSync(inside), false);
  const reuse = call([...args, '--reuse']); assert.equal(reuse.status, 2);
});
