import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, readFileSync, writeFileSync, mkdirSync, lstatSync, fstatSync, realpathSync, existsSync } from 'node:fs';
import path from 'node:path';

const KIND = 'forge-bot-bridge-v1';
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const inside = (root, value) => value === root || value.startsWith(root + path.sep);
const disjoint = (a, b) => !inside(a, b) && !inside(b, a);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function absolute(value) {
  assert(typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f]/.test(value), 'Expected an explicit absolute path');
  return path.resolve(value);
}
function real(value, directory = false) {
  const target = absolute(value);
  const stat = lstatSync(target);
  assert(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()), 'Trusted path must be a real ' + (directory ? 'directory' : 'file'));
  return realpathSync(target);
}

// Configuration is operator-owned, never a tool argument. The fingerprint binds
// a fresh root to these exact capabilities; changing it needs another fresh root.
export function validateConfig(raw) {
  assert(plain(raw) && raw.schemaVersion === 1, 'Bridge config requires schemaVersion=1');
  const config = structuredClone(raw);
  config.nodeBinary = real(config.nodeBinary);
  config.forgeRoot = real(config.forgeRoot, true);
  config.forgeEntry = real(config.forgeEntry);
  assert(inside(config.forgeRoot, config.forgeEntry), 'Forge entry must stay inside trusted forgeRoot');
  config.stateRoot = absolute(config.stateRoot);
  const parent = real(path.dirname(config.stateRoot), true);
  assert(path.join(parent, path.basename(config.stateRoot)) === config.stateRoot, 'stateRoot parent must be canonical');
  assert(disjoint(config.forgeRoot, config.stateRoot), 'stateRoot must be outside Forge installation');
  assert(plain(config.workspaces) && Object.keys(config.workspaces).length > 0, 'Explicit workspace templates are required');
  for (const [alias, template] of Object.entries(config.workspaces)) {
    assert(/^[a-zA-Z0-9_-]{1,40}$/.test(alias) && plain(template), 'Invalid workspace alias/template');
    template.worktree = real(template.worktree, true);
    assert(disjoint(template.worktree, config.stateRoot), 'stateRoot must be outside every workspace');
    assert(['codex', 'deepseek-harness'].includes(template.runtime?.kind), 'Explicit runtime kind is required');
    template.runtime.binary = real(template.runtime.binary);
    assert(typeof template.runtime.model === 'string' && template.runtime.model.length > 0, 'Explicit model is required');
    assert(template.runtime.contextMode === 'fresh-exec', 'Only fresh-exec is allowed');
    for (const key of Object.keys(template.runtime)) assert(['kind', 'binary', 'model', 'provider', 'contextMode'].includes(key), 'Unsupported runtime field');
    assert(['read-only', 'workspace-write'].includes(template.permissions?.mode), 'Explicit permissions are required');
    assert(template.budget?.maxAttempts === 1 && template.budgetSpec, 'Existing Forge one-attempt budget spec is required');
    assert((template.context?.contextFiles ?? []).length <= 4, 'At most four explicit context files');
  }
  config.allowPrepare = config.allowPrepare === true;
  return config;
}

export function initializeBridge(raw) {
  const config = validateConfig(raw);
  assert(!existsSync(config.stateRoot), 'stateRoot must be a new nonexistent directory');
  mkdirSync(config.stateRoot, { mode: 0o700 });
  save(path.join(config.stateRoot, 'bridge.json'), { kind: KIND, configHash: digest(config) });
  return { kind: KIND, stateRoot: config.stateRoot, allowPrepare: config.allowPrepare };
}

