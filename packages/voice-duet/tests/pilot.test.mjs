import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync} from 'node:fs'
import {join, dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
import {EventEmitter} from 'node:events'
import {DuetTrace} from '../trace.mjs'
import {requireSecureEndpoint} from '../policy.mjs'
import {prepare, transform, applyPatches, COMMIT} from '../prepare.mjs'

const root = mkdtempSync(join(tmpdir(), 'forge-duet-test-'))
test.after(() => rmSync(root, {recursive:true, force:true}))
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/upstream-excerpts.json', import.meta.url)))
const patched = applyPatches(fixtures)
const fixtureRoot = join(root, 'fixture')
for (const [file, data] of Object.entries(patched)) {
  const dest = join(fixtureRoot, file); mkdirSync(dirname(dest), {recursive:true}); writeFileSync(dest, data)
}
const load = (base, file) => import(pathToFileURL(join(base, 'src/host', file)))
const endpoints = await load(fixtureRoot, 'endpoint-discovery.mjs')
const settings = await load(fixtureRoot, 'settings.mjs')
const proxy = await load(fixtureRoot, 'proxy.mjs')
const route = url => ({url, config:{authorization:''}})
function socket(attempts, failFirst = false) { return class extends EventEmitter {
  constructor(url) { super(); attempts.push(url); queueMicrotask(() => this.emit(failFirst && attempts.length === 1 ? 'error' : 'open')) }
  terminate() {}
}}

test('TLS policy rejects external plaintext and credentials; accepts wss and numeric loopback', () => {
  for (const url of ['ws://voice.example/ws', 'http://voice.example', 'ws://localhost/ws', 'ftp://voice.example', 'wss://user:secret@voice.example', 'wss://voice.example?token=secret']) assert.throws(() => requireSecureEndpoint(url))
  for (const url of ['wss://voice.example/ws?protocol=realtime_v2', 'https://voice.example', 'ws://127.0.0.1:9876/ws', 'ws://[::1]:9876/ws']) assert.ok(requireSecureEndpoint(url))
})
test('patched excerpts guard discovery, settings and proxy initialization before I/O', async () => {
  let resolutions = 0
  await assert.rejects(endpoints.recommendedEndpoint('ws://47.117.104.188/ws', () => { resolutions++; throw Error('unexpected DNS') }), /voice_requires_tls/)
  assert.equal(resolutions, 0)
  const secure = await endpoints.recommendedEndpoint('wss://voice.example/ws', async () => [{address:'203.0.113.10', family:4}])
  assert.match(secure.url, /^wss:/)
  assert.throws(() => endpoints.endpointHTTP('ws://voice.example/ws', '/api/info'), /voice_requires_tls/)
  assert.equal(endpoints.endpointHTTP('wss://voice.example/ws', '/api/info'), 'https://voice.example/api/info')
  for (const value of ['ws://voice.example/ws', 'ws://47.117.104.188/ws?protocol=realtime_v2']) assert.throws(() => settings.validateBackendURL(value, new URL(value).origin), /voice_requires_tls/)
  assert.equal(settings.validateBackendURL('wss://voice.example/ws'), 'wss://voice.example/ws')
  const config = url => ({min_version:'0.1.0', max_version_exclusive:'0.2.0', endpoints:{online:url}})
  assert.throws(() => proxy.registerDuetProxy({}, config('ws://voice.example/ws'), null, () => true, {}), /voice_requires_tls/)
  assert.equal(proxy.registerDuetProxy({}, config('wss://voice.example/ws'), null, () => true, {}), 'validation-passed')
})
test('patched connector excerpt accepts secure routes by default; all fallbacks checked before connection', async () => {
  const attempts = [], Connector = socket(attempts)
  await endpoints.connectEndpoint(Connector, [route('wss://voice.example/ws')])
  assert.deepEqual(attempts, ['wss://voice.example/ws'])
  await assert.rejects(endpoints.connectEndpoint(Connector, [route('wss://safe.example/ws'), route('ws://unsafe.example/ws')]), /voice_requires_tls/)
  assert.equal(attempts.length, 1)
  await endpoints.connectEndpoint(Connector, [route('ws://127.0.0.1:9876/ws')])
  const fallback = []
  const result = await endpoints.connectEndpoint(socket(fallback, true), [route('wss://first.example/ws'), route('wss://second.example/ws')])
  assert.equal(result.fallbackReason, 'network_error'); assert.equal(fallback.length, 2)
})
test('trace writes only numeric metadata; binary, strings, nested base64 and malformed JSON never persist', async () => {
  const trace = new DuetTrace({token:'secret'}, {root:join(root, 'traces')})
  const audio = Buffer.from('UNIQUE_AUDIO_PAYLOAD_123456789'), encoded = audio.toString('base64')
  trace.frame('browser.receive', audio, true)
  trace.frame('upstream.receive', Buffer.from(JSON.stringify({type:'response.output_audio.delta', delta:encoded, nested:{audio:encoded}, sample_rate:16000})))
  trace.frame('upstream.receive', Buffer.from('invalid ' + encoded))
  trace.event(encoded, {audio, other:encoded}, audio)
  await trace.close()
  assert.deepEqual(readdirSync(trace.path), ['events.jsonl'])
  const raw = readFileSync(join(trace.path, 'events.jsonl'), 'utf8')
  for (const secret of [audio.toString(), encoded, 'secret']) assert.equal(raw.includes(secret), false)
  assert.match(raw, /16000/); assert.match(raw, new RegExp(String(audio.length)))
  assert.equal(typeof trace.snapshot().trace_id, 'string'); assert.equal(trace.snapshot().complete, true)
  const memoryOnly = new DuetTrace({}); assert.equal(memoryOnly.path, undefined)
  const full = new DuetTrace({}, {maxBytes:0}); assert.equal(full.snapshot().error, 'quota_exceeded')
  const badRoot = join(root, 'file'); writeFileSync(badRoot, 'x')
  const failed = new DuetTrace({}, {root:badRoot}); assert.equal(failed.snapshot().complete, false)
  assert.doesNotThrow(() => failed.frame('browser.receive', audio, true))
})
test('patch context or pinned blob drift is rejected', () => {
  assert.throws(() => applyPatches({...fixtures, 'src/host/proxy.mjs':'changed'}), /patch_context_drift/)
  assert.throws(() => transform(fixtures), /upstream_file_drift/)
})

test('preparation rejects a wrong Git revision before creating output', () => {
  const wrong = join(root, 'wrong-upstream'); mkdirSync(wrong)
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', wrong, ...args], {env:{PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}})
  git(['init', '--quiet'])
  git(['-c','user.name=Offline','-c','user.email=offline@example.invalid','commit','--quiet','--allow-empty','-m','fixture'])
  assert.throws(() => prepare(wrong, join(root, 'must-not-exist')), /upstream_version_mismatch/)
  assert.equal(readdirSync(root).includes('must-not-exist'), false)
})

test('complete pinned upstream preparation and unchanged plugin registration (explicit DUET_UPSTREAM)', {skip:!process.env.DUET_UPSTREAM && 'set DUET_UPSTREAM to a local dsh-duet repository at the pinned commit'}, async () => {
  const source = process.env.DUET_UPSTREAM
  const git = (...args) => execFileSync('git', ['-C', source, ...args])
  const treeBefore = git('ls-tree', '-r', COMMIT)
  const worktreeBefore = git('diff', '--binary', 'HEAD')
  // prepare restricts writes to the caller workspace; use a self-owned folder there.
  const localRoot = mkdtempSync(join(process.cwd(), '.duet-acceptance-'))
  try {
    const output = prepare(source, join(localRoot, 'plugin'))
    const original = file => git('show', `${COMMIT}:${file}`)
    for (const file of ['package.json', 'src/host/plugin.mjs', 'src/client/entry.js', 'src/client/audio.mjs', 'src/client/rpc.mjs', 'src/host/stop-task.mjs', 'config/duet.patch.yml', 'LICENSE', 'NOTICE', 'HEROICONS-LICENSE.txt']) assert.deepEqual(readFileSync(join(output, file)), original(file), file)
    const pkg = JSON.parse(readFileSync(join(output, 'package.json')))
    assert.ok(pkg.dsh.client.inject.length); assert.equal(pkg.main, './src/host/plugin.mjs')
    const {DuetTrace:PreparedTrace} = await load(output, 'trace.mjs')
    const actualTrace = new PreparedTrace({}, {root:join(localRoot, 'trace')})
    actualTrace.frame('upstream.receive', Buffer.from('TEST_AUDIO_PAYLOAD'), true)
    await actualTrace.close()
    assert.deepEqual(readdirSync(actualTrace.path), ['events.jsonl'])
    assert.equal(readFileSync(join(actualTrace.path, 'events.jsonl'), 'utf8').includes('TEST_AUDIO_PAYLOAD'), false)
    const actual = await load(output, 'endpoint-discovery.mjs')
    const actualSettings = await load(output, 'settings.mjs')
    const actualProxy = await load(output, 'proxy.mjs')
    assert.throws(() => actualSettings.validateBackendURL('ws://voice.example/ws', 'ws://voice.example'), /voice_requires_tls/)
    assert.throws(() => actualProxy.registerDuetProxy({}, {min_version:'0.1.0',max_version_exclusive:'0.2.0',endpoints:{online:'ws://voice.example/ws'}}, null, () => true, {}), /voice_requires_tls/)
    const attempts = []
    await actual.connectEndpoint(socket(attempts), [route('wss://voice.example/ws')])
    await assert.rejects(actual.connectEndpoint(socket(attempts), [route('ws://voice.example/ws')]), /voice_requires_tls/)
    assert.equal(attempts.length, 1)
    const discovered = await actual.recommendedEndpoint('wss://voice.example/ws', async () => [{address:'203.0.113.10',family:4}])
    assert.match(discovered.url, /^wss:/)
    const discovery = new actual.EndpointDiscovery(() => ({endpoints:{online:'wss://custom.example/ws'}}), {cachePath:null, fetchImpl:() => {throw Error('unexpected network')}})
    assert.equal((await discovery.plan('online'))[0].url, 'wss://custom.example/ws')
    execFileSync(process.execPath, ['scripts/check-package.mjs'], {cwd:output, stdio:'pipe'})
    execFileSync(process.execPath, ['--test','tests/unit/audio-interruption.test.mjs','tests/unit/audio-lifecycle.test.mjs'], {cwd:output, stdio:'pipe'})
    const marker = join(output, 'marker'); writeFileSync(marker, 'keep')
    assert.throws(() => prepare(source, output), /EEXIST/); assert.equal(readFileSync(marker, 'utf8'), 'keep')
    assert.throws(() => prepare(join(source, 'src'), join(localRoot, 'nested')), /upstream_must_be_repository_root/)
    assert.deepEqual(git('ls-tree', '-r', COMMIT), treeBefore)
    assert.deepEqual(git('diff', '--binary', 'HEAD'), worktreeBefore)
  } finally { rmSync(localRoot, {recursive:true, force:true}) }
})
