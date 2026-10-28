#!/usr/bin/env node
// nuwa-sdlc-kit verification v1: finite, dependency-free recipe execution.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const inside = (root, p) => p === root || p.startsWith(root + path.sep);
const canonical = p => {
  const missing = [];
  while (!fs.existsSync(p)) { missing.unshift(path.basename(p)); p = path.dirname(p); }
  return path.join(fs.realpathSync(p), ...missing);
};
export function inputFiles(root, paths) {
  const files = new Set();
  function visit(relative) {
    const absolute = path.resolve(root, relative);
    if (!inside(root, absolute)) throw new Error('input escapes repository');
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error('verification inputs must not be symlinks: ' + relative);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) {
        if (['.git', 'node_modules'].includes(name)) continue;
        visit(path.join(relative, name));
      }
    } else if (stat.isFile()) files.add(path.relative(root, absolute).split(path.sep).join('/'));
  }
  paths.forEach(visit);
  return [...files].sort().map(name => ({ path: name, sha256: sha256(fs.readFileSync(path.join(root, name))) }));
}
export const digestFiles = files => sha256(files.map(f => f.path + '\0' + f.sha256 + '\n').join(''));
const git = (root, args) => {
  const r = spawnSync('git', ['--no-optional-locks', ...args], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git inspection failed');
  return r.stdout.trim();
};
function execute(argv, options) {
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { ...options, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', error;
    const stop = () => {
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    const timer = setTimeout(() => { error = Object.assign(new Error('stage timeout'), { code: 'ETIMEDOUT' }); stop(); }, options.timeout);
    const collect = (key, chunk) => {
      if (key === 'stdout') stdout += chunk; else stderr += chunk;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 32 * 1024 * 1024) {
        error = new Error('stage output exceeds limit'); stop();
      }
    };
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    child.on('error', value => { error = value; });
    child.on('close', status => { clearTimeout(timer); stop(); resolve({ status, stdout, stderr, error }); });
  });
}
export async function runVerification({ root, recipePath, output, reuse = false }) {
  root = fs.realpathSync(root); output = canonical(path.resolve(output));
  if (inside(root, output)) throw new Error('evidence output must be outside repository');
  recipePath = path.resolve(root, recipePath);
  if (!inside(root, recipePath)) throw new Error('recipe escapes repository');
  const recipe = JSON.parse(fs.readFileSync(recipePath, 'utf8'));
  if (recipe.schemaVersion !== 1 || !recipe.id || !Array.isArray(recipe.stages) || !recipe.stages.length ||
      !Array.isArray(recipe.inputs) || !recipe.inputs.length) throw new Error('invalid verification recipe');
  const ids = new Set();
  for (const s of recipe.stages) {
    if (!/^[a-z0-9-]+$/.test(s.id) || ids.has(s.id) || !s.predicate || !Array.isArray(s.argv) ||
        !s.argv.length || s.argv.some(x => typeof x !== 'string') ||
        (s.timeoutMs !== undefined && (!Number.isInteger(s.timeoutMs) || s.timeoutMs <= 0)))
      throw new Error('invalid verification stage');
    ids.add(s.id);
  }
  const inputs = [...new Set([...recipe.inputs, path.relative(root, recipePath)])];
  const files = inputFiles(root, inputs);
  const source = { root, head: git(root, ['rev-parse', 'HEAD']), inputs, files, inputDigest: digestFiles(files) };
  const environment = { hostname: os.hostname(), platform: process.platform, arch: process.arch,
    node: process.version, nodeExecutable: process.execPath };
  fs.mkdirSync(output, { recursive: true });
  const manifestPath = path.join(output, 'verification.json');
  if (reuse && fs.existsSync(manifestPath)) {
    let old;
    try { old = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { old = {}; }
    if (old.kind === 'nuwax-verification' && old.passed === true &&
        old.source?.head === source.head && old.source?.root === root && old.source?.inputDigest === source.inputDigest &&
        JSON.stringify(old.environment) === JSON.stringify(environment) &&
        old.predicates?.length === recipe.stages.length && old.predicates.every((p, i) => p.id === recipe.stages[i].predicate && p.passed === true) &&
        old.artifacts?.length === recipe.stages.length && old.artifacts.every(a => inside(output, canonical(path.resolve(output, a.path))) &&
          fs.existsSync(path.resolve(output, a.path)) && sha256(fs.readFileSync(path.resolve(output, a.path))) === a.sha256)) {
      return { ...old, reused: true, manifestPath };
    }
  }
  const lock = path.join(output, '.verification.lock');
  const fd = fs.openSync(lock, 'wx');
  fs.writeFileSync(fd, String(process.pid));
  const startedAt = new Date().toISOString(), start = performance.now();
  const predicates = [], artifacts = [], stages = [];
  try {
    for (const stage of recipe.stages) {
      const argv = stage.argv.map(x => x === '{node}' ? process.execPath : x);
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const begin = performance.now();
      const result = await execute(argv, {
        cwd: root, env, timeout: stage.timeoutMs ?? 120000,
      });
      const log = stage.id + '.log';
      const stdout = result.stdout ?? '', stderr = result.stderr ?? '';
      fs.writeFileSync(path.join(output, log), stdout + '\n' + stderr + (result.error ? '\n' + result.error.message : ''));
      let passed = result.status === 0 && !result.error;
      let failure = passed ? null : result.error?.code === 'ETIMEDOUT' ? 'timeout' : 'command-failed';
      // Optional JSON result predicate: exit 0 does not imply ready=true.
      if (passed && stage.jsonEquals) {
        try {
          const value = JSON.parse(stdout);
          passed = Object.entries(stage.jsonEquals).every(([key, expected]) => value[key] === expected);
        } catch { passed = false; }
        if (!passed) failure = 'predicate-failed';
      }
      if (passed && stage.jsonTypes) {
        try {
          const value = JSON.parse(stdout);
          passed = Object.entries(stage.jsonTypes).every(([key, type]) =>
            (Array.isArray(value[key]) ? 'array' : typeof value[key]) === type);
        } catch { passed = false; }
        if (!passed) failure = 'predicate-failed';
      }
      predicates.push({ id: stage.predicate, passed });
      stages.push({ id: stage.id, argv, exitCode: result.status, passed, failure,
        durationMs: Math.round(performance.now() - begin), build: stage.build === true });
      artifacts.push({ path: log, sha256: sha256(fs.readFileSync(path.join(output, log))) });
      if (!passed) break;
    }
    const unchanged = source.inputDigest === digestFiles(inputFiles(root, inputs)) &&
      source.head === git(root, ['rev-parse', 'HEAD']);
    const buildKeys = stages.filter(s => s.build).map(s => JSON.stringify(s.argv));
    const manifest = { schemaVersion: 1, kind: 'nuwax-verification', recipe: recipe.id, recipePath: path.relative(root, recipePath).split(path.sep).join('/'),
      level: recipe.level, passed: unchanged && predicates.length === recipe.stages.length && predicates.every(p => p.passed),
      source, environment, startedAt, finishedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - start), predicates, artifacts, stages,
      metrics: { productBuilds: buildKeys.length, repeatedProductBuilds: buildKeys.length - new Set(buildKeys).size,
        buildMeasurement: 'declared-recipe-stages-only' },
      command: [process.execPath, fileURLToPath(import.meta.url), '--root', root, '--recipe', recipePath, '--output', output],
      failure: unchanged ? stages.find(s => !s.passed)?.failure ?? null : 'source-changed-during-verification' };
    const temporary = manifestPath + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n');
    fs.renameSync(temporary, manifestPath);
    return { ...manifest, reused: false, manifestPath };
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

export async function main(argv = process.argv.slice(2)) {
  const get = name => argv[argv.indexOf('--' + name) + 1];
  for (const name of ['root', 'recipe', 'output'])
    if (!argv.includes('--' + name) || !get(name) || get(name).startsWith('--')) throw new Error('missing --' + name);
  const result = await runVerification({ root: get('root'), recipePath: get('recipe'), output: get('output'), reuse: argv.includes('--reuse') });
  console.log(JSON.stringify(result));
  process.exitCode = result.passed ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
