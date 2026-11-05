import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateConfig, DeviceSshError } from '../config.mjs';
import { createTools } from '../index.mjs';

const baseDevice = { host: '127.0.0.1', user: 'louis', platform: 'macos', abilities: ['shell'] };
const baseConfig = { schemaVersion: 1, devices: { m1: baseDevice } };

const okTransport = () => ({
  open: () => ({ ok: true, handle: { fake: true } }),
  probe: () => ({ ok: true }),
  close: () => ({ ok: true }),
  exec: (h, argv) => ({ status: 0, signal: null, error: null, stdout: `ran:${argv.join(' ')}`, stderr: '' }),
});

test('配置：合法最小配置通过，非法变体拒绝', () => {
  const c = validateConfig(baseConfig);
  assert.equal(c.devices.m1.port, 22);
  assert.equal(c.devices.m1.commandTimeoutMs, 30000);
  assert.equal(c.exec.enabled, false);
  assert.throws(() => validateConfig({ schemaVersion: 2, devices: {} }), DeviceSshError);
  assert.throws(() => validateConfig({ schemaVersion: 1, devices: {} }), DeviceSshError); // 0 台
  assert.throws(() => validateConfig({ schemaVersion: 1, devices: { m1: { ...baseDevice, platform: 'plan9' } } }), DeviceSshError);
  assert.throws(() => validateConfig({ schemaVersion: 1, devices: { '../x': baseDevice } }), DeviceSshError);
  assert.throws(() => validateConfig({ schemaVersion: 1, devices: { m1: { ...baseDevice, host: 'a b' } } }), DeviceSshError);
  assert.throws(() => validateConfig({ schemaVersion: 1, devices: { m1: { ...baseDevice, commandTimeoutMs: 0 } } }), DeviceSshError);
  assert.throws(() => validateConfig({ schemaVersion: 1, devices: { m1: baseDevice }, exec: { enabled: true, allowlist: [] } }), DeviceSshError);
});

test('exec 默认关：未 enabled 不注册 exec 工具；enabled+allowlist 才注册', () => {
  const off = createTools(baseConfig, { transport: okTransport() });
  assert.deepEqual(off.tools.map((t) => t.name), ['device_ssh_status', 'device_ssh_probe']);
  const on = createTools({ schemaVersion: 1, devices: { m1: baseDevice }, exec: { enabled: true, allowlist: [['echo']] } }, { transport: okTransport() });
  assert.deepEqual(on.tools.map((t) => t.name), ['device_ssh_status', 'device_ssh_probe', 'device_ssh_exec']);
});

test('status/probe：只读探活走 device-core 会话语义', async () => {
  const t = okTransport();
  const { tools } = createTools({ schemaVersion: 1, devices: { m1: baseDevice, mbp: { ...baseDevice, host: '100.x.y.z' } } }, { transport: t });
  const status = tools[0].execute;
  const r = await status();
  assert.equal(r.kind, 'device-ssh-status');
  assert.equal(r.devices.m1.ready, true);
  assert.equal(r.devices.mbp.ready, true);
  const probe = tools[1].execute;
  const p = await probe({ device: 'm1' });
  assert.equal(p.device, 'm1');
  assert.equal(p.ready, true);
  await assert.rejects(() => probe({ device: 'nope' }), DeviceSshError);
});

