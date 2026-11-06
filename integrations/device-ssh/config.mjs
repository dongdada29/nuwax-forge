// integrations/device-ssh 配置校验。比照 personal-agent-forge 纪律：
// 只收操作者可信配置；exec 默认关；allowlist 是字面 argv 前缀数组，
// 不经 shell，无通配符。

export class DeviceSshError extends Error {
  constructor(code, message) { super(message); this.name = 'DeviceSshError'; this.code = code; }
}

const check = (ok, code, message) => { if (!ok) throw new DeviceSshError(code, message); };
const PLATFORMS = new Set(['macos', 'linux', 'windows', 'android', 'ios']);
const ABILITIES = new Set(['shell', 'file-push', 'screenshot', 'ui-drive']);
const HOST_RE = /^[A-Za-z0-9._-]{1,253}$/;
const USER_RE = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/;
const ALIAS_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ARG_RE = /^[\x20-\x7e]{1,200}$/;

export function validateConfig(raw) {
  check(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'DSH_INVALID_CONFIG', 'Config must be an object.');
  check(Object.keys(raw).every((k) => ['schemaVersion', 'devices', 'exec'].includes(k)), 'DSH_INVALID_CONFIG', 'Unsupported config fields.');
  check(raw.schemaVersion === 1, 'DSH_INVALID_CONFIG', 'Config requires schemaVersion 1.');
  check(raw.devices !== null && typeof raw.devices === 'object' && !Array.isArray(raw.devices), 'DSH_INVALID_CONFIG', 'devices must be an object.');
  const aliases = Object.keys(raw.devices);
  check(aliases.length >= 1 && aliases.length <= 8, 'DSH_INVALID_CONFIG', '1..8 devices required.');
  const devices = {};
  for (const alias of aliases) {
    check(ALIAS_RE.test(alias) && !['__proto__', 'prototype', 'constructor'].includes(alias), 'DSH_INVALID_CONFIG', 'Invalid device alias.');
    const d = raw.devices[alias];
    check(d !== null && typeof d === 'object' && !Array.isArray(d), 'DSH_INVALID_CONFIG', 'Device must be an object.');
    check(Object.keys(d).every((k) => ['host', 'port', 'user', 'platform', 'abilities', 'identityFile', 'commandTimeoutMs'].includes(k)), 'DSH_INVALID_CONFIG', 'Unsupported device fields.');
    check(HOST_RE.test(d.host ?? ''), 'DSH_INVALID_CONFIG', 'host must be a plain hostname or IP.');
    check(USER_RE.test(d.user ?? ''), 'DSH_INVALID_CONFIG', 'user must be 1-32 safe chars.');
    check(d.port === undefined || (Number.isInteger(d.port) && d.port >= 1 && d.port <= 65535), 'DSH_INVALID_CONFIG', 'port must be 1..65535.');
    check(PLATFORMS.has(d.platform), 'DSH_INVALID_CONFIG', 'Unknown platform.');
    check(Array.isArray(d.abilities) && d.abilities.length > 0 && d.abilities.every((a) => ABILITIES.has(a)), 'DSH_INVALID_CONFIG', 'abilities must be a non-empty known set.');
    check(d.identityFile === undefined || (typeof d.identityFile === 'string' && d.identityFile.startsWith('/') && d.identityFile.length <= 4096 && !d.identityFile.includes('\0')), 'DSH_INVALID_CONFIG', 'identityFile must be an absolute path.');
    check(d.commandTimeoutMs === undefined || (Number.isSafeInteger(d.commandTimeoutMs) && d.commandTimeoutMs > 0 && d.commandTimeoutMs <= 600000), 'DSH_INVALID_CONFIG', 'commandTimeoutMs must be 1..600000.');
    devices[alias] = { host: d.host, port: d.port ?? 22, user: d.user, platform: d.platform, abilities: Object.freeze([...d.abilities]), identityFile: d.identityFile, commandTimeoutMs: d.commandTimeoutMs ?? 30000 };
  }
  let exec = { enabled: false, allowlist: [] };
  if (raw.exec !== undefined) {
    check(raw.exec !== null && typeof raw.exec === 'object' && !Array.isArray(raw.exec), 'DSH_INVALID_CONFIG', 'exec must be an object.');
    check(Object.keys(raw.exec).every((k) => ['enabled', 'allowlist'].includes(k)), 'DSH_INVALID_CONFIG', 'Unsupported exec fields.');
    check(typeof raw.exec.enabled === 'boolean', 'DSH_INVALID_CONFIG', 'exec.enabled must be boolean.');
    check(Array.isArray(raw.exec.allowlist) && raw.exec.allowlist.every((e) => Array.isArray(e) && e.length >= 1 && e.length <= 8 && e.every((a) => ARG_RE.test(a))), 'DSH_INVALID_CONFIG', 'allowlist entries must be 1..8 literal argv items.');
    check(!raw.exec.enabled || raw.exec.allowlist.length >= 1, 'DSH_INVALID_CONFIG', 'exec.enabled requires a non-empty allowlist.');
    exec = { enabled: raw.exec.enabled, allowlist: Object.freeze(raw.exec.allowlist.map((e) => Object.freeze([...e]))) };
  }
  return { schemaVersion: 1, devices: Object.freeze(devices), exec: Object.freeze(exec) };
}
