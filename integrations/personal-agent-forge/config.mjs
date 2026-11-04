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
export function sourceIdentifier(value, code = 'PA_INVALID_INPUT') {
  check(typeof value === 'string' && value.length >= 1 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value), code, 'Source identifiers require 1–200 characters without control characters.');
  return value;
}

// This is trusted operator configuration, never a model tool argument. The
// transport uses a numeric loopback address and never resolves a hostname.
export function validateConfig(raw) {
  only(raw, ['schemaVersion', 'origin', 'instanceId', 'botId', 'auth', 'submission', 'timeoutMs', 'maxResponseBytes', 'maxItems'], 'PA_INVALID_CONFIG');
  check(raw.schemaVersion === 1, 'PA_INVALID_CONFIG', 'Config requires schemaVersion 1.');
  let origin;
  try { origin = new URL(raw.origin); } catch { /* fail below without reflecting input */ }
  check(origin?.protocol === 'http:' && origin.hostname === '127.0.0.1' && origin.origin === raw.origin
    && origin.port !== '' && !origin.username && !origin.password && !origin.search && !origin.hash
    && origin.pathname === '/', 'PA_INVALID_CONFIG', 'Select one exact http://127.0.0.1:<port> origin.');
  if (raw.auth?.mode === 'intake') sourceIdentifier(raw.instanceId, 'PA_INVALID_CONFIG');
  else identifier(raw.instanceId, 'PA_INVALID_CONFIG');
  identifier(raw.botId, 'PA_INVALID_CONFIG');
  only(raw.auth, ['mode', 'intakeId', 'publicOrigin', 'credentials'], 'PA_INVALID_CONFIG');
  check(['loopback', 'paired', 'intake'].includes(raw.auth.mode), 'PA_INVALID_CONFIG', 'Explicit loopback, paired or intake authentication is required.');
  let publicOrigin, credentials;
  if (raw.auth.mode === 'paired' || raw.auth.mode === 'intake') {
    try { publicOrigin = new URL(raw.auth.publicOrigin); } catch { /* fail below */ }
    check(publicOrigin && publicOrigin.origin === raw.auth.publicOrigin && !publicOrigin.username && !publicOrigin.password
      && !publicOrigin.search && !publicOrigin.hash && publicOrigin.pathname === '/'
      && (publicOrigin.protocol === 'https:' || publicOrigin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(publicOrigin.hostname)),
    'PA_INVALID_CONFIG', 'Paired access requires the exact PA public origin.');
    check(typeof raw.auth.credentials === 'function', 'PA_CREDENTIALS_REQUIRED', 'Provide credentials through an operator-owned runtime callback.');
    credentials = raw.auth.credentials;
    if (raw.auth.mode === 'intake') {
      sourceIdentifier(raw.instanceId, 'PA_INVALID_CONFIG');
      check(typeof raw.auth.intakeId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(raw.auth.intakeId), 'PA_INVALID_CONFIG', 'An explicit PA intake identity is required.');
    } else check(raw.auth.intakeId === undefined, 'PA_INVALID_CONFIG', 'Browser credentials cannot carry intake identity.');
  } else {
    check(Object.keys(raw.auth).length === 1, 'PA_INVALID_CONFIG', 'Loopback mode does not accept credentials.');
  }
  let submission = { enabled: false, workspaces: Object.freeze({}) };
  if (raw.submission !== undefined) {
    only(raw.submission, ['enabled', 'workspaces'], 'PA_INVALID_CONFIG');
    check(typeof raw.submission.enabled === 'boolean', 'PA_INVALID_CONFIG', 'Submission requires an explicit boolean switch.');
    check(record(raw.submission.workspaces), 'PA_INVALID_CONFIG', 'Submission requires operator-owned workspace aliases.');
    const workspaces = Object.fromEntries(Object.entries(raw.submission.workspaces).map(([alias, id]) => {
      check(/^[A-Za-z0-9_-]{1,80}$/.test(alias) && !['__proto__', 'prototype', 'constructor'].includes(alias), 'PA_INVALID_CONFIG', 'Invalid workspace alias.');
      identifier(id, 'PA_INVALID_CONFIG'); check(id.length <= 128, 'PA_INVALID_CONFIG', 'Invalid native workspace ID.');
      return [alias, id];
    }));
    check(Object.keys(workspaces).length <= 100 && (!raw.submission.enabled || raw.auth.mode === 'intake' && Object.keys(workspaces).length > 0),
      'PA_INVALID_CONFIG', 'Submission is available only with intake authentication and explicit workspace aliases.');
    submission = { enabled: raw.submission.enabled, workspaces: Object.freeze(workspaces) };
  }
  const timeoutMs = raw.timeoutMs ?? 5000, maxResponseBytes = raw.maxResponseBytes ?? 4 * 1024 * 1024, maxItems = raw.maxItems ?? 10000;
  check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 30000, 'PA_INVALID_CONFIG', 'Invalid timeout bound.');
  check(Number.isSafeInteger(maxResponseBytes) && maxResponseBytes >= 256 && maxResponseBytes <= 4 * 1024 * 1024, 'PA_INVALID_CONFIG', 'Invalid response size bound.');
  check(Number.isSafeInteger(maxItems) && maxItems >= 1 && maxItems <= 10000, 'PA_INVALID_CONFIG', 'Invalid item count bound.');
  return Object.freeze({ origin: origin.origin, port: Number(origin.port), instanceId: raw.instanceId, botId: raw.botId,
    auth: Object.freeze({ mode: raw.auth.mode, intakeId: raw.auth.intakeId, publicOrigin: publicOrigin?.origin, credentials }),
    submission: Object.freeze(submission), timeoutMs, maxResponseBytes, maxItems });
}
