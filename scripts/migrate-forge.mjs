#!/usr/bin/env node
// Transactional bridge: keep legacy release/state format untouched and recover registrations.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { safePath, verifyBundle, read, write, snapshot, restore } from './bundle-lib.mjs';
const own = path.dirname(fileURLToPath(import.meta.url));
const opts = {};
try {
  const args = process.argv.slice(2);
  for (let i=0;i<args.length;i+=2) {
    if (!['--restore','--legacy-bundle','--legacy-root','--root','--host','--host-root','--workspace','--backup','--bin-dir','--disable-skill'].includes(args[i]) || !args[i+1] || opts[args[i]]) throw Error('Invalid migration arguments');
    opts[args[i]]=args[i+1];
  }
  if (opts['--restore']) { recover(safePath(opts['--restore'])); }
  else migrate();
} catch (e) { console.error(e.message); process.exitCode=1; }
function run(bundle,args) {
  const p=spawnSync(process.execPath,[path.join(bundle,'install.mjs'),...args],{encoding:'utf8',timeout:60000});
  if(p.status!==0) throw Error(p.stderr||p.stdout||'installer failed');
  return JSON.parse(p.stdout);
}
function recover(backup) {
  const m=read(path.join(backup,'migration.json'));
  const current=path.join(m.root,'managed.json');
  if(fs.existsSync(current) && read(current).active) run(own,['uninstall','--root',m.root]);
  for(const t of m.targets) restore(t.path,t.kind,t.content);
  restore(path.join(m.legacyRoot,'managed.json'),'file',m.legacyState);
  if(m.disabled && fs.existsSync(path.join(backup,'disabled-skill'))) {
    // rename preserves symlink identity. Refuse a new registration created meanwhile.
    if(fs.existsSync(m.disabled) || fs.lstatSync(path.dirname(m.disabled)).isSymbolicLink()) throw Error('Legacy skill path occupied');
    fs.renameSync(path.join(backup,'disabled-skill'),m.disabled);
  }
  write(path.join(backup,'restored.json'),{restored:true,at:new Date().toISOString()});
  console.log(JSON.stringify({status:'restored',backup}));
}
function migrate() {
  verifyBundle(own);
  const legacyBundle=safePath(opts['--legacy-bundle']),legacyRoot=safePath(opts['--legacy-root']),root=safePath(opts['--root']),backup=safePath(opts['--backup']);
  if(legacyRoot===root || fs.existsSync(backup) || fs.existsSync(root)) throw Error('Migration requires new root and backup');
  verifyBundle(legacyBundle);
  const s=read(path.join(legacyRoot,'managed.json'));
  if(s.owner!=='nuwax-devkit-installer-v1' || !s.active || s.root!==legacyRoot || s.host!==opts['--host']) throw Error('Invalid legacy installation');
  const targets=s.history.at(-1).targets;
  for(const t of targets) if(JSON.stringify(snapshot(t.path,t.kind))!==JSON.stringify(t.content)) throw Error('Legacy registration edited');
  // Validate the launcher conflict before removing any existing registration.
  const bin=safePath(opts['--bin-dir']);
  if(fs.existsSync(path.join(bin,'nuwax-forge'))) throw Error('Launcher already exists');
  let disabled=opts['--disable-skill'];
  if(disabled) {disabled=path.resolve(disabled);safePath(path.dirname(disabled));fs.lstatSync(disabled);}
  fs.mkdirSync(backup,{recursive:true,mode:0o700});
  write(path.join(backup,'migration.json'),{legacyRoot,root,legacyBundle,targets,legacyState:snapshot(path.join(legacyRoot,'managed.json'),'file'),disabled});
  try {
    run(legacyBundle,['uninstall','--root',legacyRoot]);
    if(disabled) fs.renameSync(disabled,path.join(backup,'disabled-skill'));
    const args=['install','--host',s.host,'--root',root,'--bin-dir',bin];
    for(const key of ['--host-root','--workspace']) if(opts[key]) args.push(key,opts[key]);
    const installed=run(own,args);
    write(path.join(backup,'installed.json'),installed);
    console.log(JSON.stringify({status:'migrated',backup,...installed}));
  } catch(e) {recover(backup);throw e;}
}
