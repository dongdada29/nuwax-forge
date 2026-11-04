// Test-only peer-service adapters. No DS-Bot source is rewritten or replaced.
const peers = new Set(['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm', 'deep-view/core']);

export function resolve(specifier, context, nextResolve) {
  if (peers.has(specifier)) return { url: new URL('./bots-memory-sdk.mjs', import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
