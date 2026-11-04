import { createHash } from 'node:crypto';
import { check, identifier, only, record, sourceIdentifier } from './config.mjs';

export const canonical = value => JSON.stringify((function normalize(item) {
  return Array.isArray(item) ? item.map(normalize) : record(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)])) : item;
})(value));
export const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');

export function validateSource(value, code = 'PA_INVALID_RESPONSE') {
  only(value, ['kind', 'instanceId', 'sessionId', 'requestId'], code);
  check(value.kind === 'dsh-bot', code, 'PA task source kind is invalid.');
  return { kind: value.kind, instanceId: sourceIdentifier(value.instanceId, code), sessionId: sourceIdentifier(value.sessionId, code), requestId: sourceIdentifier(value.requestId, code) };
}

export function taskCommand(args, source, config) {
  only(args, ['requestId', 'goal', 'workspace']);
  sourceIdentifier(args.requestId);
  check(typeof args.goal === 'string' && args.goal.trim().length > 0 && args.goal.length <= 10000, 'PA_INVALID_INPUT', 'A nonempty bounded goal is required.');
  check(typeof args.workspace === 'string' && Object.hasOwn(config.submission.workspaces, args.workspace), 'PA_WORKSPACE_DENIED', 'Select an operator-allowed workspace alias.');
  const nativeSource = validateSource({ kind: 'dsh-bot', instanceId: config.instanceId, sessionId: source.callingSessionId, requestId: args.requestId }, 'PA_INVALID_INPUT');
  const commandId = 'forge_' + fingerprint([config.instanceId, nativeSource.sessionId, args.requestId]);
  return { commandId, goal: args.goal, engine: 'forge', workspaceId: config.submission.workspaces[args.workspace], source: nativeSource };
}

export function validatePostBody(body, config) {
  only(body, ['commandId', 'goal', 'engine', 'workspaceId', 'source']);
  check(typeof body.commandId === 'string' && /^forge_[a-f0-9]{64}$/.test(body.commandId), 'PA_INVALID_INPUT', 'A stable namespaced command ID is required.');
  check(typeof body.goal === 'string' && body.goal.trim().length > 0 && body.goal.length <= 10000 && body.engine === 'forge', 'PA_INVALID_INPUT', 'Intake accepts only bounded Forge goals.');
  identifier(body.workspaceId);
  check(Object.values(config.submission.workspaces).includes(body.workspaceId), 'PA_WORKSPACE_DENIED', 'Native workspace is not operator-allowed.');
  const source = validateSource(body.source, 'PA_INVALID_INPUT');
  check(source.instanceId === config.instanceId && body.commandId === 'forge_' + fingerprint([config.instanceId, source.sessionId, source.requestId]), 'PA_INVALID_INPUT', 'Command and configured source do not agree.');
}

// Cross-check the original PA admission evidence, never synthesize pending state
// from the request, HTTP status, or the bridge's operator configuration.
export function validateAdmission(posted, snapshot, body, config, httpStatus) {
  const code = 'PA_ADMISSION_MISMATCH';
  const immutable = task => {
    check(record(task) && typeof task.id === 'string' && /^[A-Za-z0-9_-]{1,1024}$/.test(task.id), code, 'PA task identity is invalid.');
    check(task.commandId === body.commandId && task.goal === body.goal && task.engine === 'forge' && task.workspaceId === body.workspaceId
      && task.intakeId === config.auth.intakeId && canonical(validateSource(task.source, code)) === canonical(body.source), code, 'PA task does not match the submitted identity and immutable request.');
    check(record(task.admission) && /^[a-f0-9]{64}$/.test(task.admission.fingerprint) && typeof task.admission.approvalId === 'string', code, 'PA task lacks original admission evidence.');
  };
  immutable(posted); immutable(snapshot?.task);
  const task = snapshot.task;
  check(posted.id === task.id && posted.admission.approvalId === task.admission.approvalId && posted.admission.fingerprint === task.admission.fingerprint,
    code, 'PA POST and snapshot refer to different task admissions.');
  check(Array.isArray(snapshot.approvals), code, 'PA snapshot lacks original task admission records.');
  const matches = snapshot.approvals.filter(row => row.id === task.admission.approvalId);
  check(matches.length === 1, code, 'PA original task admission is missing or duplicated.');
  const approval = matches[0];
  check(approval.kind === 'task_admission' && approval.taskId === task.id && approval.attemptId === null && approval.runId === null
    && approval.fingerprint === task.admission.fingerprint && record(approval.request) && fingerprint(approval.request) === approval.fingerprint,
  code, 'PA original task admission fingerprint or relationship is inconsistent.');
  const request = approval.request;
  check(request.goal === body.goal && request.engine === 'forge' && request.workspaceId === body.workspaceId && request.intakeId === config.auth.intakeId
    && canonical(validateSource(request.source, code)) === canonical(body.source), code, 'PA admission request differs from the submitted source and goal.');
  const pending = () => check(task.status === 'paused' && task.deliveryStatus === 'pending' && task.activeAttemptId === null && task.admission.status === 'pending'
    && approval.status === 'pending' && approval.selectedOptionId === null && approval.resolvedAt === null, code, 'New PA tasks must remain paused with an unresolved original admission.');
  if (httpStatus === 201) {
    check(posted.status === 'paused' && posted.deliveryStatus === 'pending' && posted.activeAttemptId === null && posted.admission.status === 'pending', code, 'A newly created PA task was already authorized or executing.');
    pending();
  } else if (task.admission.status === 'pending') pending();
  else if (task.admission.status === 'approved') check(approval.status === 'resolved' && approval.selectedOptionId === 'approve' && typeof approval.resolvedAt === 'string', code, 'PA approved admission lacks its original human decision.');
  else if (task.admission.status === 'rejected') check(approval.status === 'resolved' && approval.selectedOptionId === 'reject' && task.status === 'cancelled', code, 'PA rejected admission is inconsistent.');
  else check(task.admission.status === 'expired' && approval.status === 'expired', code, 'PA admission status is inconsistent.');
  return { task, approval };
}
