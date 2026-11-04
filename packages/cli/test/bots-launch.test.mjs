import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBotArgs } from '../lib/bots/entry.mjs';
import { browserCommand, runBotForeground } from '../lib/bots/launch.mjs';
import { prepareBot, startBot } from '../lib/bots/profile.mjs';

const url = 'http://127.0.0.1:3081/?token=test-only-token';
const args = ['--root', '/tmp/forge-launch-test', '--dsh', '/explicit/dsh'];

test('public bots command shares the standalone strict parser and read-only plan', () => {
  const cli = fileURLToPath(new URL('../bin/nuwax-forge.mjs', import.meta.url));
  const run = argv => spawnSync(process.execPath, [cli, ...argv], { encoding: 'utf8' });
  const planned = run(['bots', 'plan', ...args, '--json']);
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(JSON.parse(planned.stdout).pin.name, 'ds-bot');
  assert.match(run(['help']).stdout, /nuwax-forge bots/);
  assert.match(run(['bots', '--help']).stdout, /--open/);
  for (const argv of [['bots', 'run', ...args, '--root', '/other'], ['bots', 'check', ...args, '--open'], ['bots', 'unknown'], ['bots', 'run', ...args, '--open', '--json']]) {
    assert.equal(run(argv).status, 2);
  }
});

function fixture(open, opener = async () => {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const kills = []; child.kill = signal => kills.push(signal);
  const signals = new EventEmitter(); const output = []; const errors = [];
  let stdio;
  const running = runBotForeground({ open }, {
    start: (_options, value) => { stdio = value; return child; },
    openBrowser: opener, signals,
    stdout: { write: chunk => output.push(String(chunk)) }, stderr: { write: chunk => errors.push(String(chunk)) },
  });
  return { child, running, signals, kills, output, errors, stdio };
}

test('browser opening requires the explicit run --open flag', () => {
  assert.equal(parseBotArgs(['run', ...args]).options.open, undefined);
  assert.equal(parseBotArgs(['run', ...args, '--open']).options.open, true);
  for (const command of ['plan', 'prepare', 'check']) assert.throws(() => parseBotArgs([command, ...args, '--open']), /only supported by run/);
  assert.throws(() => parseBotArgs(['run', ...args, '--open', '--open']), /duplicate/);
  assert.throws(() => parseBotArgs(['run', ...args, '--open', '--json']), /not supported/);
});

test('browser commands are shell-free arguments for native loopback URLs only', () => {
  assert.deepEqual(browserCommand(url, 'darwin'), ['open', [url]]);
  assert.deepEqual(browserCommand(url, 'linux'), ['xdg-open', [url]]);
  assert.deepEqual(browserCommand(url, 'win32'), ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]);
  for (const value of [url.replace('127.0.0.1', 'example.com'), url.replace('http:', 'https:'), url.replace('127.0.0.1', 'user@127.0.0.1'), url + '&next=evil', url + '#other', url.replace('/?', '/other?'), url.replace('test-only-token', 'x;echo'), 'http://127.0.0.1/?token=x']) {
    assert.throws(() => browserCommand(value));
  }
});

test('default run retains native stdio, forwards signals and cleans listeners', async () => {
  const f = fixture(false, () => assert.fail('must not open a browser'));
  assert.equal(f.stdio, 'inherit');
  f.child.stdout.write(url + '\n');
  f.signals.emit('SIGINT');
  assert.deepEqual(f.kills, ['SIGINT']);
  f.child.emit('close', null, 'SIGINT');
  assert.equal(await f.running, 130);
  assert.equal(f.signals.listenerCount('SIGINT') + f.signals.listenerCount('SIGTERM'), 0);
});

test('open waits for a complete native line, preserves output and opens once across streams', async () => {
  const opened = []; const f = fixture(true, value => opened.push(value));
  assert.deepEqual(f.stdio, ['inherit', 'pipe', 'pipe']);
  f.child.stdout.write('http://example.com/?token=no\n');
  f.child.stdout.write('\u001b[32m' + url.slice(0, -5));
  await tick(); assert.equal(opened.length, 0);
  f.child.stdout.write(url.slice(-5) + '\u001b[0m\n');
  f.child.stderr.write(url + '\n');
  await tick();
  assert.deepEqual(opened, [url]);
  assert.ok(f.output.join('').includes(url));
  f.child.emit('close', 0, null);
  assert.equal(await f.running, 0);
  assert.equal(f.child.stdout.listenerCount('data'), 0);
});

test('opener failures give a credential-free manual fallback and leave host in foreground', async () => {
  const f = fixture(true, async () => { throw new Error('do not echo ' + url); });
  f.child.stdout.write(url + '\n');
  await tick();
  assert.match(f.errors.join(''), /Open the native local link/);
  assert.ok(!f.errors.join('').includes('test-only-token'));
  assert.deepEqual(f.kills, []);
  f.signals.emit('SIGTERM');
  assert.deepEqual(f.kills, ['SIGTERM']);
  f.child.emit('close', null, 'SIGTERM');
  assert.equal(await f.running, 143);
});

test('host startup errors clean signal handlers and never open a browser', async () => {
  const f = fixture(true, () => assert.fail('must not open'));
  f.child.emit('error', new Error('host unavailable'));
  await assert.rejects(f.running, /host unavailable/);
  assert.equal(f.signals.listenerCount('SIGINT') + f.signals.listenerCount('SIGTERM'), 0);
});

test('real host emits an openable authenticated link and foreground SIGINT releases its root', { skip: !process.env.FORGE_BOT_TEST_DSH, timeout: 120000 }, async t => {
  const parent = mkdtempSync(join(tmpdir(), 'forge-bots-launch-'));
  const options = { root: join(parent, 'team'), binary: process.env.FORGE_BOT_TEST_DSH, tarball: process.env.FORGE_BOT_TEST_TARBALL, open: true };
  let child; let completed;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (completed) await completed;
    rmSync(parent, { recursive: true, force: true });
  });
  await prepareBot(options);
  const signals = new EventEmitter();
  let announce; const announced = new Promise(resolve => { announce = resolve; });
  // Capture the opener request in memory; never launch a user's browser from tests.
  completed = runBotForeground(options, { signals, start: (opts, stdio) => (child = startBot(opts, stdio)), openBrowser: announce, stdout: { write() {} }, stderr: { write() {} } });
  const launch = await Promise.race([announced, completed.then(() => { throw new Error('Host exited before announcing its URL'); }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('No native launch URL')), 15000); timer.unref(); announced.then(() => clearTimeout(timer)); })]);
  const origin = new URL(launch).origin;
  const denied = await fetch(origin + '/api/bot', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'state' }) });
  assert.equal(denied.status, 401);
  signals.emit('SIGINT');
  assert.ok([0, 130].includes(await completed));
  assert.equal(existsSync(join(options.root, '.forge-bots-lock')), false);
  t.diagnostic('Native loopback opener request observed; unauthenticated API=401; foreground SIGINT stopped host and released lock. OS browser launch is not exercised by this test.');
});
