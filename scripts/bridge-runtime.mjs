import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// The integration remains the source of truth. Both distribution paths carry
// this same closed set, without introducing another installed workspace package.
export const BRIDGE_RUNTIME_FILES = Object.freeze([
  'package.json', 'index.mjs', 'bridge.mjs', 'projection.mjs',
  'locale/en.json', 'locale/zh.json', 'icon.svg',
]);

function regular(root, relative) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) throw Error('Invalid package resource path');
  let file = root;
  for (const part of relative.split('/')) {
    file = path.join(file, part);
    if (fs.lstatSync(file).isSymbolicLink()) throw Error('Package resource must not be a symlink');
  }
  if (!fs.statSync(file).isFile()) throw Error('Package resource must be a regular file');
  return file;
}

export function copyBridgeRuntime(repository, destination) {
  const source = path.join(repository, 'integrations', 'ds-bot-forge');
  if (fs.lstatSync(source).isSymbolicLink() || !fs.statSync(source).isDirectory()) throw Error('Invalid bridge source directory');
  const entries = BRIDGE_RUNTIME_FILES.map(relative => [relative, regular(source, relative)]);
  const pkg = JSON.parse(fs.readFileSync(entries[0][1], 'utf8'));
  if (pkg.name !== '@nuwax-ai/ds-bot-forge-bridge' || pkg.type !== 'module') throw Error('Unexpected bridge package identity');
  if (fs.existsSync(destination)) throw Error('Bridge runtime destination must be new');
  for (const [relative, from] of entries) {
    const to = path.join(destination, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(to, fs.statSync(from).mode & 0o777);
  }
}

// Ask npm for its ordinary CLI package file list, then pack an isolated staging
// directory with the integration added. Never generate files in the checkout.
export function stageCliPackage(repository) {
  const cli = path.join(repository, 'packages', 'cli');
  const listing = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--offline'],
    { cwd: cli, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30000 });
  if (listing.error || listing.status !== 0) throw Error('Cannot determine CLI package resources');
  const packages = JSON.parse(listing.stdout);
  if (packages.length !== 1 || packages[0].name !== '@nuwax-ai/devkit-cli' || !Array.isArray(packages[0].files)) throw Error('Unexpected CLI package file list');
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'forge-cli-package-'));
  try {
    for (const { path: relative } of packages[0].files) {
      const from = regular(cli, relative);
      const to = path.join(directory, relative);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(to, fs.statSync(from).mode & 0o777);
    }
    copyBridgeRuntime(repository, path.join(directory, 'lib', 'bots', 'bridge-runtime'));
    return { directory, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
