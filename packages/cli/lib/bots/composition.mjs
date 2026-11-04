// Explicit operator configuration for the existing native bridge. This module
// does not import that bridge unless prepare opts in; Bot tools remain unchanged.
import { createHash } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const assert = (ok, message) => { if (!ok) throw new Error(message); };
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = value => hash(JSON.stringify(value));
const MAX_JSON = 262144;
const FILES = ['package.json', 'index.mjs', 'bridge.mjs', 'projection.mjs', 'locale/en.json', 'locale/zh.json', 'icon.svg'];

export function operatorConfigPath(value) {
  assert(typeof value === 'string' && isAbsolute(value) && !/[\x00-\x1f]/.test(value), '--forge-config requires an operator-owned absolute JSON path');
  return resolve(value);
}

function regular(file, limit = MAX_JSON) {
  const bounded = stat => assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit, 'Bridge file must be a bounded regular file: ' + file);
  bounded(lstatSync(file));
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try { bounded(fstatSync(fd)); return readFileSync(fd); } finally { closeSync(fd); }
}

// No environment/package lookup or caller-supplied plugin path. A packaged
// runtime, when present, must be complete: never silently fall back if damaged.
function runtime() {
  const packaged = resolve(fileURLToPath(new URL('./bridge-runtime/', import.meta.url)));
  const source = resolve(fileURLToPath(new URL('../../../../integrations/ds-bot-forge/', import.meta.url)));
  const root = lstatSync(packaged, { throwIfNoEntry: false }) ? packaged : source;
  return runtimeAt(root);
}

function runtimeAt(root) {
  const stat = lstatSync(root);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Native bridge runtime must be a real directory');
  const canonical = realpathSync(root);
  assert(canonical === root, 'Native bridge runtime path changed');
  const files = {};
  for (const name of FILES) {
    let cursor = canonical;
    for (const part of name.split('/')) {
      cursor = join(cursor, part);
      assert(!lstatSync(cursor).isSymbolicLink(), 'Native bridge runtime cannot contain symlinks');
    }
    files[name] = hash(regular(cursor, 1024 * 1024));
  }
  assert(JSON.parse(regular(join(canonical, 'package.json'))).name === '@nuwax-ai/ds-bot-forge-bridge', 'Unexpected native bridge runtime');
  return { entry: join(canonical, 'index.mjs'), files };
}

// A managed CLI upgrade changes its version directory. An existing team keeps
// its explicitly authorized runtime; never switch it to the new CLI's code.
function boundRuntime(binding) {
  const entry = binding.entry;
  assert(typeof entry === 'string' && isAbsolute(entry) && resolve(entry) === entry && !/[\x00-\x1f]/.test(entry) && basename(entry) === 'index.mjs', 'Invalid bound native bridge entry');
  const native = runtimeAt(dirname(entry));
  assert(native.entry === entry && JSON.stringify(native.files) === JSON.stringify(binding.files), 'Bound native bridge runtime drifted; restore the authorized runtime');
  return native;
}

function readOperator(file) {
  file = operatorConfigPath(file);
  const bytes = regular(file);
  return { configPath: realpathSync(file), sourceHash: hash(bytes), raw: JSON.parse(bytes) };
}

function trusted(file, directory = false) {
  const stat = lstatSync(file);
  assert(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()) && realpathSync(file) === file, 'Bound bridge trusted path changed: ' + file);
}

function state(config, configHash) {
  trusted(config.stateRoot, true);
  const marker = JSON.parse(regular(join(config.stateRoot, 'bridge.json')));
  assert(marker.kind === 'forge-bot-bridge-v1' && marker.configHash === configHash, 'Bridge root does not match bound operator configuration');
  trusted(config.forgeRoot, true); trusted(config.forgeEntry); trusted(config.nodeBinary);
  for (const template of Object.values(config.workspaces)) { trusted(template.worktree, true); trusted(template.runtime.binary); }
}

