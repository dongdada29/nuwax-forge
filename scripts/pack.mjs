#!/usr/bin/env node
// 打包 5 个工作区包为 tarball 到可指定的仓外目录，并核对 tarball 内容边界：
// 无真实 registry、无凭据、无 .git 历史、无 node_modules；**拒绝一切符号链接**
// （tar -tvf 元数据可见 `entry -> target`，链接本身即拒绝，无论目标相对或绝对）。
// out 目录做 canonical 仓外校验（最近存在祖先 realpath）；npm pack 带 --ignore-scripts --offline；
// 只认本轮产物（mtime>=启动时刻的 5 个期望文件名），不把目录里已有的旧 tgz 冒充本轮结果。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathNearestExisting, isInside } from '../packages/cli/lib/paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const START = Date.now();
// 期望的 5 个 tarball 名（由各包 name+version 派生，不硬编码版本号）
function expectedTarballs() {
  const names = [];
  for (const dir of ['cli', 'contracts', 'nuwax-crew', 'nuwax-stack']) {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'packages', dir, 'package.json'), 'utf8'));
    names.push(`${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`);
  }
  const kit = JSON.parse(readFileSync(path.join(ROOT, 'packages', 'nuwa-sdlc-kit', 'package.json'), 'utf8'));
  names.push(`${kit.name.replace('@', '').replace('/', '-')}-${kit.version}.tgz`);
  return names.sort();
}

function usage(code) {
  console.log('用法: npm run pack -- [--out <仓外目录>]（缺省用系统临时目录）');
  process.exit(code);
}

const argv = process.argv.slice(2);
let out = path.join(os.tmpdir(), `nuwax-devkit-pack-${Date.now()}`);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') {
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) usage(2);
    out = path.resolve(argv[++i]);
  } else usage(2);
}
const outReal = realpathNearestExisting(out).real;
const rootReal = realpathNearestExisting(ROOT).real;
if (isInside(rootReal, outReal) || isInside(outReal, rootReal)) {
  console.error(`FAIL --out 必须在本仓之外（canonical 解析: ${outReal}）`);
  process.exit(1);
}
mkdirSync(out, { recursive: true });

const before = new Set(readdirSync(out).filter(f => f.endsWith('.tgz')));
const packed = spawnSync('npm', ['pack', '--workspaces', '--ignore-scripts', '--offline', '--pack-destination', out],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
if (packed.status !== 0) {
  process.stdout.write(packed.stdout ?? '');
  process.stderr.write(packed.stderr ?? '');
  process.exit(packed.status ?? 1);
}
process.stdout.write(packed.stdout);

const FORBIDDEN = [/(^|\/)registries\/mbp[^/]*/i, /(^|\/)\.git(\/|$)/, /(^|\/)\.env($|\.)/, /(^|\/)node_modules\//, /credentials?($|\.)/i];
const expected = expectedTarballs();
let failed = false;
const produced = [];
for (const name of expected) {
  const file = path.join(out, name);
  if (!existsSync(file)) { console.error(`FAIL 期望产物缺失: ${name}`); failed = true; continue; }
  const stat = statSync(file);
  if (stat.mtimeMs < START - 1000) {
    console.error(`FAIL ${name} 不是本轮产物（mtime 早于本次 pack 启动；请用新目录或清理旧 tgz）`);
    failed = true;
    continue;
  }
  if (before.has(name)) {
    console.error(`FAIL ${name} 在本轮之前已存在于目标目录，无法证明是本轮产物（请用干净目录）`);
    failed = true;
  }
  produced.push(name);
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
  // tar -tvf 输出元数据：symlink 行含 " -> "，据此拒绝一切链接（含相对目标）
  const listing = spawnSync('tar', ['-tvf', file], { encoding: 'utf8' });
  if (listing.status !== 0) {
    console.error(`FAIL 无法列出 ${name}: ${listing.stderr}`);
    failed = true;
    continue;
  }
  const lines = listing.stdout.split('\n').filter(Boolean);
  for (const line of lines) {
    const entry = line.split(/\s+/).slice(-1)[0];
    if (line.includes(' -> ')) {
      console.error(`FAIL ${name} 含符号链接（一律拒绝，无论目标相对或绝对）: ${line}`);
      failed = true;
    }
    for (const pattern of FORBIDDEN) {
      if (pattern.test(entry)) {
        console.error(`FAIL ${name} 含禁止条目: ${entry}`);
        failed = true;
      }
    }
  }
  console.log(`ok ${name}  ${(stat.size / 1024).toFixed(1)} KiB  sha256=${sha.slice(0, 12)}  entries=${lines.length}`);
}
if (produced.filter(Boolean).length !== 5) {
  console.error(`FAIL 期望 5 个本轮 tarball，实际 ${produced.length}`);
  failed = true;
}
if (failed) process.exit(1);
console.log(`\n5 个 tarball 已产出并核对：${out}`);
