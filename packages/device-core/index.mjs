// 设备连接核心（U3 试点：SSH）。零宿主依赖；四公共接口中的 ①②③④。
// 设计见 docs/DSH-PLUGIN-COMPAT.md（#29）：幂等生命周期、强制超时、
// 结构化错误、unknown 保留、凭据只经操作者回调。

const PLATFORMS = new Set(['macos', 'linux', 'windows', 'android', 'ios']);
const TRANSPORTS = new Set(['ssh', 'adb', 'applescript', 'wda']);
const ABILITIES = new Set(['shell', 'file-push', 'screenshot', 'ui-drive']);

export class DeviceError extends Error {
  constructor(code, message) { super(message); this.name = 'DeviceError'; this.code = code; }
}

// ① 设备能力声明：纯函数，不触网。
export function declareCapabilities(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new DeviceError('DEVICE_INVALID_CONFIG', 'Config must be an object.');
  const { deviceId, platform, transport, abilities, limits } = config;
  if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(deviceId)) throw new DeviceError('DEVICE_INVALID_CONFIG', 'deviceId must be 1-80 safe chars.');
  if (!PLATFORMS.has(platform) || !TRANSPORTS.has(transport)) throw new DeviceError('DEVICE_INVALID_CONFIG', 'Unknown platform or transport.');
  if (!Array.isArray(abilities) || abilities.length === 0 || !abilities.every((a) => ABILITIES.has(a))) throw new DeviceError('DEVICE_INVALID_CONFIG', 'abilities must be a non-empty known set.');
  if (limits !== undefined && (limits === null || typeof limits !== 'object' || Array.isArray(limits))) throw new DeviceError('DEVICE_INVALID_CONFIG', 'limits must be an object.');
  const timeouts = limits?.commandTimeoutMs;
  if (timeouts !== undefined && !(Number.isSafeInteger(timeouts) && timeouts > 0 && timeouts <= 600000)) throw new DeviceError('DEVICE_INVALID_CONFIG', 'limits.commandTimeoutMs must be 1..600000.');
  return Object.freeze({ deviceId, platform, transport, abilities: Object.freeze([...abilities]), limits: Object.freeze({ maxSessions: 1, commandTimeoutMs: timeouts ?? 30000 }) });
}

// ② 连接生命周期：句柄不透明；幂等；一切失败走结构化结果，不抛裸异常。
export function connect(config, deps) {
  const caps = declareCapabilities(config);
  const key = JSON.stringify([caps.deviceId, config.host ?? '', config.port ?? null, config.user ?? '']);
  const existing = deps?.sessions?.get(key);
  if (existing && existing.ready) return { ...existing, reused: true };
  if (!deps?.transport?.open) return { reused: false, ready: false, error: { code: 'DEVICE_NO_TRANSPORT', message: 'No transport adapter provided.' } };
  const opened = deps.transport.open({ ...config, caps });
  const handle = { reused: false, ready: opened.ok === true, error: opened.ok ? null : opened.error, transportHandle: opened.ok ? opened.handle : null, caps, key, gen: (deps.gen = (deps?.gen ?? 0) + 1) };
  deps?.sessions?.set(key, handle);
  return handle;
}

export function health(handle, deps) {
  if (!handle || typeof handle !== 'object') return { alive: false, error: { code: 'DEVICE_INVALID_HANDLE', message: 'Handle required.' } };
  if (!handle.ready) return { alive: false, latencyMs: null, error: handle.error };
  if (deps?.sessions?.get(handle.key)?.gen !== handle.gen) return { alive: false, latencyMs: null, error: { code: 'DEVICE_SESSION_CLOSED', message: 'Handle belongs to a closed session.' } };
  if (!deps?.transport?.probe) return { alive: null, latencyMs: null, error: { code: 'DEVICE_NO_TRANSPORT', message: 'No transport probe.' } };
  const t0 = Date.now();
  const probe = deps.transport.probe(handle.transportHandle);
  if (probe.ok) return { alive: true, latencyMs: Date.now() - t0, error: null };
  return { alive: false, latencyMs: null, error: probe.error ?? { code: 'DEVICE_PROBE_FAILED', message: 'Probe reported failure.' } };
}

export function disconnect(handle, deps) {
  if (!handle || typeof handle !== 'object') return { closed: false, error: { code: 'DEVICE_INVALID_HANDLE', message: 'Handle required.' } };
  deps?.sessions?.delete(handle.key);
  if (!handle.ready) return { closed: true, error: null };
  if (!deps?.transport?.close) return { closed: false, error: { code: 'DEVICE_NO_TRANSPORT', message: 'No transport close.' } };
  const closed = deps.transport.close(handle.transportHandle);
  return closed.ok ? { closed: true, error: null } : { closed: false, error: closed.error };
}

// ③ 结构化步骤验证结果：processPassed 逐步校验，语义回执缺失留 null（unknown 保留）。
export function evaluateStepEvidence(expected, outcome) {
  const bad = (reason) => ({ schemaVersion: 1, kind: 'forge-device-step-result', scope: 'step', processPassed: false, stepPassed: false, evidence: null, reason });
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) return bad('invalid-expected');
  if (typeof expected.stepId !== 'string' || expected.stepId.length < 1 || expected.stepId.length > 200) return bad('invalid-step-id');
  const processPassed = outcome !== null && typeof outcome === 'object' && outcome.status === 0 && outcome.signal === null && outcome.error == null;
  let evidence = null;
  try {
    if (typeof expected.verify === 'function') evidence = expected.verify(outcome) ?? null;
    if (evidence !== null && (typeof evidence !== 'object' || Array.isArray(evidence))) return bad('invalid-evidence');
  } catch { return bad('invalid-evidence'); }
  return { schemaVersion: 1, kind: 'forge-device-step-result', scope: 'step', stepId: expected.stepId, processPassed, stepPassed: processPassed, evidence, reason: processPassed ? null : 'process-failed' };
}

// ④ 宿主适配就绪检查：纯函数，输入由宿主适配层采集。
export function hostReadiness(host, observed) {
  if (host !== 'dsh' && host !== 'forge') return { host, ready: false, checks: [{ name: 'host', passed: false, detail: 'unknown host' }] };
  const checks = [
    { name: 'entry-loaded', passed: observed?.entryLoaded === true, detail: observed?.entryLoaded ? null : 'plugin entry not loaded' },
    { name: 'version-matched', passed: observed?.versionMatched === true, detail: observed?.versionMatched ? null : 'runtime version mismatch' },
    { name: 'tools-registered', passed: observed?.toolsRegistered === true, detail: observed?.toolsRegistered ? null : 'tools not registered' },
  ];
  return { host, ready: checks.every((c) => c.passed), checks };
}
