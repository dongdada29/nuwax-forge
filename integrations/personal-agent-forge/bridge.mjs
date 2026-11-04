import { createHash } from 'node:crypto';
import { createClient } from './client.mjs';
import { PersonalAgentError, check, identifier, only, sourceIdentifier, validateConfig } from './config.mjs';
import { projectSnapshot, projectTaskList } from './projection.mjs';
import { taskCommand, validateAdmission } from './admission.mjs';

export function createBridge(raw) {
  const config = validateConfig(raw), client = createClient(raw);
  const context = execution => {
    check(!execution?.signal?.aborted, 'PA_ABORTED', 'PA operation was cancelled.');
    const sessionId = execution?.agent?.session?.id;
    check(typeof sessionId === 'string' && sessionId.length >= 1 && sessionId.length <= 1024 && !/[\x00-\x1f\x7f]/.test(sessionId), 'PA_INVALID_INPUT', 'A complete actual DSH session identifier is required.');
    return { kind: 'personal-agent', instanceId: config.instanceId, botId: config.botId,
      callingSessionId: sessionId, toolCallId: identifier(execution?.callId) };
  };
  const bridge = {
    async tasks(args, execution) {
      only(args, []);
      const source = context(execution);
      return { kind: 'personal-agent-tasks', schemaVersion: 1, source,
        tasks: projectTaskList(await client.listTasks({ signal: execution.signal }), config) };
    },
    async task(args, execution) {
      only(args, ['taskId']); identifier(args.taskId);
      const source = context(execution);
      return { kind: 'personal-agent-task', schemaVersion: 1, source,
        snapshot: projectSnapshot(await client.taskSnapshot(args.taskId, { signal: execution.signal }), args.taskId, config) };
    },
    requestPreview(args, execution) {
      only(args, ['requestId', 'goal', 'workspace', 'forgeTaskKey', 'forgeAttemptId']);
      const source = context(execution);
      sourceIdentifier(args.requestId);
      check(typeof args.goal === 'string' && args.goal.trim().length > 0 && args.goal.length <= 10000,
        'PA_INVALID_INPUT', 'A nonempty bounded goal is required.');
      // Caller-supplied Forge references are labelled as declarations, not proof
      // of a run or an association already persisted in the authoritative PA DB.
      const declaredForge = { taskKey: args.forgeTaskKey === undefined ? null : identifier(args.forgeTaskKey),
        attemptId: args.forgeAttemptId === undefined ? null : identifier(args.forgeAttemptId), verified: false };
      const request = { requestId: args.requestId, goal: args.goal, instanceId: config.instanceId, botId: config.botId,
        callingSessionId: source.callingSessionId, declaredForge,
        ...(args.workspace === undefined ? {} : { workspace: identifier(args.workspace), nativeWorkspaceId: config.submission.workspaces[args.workspace] ?? null }) };
      return {
        kind: 'personal-agent-request-preview', schemaVersion: 1, status: 'preview_only',
        notice: '未提交；未创建 PA 任务；未获执行授权。请在原 PA 工作台由操作者独立审阅与发起任务。',
        source, request,
        fingerprint: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
        deduplicationEnforced: false,
        submission: { submitted: false, paTaskCreated: false, executionAuthorized: false, paTaskId: null, paAttemptId: null, paRunId: null,
          nativeCommandId: null, nativeApprovalId: null },
        blocker: { code: config.submission.enabled ? 'PA_PREVIEW_ONLY' : 'PA_SUBMISSION_DISABLED', nativePreExecutionApproval: null, externalForgeResultImport: null },
      };
    },
    request(args, execution) {
      only(args, ['requestId', 'goal', 'workspace']);
      if (!config.submission.enabled) return bridge.requestPreview(args, execution);
      return bridge.submitTask(args, execution);
    },
    submitTask(args, execution) {
      check(config.auth.mode === 'intake' && config.submission.enabled, 'PA_TASK_AUTHORIZATION_UNAVAILABLE', 'Intake submission is not explicitly enabled. No task was submitted.');
      const source = context(execution), body = taskCommand(args, source, config);
      return (async () => {
        try {
          const posted = await client.submitTask(body, { signal: execution.signal });
          check(typeof posted.task?.id === 'string' && /^[A-Za-z0-9_-]{1,1024}$/.test(posted.task.id), 'PA_ADMISSION_MISMATCH', 'PA returned an invalid task identity.');
          const rawSnapshot = await client.taskSnapshot(posted.task.id, { signal: execution.signal });
          const { task, approval } = validateAdmission(posted.task, rawSnapshot, body, config, posted.httpStatus);
          const snapshot = projectSnapshot(rawSnapshot, task.id, config);
          return { kind: 'personal-agent-request', schemaVersion: 1, status: task.admission.status === 'pending' ? 'awaiting_human_approval' : 'existing_task',
            notice: task.admission.status === 'pending' ? '已提交原 PA，等待原工作台人工审批；尚未获执行授权。' : '已找到原 PA 任务；以下为原任务和人工准入的当前事实。',
            source, requestId: args.requestId, commandId: body.commandId, replayed: posted.httpStatus === 200,
            submission: { submitted: true, paTaskCreated: posted.httpStatus === 201, executionAuthorized: task.admission.status === 'approved',
              paTaskId: task.id, paAttemptId: task.activeAttemptId, nativeCommandId: task.commandId, nativeApprovalId: approval.id },
            admission: { kind: 'task_admission', id: approval.id, fingerprint: approval.fingerprint, status: task.admission.status,
              selectedOptionId: approval.selectedOptionId, resolvedAt: approval.resolvedAt }, snapshot,
          };
        } catch (failure) {
          const error = new PersonalAgentError(failure instanceof PersonalAgentError ? failure.code : 'PA_INVALID_RESPONSE',
            `PA submission could not be confirmed. Keep the same requestId and inspect/replay commandId=${body.commandId}; do not assume no task was created.`);
          error.submissionState = 'unknown'; error.commandId = body.commandId; error.source = source;
          throw error;
        }
      })();
    },
  };
  return Object.freeze(bridge);
}