test('exec：allowlist 前缀精确匹配，非白名单/坏 argv/未知设备拒绝', async () => {
  const t = okTransport();
  const { tools } = createTools({ schemaVersion: 1, devices: { m1: baseDevice }, exec: { enabled: true, allowlist: [['uname'], ['echo', 'ok']] } }, { transport: t });
  const exec = tools[2].execute;
  assert.deepEqual((await exec({ device: 'm1', argv: ['uname', '-a'] })).stdout, 'ran:uname -a');
  assert.deepEqual((await exec({ device: 'm1', argv: ['echo', 'ok'] })).stdout, 'ran:echo ok');
  await assert.rejects(() => exec({ device: 'm1', argv: ['rm', '-rf', '/'] }), (e) => e.code === 'DSH_NOT_ALLOWLISTED');
  await assert.rejects(() => exec({ device: 'm1', argv: [] }), DeviceSshError);
  await assert.rejects(() => exec({ device: 'm1', argv: ['uname', 'x\0y'] }), DeviceSshError);
  await assert.rejects(() => exec({ device: 'ghost', argv: ['uname'] }), (e) => e.code === 'DSH_UNKNOWN_DEVICE');
});

test('exec：传输失败/非零退出/超时映射为 processPassed=false', async () => {
  const failing = { open: () => ({ ok: false, error: { code: 'SSH_AUTH', message: 'denied' } }), probe: () => ({ ok: false }), close: () => ({ ok: true }) };
  const r1 = await createTools({ schemaVersion: 1, devices: { m1: baseDevice }, exec: { enabled: true, allowlist: [['uname']] } }, { transport: failing }).tools[2].execute({ device: 'm1', argv: ['uname'] });
  assert.equal(r1.processPassed, false);
  assert.equal(r1.error.code, 'SSH_AUTH');
  const nonzero = okTransport();
  nonzero.exec = () => ({ status: 3, signal: null, error: null, stdout: '', stderr: 'boom' });
  const r2 = await createTools({ schemaVersion: 1, devices: { m1: baseDevice }, exec: { enabled: true, allowlist: [['uname']] } }, { transport: nonzero }).tools[2].execute({ device: 'm1', argv: ['uname'] });
  assert.equal(r2.processPassed, false);
  assert.equal(r2.status, 3);
  const timeout = okTransport();
  timeout.exec = () => ({ status: null, signal: 'SIGTERM', error: { code: 'SSH_TIMEOUT', message: 'Command exceeded 30000ms.' }, stdout: '', stderr: '' });
  const r3 = await createTools({ schemaVersion: 1, devices: { m1: baseDevice }, exec: { enabled: true, allowlist: [['uname']] } }, { transport: timeout }).tools[2].execute({ device: 'm1', argv: ['uname'] });
  assert.equal(r3.processPassed, false);
  assert.equal(r3.error.code, 'SSH_TIMEOUT');
});

test('apply：注册/回滚契约与 personal-agent-forge 对齐', async () => {
  const registered = [];
  const disposed = [];
  const applyMod = (await import('../index.mjs')).apply;
  const dispose = applyMod({ tools: { register: (t) => { registered.push(t.name); return () => disposed.push(t.name); } } }, baseConfig);
  assert.deepEqual(registered, ['device_ssh_status', 'device_ssh_probe']);
  dispose();
  assert.deepEqual(disposed, ['device_ssh_probe', 'device_ssh_status']); // LIFO 与 PA 扩展一致
  assert.throws(() => applyMod({ tools: { register: () => { throw new Error('boom'); } } }, baseConfig), /boom/);
});

test('真实回环（NUWAX_DEVICE_SSH_TARGET 设置时才跑）', { skip: !process.env.NUWAX_DEVICE_SSH_TARGET }, async () => {
  const [userHost, port] = process.env.NUWAX_DEVICE_SSH_TARGET.split(':');
  const [user, host] = userHost.split('@');
  const { tools } = createTools({ schemaVersion: 1, devices: { loop: { host, port: port ? Number(port) : 22, user, platform: 'macos', abilities: ['shell'] } }, exec: { enabled: true, allowlist: [['echo']] } }, {});
  const p = await tools[1].execute({ device: 'loop' });
  assert.equal(p.ready, true);
  const r = await tools[2].execute({ device: 'loop', argv: ['echo', 'nuwax-u3'] });
  assert.equal(r.processPassed, true);
  assert.match(r.stdout, /nuwax-u3/);
});
