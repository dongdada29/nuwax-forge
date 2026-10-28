import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = dirname(fileURLToPath(import.meta.url)) + '/..';
const cli = args => spawnSync(process.execPath, [join(KIT, 'cli.mjs'), ...args], { encoding: 'utf8' });

test('evals.mjs 对临时安装目录全绿', () => {
  const d = mkdtempSync(join(tmpdir(), 'sdlk-'));
  // evals 是 full 面引擎件（slim 不装 plan-gate/evals），用 full 档安装后灌事件
  assert.equal(cli(['init', '--dir', d, '--profile', 'full']).status, 0);
  const r = spawnSync(process.execPath, [join(KIT, 'kit/engine/evals.mjs'), '--dir', d], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /全部 eval 通过/);
  rmSync(d, { recursive: true, force: true });
});