export async function prepareBridge(paths, marker, requested, writeMarker, localFile) {
  if (marker.bridge) return inspectBridge(paths, marker, requested);
  if (requested === undefined) return null;
  assert(marker.state !== 'ready', 'Enabling the Forge bridge requires a new Bot root; this ready root has no bound bridge');
  const source = readOperator(requested);
  const native = runtime();
  const { validateConfig, initializeBridge, createBridge } = await import(pathToFileURL(join(dirname(native.entry), 'bridge.mjs')).href);
  const config = validateConfig(source.raw);
  const configHash = fingerprint(config);
  const patch = [{ insert: [{ id: 'forge-bot-bridge', name: native.entry, config }] }];
  const bytes = JSON.stringify(patch, null, 2) + '\n';
  const profilePatch = join(paths.profileDir, 'cordis.patch.yml');
  localFile(paths, profilePatch);
  const base = JSON.parse(regular(profilePatch));
  const expected = [{ id: 'bot', config: { home: paths.team, workspace: paths.workspace, memory: true, updateCheck: false } }];
  assert(JSON.stringify(base) === JSON.stringify(expected), 'Forge bridge requires the original managed Bot profile patch');
  const profileBytes = JSON.stringify([...base, ...patch], null, 2) + '\n';
  localFile(paths, paths.bridgePatch);
  assert(!existsSync(paths.bridgePatch), 'Unbound bridge patch already exists; use a fresh Bot root');
  // Existing roots are accepted only by the native bridge's exact marker check,
  // never by directory existence alone (supports the legacy explicit setup).
  if (!existsSync(config.stateRoot)) initializeBridge(config);
  createBridge(config);
  writeFileSync(paths.bridgePatch, bytes, { flag: 'wx', mode: 0o600 });
  writeFileSync(profilePatch, profileBytes, { mode: 0o600 });
  marker.bridge = { schema: 1, configPath: source.configPath, sourceHash: source.sourceHash, configHash, ...native, patchHash: hash(bytes), profilePatchHash: hash(profileBytes) };
  writeMarker(marker);
  return inspectBridge(paths, marker, requested);
}

export function inspectBridge(paths, marker, requested) {
  const binding = marker.bridge;
  if (!binding) {
    assert(requested === undefined, 'Forge bridge is not prepared; use prepare --forge-config with a new Bot root');
    assert(!lstatSync(paths.bridgePatch, { throwIfNoEntry: false }), 'Unbound bridge patch is forbidden');
    return null;
  }
  assert(binding.schema === 1, 'Unsupported bridge binding');
  const source = readOperator(binding.configPath);
  if (requested !== undefined) assert(readOperator(requested).configPath === binding.configPath, 'Forge bridge is bound to another operator config path');
  assert(source.configPath === binding.configPath && source.sourceHash === binding.sourceHash, 'Operator bridge config drifted; use a new Bot root');
  const native = boundRuntime(binding);
  const bytes = regular(paths.bridgePatch);
  assert(hash(bytes) === binding.patchHash, 'Managed bridge patch drifted; use a new Bot root');
  assert(hash(regular(join(paths.profileDir, 'cordis.patch.yml'))) === binding.profilePatchHash, 'Managed Bot profile patch drifted; use a new Bot root');
  const patch = JSON.parse(bytes);
  assert(Array.isArray(patch) && patch.length === 1 && patch[0].insert?.length === 1, 'Invalid managed bridge patch');
  const row = patch[0].insert[0];
  assert(row.id === 'forge-bot-bridge' && row.name === native.entry && fingerprint(row.config) === binding.configHash, 'Managed bridge patch does not match binding');
  state(row.config, binding.configHash);
  return { config: row.config, patch: paths.bridgePatch, binding };
}

export function bridgeReport(bridge) {
  return bridge ? {
    enabled: true, configPath: bridge.binding.configPath, sourceHash: bridge.binding.sourceHash,
    configHash: bridge.binding.configHash, entry: bridge.binding.entry, files: bridge.binding.files,
    patch: bridge.patch, patchHash: bridge.binding.patchHash, profilePatchHash: bridge.binding.profilePatchHash, stateRoot: bridge.config.stateRoot,
    allowPrepare: bridge.config.allowPrepare, workspaces: Object.keys(bridge.config.workspaces),
    tools: ['forge_status', 'forge_prepare'],
  } : { enabled: false };
}