// No directory enumeration, session discovery or arbitrary file reads. Reject
// symlinks for every component inside the explicitly authorized state root.
function confined(config, ...parts) {
  let cursor = config.stateRoot;
  for (const part of ['', ...parts]) {
    cursor = path.join(cursor, part);
    assert(inside(config.stateRoot, cursor), 'Path escaped stateRoot');
    const stat = lstatSync(cursor, { throwIfNoEntry: false });
    if (stat) assert(!stat.isSymbolicLink(), 'Symlink inside stateRoot is forbidden');
  }
  return cursor;
}
function read(config, parts, optional = false) {
  const file = confined(config, ...parts);
  if (optional && !existsSync(file)) return null;
  const bounded = stat => assert(stat.isFile() && stat.size <= 262144, 'State must be a bounded regular JSON file');
  bounded(lstatSync(file));
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    bounded(fstatSync(fd));
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
function checkRoot(config) {
  assert(real(config.stateRoot, true) === config.stateRoot, 'stateRoot changed');
  const marker = read(config, ['bridge.json']);
  assert(marker.kind === KIND && marker.configHash === digest(config), 'Bridge root does not match operator configuration');
  for (const template of Object.values(config.workspaces)) assert(real(template.worktree, true) === template.worktree && real(template.runtime.binary) === template.runtime.binary, 'Trusted workspace/runtime changed');
  assert(real(config.nodeBinary) === config.nodeBinary && real(config.forgeEntry) === config.forgeEntry, 'Trusted Forge entry changed');
}
function session(exec) {
  exec?.signal?.throwIfAborted();
  const id = exec?.agent?.session?.id;
  assert(typeof id === 'string' && id.length > 0 && id.length <= 200, 'An explicit calling DSH Session is required');
  return id;
}
function argsOnly(args, keys) {
  assert(plain(args) && Object.keys(args).every(key => keys.includes(key)), 'Unsupported tool argument');
}
function environment(config, attempt) {
  const home = confined(config, attempt, 'home');
  mkdirSync(home, { mode: 0o700 });
  const env = {
    PATH: [...new Set([path.dirname(config.nodeBinary), ...Object.values(config.workspaces).map(t => path.dirname(t.runtime.binary)), '/usr/bin', '/bin'])].join(path.delimiter),
    HOME: home, USERPROFILE: home, DSH_HOME: path.join(home, 'dsh'), DSH_AGENTS_HOME: path.join(home, 'agents'),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_DATA_HOME: path.join(home, 'data'),
    DSH_TELEMETRY_MODE: 'DISABLED', LANG: 'C.UTF-8',
  };
  if (process.platform === 'win32') env.SystemRoot = process.env.SystemRoot;
  return env;
}

// Only this fixed prepare argv is executable. No shell, model-supplied binary,
// command, environment or runtime settings. Cancellation stops its process group.
function invokePrepare(config, attempt, signal) {
  signal?.throwIfAborted();
  const argv = [config.forgeEntry, 'agent', 'prepare', '--spec', confined(config, attempt, 'spec.json'),
    '--brief-file', confined(config, attempt, 'brief.txt'), '--state', confined(config, attempt, 'state')];
  const env = environment(config, attempt);
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(config.nodeBinary, argv, { cwd: config.forgeRoot, env, shell: false, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', bytes = 0, failure;
    const stop = reason => {
      failure ??= reason;
      try { grouped ? process.kill(-child.pid, 'SIGKILL') : child.kill('SIGKILL'); } catch {}
    };
    const abort = () => stop(new Error('Forge prepare cancelled; inspect the returned attempt before retrying'));
    const timer = setTimeout(() => stop(new Error('Forge prepare timed out')), 30000);
    signal?.addEventListener('abort', abort, { once: true });
    const collect = (chunk, stdout) => {
      bytes += chunk.length;
      if (bytes > 262144) stop(new Error('Forge prepare output exceeded limit'));
      else if (stdout) output += chunk;
    };
    child.stdout.on('data', chunk => collect(chunk, true));
    child.stderr.on('data', chunk => collect(chunk, false));
    child.once('error', error => { failure = new Error('Trusted Forge process failed: ' + error.code); });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      if (![0, 3].includes(code)) return reject(new Error('Forge prepare failed with exit ' + code + '; inspect explicit attempt state'));
      try { resolve(JSON.parse(output)); } catch { reject(new Error('Forge prepare returned invalid JSON')); }
    });
    if (signal?.aborted) abort();
  });
}

