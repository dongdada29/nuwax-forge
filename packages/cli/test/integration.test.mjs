// 集成测试：临时 Git 消费者（含空格路径）→ kit opt-in 接线 → verify fresh/reuse/tamper。
// 只用本安装的 5 包与系统 git/python/node；无外部账号、无网络、无模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(pkg, 'bin', 'nuwax-devkit.mjs');

function cli(args, env = {}) {
  return new Promise(resolvePromise => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => resolvePromise({ code: error ? error.code : 0, stdout, stderr }));
  });
}

function git(cwd, args) {
  return new Promise((res, rej) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (error, stdout) => error ? rej(error) : res(stdout));
  });
}

async function makeConsumer() {
  // 目录名带空格：覆盖空格路径
  const base = mkdtempSync(path.join(os.tmpdir(), 'devkit consumer-'));
  const repo = path.join(base, 'project repo');
  const state = path.join(base, 'proof state');
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'input.txt'), 'one\n');
  writeFileSync(path.join(repo, 'recipe.json'), JSON.stringify({
    schemaVersion: 1, id: 'fixture-consumer', level: 'source-tooling', inputs: ['src', 'recipe.json'],
    stages: [{ id: 'check', predicate: 'check-output', argv: ['{node}', '-e', 'console.log("verified")'], timeoutMs: 30000 }],
  }, null, 2) + '\n');
  // 既有配置必须被保留：预置 profile/hooks/自有字段
  writeFileSync(path.join(repo, '.sdlc.json'), JSON.stringify({
    name: 'consumer', test: 'npm t', profile: 'slim', hooks: { 'pre-commit': './x.sh' }, envPrefix: 'CONSUMER',
  }, null, 2) + '\n');
  await git(repo, ['init', '-q']);
  await git(repo, ['add', '.']);
  await git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  return { base, repo, state };
}

function lastJson(text) {
  for (const line of text.trimEnd().split('\n').reverse()) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { return JSON.parse(t); } catch { /* skip */ }
  }
  return null;
}

test('init：opt-in 接线保留既有 hook/profile，输出实际入口', async t => {
  const { base, repo } = await makeConsumer();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const result = await cli(['init', '--project', repo, '--recipe', 'recipe.json']);
  assert.equal(result.code, 0, result.stderr);
  const cfg = JSON.parse(readFileSync(path.join(repo, '.sdlc.json'), 'utf8'));
  assert.equal(cfg.profile, 'slim');
  assert.deepEqual(cfg.hooks, { 'pre-commit': './x.sh' });
  assert.equal(cfg.envPrefix, 'CONSUMER');
  assert.equal(cfg.verification.recipe, 'recipe.json');
  assert.equal(cfg.verification.runner, 'scripts/sdlc-verify.mjs');
  assert.ok(existsSync(path.join(repo, 'scripts', 'sdlc-verify.mjs')));
  assert.ok(result.stdout.includes('实际入口'));
  assert.ok(result.stdout.includes(path.join(repo, 'scripts', 'sdlc-verify.mjs')));
});

test('init：配方不存在/越界/绝对路径均拒绝', async t => {
  const { base, repo } = await makeConsumer();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  assert.notEqual((await cli(['init', '--project', repo, '--recipe', 'nope.json'])).code, 0);
  assert.notEqual((await cli(['init', '--project', repo, '--recipe', '../escape.json'])).code, 0);
  assert.notEqual((await cli(['init', '--project', repo, '--recipe', '/etc/hosts'])).code, 0);
  assert.notEqual((await cli(['init', '--project', path.join(base, 'missing'), '--recipe', 'r.json'])).code, 0);
});

test('verify fresh → reuse → tamper 全链路（空格路径 + 显式 Node + state 仓外）', async t => {
  const { base, repo, state } = await makeConsumer();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  await cli(['init', '--project', repo, '--recipe', 'recipe.json']);

  const args = ['verify', '--project', repo, '--state', state, '--task-key', 'fixture-task-1', '--node', process.execPath];
  const fresh = await cli(args);
  assert.equal(fresh.code, 0, fresh.stderr + fresh.stdout);
  const freshJson = lastJson(fresh.stdout);
  assert.equal(freshJson.passed, true);
  assert.equal(freshJson.reused, false);
  assert.equal(freshJson.internalModelRequests, 0);
  assert.ok(existsSync(state) && readdirSync(state).length > 0, 'state 应在仓外生成工件');

  const reuse = await cli([...args, '--reuse']);
  assert.equal(reuse.code, 0, reuse.stderr + reuse.stdout);
  assert.equal(lastJson(reuse.stdout).reused, true);

  // 篡改证据：改 manifest 内容后 --reuse 必须拒绝旧证据并完整重跑
  const manifest = freshJson.manifest;
  const tampered = JSON.parse(readFileSync(manifest, 'utf8'));
  tampered.level = 'gui-product-scenario'; // 伪造更高 level
  writeFileSync(manifest, JSON.stringify(tampered, null, 2));
  const afterTamper = await cli([...args, '--reuse']);
  assert.equal(afterTamper.code, 0, afterTamper.stderr + afterTamper.stdout);
  assert.equal(lastJson(afterTamper.stdout).reused, false, '被篡改的证据不得复用');
});

test('verify：state 在仓内 / 非法参数 / 缺依赖 拒绝', async t => {
  const { base, repo, state } = await makeConsumer();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  await cli(['init', '--project', repo, '--recipe', 'recipe.json']);
  const baseArgs = ['verify', '--project', repo, '--state', state, '--task-key', 'k'];

  const inside = await cli(['verify', '--project', repo, '--state', path.join(repo, 'inside-state'), '--task-key', 'k']);
  assert.notEqual(inside.code, 0);
  assert.match(inside.stderr, /仓之外/);

  const badNode = await cli([...baseArgs, '--node', '/nonexistent/node']);
  assert.notEqual(badNode.code, 0);
  assert.match(badNode.stderr, /--node 不存在/);

  const badPython = await cli([...baseArgs, '--python', '/nonexistent/python']);
  assert.notEqual(badPython.code, 0);
  assert.match(badPython.stderr, /--python/);

  const emptyKey = await cli(['verify', '--project', repo, '--state', state, '--task-key', '   ']);
  assert.notEqual(emptyKey.code, 0);

  const missingStack = await cli(baseArgs, { NUWAX_DEVKIT_RESOLVE_ROOT: path.join(base, 'no-node_modules') });
  assert.notEqual(missingStack.code, 0);
  assert.match(missingStack.stderr, /devkit-stack/);
});

test('verify：配方失败（断言不成立）退出非 0，passed=false', async t => {
  const { base, repo, state } = await makeConsumer();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  writeFileSync(path.join(repo, 'recipe.json'), JSON.stringify({
    schemaVersion: 1, id: 'fixture-fail', level: 'source-tooling', inputs: ['src', 'recipe.json'],
    stages: [{ id: 'check', predicate: 'check-output', argv: ['{node}', '-e', 'process.exit(3)'], timeoutMs: 30000 }],
  }));
  await git(repo, ['add', '.']);
  await git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'failing recipe']);
  await cli(['init', '--project', repo, '--recipe', 'recipe.json']);
  const result = await cli(['verify', '--project', repo, '--state', state, '--task-key', 'fixture-fail-1', '--node', process.execPath]);
  assert.notEqual(result.code, 0);
  assert.equal(lastJson(result.stdout)?.passed, false);
});
