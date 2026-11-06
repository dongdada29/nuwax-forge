// integrations/device-ssh：device-core 的 Forge/DSH 宿主适配层（U3 试点）。
// 只读探活默认；exec 需显式 enabled + 字面 argv 前缀 allowlist，不经 shell。
// 工具：device_ssh_status / device_ssh_probe（只读）；device_ssh_exec（默认不注册）。

import { createSshTransport } from '../../packages/device-core/transports/ssh.mjs';
import { connect, health, disconnect } from '../../packages/device-core/index.mjs';
import { validateConfig, DeviceSshError } from './config.mjs';

const MAX_OUT_BYTES = 64 * 1024;

const truncate = (text) => {
  if (text.length <= MAX_OUT_BYTES) return { text, truncated: false };
  return { text: text.slice(0, MAX_OUT_BYTES), truncated: true };
};

const matchesAllowlist = (argv, allowlist) =>
  allowlist.some((entry) => argv.length >= entry.length && entry.every((item, i) => argv[i] === item));

export function createTools(rawConfig, deps = {}) {
  const config = validateConfig(rawConfig);
  const transport = deps.transport ?? createSshTransport({ sshPath: deps.sshPath });
  const sessions = new Map();
  const store = deps.store ?? { sessions };

  const coreConfig = (alias) => {
    const d = config.devices[alias];
    return { deviceId: alias, platform: d.platform, transport: 'ssh', abilities: d.abilities, limits: { commandTimeoutMs: d.commandTimeoutMs }, host: d.host, port: d.port, user: d.user, identityFile: d.identityFile, connectTimeoutMs: Math.min(d.commandTimeoutMs, 5000) };
  };

  const status = async () => {
    const devices = {};
    for (const alias of Object.keys(config.devices)) {
      const handle = connect(coreConfig(alias), { transport, ...store });
      const h = health(handle, { transport, ...store });
      devices[alias] = { ready: handle.ready && h.alive !== false, alive: h.alive, error: h.error, latencyMs: h.latencyMs ?? null };
    }
    return { schemaVersion: 1, kind: 'device-ssh-status', devices };
  };

  const probe = async ({ device }) => {
    if (typeof device !== 'string' || !Object.hasOwn(config.devices, device)) throw new DeviceSshError('DSH_UNKNOWN_DEVICE', 'Unknown device alias.');
    const handle = connect(coreConfig(device), { transport, ...store });
    const h = health(handle, { transport, ...store });
    return { schemaVersion: 1, kind: 'device-ssh-probe', device, ready: handle.ready && h.alive !== false, alive: h.alive, latencyMs: h.latencyMs ?? null, error: h.error };
  };

  const exec = async ({ device, argv }) => {
    if (typeof device !== 'string' || !Object.hasOwn(config.devices, device)) throw new DeviceSshError('DSH_UNKNOWN_DEVICE', 'Unknown device alias.');
    if (!Array.isArray(argv) || argv.length === 0 || argv.length > 16 || !argv.every((a) => typeof a === 'string' && /^[\x20-\x7e]{1,200}$/.test(a))) throw new DeviceSshError('DSH_INVALID_ARGV', 'argv must be 1..16 printable ASCII strings.');
    if (!matchesAllowlist(argv, config.exec.allowlist)) throw new DeviceSshError('DSH_NOT_ALLOWLISTED', 'argv does not match any allowlist entry.');
    const handle = connect(coreConfig(device), { transport, ...store });
    if (!handle.ready) return { schemaVersion: 1, kind: 'device-ssh-exec', device, processPassed: false, status: null, signal: null, error: handle.error, stdout: null, stderr: null, truncated: false };
    const d = config.devices[device];
    const outcome = transport.exec(handle.transportHandle, argv, d.commandTimeoutMs);
    const out = truncate(outcome.stdout ?? '');
    const err = truncate(outcome.stderr ?? '');
    return { schemaVersion: 1, kind: 'device-ssh-exec', device, processPassed: outcome.error === null && outcome.status === 0 && outcome.signal === null, status: outcome.status, signal: outcome.signal, error: outcome.error, stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated };
  };

  const tools = [
    { name: 'device_ssh_status', description: 'Read-only SSH reachability for all configured devices. No command execution.', parameters: { type: 'object', additionalProperties: false, properties: {} }, execute: status },
    { name: 'device_ssh_probe', description: 'Read-only SSH probe for one device alias. No command execution.', parameters: { type: 'object', additionalProperties: false, required: ['device'], properties: { device: { type: 'string', maxLength: 40 } } }, execute: probe },
  ];
  if (config.exec.enabled) tools.push({ name: 'device_ssh_exec', description: 'Run one allowlisted command on a device. Allowlist constrains literal argv prefixes only; no local shell, but the remote login shell still interprets the command line — keep allowlist entries tight (e.g. fixed arguments).', parameters: { type: 'object', additionalProperties: false, required: ['device', 'argv'], properties: { device: { type: 'string', maxLength: 40 }, argv: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 200 } } } }, execute: exec });
  return { config, tools, disconnectAll: async () => { for (const handle of sessions.values()) disconnect(handle, { transport, ...store }); } };
}

export const name = 'device-ssh';
export const inject = ['tools'];
export function apply(ctx, rawConfig) {
  const { tools, disconnectAll } = createTools(rawConfig);
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
  const disposers = [];
  try {
    for (const tool of tools) disposers.push(ctx.tools.register({ ...tool, output, timeoutMs: 35000, isConcurrencySafe: () => tool.name !== 'device_ssh_exec' }));
  } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error; }
  return () => { for (const dispose of disposers.reverse()) dispose(); disconnectAll(); };
}
