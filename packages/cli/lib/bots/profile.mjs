import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BOT_FILES, BOT_PIN, BOT_PROFILE, BOT_DSH_VERSIONS } from './pin.mjs';
import { bridgeReport, inspectBridge, operatorConfigPath, prepareBridge } from './composition.mjs';
import { compatibilityFiles } from './compatibility.mjs';

const KIND = 'nuwax-forge-ds-bot';
const MAX_ARTIFACT = 8 * 1024 * 1024;
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const digest = (value, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(value).digest(encoding);

export function botPaths(root) {
  assert(typeof root === 'string' && isAbsolute(root) && !/[\0\r\n]/.test(root), '--root must be an absolute path without control characters');
  root = resolve(root);
  assert(root !== resolve(root, '..'), '--root cannot be a filesystem root');
  const dshHome = join(root, 'dsh');
  return {
    root, dshHome, profile: BOT_PROFILE,
    profileDir: join(dshHome, 'profiles', BOT_PROFILE),
    team: join(root, 'team'), workspace: join(root, 'workspace'),
    marker: join(root, 'forge-bots.json'), archive: join(root, 'artifacts', 'ds-bot-0.2.7.tgz'),
    bridgePatch: join(root, 'forge-bridge.patch.json'),
  };
}

// Use a new, private directory; an existing arbitrary HOME/profile is never adopted.
function owned(paths, create = false) {
  if (!existsSync(paths.root)) {
    assert(create, 'Bot root is not prepared; run prepare first');
    mkdirSync(paths.root, { mode: 0o700 });
    writeFileSync(paths.marker, JSON.stringify({ kind: KIND, schema: 1, profile: BOT_PROFILE, pin: BOT_PIN, state: 'preparing' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  assert(lstatSync(paths.root).isDirectory() && !lstatSync(paths.root).isSymbolicLink(), 'Bot root must be a real owned directory');
  assert(existsSync(paths.marker) && !lstatSync(paths.marker).isSymbolicLink(), 'Refusing to adopt an existing directory without a Forge Bot marker');
  const marker = json(paths.marker);
  assert(marker.kind === KIND && marker.schema === 1 && marker.profile === BOT_PROFILE && JSON.stringify(marker.pin) === JSON.stringify(BOT_PIN), 'Bot root marker or pinned version does not match');
  return marker;
}

// Refuse symlink redirects for every integration-owned path before writing it.
function directory(paths, target) {
  const parts = relative(paths.root, target).split(sep);
  assert(!parts.includes('..') && !isAbsolute(relative(paths.root, target)), 'Path escaped Bot root');
  let cursor = paths.root;
  for (const part of parts.filter(Boolean)) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o700 });
    assert(lstatSync(cursor).isDirectory() && !lstatSync(cursor).isSymbolicLink(), 'Managed directory must not be a symlink: ' + cursor);
  }
  return target;
}

function localFile(paths, target) {
  directory(paths, resolve(target, '..'));
  const entry = lstatSync(target, { throwIfNoEntry: false });
  if (entry) assert(entry.isFile() && !entry.isSymbolicLink(), 'Managed file must not be a symlink: ' + target);
}

function lock(paths) {
  const target = join(paths.root, '.forge-bots-lock');
  try { mkdirSync(target, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Bot root is busy; another prepare/check/run owns its lock'); throw error; }
  return () => rmdirSync(target);
}

export function botEnvironment(paths, ambient = process.env) {
  // No inherited provider keys, tokens, NODE_OPTIONS, DSH overrides, or agent homes.
  const env = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TERM', 'SystemRoot', 'COMSPEC', 'PATHEXT']) {
    if (ambient[key] !== undefined) env[key] = ambient[key];
  }
  return Object.assign(env, {
    HOME: join(paths.root, 'home'), USERPROFILE: join(paths.root, 'home'),
    DSH_HOME: paths.dshHome, DSH_AGENTS_HOME: join(paths.root, 'agents'),
    XDG_CONFIG_HOME: join(paths.root, 'config'), XDG_CACHE_HOME: join(paths.root, 'cache'),
    XDG_DATA_HOME: join(paths.root, 'data'), XDG_STATE_HOME: join(paths.root, 'state'),
    PNPM_HOME: join(paths.root, 'pnpm'), COREPACK_HOME: join(paths.root, 'cache', 'corepack'),
    TMPDIR: join(paths.root, 'tmp'), TMP: join(paths.root, 'tmp'), TEMP: join(paths.root, 'tmp'),
    npm_config_userconfig: join(paths.root, 'config', 'npmrc'),
    npm_config_globalconfig: join(paths.root, 'config', 'npmrc-global'),
    npm_config_cache: join(paths.root, 'cache', 'npm'), npm_config_ignore_scripts: 'true',
    npm_config_store_dir: join(paths.root, 'cache', 'pnpm-store'),
    npm_config_state_dir: join(paths.root, 'state', 'pnpm'),
    DSH_TELEMETRY_MODE: 'DISABLED', DSH_PERMISSION_MODE: 'workspace-write',
  });
}

function setup(paths) {
  const env = botEnvironment(paths);
  for (const target of [paths.dshHome, paths.workspace, paths.team, ...Object.entries(env).filter(([key]) => /^(HOME|DSH_AGENTS_HOME|XDG_|PNPM_HOME|COREPACK_HOME|TMPDIR)/.test(key)).map(([, value]) => value)]) directory(paths, target);
  for (const file of [env.npm_config_userconfig, env.npm_config_globalconfig]) {
    localFile(paths, file);
    if (!existsSync(file)) writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  }
  directory(paths, join(paths.dshHome, 'profiles'));
  if (existsSync(paths.profileDir)) directory(paths, paths.profileDir);
  for (const file of [join(paths.dshHome, 'cordis.patch.yml'), join(paths.dshHome, '.credentials.yaml'), join(paths.dshHome, '.env'), ...['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml'].map(name => join(paths.profileDir, name))]) {
    if (lstatSync(file, { throwIfNoEntry: false })) localFile(paths, file);
  }
}

function binaryPath(binary) {
  assert(typeof binary === 'string' && isAbsolute(binary) && !/[\0\r\n]/.test(binary), '--dsh must name an absolute DSH executable path');
  return binary;
}

function invoke(binary, paths, args) {
  const result = spawnSync(binaryPath(binary), args, { cwd: paths.workspace, env: botEnvironment(paths), shell: false, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
  assert(!result.error, `DSH ${args[0]} could not run (${result.error?.code ?? 'unknown'})`);
  const diagnostic = result.stderr?.match(/diagnostics: ([^\r\n]+)/)?.[1];
  const hint = diagnostic?.startsWith(paths.root + sep) ? `; diagnostics: ${diagnostic}` : '';
  assert(result.status === 0, `DSH ${args[0]} exited ${result.status ?? result.signal}${hint}; no raw config or credentials were printed`);
  return result.stdout;
}

function version(binary, paths) {
  const found = invoke(binary, paths, ['--version']).trim();
  assert(BOT_DSH_VERSIONS.includes(found), `DSH version mismatch: supported hosts are ${BOT_DSH_VERSIONS.join(', ')}`);
  return found;
}

export function botPlan({ root, binary, port = 0, forgeConfig }) {
  const paths = botPaths(root);
  binaryPath(binary);
  assert(Number.isInteger(port) && port >= 0 && port <= 65535, '--port must be an integer from 0 to 65535');
  if (forgeConfig !== undefined) operatorConfigPath(forgeConfig);
  let bridge = forgeConfig === undefined ? { enabled: false } : { requested: true, configPath: resolve(forgeConfig), patch: paths.bridgePatch };
  if (existsSync(paths.marker)) {
    const marker = owned(paths);
    if (marker.bridge) bridge = bridgeReport(inspectBridge(paths, marker, forgeConfig));
  }
  return {
    kind: KIND, pin: BOT_PIN, paths,
    prepare: ['plugin', '--profile', BOT_PROFILE, 'add', paths.archive, '--save-exact', '--ignore-scripts', '--store-dir', join(paths.root, 'cache', 'pnpm-store'), '--cache-dir', join(paths.root, 'cache', 'pnpm'), '--config.state-dir=' + join(paths.root, 'state', 'pnpm')],
    run: ['--profile', BOT_PROFILE, '--host', '127.0.0.1', '--port', String(port), '--no-open'],
    bridge,
    acceptance: { installation: 'not-run', composition: 'not-run', host: 'not-run', ui: 'not-run', modelBehavior: 'not-run' },
  };
}

export function verifyBotArchive(bytes) {
  assert(bytes.byteLength <= MAX_ARTIFACT, 'DS-Bot archive exceeds size limit');
  assert('sha512-' + digest(bytes, 'sha512', 'base64') === BOT_PIN.integrity, 'DS-Bot archive integrity mismatch');
}

async function archive(paths, tarball) {
  localFile(paths, paths.archive);
  let bytes;
  if (existsSync(paths.archive)) {
    assert(lstatSync(paths.archive).size <= MAX_ARTIFACT, 'DS-Bot archive exceeds size limit');
    bytes = readFileSync(paths.archive);
  }
  else if (tarball) {
    assert(isAbsolute(tarball), '--tarball must be an absolute path to the original pinned npm archive');
    assert(lstatSync(tarball).size <= MAX_ARTIFACT, 'DS-Bot archive exceeds size limit');
    bytes = readFileSync(tarball);
  } else {
    const response = await fetch(BOT_PIN.tarball, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    assert(response.ok, `DS-Bot download failed (${response.status})`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_ARTIFACT) { await response.body.cancel().catch(() => {}); throw new Error('DS-Bot archive exceeds size limit'); }
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  }
  verifyBotArchive(bytes);
  if (!existsSync(paths.archive)) writeFileSync(paths.archive, bytes, { flag: 'wx', mode: 0o600 });
}

function packageCheck(paths, runtimeVersion) {
  const manifest = json(join(paths.profileDir, 'package.json'));
  const bundles = manifest.dsh?.profile?.bundles;
  assert(Array.isArray(bundles) && ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot'].every(name => bundles.includes(name)), 'DSH web profile has not activated the original DS-Bot bundle');
  assert(Object.keys(manifest.dependencies ?? {}).length === 1 && manifest.dependencies['ds-bot'], 'Unexpected profile dependencies; use a fresh integration root');
  const packageDir = realpathSync(join(paths.profileDir, 'node_modules', 'ds-bot'));
  const ownRoot = realpathSync(paths.root) + sep;
  assert(packageDir.startsWith(ownRoot), 'Installed DS-Bot resolved outside this integration root');
  const pkg = json(join(packageDir, 'package.json'));
  assert(pkg.name === BOT_PIN.name && pkg.version === BOT_PIN.version && pkg.license === BOT_PIN.license, 'Installed DS-Bot package/version mismatch');
  assert(pkg.main === 'index.js' && pkg.exports?.['./client'] === './client.js' && pkg.dsh?.client?.platform === 'web' && pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'Original host/client/bundle exports are required');
  const expectedFiles = compatibilityFiles(paths, runtimeVersion);
  for (const [file, hash] of Object.entries(expectedFiles)) {
    const target = realpathSync(join(packageDir, file));
    assert(target.startsWith(packageDir + sep), 'DS-Bot file escaped installed package');
    assert(digest(readFileSync(target)) === hash, 'Original DS-Bot artifact changed: ' + file);
  }
  return { name: pkg.name, version: pkg.version, originalFilesVerified: runtimeVersion === '0.2.2-rc.1' ? 6 : 7,
    compatibility: runtimeVersion === '0.2.2-rc.1' ? 'forge-prompt-assembly-v1' : null, client: pkg.exports['./client'] };
}

function rowOf(dump, id) {
  const rows = dump.split(/(?=^- id: )/m);
  return rows.find(row => row.split('\n', 1)[0] === '- id: ' + id) ?? '';
}

// Read only fixed scalar fields from DSH's config dump; never evaluate YAML/!!js.
function scalar(row, key, indentation) {
  const lines = row.split('\n');
  const index = lines.findIndex(line => line.startsWith(' '.repeat(indentation) + key + ': '));
  if (index < 0) return undefined;
  const line = lines[index];
  const value = line.slice(indentation + key.length + 2).trim();
  // DSH's YAML dumper folds long absolute paths (notably macOS temp paths).
  if (value === '>-' || value === '|-') {
    const parts = [];
    for (const next of lines.slice(index + 1)) {
      if (!next.startsWith(' '.repeat(indentation + 2))) break;
      parts.push(next.slice(indentation + 2));
    }
    return parts.join(value === '>-' ? ' ' : '\n');
  }
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

export function verifyBotComposition(dump, paths) {
  for (const [id, name] of [['bot', 'ds-bot'], ['web-search-auto', 'ds-bot/web-search']]) {
    const row = rowOf(dump, id);
    assert(scalar(row, 'name', 2) === name, 'Original DS-Bot entry is missing: ' + id);
    const disabled = scalar(row, 'disabled', 2);
    assert(disabled === undefined || disabled === 'false', 'Original DS-Bot entry is disabled: ' + id);
  }
  const bot = rowOf(dump, 'bot');
  assert(scalar(bot, 'home', 4) === paths.team && scalar(bot, 'workspace', 4) === paths.workspace, 'DS-Bot data/workspace escaped the managed root');
  assert(scalar(bot, 'memory', 4) === 'true' && scalar(bot, 'updateCheck', 4) === 'false', 'DS-Bot memory or version-pin settings changed');
  return { bot: 'ds-bot', webSearch: 'ds-bot/web-search', memory: true };
}

function inspect({ root, binary, forgeConfig }) {
  const paths = botPaths(root);
  const marker = owned(paths); setup(paths);
  const bridge = inspectBridge(paths, marker, forgeConfig);
  const dshVersion = version(binary, paths);
  localFile(paths, paths.archive);
  verifyBotArchive(readFileSync(paths.archive));
  const pkg = packageCheck(paths, dshVersion);
  const dump = invoke(binary, paths, ['--profile', BOT_PROFILE, '--dump-config']);
  const composition = verifyBotComposition(dump, paths);
  if (bridge) {
    assert(dump.split(/(?=^- id: )/m).filter(row => row.split('\n', 1)[0] === '- id: forge-bot-bridge').length === 1, 'Native Forge bridge entry is missing or duplicated');
    const row = rowOf(dump, 'forge-bot-bridge');
    assert(scalar(row, 'name', 2) === pathToFileURL(bridge.binding.entry).href, 'Native Forge bridge entry changed');
    assert([undefined, 'false'].includes(scalar(row, 'disabled', 2)), 'Native Forge bridge entry is disabled');
    for (const key of ['stateRoot', 'nodeBinary', 'forgeRoot', 'forgeEntry', 'schemaVersion', 'allowPrepare']) {
      assert(scalar(row, key, 4) === String(bridge.config[key]), 'Native Forge bridge configuration changed: ' + key);
    }
  } else assert(!rowOf(dump, 'forge-bot-bridge'), 'Unbound native Forge bridge entry is forbidden');
  return { kind: KIND, pin: BOT_PIN, paths, dshVersion, package: pkg, composition, bridge: bridgeReport(bridge), acceptance: { installation: 'verified', composition: 'verified', host: 'not-run', ui: 'not-run', modelBehavior: 'not-run' } };
}

export async function prepareBot(options) {
  const plan = botPlan(options);
  const paths = plan.paths;
  const marker = owned(paths, true);
  const release = lock(paths);
  try {
    setup(paths);
    const runtimeVersion = version(options.binary, paths);
    if (marker.state === 'ready') {
      verifyBotArchive(readFileSync(paths.archive));
      compatibilityFiles(paths, runtimeVersion, true);
      return inspect(options);
    }
    if (!existsSync(join(paths.profileDir, 'package.json'))) invoke(options.binary, paths, ['--profile', BOT_PROFILE, '--from-default-profile', 'web', '--dump-config']);
    const patch = join(paths.profileDir, 'cordis.patch.yml');
    localFile(paths, patch);
    if (!existsSync(patch) || readFileSync(patch, 'utf8').replace(/^\s*#.*$/gm, '').trim() === '[]') {
      writeFileSync(patch, JSON.stringify([{ id: 'bot', config: { home: paths.team, workspace: paths.workspace, memory: true, updateCheck: false } }], null, 2) + '\n', { mode: 0o600 });
    }
    await prepareBridge(paths, marker, options.forgeConfig,
      value => writeFileSync(paths.marker, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }), localFile);
    await archive(paths, options.tarball);
    invoke(options.binary, paths, plan.prepare);
    compatibilityFiles(paths, runtimeVersion, true);
    const result = inspect(options);
    writeFileSync(paths.marker, JSON.stringify({ ...marker, state: 'ready' }, null, 2) + '\n', { mode: 0o600 });
    return result;
  } finally { release(); }
}

export function checkBot(options) {
  const paths = botPaths(options.root);
  owned(paths);
  const release = lock(paths);
  try { return inspect(options); } finally { release(); }
}

// Explicit, foreground launch of the original DSH web application. No messages,
// providers, or sessions are created by Forge; DS-Bot owns its normal lifecycle.
export function startBot(options, stdio = 'inherit') {
  const plan = botPlan(options);
  owned(plan.paths);
  const release = lock(plan.paths);
  try { inspect(options); } catch (error) { release(); throw error; }
  let child;
  try { child = spawn(options.binary, plan.run, { cwd: plan.paths.workspace, env: botEnvironment(plan.paths), shell: false, stdio }); }
  catch (error) { release(); throw error; }
  child.once('close', release);
  return child;
}
