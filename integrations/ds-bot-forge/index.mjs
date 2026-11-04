import { createBridge } from './bridge.mjs';

export const name = 'forge-bot-bridge';
export const inject = ['tools'];

// Raw ToolDefinition is the shipped DSH 0.2.1-rc.5 API. Registering through the
// native registry retains native pre-execute policy, guards and cancellation.
export function apply(ctx, config) {
  const bridge = createBridge(config);
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
  const definitions = [
    { name: 'forge_status', description: 'Read one explicitly identified Forge attempt from the operator-authorized root. Unknown usage is unknown. No session discovery.',
      parameters: { type: 'object', additionalProperties: false, required: ['attemptId'], properties: { attemptId: { type: 'string' } } },
      output, isConcurrencySafe: () => true, execute: bridge.status },
    { name: 'forge_prepare', description: 'Prepare a fresh bounded Forge task with operator-configured workspace/runtime/budget. Does not call a model, run work, or approve execution. Return run argv only for an authorized human operator.',
      parameters: { type: 'object', additionalProperties: false, required: ['workspace', 'taskKey', 'brief'], properties: { workspace: { type: 'string' }, taskKey: { type: 'string' }, brief: { type: 'string' } } },
      output, timeoutMs: 35000, isConcurrencySafe: () => false, execute: bridge.prepare },
  ];
  const disposers = [];
  try { for (const definition of definitions) disposers.push(ctx.tools.register(definition)); }
  catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error; }
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
