#!/usr/bin/env node
// Fresh-instance authorization preflight. Never sends a message, adds a provider,
// imports credentials or prints native launch output. Real model acceptance is separate.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareBot, startBot } from '../packages/cli/lib/bots/profile.mjs';

export function parsePreflightArgs(argv) {
  if (!argv.length || argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = new Map([['--dsh', 'binary'], ['--tarball', 'tarball']]).get(argv[i]);
    if (!key || options[key] || !argv[i + 1] || !isAbsolute(argv[i + 1])) throw new Error('Expected distinct --dsh and --tarball absolute paths');
    options[key] = argv[i + 1];
  }
  if (!options.binary || !options.tarball) throw new Error('Both --dsh and --tarball are required');
  return options;
}

// Whitelist booleans/counts; never serialize an API object or a provider error.
export function summarizeAuthorization(state, providers) {
  if (!Array.isArray(state?.bots) || !Array.isArray(state?.models) || providers?.available !== true || !Array.isArray(providers.providers)) {
    throw new Error('Native authorization metadata unavailable');
  }
  if (!state.bots.length || !state.bots.every(bot => typeof bot.waiting === 'boolean') ||
      !state.models.every(model => typeof model.ref === 'string' && (model.needsKey === undefined || typeof model.needsKey === 'boolean'))) {
    throw new Error('Unexpected native Bot metadata');
  }
  const routesWithoutNeedsKeyFlag = state.models.filter(model => model.needsKey !== true).length;
  return {
    authorization: 'not-validated',
    modelSetup: routesWithoutNeedsKeyFlag === 0 ? 'no-usable-route-reported' : 'route-reported-usable-not-exercised',
    botCount: state.bots.length,
    allBotsWaiting: state.bots.every(bot => bot.waiting),
    selectedBotModelCount: state.bots.filter(bot => typeof bot.model === 'string').length,
    catalogModelCount: state.models.length,
    routesWithoutNeedsKeyFlag,
    catalogSufficesForAuthorization: false,
    configuredProviderKeyCount: providers.providers.filter(provider => provider.key?.configured === true).length,
    providerSetupAvailable: true,
    modelMessagesSent: 0,
    realModelAcceptance: 'not-run',
    billingUsage: 'unknown',
  };
}

export function summarizeAccountState(envelope, rpcId) {
  const status = envelope?.result?.value?.status;
  if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId || envelope.result?.ok !== true || !['signed-out', 'credential-stored'].includes(status)) {
    return { accountMetadata: 'unavailable', accountGrantStored: null };
  }
  return { accountMetadata: 'available', accountStatus: status, accountGrantStored: status === 'credential-stored' };
}

export async function preflight(options, { signal } = {}) {
  signal?.throwIfAborted();
  const requestSignal = () => signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
  const parent = mkdtempSync(join(tmpdir(), 'forge-bot-real-preflight-'));
  const root = join(parent, 'fresh-team');
  let child; let closed; let output = ''; let processError;
  let stage = 'prepare';
  try {
    const prepared = await prepareBot({ ...options, root });
    signal?.throwIfAborted();
    stage = 'start';
    child = startBot({ ...options, root }, ['ignore', 'pipe', 'pipe']);
    closed = new Promise(resolve => { child.once('close', resolve); child.once('error', resolve); });
    child.once('error', error => { processError = error; });
    const capture = chunk => { output = (output + chunk).slice(-1024 * 1024); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    let launch;
    for (let n = 0; n < 200; n++) {
      signal?.throwIfAborted();
      launch = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
      if (launch || processError || child.exitCode !== null) break;
      await delay(100);
    }
    if (!launch || processError) throw new Error('Native launch unavailable');
    stage = 'authenticate';
    const origin = new URL(launch).origin;
    const login = await fetch(launch, { redirect: 'manual', signal: requestSignal() });
    if (login.status !== 303) throw new Error('Native login refused');
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    if (!cookie) throw new Error('Native login cookie missing');
    output = ''; launch = undefined;
    const api = async endpoint => {
      const response = await fetch(origin + '/api/bot', {
        method: 'POST', headers: { 'content-type': 'application/json', origin, cookie },
        body: JSON.stringify({ endpoint }), signal: requestSignal(),
      });
      if (response.status !== 200) throw new Error('Native metadata refused');
      const result = await response.json();
      if (result.ok !== true) throw new Error('Native metadata unavailable');
      return result.value;
    };
    stage = 'inspect';
    const state = await api('state');
    const providers = await api('providers');
    stage = 'account-metadata';
    const rpcId = 'bot-preflight-account-state';
    const accountResponse = await fetch(origin + '/api/account/getState', {
      method: 'POST', headers: { 'content-type': 'application/json', origin, cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'account/getState', payload: { args: {} } }),
      signal: requestSignal(),
    });
    const account = accountResponse.status === 200
      ? summarizeAccountState(await accountResponse.json(), rpcId)
      : { accountMetadata: 'unavailable', accountGrantStored: null };
    return {
      kind: 'forge-bot-real-preflight', dshVersion: prepared.dshVersion,
      botVersion: prepared.pin.version, freshRoot: true,
      ...summarizeAuthorization(state, providers),
      ...account,
    };
  } catch {
    // Never expose a raw provider/host error, config, credential or launch URL.
    throw new Error('Real Bot preflight failed at ' + stage);
  } finally {
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 8000); timer.unref();
      await closed; clearTimeout(timer);
    }
    output = '';
    rmSync(parent, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parsePreflightArgs(argv);
  if (options.help) {
    process.stdout.write('Usage: node scripts/bot-real-preflight.mjs --dsh <absolute-dsh> --tarball <absolute-original-tgz>\nFresh isolated root; metadata only; no model messages. Temporary instance is removed on exit.\n');
    return;
  }
  const controller = new AbortController();
  const interrupt = () => { process.exitCode = 130; controller.abort(); };
  const terminate = () => { process.exitCode = 143; controller.abort(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    process.stdout.write(JSON.stringify(await preflight(options, { signal: controller.signal }), null, 2) + '\n');
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode ||= 1; });
}
