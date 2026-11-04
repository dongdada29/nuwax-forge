import http from 'node:http';
import { PersonalAgentError, check, only, identifier, validateConfig } from './config.mjs';
import { validatePostBody } from './admission.mjs';

const error = (code, message) => new PersonalAgentError(code, message);
const httpError = status => error(status === 401 ? 'PA_AUTH_REQUIRED' : status === 403 ? 'PA_ACCESS_REJECTED'
  : status === 404 ? 'PA_NOT_FOUND' : status === 409 ? 'PA_COMMAND_CONFLICT' : 'PA_HTTP_ERROR', 'The selected PA endpoint rejected the request.');

// Fixed native routes only. POST exists solely for explicitly enabled intake.
// No redirects, proxies, cookie jar, pairing, discovery, retries or generic API.
export function createClient(raw) {
  const config = validateConfig(raw);
  function requestNative(path, signal, body) {
    const method = body === undefined ? 'GET' : 'POST';
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    check(payload === undefined || payload.length <= 32768, 'PA_REQUEST_TOO_LARGE', 'PA request exceeded its byte bound.');
    return new Promise((resolve, reject) => {
      let settled = false, request, response;
      const credentialAbort = new AbortController();
      const finish = (failure, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (failure) { credentialAbort.abort(); response?.destroy(); request?.destroy(); reject(failure); }
        else resolve(value);
      };
      const abort = () => finish(error('PA_ABORTED', 'PA request was cancelled.'));
      const timer = setTimeout(() => finish(error('PA_TIMEOUT', 'PA request exceeded its total time bound.')), config.timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      // Deadline includes a slow credential provider. Its late result is ignored.
      Promise.resolve().then(async () => {
        let token;
        if (config.auth.mode === 'paired' || config.auth.mode === 'intake') {
          let credentials;
          try { credentials = await config.auth.credentials({ signal: credentialAbort.signal }); }
          catch { throw error('PA_CREDENTIALS_REQUIRED', 'Operator runtime credentials are unavailable.'); }
          const key = config.auth.mode === 'intake' ? 'intakeToken' : 'deviceToken';
          only(credentials, [key], 'PA_CREDENTIALS_REQUIRED');
          check(typeof credentials[key] === 'string' && /^[A-Za-z0-9_-]{43}$/.test(credentials[key]),
            'PA_CREDENTIALS_REQUIRED', 'Operator runtime credentials are invalid.');
          token = credentials[key];
        }
        if (settled) return;
        const headers = { accept: 'application/json', host: new URL(config.auth.publicOrigin ?? config.origin).host };
        if (token) {
          headers.origin = config.auth.publicOrigin;
          if (config.auth.mode === 'intake') headers.authorization = `Bearer ${token}`;
          else headers.cookie = `${config.auth.publicOrigin.startsWith('https:') ? '__Host-pa-device' : 'pa-device-dev'}=${token}`;
        }
        if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = String(payload.length); }
        request = http.request({ hostname: '127.0.0.1', port: config.port, path, method, headers,
          agent: false, maxHeaderSize: 16384 }, res => {
          response = res;
          res.on('aborted', () => finish(error('PA_TRANSPORT_ERROR', 'PA response ended before completion.')));
          res.on('error', () => finish(error('PA_TRANSPORT_ERROR', 'PA read transport failed.')));
          if (!(res.statusCode === 200 || method === 'POST' && res.statusCode === 201)) { finish(httpError(res.statusCode)); return; }
          if (!/^application\/json(?:\s*;|$)/i.test(res.headers['content-type'] ?? '')
            || res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
            finish(error('PA_INVALID_RESPONSE', 'PA read requires an uncompressed JSON response.')); return;
          }
          const length = res.headers['content-length'];
          if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > config.maxResponseBytes)) {
            finish(error('PA_RESPONSE_TOO_LARGE', 'PA response exceeded its size bound.')); return;
          }
          let bytes = 0; const chunks = [];
          res.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > config.maxResponseBytes) finish(error('PA_RESPONSE_TOO_LARGE', 'PA response exceeded its size bound.'));
            else chunks.push(chunk);
          });
          res.on('end', () => {
            if (settled) return;
            try {
              const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
              // Even a misbehaving endpoint must not echo runtime credentials to
              // model output. Errors never include response bodies or headers.
              const value = JSON.parse(text);
              // Normalize JSON escapes first so an escaped echo cannot bypass
              // redaction. Only base64url token characters are accepted above.
              const sanitized = token ? JSON.parse(JSON.stringify(value).replaceAll(token, '[REDACTED]')) : value;
              finish(null, method === 'POST' ? { httpStatus: res.statusCode, task: sanitized } : sanitized);
            } catch { finish(error('PA_INVALID_RESPONSE', 'PA response is not valid bounded JSON.')); }
          });
        });
        request.on('error', () => finish(error('PA_TRANSPORT_ERROR', 'PA read transport failed.')));
        request.end(payload);
      }).catch(failure => finish(failure instanceof PersonalAgentError ? failure : error('PA_TRANSPORT_ERROR', 'PA read transport failed.')));
    });
  }
  const operations = {
    listTasks: ({ signal } = {}) => requestNative('/api/tasks', signal),
    taskSnapshot: (taskId, { signal } = {}) => { identifier(taskId); return requestNative(`/api/tasks/${encodeURIComponent(taskId)}`, signal); },
  };
  if (config.auth.mode === 'intake' && config.submission.enabled) operations.submitTask = (body, { signal } = {}) => {
    validatePostBody(body, config);
    return requestNative('/api/tasks', signal, body);
  };
  return Object.freeze(operations);
}
