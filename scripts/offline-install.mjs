#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { safePath, inside, verifyBundle, read, write, snapshot, restore, fileMap } from './bundle-lib.mjs';

const help = `node install.mjs install --host codex|deepseek-harness|nuwax [--root <managed-root>] [--host-root <agents-root|DSH_HOME>] [--workspace <nuwax-workspace>] [--bin-dir <user-bin>]
node install.mjs rollback|uninstall --root <managed-root>
Node>=22 / Python>=3.10; offline, no npm install. Existing unowned paths are never overwritten.`;
const args = process.argv.slice(2), action = args.shift();
if (!action || action === '--help') { console.log(help); process.exit(0); }
try { main(); } catch (e) { console.error(`FAIL ${e.message}`); process.exitCode = 1; }
function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw Error('需要 Node>=22');
  if (!['install', 'rollback', 'uninstall'].includes(action)) throw Error(help);
  const opts = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--host', '--root', '--host-root', '--workspace', '--bin-dir'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || opts[args[i]]) throw Error(help);
    opts[args[i]] = args[i + 1];
  }
  const host = opts['--host'];
  if (action === 'install' && !['codex', 'deepseek-harness', 'nuwax'].includes(host)) throw Error('--host 必须显式选择');
  if (action !== 'install' && (!opts['--root'] || host || opts['--host-root'] || opts['--workspace'] || opts['--bin-dir'])) throw Error('rollback/uninstall 仅接受 --root');
  const root = safePath(opts['--root'] ?? path.join(os.homedir(), '.local', 'share', 'nuwax-forge', host));
  const bundle = safePath(path.dirname(fileURLToPath(import.meta.url)));
  if (inside(root, bundle) || inside(bundle, root)) throw Error('安装根与分发包不能交叠');
  const stateFile = path.join(root, 'managed.json');
  let state = fs.existsSync(stateFile) ? read(safePath(stateFile)) : null;
  if (state && (state.owner !== 'nuwax-forge-installer-v1' || state.root !== root || !Array.isArray(state.history) || !Array.isArray(state.originals))) throw Error('无效受管记录');
  if (!state && fs.existsSync(root) && fs.readdirSync(root).length) throw Error('安装根已有非受管内容');
  if (!state && action !== 'install') throw Error('未找到受管安装');
  // Complete preflight before touching registrations. Host targets never overlap install/bundle roots.
  let targetPaths, manifest;
  if (action === 'install') {
    manifest = verifyBundle(bundle);
    if (host === 'nuwax') {
      if (!opts['--workspace'] || opts['--host-root']) throw Error('Nuwax 需要 --workspace，不接受 --host-root');
      const workspace = safePath(opts['--workspace']);
      if (!fs.statSync(workspace).isDirectory()) throw Error('workspace 必须存在');
      targetPaths = [{ path: path.join(workspace, 'AGENTS.md'), kind: 'file' }, { path: path.join(workspace, 'work-computer.json'), kind: 'file' }];
      if (!fs.existsSync(safePath(targetPaths[1].path))) throw Error('需要已有 work-computer.json');
    } else {
      if (opts['--workspace']) throw Error('此 host 不接受 --workspace');
      const envRoot = host === 'deepseek-harness' ? process.env.DSH_HOME?.trim() : null;
      if (host === 'deepseek-harness' && !opts['--host-root'] && !envRoot) throw Error('DSH 需要已核对的 --host-root 或 DSH_HOME');
      const hostRoot = safePath(opts['--host-root'] ?? envRoot ?? path.join(os.homedir(), '.agents'));
      targetPaths = [{ path: path.join(hostRoot, 'skills', 'nuwax-forge'), kind: 'dir' }];
    }
    const bin = safePath(opts['--bin-dir'] ?? path.join(os.homedir(), '.local', 'bin'));
    targetPaths.push({path: path.join(bin, 'nuwax-forge'), kind: 'file'});
    if (state && (state.host !== host || JSON.stringify(state.originals.map(({path, kind}) => ({path, kind}))) !== JSON.stringify(targetPaths))) throw Error('受管根不能切换宿主或目标位置');
  } else targetPaths = state.originals.map(({path, kind}) => ({path, kind}));
  for (const t of targetPaths) {
    safePath(t.path);
    if ([root, bundle].some(base => inside(base, t.path) || inside(t.path, base))) throw Error('目标与安装根/分发包交叠');
  }
  const current = state?.active ? state.history.at(-1).targets : state?.originals;
  if (current) for (const t of current) {
    if (!targetPaths.some(x => x.path === t.path && x.kind === t.kind)) throw Error('受管记录目标不一致');
    if (JSON.stringify(snapshot(t.path, t.kind)) !== JSON.stringify(t.content)) throw Error(`受管目标已被修改，拒绝覆盖: ${t.path}`);
  }
  if (action === 'install' && !state) {
    for (const t of targetPaths) {
      if ((t.kind === 'dir' || t.path.endsWith('/nuwax-forge')) && snapshot(t.path, t.kind) !== null) throw Error('Skill 路径已有非受管内容');
      if (host === 'nuwax' && t.path.endsWith('AGENTS.md') && fs.existsSync(t.path) && fs.readFileSync(t.path, 'utf8').includes('<!-- nuwax-forge:')) throw Error('AGENTS 存在非受管同名标记');
    }
  }
  if (action !== 'install' && !state.active) throw Error('当前没有活动安装');
  if (action === 'rollback' && state.history.length < 2) throw Error('没有可回滚版本');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, 'install.lock');
  const fd = fs.openSync(lock, 'wx', 0o600); fs.closeSync(fd);
  try {
    // Reject a stale preflight if another installer completed before we acquired the lock.
    const lockedState = fs.existsSync(stateFile) ? read(safePath(stateFile)) : null;
    if (JSON.stringify(lockedState) !== JSON.stringify(state)) throw Error('受管状态并发变化，请重新检查');
    if (fs.existsSync(stateFile + '.transaction') || fs.existsSync(stateFile + '.next')) throw Error('发现未完成事务，请先恢复');
    if (current) for (const t of current) {
      if (JSON.stringify(snapshot(t.path, t.kind)) !== JSON.stringify(t.content)) throw Error('受管目标并发变化');
    }
    if (action === 'install') {
      const release = path.join(root, 'versions', manifest.id), cli = path.join(release, 'node_modules', '@nuwax-ai', 'devkit-cli', 'bin', 'nuwax-forge.mjs');
      const crew = path.join(release, 'node_modules', '@nuwax-ai', 'devkit-crew');
      safePath(release);
      const stage = path.join(root, 'stage');
      if (fs.existsSync(stage)) throw Error('发现未完成 stage，请检查后恢复');
      fs.mkdirSync(stage);
      try {
        fs.cpSync(path.join(bundle, 'payload', 'packages'), path.join(stage, 'node_modules'), { recursive: true });
        fs.cpSync(path.join(bundle, 'payload', 'skill'), path.join(stage, 'skill'), { recursive: true });
        write(path.join(stage, 'bundle-manifest.json'), manifest);
        write(path.join(stage, 'release-hashes.json'), fileMap(stage));
        const hashes = read(path.join(stage, 'release-hashes.json'));
        if (fs.existsSync(release)) {
          const existing = fileMap(release); delete existing['release-hashes.json'];
          if (!sameMap(existing, hashes) || !sameMap(read(safePath(path.join(release, 'release-hashes.json'))), hashes)) throw Error('已有版本内容冲突/篡改');
        } else {
          fs.mkdirSync(path.dirname(release), { recursive: true }); fs.renameSync(stage, release);
        }
      } finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true }); }
      // Installed core is checked before registration. Never consult source dependencies/config.
      const env = { ...process.env }; delete env.NUWAX_DEVKIT_RESOLVE_ROOT;
      let hostPython;
      if (host === 'nuwax') {
        hostPython = read(targetPaths[1].path).runtimeGuard?.tools?.python?.path;
        if (hostPython !== undefined) {
          if (typeof hostPython !== 'string' || !path.isAbsolute(hostPython) || /[\r\n\0]/.test(hostPython)) throw Error('工作台 Python 必须是显式绝对路径');
          env.NUWAX_DEVKIT_PYTHON = hostPython;
        }
      }
      const check = spawnSync(process.execPath, [cli, 'doctor', '--json'], { env, encoding: 'utf8', timeout: 30000 });
      if (check.status !== 0) throw Error(`安装版 doctor 失败: ${check.stderr || check.stdout}`);
      let targets;
      const originals = state?.originals ?? targetPaths.map(t => ({ ...t, content: snapshot(t.path, t.kind) }));
      if (host !== 'nuwax') {
        const content = snapshot(path.join(release, 'skill'), 'dir');
        // Registered copies follow the active version without baking a username or version into the Skill.
        const runtimeRoot = path.relative(targetPaths[0].path, root).split(path.sep).join('/');
        content.files['installation.json'].data = Buffer.from(JSON.stringify({
          schemaVersion: 2, command: 'nuwax-forge', runtimeRoot,
        }, null, 2) + '\n').toString('base64');
        targets = [{ ...targetPaths[0], content }];
      }
      else {
        const workspace = safePath(opts['--workspace']);
        let originalAgents = originals[0].content ? Buffer.from(originals[0].content.data, 'base64').toString('utf8') : '';
        const stack = path.join(release, 'node_modules', '@nuwax-ai', 'devkit-stack', 'modules', 'stack');
        originalAgents = originalAgents.replaceAll('~/.codex/skills/nuwax-stack', stack).replaceAll(path.join(os.homedir(), '.codex/skills/nuwax-stack'), stack).replaceAll(path.join(workspace, '.agents/skills/nuwax-stack'), stack);
        originalAgents = originalAgents.replaceAll('统一研发技能为 nuwax-stack（平台13555，0.4.0）', '统一研发技能为 nuwax-forge（平台13555），Stack 为内部模块')
          .replaceAll('每次唤醒先加载 nuwax-stack', '每次唤醒先加载 nuwax-forge，按需读取 Stack 内部模块');
        const route = `\n<!-- nuwax-forge:begin -->\n有限本机执行按需读取 ${path.join(release, 'skill', 'SKILL.md')}，调用 node ${JSON.stringify(path.join(release, 'skill', 'scripts', 'forge.mjs'))}。平台统一入口为 nuwax-forge，Stack 为内部模块；子执行器只完成短 brief，不加载主控 Skill 或递归派工。\n<!-- nuwax-forge:end -->\n`;
        const config = JSON.parse(Buffer.from(originals[1].content.data, 'base64').toString('utf8'));
        if (!config || Array.isArray(config) || typeof config !== 'object' || (config.runtimeGuard !== undefined && (!config.runtimeGuard || Array.isArray(config.runtimeGuard) || typeof config.runtimeGuard !== 'object'))) throw Error('work-computer.json/runtimeGuard 必须是对象');
        config.runtimeGuard = { ...config.runtimeGuard, devkitCli: cli, devkitCrewRoot: crew };
        const tool = config.runtimeGuard.tools?.devkitCli;
        if (tool !== undefined) {
          if (!tool || Array.isArray(tool) || typeof tool !== 'object') throw Error('runtimeGuard.tools.devkitCli 必须是对象');
          config.runtimeGuard.tools = { ...config.runtimeGuard.tools, devkitCli: { ...tool, path: cli } };
        }
        const replacePaths = value => {
          if (typeof value === 'string') return value.replaceAll(path.join(workspace, '.agents/skills/nuwax-stack'), stack).replaceAll(path.join(os.homedir(), '.codex/skills/nuwax-stack'), stack).replaceAll(path.join(workspace, '.agents/skills/nuwax-stack'), stack).replaceAll('~/.codex/skills/nuwax-stack', stack);
          if (Array.isArray(value)) return value.map(replacePaths);
          if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,replacePaths(v)]));
          return value;
        };
        Object.assign(config, replacePaths(config));
        targets = [{ ...targetPaths[0], content: { data: Buffer.from(originalAgents + route).toString('base64'), mode: originals[0].content?.mode ?? 0o600 } },
          { ...targetPaths[1], content: { data: Buffer.from(JSON.stringify(config, null, 2) + '\n').toString('base64'), mode: originals[1].content.mode } }];
      }
      const quote = x => "'" + x.replaceAll("'", "'\\''") + "'";
      const launcher = '#!/bin/sh\nunset NUWAX_DEVKIT_RESOLVE_ROOT\n' + (hostPython ? 'export NUWAX_DEVKIT_PYTHON=' + quote(hostPython) + '\n' : '') +
        'exec ' + [process.execPath, cli].map(quote).join(' ') + ' \"$@\"\n';
      targets.push({...targetPaths.at(-1), content: {data: Buffer.from(launcher).toString('base64'), mode: 0o755}});
      if (state?.active && state.history.at(-1).id === manifest.id) { console.log(JSON.stringify({ status: 'unchanged', root, release, doctor: JSON.parse(check.stdout) })); return; }
      const next = state ?? { owner: 'nuwax-forge-installer-v1', root, host, originals, history: [] };
      const history = next.active === false ? [] : next.history;
      commitTargets(targets, { ...next, active: true, history: [...history, { id: manifest.id, release, targets }] }, stateFile);
      console.log(JSON.stringify({ status: 'installed', root, release, cli, skill: path.join(release, 'skill'), doctor: JSON.parse(check.stdout) }));
    } else {
      const targets = action === 'uninstall' ? state.originals : state.history.at(-2).targets;
      if (action === 'rollback') {
        const release = safePath(state.history.at(-2).release);
        if (!inside(path.join(root, 'versions'), release)) throw Error('回滚版本路径逃逸');
        const actual = fileMap(release); delete actual['release-hashes.json'];
        if (!sameMap(actual, read(path.join(release, 'release-hashes.json')))) throw Error('回滚版本已篡改');
      }
      commitTargets(targets, { ...state, active: action !== 'uninstall', history: action === 'rollback' ? state.history.slice(0, -1) : state.history }, stateFile);
      console.log(JSON.stringify({ status: action === 'rollback' ? 'rolled-back' : 'uninstalled', root, retained: 'managed.json and versions retained for audit/backup; no active registration after uninstall' }));
    }
  } finally { fs.rmSync(lock, { force: true }); }
}
function sameMap(a, b) { return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => a[k] === b[k]); }
function commitTargets(targets, state, stateFile) {
  const before = targets.map(t => ({ ...t, content: snapshot(t.path, t.kind) }));
  // Persist byte-exact original/previous content before host writes. Refuse stale temp files.
  const journal = stateFile + '.transaction';
  const fd = fs.openSync(journal, 'wx', 0o600); fs.closeSync(fd); write(journal, { before, next: state });
  try {
    for (const t of targets) restore(t.path, t.kind, t.content);
    const temp = stateFile + '.next'; const fd = fs.openSync(temp, 'wx', 0o600); fs.closeSync(fd); write(temp, state); fs.renameSync(temp, stateFile);
    fs.rmSync(journal);
  } catch (e) {
    for (const t of before) restore(t.path, t.kind, t.content);
    throw e;
  }
}
