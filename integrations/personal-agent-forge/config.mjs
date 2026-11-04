export class PersonalAgentError extends Error {
  constructor(code, message) { super(message); this.name = 'PersonalAgentError'; this.code = code; }
}

export function check(ok, code, message) {
  if (!ok) throw new PersonalAgentError(code, message);
}
export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function only(value, keys, code = 'PA_INVALID_INPUT') {
  check(record(value) && Object.keys(value).every(key => keys.includes(key)), code, 'Unsupported or invalid fields.');
}
export function identifier(value, code = 'PA_INVALID_INPUT') {
  check(typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,1024}$/.test(value), code, 'A complete explicit identifier is required.');
  return value;
}

// This is trusted operator configuration, never a model tool argument. The
// transport uses a numeric loopback address and never resolves a hostname.
export function validateConfig(raw) {
  only(raw, ['schemaVersion', 'origin', 'instanceId', 'botId', 'auth', 'timeoutMs', 'maxResponseBytes', 'maxItems'], 'PA_INVALID_CONFIG');
  check(raw.schemaVersion === 1, 'PA_INVALID_CONFIG', 'Config requires schemaVersion 1.');
  let origin;
  try { origin = new URL(raw.origin); } catch { /* fail below without reflecting input */ }
  check(origin?.protocol === 'http:' && origin.hostname === '127.0.0.1' && origin.origin === raw.origin
    && origin.port !== '' && !origin.username && !origin.password && !origin.search && !origin.hash
    && origin.pathname === '/', 'PA_INVALID_CONFIG', 'Select one exact http://127.0.0.1:<port> origin.');
  identifier(raw.instanceId, 'PA_INVALID_CONFIG');
  identifier(raw.botId, 'PA_INVALID_CONFIG');
  only(raw.auth, ['mode', 'publicOrigin', 'credentials'], 'PA_INVALID_CONFIG');
  check(['loopback', 'paired'].includes(raw.auth.mode), 'PA_INVALID_CONFIG', 'Explicit loopback or paired authentication is required.');
  let publicOrigin, credentials;
  if (raw.auth.mode === 'paired') {
    try { publicOrigin = new URL(raw.auth.publicOrigin); } catch { /* fail below */ }
    check(publicOrigin && publicOrigin.origin === raw.auth.publicOrigin && !publicOrigin.username && !publicOrigin.password
      && !publicOrigin.search && !publicOrigin.hash && publicOrigin.pathname === '/'
      && (publicOrigin.protocol === 'https:' || publicOrigin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(publicOrigin.hostname)),
    'PA_INVALID_CONFIG', 'Paired access requires the exact PA public origin.');
    check(typeof raw.auth.credentials === 'function', 'PA_CREDENTIALS_REQUIRED', 'Provide credentials through an operator-owned runtime callback.');
    credentials = raw.auth.credentials;
  } else {
    check(Object.keys(raw.auth).length === 1, 'PA_INVALID_CONFIG', 'Loopback mode does not accept credentials.');
  }
  const timeoutMs = raw.timeoutMs ?? 5000, maxResponseBytes = raw.maxResponseBytes ?? 4 * 1024 * 1024, maxItems = raw.maxItems ?? 10000;
  check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 30000, 'PA_INVALID_CONFIG', 'Invalid timeout bound.');
  check(Number.isSafeInteger(maxResponseBytes) && maxResponseBytes >= 256 && maxResponseBytes <= 4 * 1024 * 1024, 'PA_INVALID_CONFIG', 'Invalid response size bound.');
  check(Number.isSafeInteger(maxItems) && maxItems >= 1 && maxItems <= 10000, 'PA_INVALID_CONFIG', 'Invalid item count bound.');
  return Object.freeze({ origin: origin.origin, port: Number(origin.port), instanceId: raw.instanceId, botId: raw.botId,
    auth: Object.freeze({ mode: raw.auth.mode, publicOrigin: publicOrigin?.origin, credentials }), timeoutMs, maxResponseBytes, maxItems });
}
