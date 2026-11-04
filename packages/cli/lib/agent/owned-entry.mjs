#!/usr/bin/env node
// Explicit embedding entry for an outer supervisor which owns this POSIX group.
// Ordinary `agent run` retains its independent process group and public contract.
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { run } from './index.mjs';
import { readBoundedJson } from '../budget/execution.mjs';

function ownedState(argv) {
  if (process.platform === 'win32') throw Error('Owned Forge execution requires a POSIX process group');
  if (argv.length !== 1 || !path.isAbsolute(argv[0]) || /[\x00-\x1f]/.test(argv[0])) throw Error('Expected exactly one absolute Forge state directory');
  const group = spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8', timeout: 2000 });
  if (group.error || group.status !== 0) throw Error('Cannot inspect the owned process group');
  const pgid = Number(group.stdout.trim());
  if (pgid === process.pid) return { state: argv[0], ownerPid: process.pid };
  // PA durably registers a group-leader wrapper before releasing its startup
  // gate. Its actual Forge command is a child, not the leader itself.
  const proofPath = path.join(argv[0], 'outer-owner.json');
  if (pgid !== process.ppid || !fs.existsSync(proofPath) || fs.lstatSync(proofPath).isSymbolicLink()) {
    throw Error('Outer supervisor must register the group leader before starting this entry');
  }
  const record = readBoundedJson(proofPath), request = readBoundedJson(path.join(argv[0], 'request.json'));
  if (record.kind !== 'personal-agent-process-owner-v1' || record.status !== 'active'
      || record.pid !== process.ppid || record.pgid !== pgid || record.taskKey !== request.taskKey
      || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(record.id ?? '')
      || typeof record.wrapperPath !== 'string' || !path.isAbsolute(record.wrapperPath)
      || fs.realpathSync(record.wrapperPath) !== record.wrapperPath) throw Error('Invalid outer process ownership binding');
  const parent = spawnSync('ps', ['-ww', '-p', String(record.pid), '-o', 'pid=', '-o', 'pgid=', '-o', 'command='],
    { encoding: 'utf8', timeout: 2000, maxBuffer: 8192 });
  const row = /^\s*(\d+)\s+(\d+)\s+([^\r\n]+)\s*$/u.exec(parent.stdout ?? '');
  if (parent.error || parent.status !== 0 || !row || Number(row[1]) !== record.pid || Number(row[2]) !== record.pgid
      || row[3].trim() !== `${process.execPath} ${record.wrapperPath} --personal-agent-owner=${record.id}`) {
    throw Error('Outer process owner identity cannot be verified');
  }
  return { state: argv[0], ownerPid: record.pid };
}

try {
  const { state, ownerPid } = ownedState(process.argv.slice(2));
  const result = await run(state, { detached: false });
  process.stdout.write(JSON.stringify({ ...result, state,
    processOwnership: { mode: 'inherited-posix-group', ownerPid, processGroupId: ownerPid, entryPid: process.pid } }) + '\n');
  process.exitCode = result.status === 'blocked' ? 3 : result.status === 'failed' ? 1 : 0;
} catch (error) {
  process.stderr.write('Owned Forge run rejected: ' + error.message + '\n');
  process.exitCode = 2;
}
