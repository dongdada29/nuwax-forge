import { createHash } from 'node:crypto';
import { createClient } from './client.mjs';
import { PersonalAgentError, check, identifier, only, validateConfig } from './config.mjs';
import { projectSnapshot, projectTaskList } from './projection.mjs';

export function createBridge(raw) {
  const config = validateConfig(raw), client = createClient(raw);
  const context = execution => {
    check(!execution?.signal?.aborted, 'PA_ABORTED', 'PA operation was cancelled.');
    return { kind: 'personal-agent', instanceId: config.instanceId, botId: config.botId,
      callingSessionId: identifier(execution?.agent?.session?.id), toolCallId: identifier(execution?.callId) };
  };
  return Object.freeze({
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
      only(args, ['requestId', 'goal', 'forgeTaskKey', 'forgeAttemptId']);
      const source = context(execution);
      check(typeof args.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(args.requestId), 'PA_INVALID_INPUT', 'An explicit requestId is required.');
      check(typeof args.goal === 'string' && args.goal.trim().length > 0 && args.goal.length <= 10000,
        'PA_INVALID_INPUT', 'A nonempty bounded goal is required.');
      // Caller-supplied Forge references are labelled as declarations, not proof
      // of a run or an association already persisted in the authoritative PA DB.
      const declaredForge = { taskKey: args.forgeTaskKey === undefined ? null : identifier(args.forgeTaskKey),
        attemptId: args.forgeAttemptId === undefined ? null : identifier(args.forgeAttemptId), verified: false };
      const request = { requestId: args.requestId, goal: args.goal, instanceId: config.instanceId, botId: config.botId,
        callingSessionId: source.callingSessionId, declaredForge };
      return {
        kind: 'personal-agent-request-preview', schemaVersion: 1, status: 'preview_only',
        notice: '未提交；未创建 PA 任务；未获执行授权。请在原 PA 工作台由操作者独立审阅与发起任务。',
        source, request,
        fingerprint: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
        deduplicationEnforced: false,
        submission: { submitted: false, paTaskCreated: false, executionAuthorized: false, paTaskId: null, paAttemptId: null, paRunId: null,
          nativeCommandId: null, nativeApprovalId: null },
        blocker: { code: 'PA_TASK_AUTHORIZATION_UNAVAILABLE', nativePreExecutionApproval: false, externalForgeResultImport: false },
      };
    },
    // A direct library caller cannot bypass the absent native authorization
    // boundary by skipping DSH's tool registry. No HTTP mutation is implemented.
    submitTask() { throw new PersonalAgentError('PA_TASK_AUTHORIZATION_UNAVAILABLE', 'PA has no native pre-execution task authorization flow. No task was submitted.'); },
  });
}
