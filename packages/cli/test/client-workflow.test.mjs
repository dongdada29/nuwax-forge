import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const runtime = fileURLToPath(new URL('../lib/client_workflow/test_workflow.py', import.meta.url));
const bin = fileURLToPath(new URL('../bin/nuwax-devkit.mjs', import.meta.url));
test('client-workflow strict flags and commands', () => {
  for (const args of [['client-workflow','--prompt','bad'],['client-workflow','pair'],['client-workflow']]) {
    const p=spawnSync(process.execPath,[bin,...args],{encoding:'utf8'}); assert.equal(p.status,2,p.stderr);
  }
});
test('client-workflow offline budget/path/seal counterexamples and real process supervisor', () => {
  const p=spawnSync('python3',['-B',runtime],{encoding:'utf8',timeout:45000}); assert.equal(p.status,0,p.stdout+p.stderr);
});
