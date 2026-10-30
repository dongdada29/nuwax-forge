#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const config = JSON.parse(readFileSync(new URL('../installation.json', import.meta.url), 'utf8'));
const env = { ...process.env }; delete env.NUWAX_DEVKIT_RESOLVE_ROOT;
const p = spawnSync(process.execPath, [config.cli, ...process.argv.slice(2)], { stdio: 'inherit', env });
if (p.error) console.error(p.error.message);
process.exit(p.status ?? 1);