export function createBridge(raw) {
  const config = validateConfig(raw);
  checkRoot(config);
  const status = async (args, exec) => {
    session(exec); argsOnly(args, ['attemptId']);
    assert(typeof args.attemptId === 'string' && idPattern.test(args.attemptId), 'Expected exact attemptId from prepare; no paths or discovery');
    checkRoot(config);
    const a = args.attemptId;
    const source = read(config, [a, 'source.json']);
    assert(source.kind === KIND && source.attemptId === a && source.attempt === 1, 'Invalid attempt provenance');
    assert(Object.hasOwn(config.workspaces, source.workspace) && typeof source.taskKey === 'string' && /^[\w.-]{1,80}$/.test(source.taskKey)
      && typeof source.callingSessionId === 'string' && source.callingSessionId.length > 0, 'Invalid source workspace/task/Session');
    const manifest = read(config, [a, 'state', 'manifest.json'], true);
    const request = read(config, [a, 'state', 'request.json'], true);
    const guard = read(config, [a, 'state', 'budget-guard.json'], true);
    const settlement = read(config, [a, 'state', 'budget-reconcile.json'], true);
    const usage = read(config, [a, 'state', 'usage.json'], true);
    if (request) assert(request.taskKey === source.taskKey && request.worktree === config.workspaces[source.workspace]?.worktree, 'Forge task/workspace provenance mismatch');
    if (manifest) assert(manifest.taskKey === source.taskKey, 'Forge manifest task provenance mismatch');
    const knownStatuses = ['prepared', 'blocked', 'running', 'failed', 'completed'];
    const value = key => typeof manifest?.[key] === 'boolean' ? manifest[key] : null;
    const tokens = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    return {
      attemptId: a, taskKey: source.taskKey, attempt: 1, workspace: source.workspace,
      source: { kind: KIND, callingSessionId: source.callingSessionId, executionSessionId: typeof usage?.observation?.sessionId === 'string' ? usage.observation.sessionId : null, state: confined(config, a, 'state') },
      status: request && knownStatuses.includes(manifest?.status) ? manifest.status : 'unknown', reason: typeof manifest?.reason === 'string' ? manifest.reason : null,
      modelDispatched: value('modelDispatched'), processPassed: value('processPassed'), agentCompleted: value('agentCompleted'), acceptancePassed: value('acceptancePassed'),
      budget: { usageKnown: value('usageKnown'), chargedTokens: tokens(manifest?.chargedTokens),
        verdict: ['within', 'exceeds', 'unknown'].includes(settlement?.reconciliation?.budget?.verdict) ? settlement.reconciliation.budget.verdict : 'unknown',
        observedVerdict: settlement?.observedBudget?.verdict === 'exceeds' ? 'exceeds' : 'unknown',
        reportedTokensLowerBound: tokens(settlement?.observedBudget?.reportedTokensLowerBound) },
      operatorRun: manifest?.status === 'prepared' && request && guard?.allowed === true ? { requiresOperatorAuthorization: true, argv: [config.nodeBinary, config.forgeEntry, 'agent', 'run', '--state', confined(config, a, 'state')] } : null,
    };
  };
  const prepare = async (args, exec) => {
    const callingSessionId = session(exec); argsOnly(args, ['workspace', 'taskKey', 'brief']);
    assert(config.allowPrepare, 'Prepare was not explicitly enabled by the operator');
    assert(typeof args.workspace === 'string' && Object.hasOwn(config.workspaces, args.workspace), 'Workspace is not in the operator allowlist');
    assert(typeof args.taskKey === 'string' && /^[\w.-]{1,80}$/.test(args.taskKey), 'Invalid bounded taskKey');
    assert(typeof args.brief === 'string' && args.brief.trim() && !args.brief.includes('\0') && Buffer.byteLength(args.brief) <= 16384, 'Brief must be nonempty text of at most 16KiB');
    checkRoot(config);
    const attemptId = randomUUID();
    mkdirSync(confined(config, attemptId), { mode: 0o700 });
    const source = { kind: KIND, attemptId, attempt: 1, taskKey: args.taskKey, workspace: args.workspace, callingSessionId };
    save(confined(config, attemptId, 'source.json'), source);
    const spec = { ...structuredClone(config.workspaces[args.workspace]), schemaVersion: 1, taskKey: args.taskKey };
    save(confined(config, attemptId, 'spec.json'), spec);
    writeFileSync(confined(config, attemptId, 'brief.txt'), args.brief, { flag: 'wx', mode: 0o600 });
    try {
      await invokePrepare(config, attemptId, exec.signal);
      return await status({ attemptId }, exec);
    }
    catch (error) { throw new Error(`${error.message}; attemptId=${attemptId}`); }
  };
  return { status, prepare };
}
