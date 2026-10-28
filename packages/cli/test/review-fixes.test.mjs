// Codex 复审修复项的集成反例：realpath state、level 门、配方结构门、解释器版本门、
// init 失败零副作用。全部用真实文件系统状态（真实 symlink、可执行假解释器），不是字符串拼接测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const validRecipe = { schemaVersion: 1, id: 'fixture-consumer', level: 'source-tooling', inputs: ['src', 'recipe.json'],
  stages: [{ id: 'check', predicate: 'check-output', argv: ['{node}', '-e', 'console.log("verified")'], timeoutMs: 30000 }] };

async function makeConsumer() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'devkit review fixes-'));
  const repo = path.join(base, 'project repo');
  const state = path.join(base, 'proof state');
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'input.txt'), 'one\n');
  writeFileSync(path.join(repo, 'recipe.json'), JSON.stringify(validRecipe, null, 2) + '\n');
  await git(repo, ['init', '-q']);
  await git(repo, ['add', '.']);
  await git(repo, ['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'fixture']);
  return { base, repo, state };
}

function fakeInterpreter(base, name, text) {
  const file = path.join(base, name);
  writeFileSync(file, `#!/bin/sh\necho ${text}\n`);
  chmodSync(file, 0o755);
  return file;
}

test('state 经真实 symlink 指进项目仓：在任何 mkdir/TaskStore 之前被拒', async t => {
  const { base, repo, state } = await makeConsumer();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  // 真实 symlink：alias -> 仓内目录（已存在），state 参数走别名
  const alias = path.join(base, 'state alias');
  symlinkSync(path.join(repo, 'inside-state'), alias); // 悬空链接也必须按 realpath 链解析出仓内归属
  const result = await cli(['verify', '--project', repo, '--state', alias, '--task-key', 'k']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /失效符号链接/); // 悬空链接：结构化拒绝，先于任何 mkdir
  // 已存在的 symlink 指向仓内已建目录同样拒绝
  mkdirSync(path.join(repo, 'existing-inside'));
  const alias2 = path.join(base, 'state alias 2');
  symlinkSync(path.join(repo, 'existing-inside'), alias2);
  const r2 = await cli(['verify', '--project', repo, '--state', alias2, '--task-key', 'k']);
  assert.notEqual(r2.code, 0);
  assert.match(r2.stderr, /仓之外/);
  assert.equal(existsSync(path.join(repo, 'existing-inside', 'usage.jsonl')), false, '不得在仓内留下任何 state 工件');
  // 好路径不受影响：仓外 state 正常
  await cli(['init', '--project', repo, '--recipe', 'recipe.json']);
  const ok = await cli(['verify', '--project', repo, '--state', state, '--task-key', 'k1']);
  assert.equal(ok.code, 0, ok.stderr + ok.stdout);
});

test('state 指向 devkit 安装目录内部（symlink 别名）被拒且不写入', async t => {
  const { base, repo } = await makeConsumer();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const stackRoot = path.resolve(pkg, '..', 'nuwax-stack');
  const alias = path.join(base, 'innocent name');
  symlinkSync(stackRoot, alias);
  const result = await cli(['verify', '--project', repo, '--state', alias, '--task-key', 'k']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /devkit 安装目录/);
});

test('配方 level=gui-product-scenario：统一 CLI 拒绝且失败发生在创建 state 之前', async t => {
  const { base, repo, state } = await makeConsumer();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  for (const level of ['gui-product-scenario', 'gui-toolchain-smoke', 'made-up-level']) {
    rmSync(path.join(repo, '.sdlc.json'), { force: true }); // 每轮重置，确保断言针对本轮 init
    rmSync(path.join(repo, 'scripts'), { recursive: true, force: true });
    writeFileSync(path.join(repo, 'recipe.json'), JSON.stringify({ ...validRecipe, level }, null, 2) + '\n');
    const init = await cli(['init', '--project', repo, '--recipe', 'recipe.json']);
    assert.notEqual(init.code, 0, level);
    assert.match(init.stderr + init.stdout, /未实现|未注册/);
    assert.equal(existsSync(path.join(repo, '.sdlc.json')), false, 'init 失败不得写 .sdlc.json');
    assert.equal(existsSync(path.join(repo, 'scripts', 'sdlc-verify.mjs')), false, 'init 失败不得写 runner');
    // 预置绑定后走 verify 同样在 state 创建前被拒
    writeFileSync(path.join(repo, '.sdlc.json'), JSON.stringify({ verification: { schemaVersion: 1, recipe: 'recipe.json', runner: 'scripts/sdlc-verify.mjs' } }));
    const verify = await cli(['verify', '--project', repo, '--state', state, '--task-key', 'k']);
    assert.notEqual(verify.code, 0, level);
    assert.match(verify.stderr, /level/);
    assert.equal(existsSync(state), false, `level=${level} 拒绝必须发生在创建 state 之前`);
  }
});

test('init：损坏配方（非法 JSON/缺结构/symlink/越界）零副作用', async t => {
  const { base, repo } = await makeConsumer();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const cases = [
    ['broken.json', '{not json'],
    ['no-stages.json', JSON.stringify({ schemaVersion: 1, id: 'x', level: 'source-tooling', inputs: ['src'] })],
    ['no-argv.json', JSON.stringify({ ...validRecipe, stages: [{ id: 'c', predicate: 'p' }] })],
  ];
  for (const [name, content] of cases) {
    writeFileSync(path.join(repo, name), content);
    const r = await cli(['init', '--project', repo, '--recipe', name]);
    assert.notEqual(r.code, 0, name);
    assert.match(r.stderr, /配方验证失败/);
    assert.equal(existsSync(path.join(repo, '.sdlc.json')), false, `${name} 失败不得写 .sdlc.json`);
    assert.equal(existsSync(path.join(repo, 'scripts')), false, `${name} 失败不得写 scripts/`);
  }
  // recipe 本身是 symlink → 拒绝（指向仓外真实文件）
  const outside = path.join(base, 'outside recipe.json');
  writeFileSync(outside, JSON.stringify(validRecipe));
  symlinkSync(outside, path.join(repo, 'link.json'));
  const link = await cli(['init', '--project', repo, '--recipe', 'link.json']);
  assert.notEqual(link.code, 0);
  assert.match(link.stderr, /符号链接/);
  assert.equal(existsSync(path.join(repo, '.sdlc.json')), false);
});

test('init：配方父目录是指向仓外的真实 symlink alias → 拒绝且零副作用（.sdlc 字节不变）', async t => {
  const { base, repo } = await makeConsumer();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  // 既有配置必须字节不变：预置并记录原文
  const sdlc = path.join(repo, '.sdlc.json');
  const original = JSON.stringify({ name: 'consumer', profile: 'slim', hooks: { 'pre-commit': './x.sh' } }, null, 2) + '\n';
  writeFileSync(sdlc, original);
  // 项目外目录放合法配方；仓内"父目录 alias"是 symlink 指向它（最终文件不是 symlink）
  const outsideDir = path.join(base, 'outside recipes');
  mkdirSync(outsideDir);
  writeFileSync(path.join(outsideDir, 'recipe.json'), JSON.stringify(validRecipe, null, 2) + '\n');
  symlinkSync(outsideDir, path.join(repo, 'recipe dir alias'));
  const r = await cli(['init', '--project', repo, '--recipe', 'recipe dir alias/recipe.json']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /逃逸出项目仓/);
  assert.equal(readFileSync(sdlc, 'utf8'), original, '失败不得改动既有 .sdlc.json 字节');
  assert.equal(existsSync(path.join(repo, 'scripts')), false, '失败不得生成 runner/其它文件');
});

test('verify：显式 --node/--python 版本低（真实可执行假解释器）在创建 state 前被拒', async t => {
  const { base, repo, state } = await makeConsumer();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  await cli(['init', '--project', repo, '--recipe', 'recipe.json']);
  const oldNode = fakeInterpreter(base, 'fake-node-v18', 'v18.99.0');
  const r1 = await cli(['verify', '--project', repo, '--state', state, '--task-key', 'k', '--node', oldNode]);
  assert.notEqual(r1.code, 0);
  assert.match(r1.stderr, /Node 版本过低.*v18/);
  assert.equal(existsSync(state), false, '版本检查失败必须发生在创建 state 之前');
  const badNodeOut = fakeInterpreter(base, 'fake-node-garbage', 'not-a-version');
  const r2 = await cli(['verify', '--project', repo, '--state', state, '--task-key', 'k', '--node', badNodeOut]);
  assert.notEqual(r2.code, 0);
  assert.match(r2.stderr, /无法从.*解析 Node 版本/);
  const oldPython = fakeInterpreter(base, 'fake-python-39', 'Python 3.9.1');
  const r3 = await cli(['verify', '--project', repo, '--state', state, '--task-key', 'k', '--python', oldPython]);
  assert.notEqual(r3.code, 0);
  assert.match(r3.stderr, /Python 版本过低.*3\.9/);
  assert.equal(existsSync(state), false);
  // PATH 命令名形式可用（沿 PATH 找到，不从 cwd 解析）
  const ok = await cli(['verify', '--project', repo, '--state', state, '--task-key', 'k2', '--python', 'python3']);
  assert.equal(ok.code, 0, ok.stderr + ok.stdout);
});
