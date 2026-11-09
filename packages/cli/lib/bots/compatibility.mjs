import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOT_FILES } from './pin.mjs';

const target = 'src/host/tools.js';
const oldFilter = 'tools: assembled.tools.filter(tool => !HIDDEN_TOOLS.includes(tool.name)),';
const newFilter = '...(Array.isArray(assembled.tools) ? { tools: assembled.tools.filter(tool => !HIDDEN_TOOLS.includes(tool.name)) } : {}),';
const hook = "  const { ctx, state } = rt\n";
const moduleSource = `// Forge compatibility for DSH 0.2.2's split prompt presentation and tool assembly.
export function installPromptAssemblyCompat(rt, hiddenTools) {
  const service = rt.ctx.systemPrompt
  const descriptor = Object.getOwnPropertyDescriptor(service, 'assemble')
  const assemble = service.assemble
  const hidden = new Set(hiddenTools)
  const compatible = async function (...args) {
    const assembled = await assemble.apply(this, args)
    const context = args[0]
    const agent = context?.agent ?? context?.scope
    const id = agent?.session?.id ?? agent?.id
    if (!rt.isBotSession(id)) return assembled
    return { ...assembled, tools: assembled.tools.filter(tool => !hidden.has(tool.name)) }
  }
  rt.ctx.effect(() => {
    service.assemble = compatible
    return () => {
      if (Object.getOwnPropertyDescriptor(service, 'assemble')?.value !== compatible) return
      if (descriptor === undefined) delete service.assemble
      else Object.defineProperty(service, 'assemble', descriptor)
    }
  }, 'forge: DSH 0.2.2 prompt assembly compatibility')
}
`;
const sha = value => createHash('sha256').update(value).digest('hex');
const check = (ok, message) => { if (!ok) throw new Error(message); };

function patched(original) {
  check(sha(original) === BOT_FILES[target], 'Original DS-Bot tools artifact changed');
  check(original.split(oldFilter).length === 2 && original.split(hook).length === 2, 'DS-Bot compatibility patch drift');
  return "// Modified by Forge for DSH 0.2.2 prompt assembly.\nimport { installPromptAssemblyCompat } from './forge-prompt-compat.js'\n" +
    original.replace(oldFilter, newFilter).replace(hook, hook + '  installPromptAssemblyCompat(rt, HIDDEN_TOOLS)\n');
}

export function compatibilityFiles(paths, runtimeVersion, install = false) {
  const originalFile = join(paths.root, 'artifacts', 'ds-bot-tools-original.js');
  if (runtimeVersion !== '0.2.2-rc.1' && (!install || !existsSync(originalFile))) return BOT_FILES;
  const packageDir = realpathSync(join(paths.profileDir, 'node_modules', 'ds-bot'));
  check(packageDir.startsWith(realpathSync(paths.root) + '/'), 'Compatibility package escaped managed root');
  const file = join(packageDir, target);
  const helper = join(packageDir, 'src/host/forge-prompt-compat.js');
  for (const directory of [join(paths.root, 'artifacts'), join(packageDir, 'src'), join(packageDir, 'src/host')]) {
    const stat = lstatSync(directory);
    check(stat.isDirectory() && !stat.isSymbolicLink(), 'Unsafe compatibility directory');
  }
  for (const candidate of [file, originalFile, helper]) {
    const stat = lstatSync(candidate, { throwIfNoEntry: false });
    check(!stat || stat.isFile() && !stat.isSymbolicLink(), 'Unsafe compatibility file');
  }
  if (install && !existsSync(originalFile)) {
    const original = readFileSync(file, 'utf8');
    check(sha(original) === BOT_FILES[target], 'Refusing to patch an unrecognized DS-Bot artifact');
    writeFileSync(originalFile, original, { flag: 'wx', mode: 0o600 });
  }
  check(existsSync(originalFile), 'DSH 0.2.2 compatibility requires bots prepare on this managed team');
  const expected = patched(readFileSync(originalFile, 'utf8'));
  if (runtimeVersion !== '0.2.2-rc.1') {
    check([BOT_FILES[target], sha(expected)].includes(sha(readFileSync(file))), 'DS-Bot compatibility file has local changes');
    writeFileSync(file, readFileSync(originalFile));
    return BOT_FILES;
  }
  if (install) {
    const current = sha(readFileSync(file));
    check([BOT_FILES[target], sha(expected)].includes(current), 'DS-Bot compatibility file has local changes');
    check(!existsSync(helper) || readFileSync(helper, 'utf8') === moduleSource, 'DS-Bot compatibility helper changed');
    writeFileSync(helper, moduleSource, { mode: 0o600 });
    writeFileSync(file, expected);
  }
  check(existsSync(helper) && readFileSync(helper, 'utf8') === moduleSource, 'DS-Bot compatibility helper missing or changed');
  return { ...BOT_FILES, [target]: sha(expected) };
}
