import { validateBinding, startupStatuses, writeEvidence } from './dsh-task-evidence.mjs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
export const inject = ['loader', 'appReady', 'profileContext'];
export async function apply(ctx, config) {
  const binding = validateBinding(config);
  // Resolved by the real DSH host; Forge does not ship another plugin runtime.
  const hostRequire = createRequire(ctx.profileContext.installAnchor);
  const { getDshRuntimeVersion } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-app-boot')).href);
  if (getDshRuntimeVersion() !== binding.runtimeVersion) throw new Error('unsupported DSH runtime');
  ctx.effect(() => ctx.appReady.onReady(() => {
    const entries = [...ctx.loader.entries()];
    writeEvidence(binding, startupStatuses(entries, binding.targetEntryIds));
  }));
}
