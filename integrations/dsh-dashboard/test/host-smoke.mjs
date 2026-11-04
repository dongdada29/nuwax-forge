// Opt-in installed-host smoke. No providers, prompts, or existing DSH profiles.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';

if (!process.env.DSH_BINARY) throw new Error('Set DSH_BINARY to the installed dsh launcher');
if (process.argv.slice(2).some((arg) => arg !== '--keep')) throw new Error('Only --keep is supported');
const keep = process.argv.includes('--keep');
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const plugin = new URL('../index.mjs', import.meta.url).href;
const home = await mkdtemp(join(tmpdir(), 'forge-dsh-dashboard-'));
const env = { HOME: home, DSH_HOME: join(home, 'dsh'), PATH: process.env.PATH, TMPDIR: home };
const providerRows = ['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai'];
const children = [];
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const child of children.reverse()) {
    if (child.exitCode !== null) continue;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 1000))]);
    if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  }
  await rm(home, { recursive: true, force: true });
}
const shutdown = () => { void cleanup().finally(() => process.exit(130)); };
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
function start(binary, args, childEnv, pattern) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env: childEnv, cwd: home, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    const timer = setTimeout(() => reject(new Error('Host did not become ready within 30 seconds')), 30000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => { clearTimeout(timer); if (code !== null) reject(new Error(`Child exited before readiness (${code})`)); });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
      output += chunk;
      const match = output.match(pattern);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
}
function hostileHostStatus(url) {
  // Fetch implementations may replace Host; use the HTTP transport explicitly.
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { Host: 'untrusted.example' }, timeout: 5000 }, (response) => {
      response.resume(); resolve(response.statusCode);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('HTTP timeout')));
    req.end();
  });
}

try {
  const version = spawnSync(process.env.DSH_BINARY, ['--version'], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(version.status, 0, 'installed DSH version probe failed');
  assert.equal(version.stdout.trim(), '0.2.1-rc.5', 'this smoke is pinned to DSH 0.2.1-rc.5');
  const init = spawnSync(process.env.DSH_BINARY, ['--profile', 'web', '--dump-config'], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(init.status, 0, 'isolated web profile initialization failed');
  const patch = join(home, 'forge.patch.yml');
  await writeFile(patch, providerRows.map((id) => `- id: ${id}\n  disabled: true\n`).join('')
    + `- insert:\n    - id: forge-dashboard\n      name: ${JSON.stringify(plugin)}\n`);
  const composed = spawnSync(process.env.DSH_BINARY, ['--profile', 'web', '--patch', patch, '--dump-config'], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(composed.status, 0, 'isolated patched profile failed to compose');
  const rows = composed.stdout.split(/\n(?=- id: )/);
  for (const id of providerRows) {
    const row = rows.find((row) => row.startsWith(`- id: ${id}\n`));
    assert.match(row || '', /\n  disabled: true(?:\n|$)/, `provider ${id} must be disabled before boot`);
  }
  const hostUrl = await start(process.env.DSH_BINARY,
    ['--profile', 'web', '--patch', patch, '--port', '0', '--no-open'], env, /dsh web: (http:\/\/[^\s]+)/);
  const origin = new URL(hostUrl).origin;
  const auth = await fetch(hostUrl, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  const cookie = auth.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'isolated DSH did not issue its browser cookie');
  const index = await fetch(origin, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
  assert.equal(index.status, 200);
  const html = await index.text();
  const graphMatch = html.match(/globalThis\["__DSH_BOOT__"\]\s*=\s*([^<]+)<\/script>/);
  assert.ok(graphMatch, 'real DSH boot graph missing');
  const graph = JSON.parse(graphMatch[1].trim().replace(/;$/, ''));
  const entry = graph.entries.find((entry) => entry.id === '@nuwax-ai/dsh-forge-dashboard');
  assert.ok(entry, 'plugin missing from real DSH client registry');
  const resource = await fetch(new URL(entry.url, origin + '/'), { headers: { cookie }, signal: AbortSignal.timeout(5000) });
  assert.equal(resource.status, 200);
  assert.match(resource.headers.get('content-type'), /javascript/);
  assert.match(await resource.text(), /id: '@nuwax-ai\/dsh-forge-dashboard'/);

  await writeFile(join(home, 'ledger.jsonl'), JSON.stringify({ taskKey: 'dsh-host-fixture', attemptId: 'fixture', status: 'completed' }) + '\n');
  await writeFile(join(home, 'registry.json'), JSON.stringify({ executors: [] }));
  const dashboardEnv = { HOME: home, PATH: process.env.PATH, PYTHONPATH: [join(repo, 'packages/dashboard'), join(repo, 'packages/nuwax-crew')].join(delimiter) };
  const addresses = {};
  for (const [name, ancestor] of [['allowed', origin], ['denied', 'http://127.0.0.1:1']]) {
    const url = await start(process.env.PYTHON || 'python3', ['-B', '-m', 'forge_dashboard', '--ledger', join(home, 'ledger.jsonl'),
      '--registry', join(home, 'registry.json'), '--serve', '--port', '0', '--embed-origin', ancestor], dashboardEnv, /"url":\s*"([^"]+)"/);
    addresses[name] = url;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-security-policy').endsWith('frame-ancestors ' + ancestor));
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.match(await response.text(), /dsh-host-fixture/);
    assert.equal(await hostileHostStatus(url), 403);
    assert.equal((await fetch(url + 'api/approvals/decision', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  }
  const result = { hostVersion: version.stdout.trim(), release: graph.release, origin, pluginRegistered: true, resourceServed: true,
    providersDisabled: providerRows, dashboardHeadersVerified: true, hostAndApprovalRejected: true,
    browserConsumption: 'Separate browser verification required; HTTP headers alone do not prove iframe rendering.' };
  if (keep) {
    const connection = join(home, 'connection.json');
    await writeFile(connection, JSON.stringify({ hostUrl, ...addresses }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ ...result, connectionFile: connection }, null, 2));
    console.log('Open hostUrl from connectionFile; stop with Ctrl-C to clean up. Do not publish its token.');
    await new Promise(() => {});
  } else console.log(JSON.stringify(result, null, 2));
} finally {
  process.removeListener('SIGINT', shutdown);
  process.removeListener('SIGTERM', shutdown);
  await cleanup();
}
