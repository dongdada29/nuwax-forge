#!/usr/bin/env node
// Explicit macOS default-browser acceptance. No providers, messages or models
// are configured. Native tokens/cookies stay in memory and never enter reports.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareBot } from '../packages/cli/lib/bots/profile.mjs';

const cli = fileURLToPath(new URL('../packages/cli/bin/nuwax-forge.mjs', import.meta.url));

export function parseOptions(argv) {
  const options = {}; const known = new Set(['root', 'dsh', 'tarball', 'output']);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--open' && !options.open) { options.open = true; continue; }
    const key = argv[i].slice(2);
    if (!argv[i].startsWith('--') || !known.has(key) || options[key]) throw new Error('Unknown or duplicate argument');
    const value = argv[++i];
    if (!value || !isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error('Paths must be explicit absolute paths');
    options[key] = value;
  }
  if (!options.open || [...known].some(key => !options[key])) throw new Error('Usage: node scripts/bot-real-ui-acceptance.mjs --open --root <new-directory> --dsh <binary> --tarball <original.tgz> --output <new.json>');
  return options;
}

export function summarizeState(state) {
  return {
    modelCatalogCount: state.models.length,
    modelsWithoutNeedsKeyFlag: state.models.filter(model => model.needsKey !== true).length,
    botCount: state.bots.length,
    allBotsWaitingWithoutModel: state.bots.every(bot => bot.waiting && !bot.model),
    // Catalog flags are not proof of authentication or provider-side validity.
    providerAuthorization: 'not-proven',
  };
}

async function start(options, open) {
  const args = [cli, 'bots', 'run', '--root', options.root, '--dsh', options.dsh, ...(open ? ['--open'] : [])];
  // This macOS-only probe owns a separate process group, including native DSH.
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true });
  let output = ''; let failed = false;
  child.on('error', () => { failed = true; });
  const append = chunk => { output = (output + chunk).slice(-131072); };
  child.stdout.on('data', append); child.stderr.on('data', append);
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const signalGroup = signal => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, signal); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw new Error('Owned process-group cleanup failed'); }
  };
  const stop = async () => {
    signalGroup('SIGINT');
    const deadline = Date.now() + 8000;
    while (signalGroup(0) && Date.now() < deadline) await delay(50);
    const forcedKill = signalGroup(0) ? signalGroup('SIGKILL') : false;
    const exit = await closed; output = '';
    for (let n = 0; n < 20 && signalGroup(0); n++) await delay(50);
    return { ...exit, forcedKill, processGroupExited: !signalGroup(0), lockReleased: !existsSync(join(options.root, '.forge-bots-lock')) };
  };
  try {
    let url;
    for (let n = 0; n < 150; n++) {
      url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
      if (url || failed || child.exitCode !== null) break;
      await delay(100);
    }
    if (!url) throw new Error('Native host did not announce a launch URL');
    const origin = new URL(url).origin;
    const auth = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if (auth.status !== 303) throw new Error('Native authentication did not redirect');
    const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const state = async () => {
      const response = await fetch(origin + '/api/bot', { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'state' }), signal: AbortSignal.timeout(10000) });
      const body = await response.json();
      if (!body.ok) throw new Error('Native state request failed');
      return summarizeState(body.value);
    };
    return { origin, state, stop };
  } catch (error) { await stop(); throw error; }
}

async function observeDefaultTab(origin) {
  // Only metadata for this new host is returned; no user page body is read.
  const source = `const task=await taskSpace(${JSON.stringify('Forge Bot opener ' + origin)});
let matches=[];
try {
  for(let n=0;n<40;n++) {
    matches=(await task.cdp('Target.getTargets')).targetInfos.filter(t=>t.url===${JSON.stringify(origin + '/')}&&/DeepSeek Harness/.test(t.title));
    if(matches.length) break;
    await new Promise(r=>setTimeout(r,250));
  }
  console.log('FORGE_RESULT:'+JSON.stringify({tabObserved:matches.length===1,title:matches.length===1?matches[0].title:null,exactOrigin:matches.length===1,tokenInAddress:matches.length===1?false:null}));
  for(const tab of matches) await task.cdp('Target.closeTarget',{targetId:tab.targetId});
} finally { await task.finish({keep:[]}); }`;
  const result = spawnSync('ego-browser', ['nodejs'], { input: source, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024, shell: false });
  if (result.status !== 0) throw new Error('Default-browser observation failed; raw output withheld');
  const line = result.stdout.split('\n').find(value => value.startsWith('FORGE_RESULT:'));
  if (!line) throw new Error('No browser observation receipt');
  return JSON.parse(line.slice('FORGE_RESULT:'.length));
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (process.platform !== 'darwin') throw new Error('This acceptance script currently supports macOS only');
  if (existsSync(options.root) || existsSync(options.output)) throw new Error('Root and output must be new; existing data is never adopted');
  const app = spawnSync('osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("http://127.0.0.1")).path.js'], { encoding: 'utf8', shell: false });
  if (app.status !== 0 || !app.stdout.trim().endsWith('/ego lite.app')) throw new Error('Default browser is not ego lite; use native UI observation on this machine');
  const report = { schema: 1, root: options.root, defaultBrowser: app.stdout.trim(), realPublicCommand: 'nuwax-forge bots run --open', userMessagesSent: 0, modelCallsRequestedByScript: 0, nativeAutomaticModelActivity: 'not-audited', credentialValuesRead: false, layoutAcceptance: 'separate-manual-screenshots', baseline: null, afterOpen: null, browser: null, shutdown: null };
  let host; let stage = 'prepare';
  try {
    await prepareBot({ root: options.root, binary: options.dsh, tarball: options.tarball });
    stage = 'baseline-start';
    host = await start(options, false);
    stage = 'baseline-state';
    report.baseline = await host.state();
    report.baseline.credentialFileExists = existsSync(join(options.root, 'dsh', '.credentials.yaml'));
    stage = 'empty-model-gate';
    if (report.baseline.modelCatalogCount || !report.baseline.allBotsWaitingWithoutModel) throw new Error('Stop: baseline is not an empty-model team');
    stage = 'baseline-shutdown';
    report.baselineShutdown = await host.stop(); host = null;
    if (!report.baselineShutdown.lockReleased || !report.baselineShutdown.processGroupExited) throw new Error('Baseline host did not stop cleanly');
    stage = 'open-start';
    host = await start(options, true);
    stage = 'browser-observation';
    report.browser = await observeDefaultTab(host.origin);
    stage = 'post-open-state';
    report.afterOpen = await host.state();
    report.afterOpen.credentialFileExists = existsSync(join(options.root, 'dsh', '.credentials.yaml'));
    report.status = report.browser.tabObserved ? 'browser-open-observed' : 'browser-not-observed';
    report.catalogChanged = report.afterOpen.modelCatalogCount !== report.baseline.modelCatalogCount;
    report.catalogChangeCause = report.catalogChanged ? 'unknown' : 'not-applicable';
  } catch {
    report.status = 'incomplete'; report.error = 'ACCEPTANCE_STAGE_FAILED'; report.failedStage = stage;
  } finally {
    if (host) {
      try { report.shutdown = await host.stop(); }
      catch { report.status = 'incomplete'; report.error = 'OWNED_GROUP_CLEANUP_FAILED'; }
    }
    writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.status !== 'browser-open-observed' || !report.shutdown?.lockReleased || !report.shutdown?.processGroupExited) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { process.stderr.write('Bot browser acceptance could not start; verify explicit paths and prerequisites.\n'); process.exitCode = 1; });
