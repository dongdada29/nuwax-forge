import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/nuwax-forge.mjs', import.meta.url));
const entry = fileURLToPath(new URL('../lib/agent/owned-entry.mjs', import.meta.url));
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
function fixture(t, hang = false) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'forge-owned-agent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const worktree = path.join(root, 'workspace'); fs.mkdirSync(worktree);
  assert.equal(spawnSync('git', ['init', '-q', worktree]).status, 0);
  const marker = path.join(root, 'runtime.json'), binary = path.join(root, 'fixture.mjs');
  fs.writeFileSync(binary, `#!${process.execPath}\nimport fs from 'node:fs';import {spawn,spawnSync} from 'node:child_process';
const args=process.argv.slice(2);
if(args.includes('--version')){console.log('codex-fixture');process.exit(0)}
if(args.includes('--help')){console.log('--json --ephemeral --ignore-user-config --ignore-rules --sandbox --cd');process.exit(0)}
const child=${hang ? "spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})" : 'null'};
fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,group:Number(spawnSync('ps',['-o','pgid=','-p',String(process.pid)],{encoding:'utf8'}).stdout.trim()),child:child?.pid??null}));
for await(const chunk of process.stdin){}
${hang ? 'setInterval(()=>{},1000);' : `for(const e of [{type:'thread.started',thread_id:'owned-fixture'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:'fixture result'}},{type:'turn.completed',usage:{input_tokens:100,output_tokens:10,cached_input_tokens:80}}])console.log(JSON.stringify(e));`}
`, { mode: 0o700 });
  const state = path.join(root, 'state'), brief = path.join(root, 'brief.txt'), spec = path.join(root, 'spec.json');
  fs.writeFileSync(brief, 'Deterministic marker only.');
  fs.writeFileSync(spec, JSON.stringify({schemaVersion:1,taskKey:'owned-fixture',worktree,
    runtime:{kind:'codex',binary,model:'fixture-model',contextMode:'fresh-exec'},permissions:{mode:'read-only'},
    budget:{maxTokens:20000,maxWallSeconds:hang?30:5,maxAttempts:1},
    budgetSpec:{schemaVersion:1,id:'owned-fixture',mode:'model',taskKind:'text-implementation',model:{name:'fixture-model'},expectedCalls:1,initialContextTokens:1000,perCallOutputTokens:10,budgetTokens:20000}}));
  const prepared = spawnSync(process.execPath,[cli,'agent','prepare','--spec',spec,'--brief-file',brief,'--state',state],{encoding:'utf8',timeout:15000});
  assert.equal(prepared.status,0,prepared.stderr);
  return {root,state,marker};
}
function liveGroup(group) {
  const ps=spawnSync('ps',['-axo','pgid=,stat='],{encoding:'utf8',timeout:2000});
  assert.equal(ps.status,0,ps.stderr);
  return ps.stdout.split('\n').some(row=>{const [id,status]=row.trim().split(/\s+/);return Number(id)===group && !status?.includes('Z');});
}

test('inherited entry rejects an unowned process group before claiming or dispatching', {skip:process.platform==='win32'}, t=>{
  const f=fixture(t);
  const result=spawnSync(process.execPath,[entry,f.state],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,2); assert.match(result.stderr,/leader/);
  assert.equal(fs.existsSync(path.join(f.state,'run.claim')),false);
  assert.equal(fs.existsSync(f.marker),false);
});

test('owned marker run inherits the outer group and retains one-shot/budget evidence', {skip:process.platform==='win32'}, t=>{
  const f=fixture(t);
  const result=spawnSync(process.execPath,[entry,f.state],{detached:true,encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);
  const out=JSON.parse(result.stdout), marker=read(f.marker);
  assert.equal(out.status,'completed'); assert.equal(out.chargedTokens,110); assert.equal(out.acceptancePassed,null);
  assert.equal(marker.group,out.processOwnership.ownerPid); assert.notEqual(marker.pid,marker.group);
  assert.equal(liveGroup(marker.group),false);
  const again=spawnSync(process.execPath,[entry,f.state],{detached:true,encoding:'utf8',timeout:5000});
  assert.equal(again.status,2); assert.equal(read(f.marker).pid,marker.pid);
});

test('outer group SIGKILL stops marker descendants; reconciliation cannot dispatch again', {skip:process.platform==='win32'}, async t=>{
  const f=fixture(t,true), owner=spawn(process.execPath,[entry,f.state],{detached:true,stdio:'ignore'});
  t.after(()=>{try{process.kill(-owner.pid,'SIGKILL')}catch{}});
  const closed=new Promise(resolve=>owner.once('close',resolve));
  const deadline=Date.now()+10000;
  while(!fs.existsSync(f.marker)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(fs.existsSync(f.marker),true,'runtime must actually start');
  const marker=read(f.marker); assert.equal(marker.group,owner.pid); assert.ok(marker.child);
  process.kill(-owner.pid,'SIGKILL'); await closed;
  const stopped=Date.now()+2000;
  while(liveGroup(owner.pid)&&Date.now()<stopped)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(liveGroup(owner.pid),false);
  assert.equal(fs.existsSync(path.join(f.state,'run.claim')),true);
  const result=spawnSync(process.execPath,[cli,'agent','reconcile','--state',f.state],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,1,result.stderr);
  const out=JSON.parse(result.stdout); assert.equal(out.usageKnown,false); assert.equal(out.chargedTokens,null);
  assert.equal(read(f.marker).pid,marker.pid);
  const again=spawnSync(process.execPath,[entry,f.state],{detached:true,encoding:'utf8',timeout:5000});
  assert.equal(again.status,2); assert.equal(read(f.marker).pid,marker.pid);
});
