#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skill = fileURLToPath(new URL('../', import.meta.url));
try {
  const config = JSON.parse(readFileSync(new URL('../installation.json', import.meta.url), 'utf8'));
  let cli;
  if (config.schemaVersion === 1 && typeof config.cli === 'string') {
    // Read old managed registrations until their next installer upgrade.
    cli = config.cli;
  } else if (config.schemaVersion === 2 && config.command === 'nuwax-forge') {
    if (config.runtimeRoot !== undefined) {
      if (typeof config.runtimeRoot !== 'string' || !config.runtimeRoot ||
          path.posix.isAbsolute(config.runtimeRoot) || path.win32.isAbsolute(config.runtimeRoot) ||
          /[\r\n\0]/.test(config.runtimeRoot)) throw Error('runtimeRoot must be a relative installation binding');
      const root = path.resolve(skill, config.runtimeRoot);
      const state = JSON.parse(readFileSync(path.join(root, 'managed.json'), 'utf8'));
      const id = state.history?.at(-1)?.id;
      if (state.owner !== 'nuwax-forge-installer-v1' || !state.active ||
          typeof id !== 'string' || !/^[\w.-]{1,200}$/.test(id) || ['.', '..'].includes(id)) {
        throw Error('No active managed Forge installation');
      }
      cli = path.join(root, 'versions', id, 'node_modules', '@nuwax-ai', 'devkit-cli', 'bin', 'nuwax-forge.mjs');
    } else {
      // A complete release is relocatable; a standalone shared Skill uses PATH.
      const bundled = path.resolve(skill, '../node_modules/@nuwax-ai/devkit-cli/bin/nuwax-forge.mjs');
      if (existsSync(bundled)) cli = bundled;
    }
  } else throw Error('Unsupported Forge installation descriptor');
  if (cli && !existsSync(cli)) throw Error('Managed Forge CLI is missing; repair the installation');
  if (!cli && process.env.NUWAX_FORGE_SKILL_ENTRY === '1') throw Error('Forge launcher resolves to the Skill itself');
  const env = { ...process.env, NUWAX_FORGE_SKILL_ENTRY: '1' };
  delete env.NUWAX_DEVKIT_RESOLVE_ROOT;
  const p = spawnSync(cli ? process.execPath : config.command,
    [...(cli ? [cli] : []), ...process.argv.slice(2)], { stdio: 'inherit', env });
  if (p.error) console.error(`Forge launcher unavailable: ${p.error.message}`);
  process.exit(p.status ?? 1);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
