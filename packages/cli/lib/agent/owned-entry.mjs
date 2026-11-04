#!/usr/bin/env node
// Explicit embedding entry for an outer supervisor which owns this POSIX group.
// Ordinary `agent run` retains its independent process group and public contract.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run } from './index.mjs';

function ownedState(argv) {
  if (process.platform === 'win32') throw Error('Owned Forge execution requires a POSIX process group');
  if (argv.length !== 1 || !path.isAbsolute(argv[0]) || /[\x00-\x1f]/.test(argv[0])) throw Error('Expected exactly one absolute Forge state directory');
  const group = spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8', timeout: 2000 });
  if (group.error || group.status !== 0 || Number(group.stdout.trim()) !== process.pid) {
    throw Error('Outer supervisor must launch this entry as the leader of its owned process group');
  }
  return argv[0];
}

try {
  const state = ownedState(process.argv.slice(2));
  const result = await run(state, { detached: false });
  process.stdout.write(JSON.stringify({ ...result, state,
    processOwnership: { mode: 'inherited-posix-group', ownerPid: process.pid, processGroupId: process.pid } }) + '\n');
  process.exitCode = result.status === 'blocked' ? 3 : result.status === 'failed' ? 1 : 0;
} catch (error) {
  process.stderr.write('Owned Forge run rejected: ' + error.message + '\n');
  process.exitCode = 2;
}
