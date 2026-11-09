import fs from 'node:fs';
import path from 'node:path';
import { BOT_DSH_VERSIONS } from './bots/pin.mjs';

export const MAX_REPORT_BYTES = 32768;
export const DSH_RUNTIME_VERSION = '0.2.1-rc.5';
export const DSH_UPSTREAM_SHA = 'b830ec950faba0a46dda564be3e2d854afed94f1';
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const keys = (x, names) => plain(x) && Object.keys(x).sort().join(',') === [...names].sort().join(',');
const string = x => typeof x === 'string' && x.trim().length > 0 && x.length <= 256 && !/[\x00-\x1f\x7f]/.test(x);
const bindingKeys = ['schemaVersion', 'taskRef', 'attemptId', 'runId', 'invocationId', 'targetEntryIds', 'runtimeVersion', 'reportPath'];
export function validateBinding(b) {
  if (!keys(b, bindingKeys) || b.schemaVersion !== 1 || !BOT_DSH_VERSIONS.includes(b.runtimeVersion) ||
      !keys(b.taskRef, ['source', 'taskKey']) || !string(b.taskRef.source) || !/^[^:\s]+:[^\s]+$/.test(b.taskRef.source) || !string(b.taskRef.taskKey) ||
      !['attemptId', 'runId'].every(k => string(b[k])) || !/^[a-f0-9]{32,128}$/.test(b.invocationId) ||
      !Array.isArray(b.targetEntryIds) || !b.targetEntryIds.length || b.targetEntryIds.length > 64 ||
      !b.targetEntryIds.every(string) || new Set(b.targetEntryIds).size !== b.targetEntryIds.length ||
      typeof b.reportPath !== 'string' || b.reportPath.length > 4096 || !path.isAbsolute(b.reportPath) || /[\x00-\x1f\x7f]/.test(b.reportPath) || path.normalize(b.reportPath) !== b.reportPath) throw new Error('invalid binding');
  // Object key order is not task identity; explicit target order stays unchanged.
  return { ...structuredClone(b), taskRef: { source: b.taskRef.source, taskKey: b.taskRef.taskKey } };
}
export function startupStatuses(entries, targets) {
  return targets.map(entryId => {
    const found = entries.filter(e => e.id === entryId);
    let status = 'missing';
    if (found.length > 1) status = 'duplicate';
    else if (found.length) {
      try {
        const state = found[0].fiber?.state;
        // Pinned DSH auditStartupEntries uses these inlined Cordis enum values.
        status = found[0].disabled ? 'disabled' : state === 0 ? 'pending' : state === 2 ? 'active' : state === 3 ? 'failed' : 'unknown';
      } catch { status = 'unknown'; }
    }
    return { entryId, status };
  });
}
function safeParent(file) {
  let current = path.parse(file).root;
  for (const part of path.dirname(file).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe report directory');
  }
}
export function writeEvidence(binding, statuses) {
  const b = validateBinding(binding);
  validateStatuses(statuses, b.targetEntryIds);
  safeParent(b.reportPath);
  const data = JSON.stringify({ kind: 'dsh-plugin-startup-evidence', scope: 'startup', ...b, observedAt: new Date().toISOString(), statuses });
  if (Buffer.byteLength(data) > MAX_REPORT_BYTES) throw new Error('report too large');
  const tmp = `${b.reportPath}.${b.invocationId}.tmp`;
  let created = false;
  try {
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    created = true;
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.linkSync(tmp, b.reportPath); // Atomic publication, fails if destination exists (including symlinks).
  } finally { if (created) fs.unlinkSync(tmp); }
}
function validateStatuses(statuses, targets) {
  if (!Array.isArray(statuses) || statuses.length !== targets.length) throw new Error('invalid statuses');
  statuses.forEach((s, i) => {
    if (!keys(s, ['entryId', 'status']) || s.entryId !== targets[i] || !['active', 'pending', 'failed', 'disabled', 'missing', 'duplicate', 'unknown'].includes(s.status)) throw new Error('invalid statuses');
  });
}
export function evaluateTaskEvidence(expected, outcome) {
  const b = validateBinding(expected);
  const processPassed = plain(outcome) && outcome.status === 0 && outcome.signal === null && outcome.error == null && outcome.cleanupFailed !== true;
  const base = { schemaVersion: 1, kind: 'forge-dsh-plugin-startup-result', scope: 'startup', runtimeVersion: b.runtimeVersion, taskRef: b.taskRef, attemptId: b.attemptId, runId: b.runId, invocationId: b.invocationId, observedAt: null, processPassed, pluginReady: false, acceptancePassed: null, usage: null, budget: null, statuses: [] };
  try {
    safeParent(b.reportPath);
    const fd = fs.openSync(b.reportPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let report;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) throw new Error();
      const buffer = Buffer.alloc(MAX_REPORT_BYTES + 1);
      const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (size > MAX_REPORT_BYTES) throw new Error();
      report = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    } finally { fs.closeSync(fd); }
    if (!keys(report, [...bindingKeys, 'kind', 'scope', 'observedAt', 'statuses']) || report.kind !== 'dsh-plugin-startup-evidence' || report.scope !== 'startup') throw new Error();
    const actual = Object.fromEntries(bindingKeys.map(k => [k, report[k]]));
    const normalized = validateBinding(actual);
    for (const k of bindingKeys) if (JSON.stringify(normalized[k]) !== JSON.stringify(b[k])) throw new Error();
    if (typeof report.observedAt !== 'string' || !Number.isFinite(Date.parse(report.observedAt)) || new Date(report.observedAt).toISOString() !== report.observedAt ||
        !Array.isArray(report.statuses) || report.statuses.length !== b.targetEntryIds.length) throw new Error();
    validateStatuses(report.statuses, b.targetEntryIds);
    return { ...base, observedAt: report.observedAt, pluginReady: report.statuses.every(s => s.status === 'active'), statuses: report.statuses, evidenceValid: true, passed: processPassed && report.statuses.every(s => s.status === 'active') };
  } catch {
    return { ...base, evidenceValid: false, passed: false, reason: 'missing-or-invalid-evidence' };
  }
}
