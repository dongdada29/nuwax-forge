#!/usr/bin/env node
// 全新 tmp 消费者冒烟：同时安装 5 个 tgz（离线、ignore-scripts），用**已安装**的
// nuwax-devkit bin 跑 help / doctor / fixture init+verify。不依赖 monorepo 源码或旧试点路径。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
let tarballs = argv[0] ?? '/tmp/nuwax-devkit-tarballs';
if (argv[0] === '--tarballs') tarballs = argv[1];
const tgz = [];
for (const name of ['cli', 'contracts', 'crew', 'stack']) tgz.push(path.join(tarballs, `nuwax-ai-devkit-${name}-0.1.0-devkit-local.1.tgz`));
tgz.push(path.join(tarballs, 'nuwax-ai-nuwa-sdlc-kit-1.5.0-devkit-local.1.tgz'));
for (const file of tgz) if (!existsSync(file)) { console.error(`FAIL 缺 tarball: ${file}（先 npm run pack -- --out ${tarballs}）`); process.exit(1); }

const work = mkdtempSync(path.join(os.tmpdir(), 'devkit consumer smoke-'));
const project = path.join(work, 'app repo');
const state = path.join(work, 'proof state');
mkdirSync(path.join(project, 'src'), { recursive: true });
writeFileSync(path.join(project, 'src', 'input.txt'), 'one\n');
writeFileSync(path.join(project, 'recipe.json'), JSON.stringify({
  schemaVersion: 1, id: 'fixture-consumer', level: 'source-tooling', inputs: ['src', 'recipe.json'],
  stages: [{ id: 'check', predicate: 'check-output', argv: ['{node}', '-e', 'console.log("verified")'], timeoutMs: 30000 }],
}, null, 2) + '\n');

const run = (cmd, args, opts = {}) => {
  const result = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts });
  return { code: result.status, out: (result.stdout ?? '') + (result.stderr ?? '') };
};
const fail = step => { console.error(`FAIL ${step}`); rmSync(work, { recursive: true, force: true }); process.exit(1); };

// 1) 离线安装 5 tgz
const install = run('npm', ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', ...tgz], { cwd: work });
if (install.code !== 0) { console.error(install.out); fail('npm install 5 tgz'); }
console.log('ok npm install --ignore-scripts --offline（5 tgz）');

const bin = path.join(work, 'node_modules', '.bin', 'nuwax-devkit');
if (!existsSync(bin)) fail('bin nuwax-devkit 未生成');

// 2) 已安装 CLI：help
const help = run(bin, ['help']);
if (help.code !== 0 || !help.out.includes('doctor')) fail('help');
console.log('ok nuwax-devkit help');

// 3) 已安装 CLI：doctor
const doctor = run(bin, ['doctor']);
if (doctor.code !== 0 || !doctor.out.includes('全部检查通过')) { console.error(doctor.out); fail('doctor'); }
console.log('ok nuwax-devkit doctor（Node/Python/5 包绑定）');

// 4) git 消费者 + fixture init/verify
for (const args of [['init', '-q', project], ['-C', project, 'add', '.'], ['-C', project, '-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'smoke']]) {
  if (run('git', args).code !== 0) fail('git fixture ' + args.join(' '));
}
const init = run(bin, ['init', '--project', project, '--recipe', 'recipe.json']);
if (init.code !== 0 || !init.out.includes('实际入口')) { console.error(init.out); fail('init'); }
console.log('ok nuwax-devkit init（kit opt-in，输出实际入口）');

const verify = run(bin, ['verify', '--project', project, '--state', state, '--task-key', 'smoke-1']);
if (verify.code !== 0) { console.error(verify.out); fail('verify'); }
const verdict = verify.out.trim().split('\n').reverse().find(l => l.startsWith('{'));
const parsed = JSON.parse(verdict);
if (parsed.passed !== true || parsed.internalModelRequests !== 0) fail('verify 结论 passed=true / 0 模型调用');
console.log(`ok nuwax-devkit verify（passed=true, reused=${parsed.reused}, internalModelRequests=0）`);

rmSync(work, { recursive: true, force: true });
console.log('\n消费者冒烟通过：全新 tmp 安装 5 tgz → help/doctor/fixture init+verify 全部真实执行');
