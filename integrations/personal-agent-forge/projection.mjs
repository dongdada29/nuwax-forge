import { check, identifier, record } from './config.mjs';
import { validateSource } from './admission.mjs';

const RESPONSE = 'PA_INVALID_RESPONSE';
const statuses = ['queued', 'running', 'waiting_human', 'paused', 'interrupted', 'completed', 'failed', 'cancelled'];
const deliveries = ['pending', 'accepted', 'returned'];
const text = (value, max = 10000) => {
  check(typeof value === 'string' && value.length <= max, RESPONSE, 'PA response contains invalid text.');
  return value;
};
const optionalId = value => value === undefined || value === null ? null : identifier(value, RESPONSE);
const array = (value, config) => {
  check(Array.isArray(value) && value.length <= config.maxItems, RESPONSE, 'PA response contains an invalid or oversized collection.');
  return value;
};
const unique = (rows, key) => {
  check(new Set(rows.map(row => row[key])).size === rows.length, RESPONSE, 'PA response contains duplicate identifiers or sequence numbers.');
  return rows;
};
const unknownUsage = () => ({ known: null, inputTokens: null, outputTokens: null, chargedTokens: null, actualModel: null, executionSessionId: null });

export function projectTask(value, config) {
  check(record(value), RESPONSE, 'PA task is invalid.');
  const taskId = identifier(value.id, RESPONSE);
  check(statuses.includes(value.status) && deliveries.includes(value.deliveryStatus), RESPONSE, 'PA task state is invalid.');
  check(value.engine === undefined || ['fake', 'claude', 'forge'].includes(value.engine), RESPONSE, 'PA engine is unsupported.');
  if (config.auth.mode === 'intake') check(value.intakeId === config.auth.intakeId, RESPONSE, 'PA returned a task from a different intake identity.');
  let admission = null;
  if (value.admission !== undefined) {
    check(record(value.admission) && ['pending', 'approved', 'rejected', 'expired'].includes(value.admission.status)
      && /^[a-f0-9]{64}$/.test(value.admission.fingerprint), RESPONSE, 'PA task admission is invalid.');
    admission = { approvalId: identifier(value.admission.approvalId, RESPONSE), fingerprint: value.admission.fingerprint, status: value.admission.status };
  }
  return {
    taskRef: { source: `personal-agent:${config.instanceId}`, taskKey: taskId }, taskId,
    commandId: optionalId(value.commandId), goal: text(value.goal), status: value.status, deliveryStatus: value.deliveryStatus,
    workspaceId: optionalId(value.workspaceId), intakeId: optionalId(value.intakeId),
    source: value.source === undefined ? null : validateSource(value.source), sourceAuthenticated: false, admission,
    activeAttemptId: optionalId(value.activeAttemptId), activeAttemptKnown: Object.hasOwn(value, 'activeAttemptId'),
    engine: value.engine ?? null, pauseRequested: typeof value.pauseRequested === 'boolean' ? value.pauseRequested : null,
    createdAt: value.createdAt === undefined ? null : text(value.createdAt, 128),
    updatedAt: value.updatedAt === undefined ? null : text(value.updatedAt, 128),
    usage: unknownUsage(), productAcceptancePassed: null,
  };
}

export function projectTaskList(value, config) {
  check(record(value), RESPONSE, 'PA task list is invalid.');
  return unique(array(value.tasks, config).map(row => projectTask(row, config)), 'taskId');
}

// Allowlisted facts only. In particular, config snapshots, verification argv,
// permission rawInput, model settings, and arbitrary event payloads stay in PA.
export function projectSnapshot(value, expectedId, config) {
  check(record(value), RESPONSE, 'PA task snapshot is invalid.');
  const projectedTask = projectTask(value.task, config);
  check(projectedTask.taskId === expectedId, RESPONSE, 'PA returned a different task identity.');
  check(Number.isSafeInteger(value.cursor) && value.cursor >= 0, RESPONSE, 'PA event cursor is invalid.');
  const linked = row => {
    check(record(row) && row.taskId === expectedId, RESPONSE, 'PA record belongs to a different task.');
    return row;
  };
  let previousSeq = 0;
  const events = array(value.events, config).map(row => {
    linked(row);
    check(Number.isSafeInteger(row.seq) && row.seq > previousSeq && row.seq <= value.cursor, RESPONSE, 'PA event replay is unordered, duplicated, or beyond the snapshot cursor.');
    previousSeq = row.seq;
    return { seq: row.seq, taskId: row.taskId, attemptId: optionalId(row.attemptId), type: text(row.type, 200), createdAt: text(row.createdAt, 128) };
  });
  const collection = (key, project) => value[key] === undefined ? null : unique(array(value[key], config).map(row => project(linked(row))), 'id');
  const identity = row => ({ id: identifier(row.id, RESPONSE), taskId: row.taskId, attemptId: optionalId(row.attemptId) });
  const result = {
    task: projectedTask, cursor: value.cursor, events,
    stages: collection('stages', row => ({ ...identity(row), name: text(row.name, 100), status: text(row.status, 100) })),
    runs: collection('runs', row => ({ ...identity(row), stageId: optionalId(row.stageId), role: text(row.role, 100), status: text(row.status, 100), usage: unknownUsage() })),
    artifacts: collection('artifacts', row => ({ ...identity(row), kind: text(row.kind, 100), name: text(row.name, 1000) })),
    verifications: collection('verifications', row => ({ ...identity(row), stageId: optionalId(row.stageId),
      exitCode: Number.isSafeInteger(row.exitCode) ? row.exitCode : null,
      timedOut: typeof row.timedOut === 'boolean' ? row.timedOut : null, cancelled: typeof row.cancelled === 'boolean' ? row.cancelled : null })),
    approvals: collection('approvals', row => ({ ...identity(row), runId: optionalId(row.runId), status: text(row.status, 100),
      kind: row.kind ?? 'tool_permission', fingerprint: row.kind === 'task_admission' ? text(row.fingerprint, 64) : null })),
    historyComplete: null,
  };
  // Optional historical collections may be absent. When both ends are present,
  // their original IDs and explicit attempts must agree; never fill a missing
  // attempt from the task's activeAttemptId or from a neighbouring record.
  const match = (row, key, candidates) => {
    if (!row[key] || candidates === null) return;
    const target = candidates.find(candidate => candidate.id === row[key]);
    check(target && (!row.attemptId || !target.attemptId || row.attemptId === target.attemptId), RESPONSE, 'PA record has an inconsistent native relationship.');
  };
  for (const row of result.runs ?? []) match(row, 'stageId', result.stages);
  for (const row of result.verifications ?? []) match(row, 'stageId', result.stages);
  for (const row of result.approvals ?? []) match(row, 'runId', result.runs);
  return result;
}
