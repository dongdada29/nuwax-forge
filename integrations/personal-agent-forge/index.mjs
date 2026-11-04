import { createBridge } from './bridge.mjs';

export const name = 'personal-agent-forge';
export const inject = ['tools'];

// The same native ToolDefinition contract used by the existing Forge bridge.
// DSH owns policy guards, pre-execute approval, cancellation, and disposal.
export function apply(ctx, config) {
  const bridge = createBridge(config);
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
  const definitions = [
    { name: 'personal_agent_tasks', description: 'Read tasks from one operator-selected local Personal Agent. No discovery, submission, or approval.',
      parameters: { type: 'object', additionalProperties: false, properties: {} }, execute: bridge.tasks },
    { name: 'personal_agent_task', description: 'Read an explicitly identified original PA task with complete IDs and unknown usage retained. No control or approval.',
      parameters: { type: 'object', additionalProperties: false, required: ['taskId'], properties: { taskId: { type: 'string', maxLength: 1024 } } }, execute: bridge.task },
    { name: 'personal_agent_request_preview', description: 'Preview only: 未提交、未创建 PA 任务、未获执行授权. Produces no persistent task, approval, execution, or command. Forge references are unverified declarations.',
      parameters: { type: 'object', additionalProperties: false, required: ['requestId', 'goal'], properties: {
        requestId: { type: 'string', maxLength: 128 }, goal: { type: 'string', maxLength: 10000 },
        forgeTaskKey: { type: 'string', maxLength: 1024 }, forgeAttemptId: { type: 'string', maxLength: 1024 },
      } }, execute: bridge.requestPreview },
  ];
  const disposers = [];
  try {
    for (const definition of definitions) disposers.push(ctx.tools.register({ ...definition, output, timeoutMs: 35000, isConcurrencySafe: () => true }));
  } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error; }
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
