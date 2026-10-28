#!/usr/bin/env node
// nuwa-sdlc-kit CLI —— 零依赖。init=安装/补齐；check=漂移体检；upgrade=仅刷新引擎件。
// 设计约定：引擎件（hooks/settings，带 "nuwa-sdlc-kit v" 头）升级时覆盖；
// 内容件（templates/skills/REVIEW/verifier）播种一次、本地所有，永不覆盖。
// profile（v1.5.0+）：slim=地板层（guard/deploy 双 hook + 单遍 REVIEW + 单件计划模板，
// .sdlc.json 不写 srcPaths → plan-gate 与 ACP 侧计划门均不触发），新仓默认档；
// full=完整工件链（v1.4.0 面）。已装仓 .sdlc.json 无 profile 字段视为 full（老仓零惊扰），
// 显式 --profile slim|full 才转换；转换只删引擎件/接线/kit 播种的 CI，内容件保留列清单。
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, chmodSync, rmSync } from 'node:fs';
import { resolve, dirname, join, basename, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const KIT = resolve(dirname(fileURLToPath(import.meta.url)));
const VERSION = readFileSync(join(KIT, 'kit', 'VERSION'), 'utf8').trim();
const args = process.argv.slice(2);
const cmd = args[0] ?? 'help';
const flag = (k, d = '') => { const i = args.indexOf(`--${k}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const dir = resolve(flag('dir', '.'));
const log = (...m) => console.log(...m);
const rel = p => relative(dir, p).split(sep).join('/');
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12);

function loadCfg() {
  const p = resolve(dir, '.sdlc.json');
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
}
// profile 解析：显式 --profile > .sdlc.json profile > 已装老仓（无字段）= full / 新仓 = slim
function resolveProfile(old, hasCfg) {
  const p = flag('profile', old.profile ?? (hasCfg ? 'full' : 'slim'));
  if (!['slim', 'full'].includes(p)) { console.error(`--profile 仅支持 slim|full（当前: ${p}）`); process.exit(1); }
  return p;
}
function render(tpl, cfg) {
  const grill = (cfg.grillExtra ?? []).map(s => `- ${s}`).join('\n');
  return tpl
    .replaceAll('{{PROJECT_NAME}}', cfg.name ?? 'repo')
    .replaceAll('{{TEST_COMMAND}}', cfg.test ?? 'pnpm test')
    .replaceAll('{{ENVPREFIX}}', cfg.envPrefix ?? 'SDLC')
    .replaceAll('{{GRILL_EXTRA_SECTION}}', grill || '（安装后按仓库实际维护此节）');
}
// 引擎件清单：[kit 源文件, 目标仓相对位置]。引擎文件跨仓逐字节相同，upgrade 覆盖。
// slim 只装地板两件；full 追加 plan-gate 与 evals。
const ENGINE_FLOOR = [
  ['guard-paths.mjs', '.claude/hooks/guard-paths.mjs'],
  ['deploy-gate.mjs', '.claude/hooks/deploy-gate.mjs'],
];
const ENGINE_FULL = [
  ['plan-gate.mjs', '.claude/hooks/plan-gate.mjs'],
  ['evals.mjs', 'scripts/sdlc-evals.mjs'],
];
const engineList = profile => profile === 'slim' ? ENGINE_FLOOR : [...ENGINE_FLOOR, ...ENGINE_FULL];
function copyEngine([src, dstRel]) {
  const dst = resolve(dir, dstRel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(join(KIT, 'kit/engine', src), dst);
  return dst;
}
function mergeSettings(profile) {
  const kitSettings = JSON.parse(readFileSync(join(KIT, 'kit/engine/settings.json'), 'utf8'));
  const dst = resolve(dir, '.claude/settings.json');
  let cur = {};
  if (existsSync(dst)) { try { cur = JSON.parse(readFileSync(dst, 'utf8')); } catch { cur = {}; } }
  cur.hooks ??= {}; cur.hooks.PreToolUse ??= [];
  // slim：剪除既有 plan-gate 接线（fresh 与转换统一走这里）
  if (profile === 'slim') cur.hooks.PreToolUse = cur.hooks.PreToolUse
    .map(e => ({ ...e, hooks: (e.hooks ?? []).filter(h => !String(h.command ?? '').includes('plan-gate.mjs')) }))
    .filter(e => (e.hooks ?? []).length > 0);
  const have = new Set(cur.hooks.PreToolUse.flatMap(e => (e.hooks ?? []).map(h => h.command)));
  for (const entry of kitSettings.hooks.PreToolUse) {
    if (profile === 'slim' && (entry.hooks ?? []).some(h => h.command.includes('plan-gate.mjs'))) continue;
    for (const h of entry.hooks ?? []) {
      if (!have.has(h.command)) {
        cur.hooks.PreToolUse.push({ matcher: entry.matcher, hooks: [{ type: h.type, command: h.command }] });
        have.add(h.command);
      }
    }
  }
  cur.permissions ??= {};
  cur.permissions.deny = [...new Set([...(cur.permissions.deny ?? []), ...(kitSettings.permissions.deny ?? [])])];
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, JSON.stringify(cur, null, 2) + '\n');
  return dst;
}
// ZCode 客户端接线（v1.3.0+）：PreToolUse 闸门合入 <repo>/.zcode/config.json。
// ZCode 与 Claude Code 的 hook 协议同构（stdin 事件 JSON、exit 0 放行 / 2 阻断），engine 文件零适配复用；
// 配置文件 hooks 默认关闭，须 hooks.enabled:true；${ZCODE_PROJECT_DIR} 模板变量同时以环境变量注入，
// engine 侧已有 env 兜底解析 .sdlc.json。matcher 为大小写敏感正则（对工具名）。
const ZCODE_HOOKS = [
  { matcher: 'Read|Edit|Write|Bash', command: 'node "${ZCODE_PROJECT_DIR}/.claude/hooks/guard-paths.mjs"' },
  { matcher: 'Edit|Write', command: 'node "${ZCODE_PROJECT_DIR}/.claude/hooks/plan-gate.mjs"' },
  { matcher: 'Bash', command: 'node "${ZCODE_PROJECT_DIR}/.claude/hooks/deploy-gate.mjs"' },
];
function mergeZcodeConfig(profile) {
  const dst = resolve(dir, '.zcode/config.json');
  let cur = {};
  if (existsSync(dst)) { try { cur = JSON.parse(readFileSync(dst, 'utf8')); } catch { cur = {}; } }
  cur.hooks ??= {};
  cur.hooks.enabled = true;
  cur.hooks.events ??= {};
  cur.hooks.events.PreToolUse ??= [];
  if (profile === 'slim') cur.hooks.events.PreToolUse = cur.hooks.events.PreToolUse
    .map(e => ({ ...e, hooks: (e.hooks ?? []).filter(h => !String(h.command ?? '').includes('plan-gate.mjs')) }))
    .filter(e => (e.hooks ?? []).length > 0);
  const have = new Set(cur.hooks.events.PreToolUse.flatMap(e => (e.hooks ?? []).map(h => h.command)));
  for (const { matcher, command } of ZCODE_HOOKS) {
    if (profile === 'slim' && command.includes('plan-gate.mjs')) continue;
    if (have.has(command)) continue;
    cur.hooks.events.PreToolUse.push({ matcher, hooks: [{ type: 'command', command }] });
  }
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, JSON.stringify(cur, null, 2) + '\n');
  return dst;
}
function upsertAgentsSection(cfg, profile) {
  const secTpl = readFileSync(join(KIT, 'kit/content', profile === 'slim' ? 'AGENTS-SECTION.slim.md' : 'AGENTS-SECTION.md'), 'utf8');
  const agents = resolve(dir, 'AGENTS.md');
  let created = false;
  let text;
  if (existsSync(agents)) text = readFileSync(agents, 'utf8');
  else {
    created = true;
    text = `# ${cfg.name ?? 'repo'} · Agent 速览\n\n（由 nuwa-sdlc-kit 创建骨架，仓库内容请自行补全。）\n`;
  }
  const rendered = secTpl
    .replaceAll('{{ENVPREFIX}}', cfg.envPrefix ?? 'SDLC')
    .replaceAll('{{TEST_COMMAND}}', cfg.test ?? 'pnpm test')
    .replaceAll('{{ENTRY_NOTE}}', existsSync(resolve(dir, 'CLAUDE.md'))
      ? '（根 CLAUDE.md 已存在，建议人工收敛为单行 `@AGENTS.md` 指针）'
      : '（根 CLAUDE.md 是一行 `@AGENTS.md` 指针，由安装器创建）');
  const begin = /<!-- nuwa-sdlc-kit:begin[^\n]*-->/;
  if (begin.test(text)) {
    text = text.replace(/<!-- nuwa-sdlc-kit:begin[\s\S]*?<!-- nuwa-sdlc-kit:end -->/, rendered.trim());
  } else {
    text = text.trimEnd() + '\n\n' + rendered.trim() + '\n';
  }
  writeFileSync(agents, text);
  if (!existsSync(resolve(dir, 'CLAUDE.md'))) writeFileSync(resolve(dir, 'CLAUDE.md'), '@AGENTS.md\n');
  return { agents, created };
}
function seedIfAbsent(src, dst) {
  if (existsSync(dst)) return false;
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  return true;
}
// CI 门禁落点：显式 --ci 胜出；其次仓库已有 .gitlab-ci.yml；再次 origin 指向含 gitlab
// 或命中 NUWA_SDLK_GITLAB_HOSTS（逗号分隔，self-host 域名识别用）；其余默认 github。
function ciTarget() {
  const want = flag('ci', 'auto');
  if (['github', 'gitlab', 'both'].includes(want)) return want;
  if (existsSync(resolve(dir, '.gitlab-ci.yml'))) return 'gitlab';
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8' });
  const url = r.status === 0 ? (r.stdout || '') : '';
  const hosts = (process.env.NUWA_SDLK_GITLAB_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (/gitlab/i.test(url) || hosts.some(h => url.includes(h))) return 'gitlab';
  return 'github';
}
const CI_MAP = {
  github: ['.github/workflows/sdlc-evals.yml', 'ci/github-sdlc-evals.yml'],
  gitlab: ['.gitlab-ci.yml', 'ci/gitlab-sdlc-evals.yml'],
};
// kit skills 清单：播种到 .claude/skills/（Claude Code 原生发现）与
// .agents/skills/（ZCode workspace 级原生发现，codex 等亦可直读）双落点，内容同源。
const SKILLS = ['requirement-analysis', 'grill-with-docs', 'pre-commit-quality-review'];
const SKILL_BASES = ['.claude/skills', '.agents/skills'];
// kit slash commands 清单：同样双落点——.claude/commands/（Claude Code）与
// .agents/commands/（ZCode workspace 级发现，免动 .zcode/ 忽略规则）。文件名即命令名。
const COMMANDS = ['quality-review'];
const COMMAND_BASES = ['.claude/commands', '.agents/commands'];
// full 面专属内容件（slim 不播种；转换时保留、仅列遗留清单）
const FULL_CONTENT = [
  'templates/intent.md', 'templates/spec.md', '.claude/agents/verifier.md',
  ...SKILLS.flatMap(sk => SKILL_BASES.map(base => `${base}/${sk}/SKILL.md`)),
  ...COMMANDS.flatMap(c => COMMAND_BASES.map(base => `${base}/${c}.md`)),
  'samples/deploy-gate.example.json', 'samples/maintain-bands.md', 'samples/pre-commit.secrets.sh',
];
function seedContentTree(cfg, profile) {
  const seeded = [], kept = [];
  const srcRoot = join(KIT, 'kit/content');
  // slim 只播单件计划模板与单遍 REVIEW（源为 .slim 变体）；full 播完整工件链内容件。
  const contents = profile === 'slim'
    ? [['templates/plan.slim.md', 'templates/plan.md'], ['REVIEW.slim.md', 'REVIEW.md']]
    : [
      ['templates/intent.md', 'templates/intent.md'],
      ['templates/spec.md', 'templates/spec.md'],
      ['templates/plan.md', 'templates/plan.md'],
      ['REVIEW.md', 'REVIEW.md'],
    ];
  for (const [src, dstRel] of contents) {
    const dst = resolve(dir, dstRel);
    if (seedIfAbsent(join(srcRoot, src), dst)) { seeded.push(dstRel); writeFileSync(dst, render(readFileSync(dst, 'utf8'), cfg)); }
    else kept.push(dstRel);
  }
  if (profile === 'slim') return { seeded, kept };
  const vdst = resolve(dir, '.claude/agents/verifier.md');
  if (seedIfAbsent(join(srcRoot, 'agents-verifier.md'), vdst)) { seeded.push('.claude/agents/verifier.md'); writeFileSync(vdst, render(readFileSync(vdst, 'utf8'), cfg)); }
  else kept.push('.claude/agents/verifier.md');
  for (const sk of SKILLS) for (const base of SKILL_BASES) {
    const sdst = resolve(dir, base, sk, 'SKILL.md');
    if (seedIfAbsent(join(srcRoot, 'skills', sk, 'SKILL.md'), sdst)) { seeded.push(`${base}/${sk}/SKILL.md`); writeFileSync(sdst, render(readFileSync(sdst, 'utf8'), cfg)); }
    else kept.push(`${base}/${sk}/SKILL.md`);
    const rsrc = join(srcRoot, 'skills', sk, 'references');
    if (existsSync(rsrc)) for (const f of readdirSync(rsrc)) {
      const rd = resolve(dir, base, sk, 'references', f);
      if (seedIfAbsent(join(rsrc, f), rd)) seeded.push(`${base}/${sk}/references/${f}`);
    }
  }
  for (const c of COMMANDS) for (const base of COMMAND_BASES) {
    const cdst = resolve(dir, base, `${c}.md`);
    if (seedIfAbsent(join(srcRoot, 'commands', `${c}.md`), cdst)) { seeded.push(`${base}/${c}.md`); writeFileSync(cdst, render(readFileSync(cdst, 'utf8'), cfg)); }
    else kept.push(`${base}/${c}.md`);
  }
  for (const f of ['samples/deploy-gate.example.json', 'samples/maintain-bands.md', 'samples/pre-commit.secrets.sh']) {
    const dst = resolve(dir, f);
    if (seedIfAbsent(join(srcRoot, f), dst)) seeded.push(f); else kept.push(f);
  }
  const ci = ciTarget();
  for (const [dstCI, srcCI] of ci === 'both' ? Object.values(CI_MAP) : [CI_MAP[ci]]) {
    if (seedIfAbsent(join(srcRoot, srcCI), resolve(dir, dstCI))) { seeded.push(dstCI); writeFileSync(resolve(dir, dstCI), render(readFileSync(resolve(dir, dstCI), 'utf8'), cfg)); }
    else kept.push(dstCI);
  }
  return { seeded, kept };
}
function writeConfig(cfg, switching) {
  const p = resolve(dir, '.sdlc.json');
  if (existsSync(p)) {
    if (!switching) { log(`= .sdlc.json 已存在，保留不覆盖`); return p; }
    const cur = JSON.parse(readFileSync(p, 'utf8'));
    cur.profile = cfg.profile;
    if (cfg.profile === 'slim') { delete cur.srcPaths; delete cur.plansDirs; delete cur.grillExtra; }
    else { cur.srcPaths ??= cfg.srcPaths; cur.plansDirs ??= cfg.plansDirs; }
    writeFileSync(p, JSON.stringify(cur, null, 2) + '\n');
    log(`~ .sdlc.json profile → ${cfg.profile}${cfg.profile === 'slim' ? '（srcPaths/plansDirs 已移除，计划门静默）' : ''}`);
    return p;
  }
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  return p;
}
// full→slim 转换清理：删 full 专属引擎件与 kit 播种的 CI evals 工作流；内容件不删、列遗留清单。
// 引擎件按「头含 kit 标记」判定可删（托管契约：upgrade 本就覆盖）；.gitlab-ci.yml 可能是仓库
// 自有流水线，仅逐字节等于 kit 模板渲染结果才删，否则提示人工确认。
function cleanupToSlim(cfg) {
  const removed = [], manual = [];
  for (const dstRel of ['.claude/hooks/plan-gate.mjs', 'scripts/sdlc-evals.mjs']) {
    const p = resolve(dir, dstRel);
    if (!existsSync(p)) continue;
    if (readFileSync(p, 'utf8').slice(0, 300).includes('nuwa-sdlc-kit')) { rmSync(p); removed.push(dstRel); }
    else manual.push(`${dstRel}（头无 kit 标记，疑本地改造，未删）`);
  }
  const gh = resolve(dir, '.github/workflows/sdlc-evals.yml');
  if (existsSync(gh)) {
    if (readFileSync(gh, 'utf8').includes('nuwa-sdlc-kit')) { rmSync(gh); removed.push('.github/workflows/sdlc-evals.yml'); }
    else manual.push('.github/workflows/sdlc-evals.yml（头无 kit 标记，未删）');
  }
  const gl = resolve(dir, '.gitlab-ci.yml');
  if (existsSync(gl)) {
    const body = readFileSync(gl, 'utf8');
    if (body.includes('nuwa-sdlc-kit')) {
      const tpl = render(readFileSync(join(KIT, 'kit/content/ci/gitlab-sdlc-evals.yml'), 'utf8'), cfg);
      if (body === tpl) { rmSync(gl); removed.push('.gitlab-ci.yml'); }
      else manual.push('.gitlab-ci.yml（kit 播种但已被本地修改，请手工移除 evals job）');
    }
  }
  if (removed.length) log(`- 转换清理（full→slim）: ${removed.join(', ')}`);
  if (manual.length) log(`! 需人工处理: ${manual.join('；')}`);
  const leftovers = FULL_CONTENT.filter(f => existsSync(resolve(dir, f)));
  if (leftovers.length) log(`· full 内容件遗留（本地所有，可手工删）: ${leftovers.join(', ')}`);
}

if (cmd === 'verify:init') {
  // Explicit opt-in: preserve existing profile, hooks, and project-owned recipe.
  const recipe = flag('recipe');
  const absolute = resolve(dir, recipe);
  if (!recipe || relative(dir, absolute).startsWith('..') || !existsSync(absolute)) {
    throw new Error('verify:init requires an existing repository-local --recipe');
  }
  const p = resolve(dir, '.sdlc.json');
  const cfg = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  cfg.verification = { schemaVersion: 1, recipe, runner: 'scripts/sdlc-verify.mjs' };
  mkdirSync(resolve(dir, 'scripts'), { recursive: true });
  copyFileSync(join(KIT, 'kit/engine/verify.mjs'), resolve(dir, cfg.verification.runner));
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  log('Verification runner installed; profile and hooks preserved.');
} else if (cmd === 'verify') {
  const cfg = loadCfg();
  const recipe = flag('recipe', cfg.verification?.recipe);
  const output = flag('output');
  if (!recipe || !output) throw new Error('verify requires a recipe and --output');
  const { runVerification } = await import('./kit/engine/verify.mjs');
  const result = await runVerification({ root: dir, recipePath: recipe, output, reuse: args.includes('--reuse') });
  log(JSON.stringify(result));
  process.exitCode = result.passed ? 0 : 1;
} else if (cmd === 'init' || cmd === 'upgrade') {
  const old = loadCfg();
  const hasCfg = existsSync(resolve(dir, '.sdlc.json'));
  // init 重跑已装仓时 cfg 默认取旧 .sdlc.json（显式 flag 仍优先），
  // 避免裸 init 用出厂默认重渲染 AGENTS 托管区把 envPrefix/test 等占位符值冲掉。
  const profile = resolveProfile(old, hasCfg);
  const switching = hasCfg && (old.profile ?? 'full') !== profile;
  const cfg = {
    profile,
    name: flag('name', old.name ?? basename(dir)),
    protectedWrite: flag('protected', (old.protectedWrite ?? []).join(',')).split(',').map(s => s.trim()).filter(Boolean),
    envPrefix: flag('env-prefix', old.envPrefix ?? 'SDLC'),
    test: flag('test', old.test ?? 'pnpm test'),
  };
  if (profile === 'full') {
    cfg.srcPaths = flag('src', (old.srcPaths ?? ['packages/[^/]+/src/', 'apps/[^/]+/src/']).join(',')).split(',').map(s => s.trim()).filter(Boolean);
    cfg.plansDirs = flag('plans-dirs', (old.plansDirs ?? ['plans', 'specs']).join(',')).split(',');
    cfg.grillExtra = (() => { const f = flag('grill', ''); try { return f ? readFileSync(resolve(f), 'utf8').split('\n').map(s => s.replace(/^- /, '').trim()).filter(Boolean) : (old.grillExtra ?? []); } catch { return []; } })();
  }
  if (!existsSync(dir)) { console.error(`目标目录不存在: ${dir}`); process.exit(1); }
  if (cmd === 'init' || switching) writeConfig(cfg, switching);

  const engine = engineList(profile).map(copyEngine);
  if (old.verification?.runner === 'scripts/sdlc-verify.mjs') {
    mkdirSync(resolve(dir, 'scripts'), { recursive: true });
    copyFileSync(join(KIT, 'kit/engine/verify.mjs'), resolve(dir, old.verification.runner));
  }
  const settings = mergeSettings(profile);
  const zcode = mergeZcodeConfig(profile);
  const { agents, created } = upsertAgentsSection(cfg, profile);
  if (profile === 'slim') cleanupToSlim(cfg);
  if (cmd === 'init') {
    const { seeded, kept } = seedContentTree(cfg, profile);
    if (args.includes('--pre-commit')) {
      const hookDst = resolve(dir, '.git/hooks/pre-commit');
      if (!existsSync(hookDst)) {
        mkdirSync(dirname(hookDst), { recursive: true });
        copyFileSync(join(KIT, 'kit/content/samples/pre-commit.secrets.sh'), hookDst);
        chmodSync(hookDst, 0o755);
        log(`+ .git/hooks/pre-commit（秘钥地板，--pre-commit 安装）`);
      } else log(`= .git/hooks/pre-commit 已存在，未动`);
    }
    log(`\n✅ nuwa-sdlc-kit v${VERSION} init 完成（${cfg.name ?? basename(dir)} · profile: ${profile}${switching ? ' · 已转换' : ''}）`);
    log(`引擎件（托管，upgrade 可覆盖）: ${engine.map(e => rel(e)).join(', ')} + ${rel(settings)} + ${rel(zcode)}（ZCode 接线）`);
    log(`内容件（播种 ${seeded.length} 个，本地保留 ${kept.length} 个）:`);
    seeded.forEach(f => log(`  + ${f}`)); kept.forEach(f => log(`  = ${f}（已存在，未动）`));
    log(`入口: ${rel(agents)}${created ? '（新建）' : '（追加/刷新托管区间）'}；CLAUDE.md 指针${existsSync(resolve(dir, 'CLAUDE.md')) ? '就绪/保留' : '待建'}`);
  } else {
    log(`✅ nuwa-sdlc-kit v${VERSION} upgrade（profile: ${profile}${switching ? ' · 已转换；内容件不随 upgrade 播种，需补请重跑 init' : '：引擎件已刷新，内容件一律未动'}）`);
  }
  log(`下一步: ① 重启 Claude Code / ZCode 会话使 hooks 生效（ZCode 读 .zcode/config.json） ② 跑 node ${rel(resolve(KIT, 'cli.mjs'))} check 体检`);
} else if (cmd === 'check') {
  const cfg = loadCfg();
  const hasCfg = existsSync(resolve(dir, '.sdlc.json'));
  const profile = ['slim', 'full'].includes(cfg.profile) ? cfg.profile : (hasCfg ? 'full' : 'slim');
  const wantHooks = profile === 'slim'
    ? ['guard-paths.mjs', 'deploy-gate.mjs']
    : ['guard-paths.mjs', 'plan-gate.mjs', 'deploy-gate.mjs'];
  const rows = [];
  for (const [src, dstRel] of engineList(profile)) {
    const t = resolve(dir, dstRel);
    rows.push([dstRel, !existsSync(t) ? 'MISSING' : sha(t) === sha(join(KIT, 'kit/engine', src)) ? 'ok' : 'DRIFT']);
  }
  const s = resolve(dir, '.claude/settings.json');
  const sOk = existsSync(s) && wantHooks.every(x => readFileSync(s, 'utf8').includes(x));
  rows.push(['.claude/settings.json hooks', sOk ? 'ok' : existsSync(s) ? 'DRIFT/MISSING-ENTRY' : 'MISSING']);
  const z = resolve(dir, '.zcode/config.json');
  const zOk = (() => { try { const j = JSON.parse(readFileSync(z, 'utf8')); if (j.hooks?.enabled !== true) return false; const t = JSON.stringify(j.hooks?.events?.PreToolUse ?? []); return wantHooks.every(x => t.includes(x)); } catch { return false; } })();
  rows.push(['.zcode/config.json hooks（ZCode 接线）', zOk ? 'ok' : existsSync(z) ? 'DRIFT/MISSING-ENTRY' : 'MISSING']);
  rows.push(['.sdlc.json', hasCfg ? 'ok' : 'MISSING']);
  const contentExpect = profile === 'slim'
    ? ['templates/plan.md', 'REVIEW.md']
    : ['templates/intent.md', 'templates/spec.md', 'templates/plan.md', 'REVIEW.md', '.claude/agents/verifier.md',
      ...SKILLS.flatMap(sk => SKILL_BASES.map(base => `${base}/${sk}/SKILL.md`)),
      ...COMMANDS.flatMap(c => COMMAND_BASES.map(base => `${base}/${c}.md`)),
      'samples/deploy-gate.example.json', 'samples/maintain-bands.md', 'samples/pre-commit.secrets.sh'];
  for (const f of contentExpect) {
    rows.push([f, existsSync(resolve(dir, f)) ? 'ok' : 'MISSING（init 可补）']);
  }
  if (profile === 'full') {
    const ciFile = ['.github/workflows/sdlc-evals.yml', '.gitlab-ci.yml'].find(f => existsSync(resolve(dir, f)));
    rows.push([`CI evals 门禁（${ciFile ?? 'github/gitlab 皆缺'}）`, ciFile ? 'ok' : 'MISSING（init 或 --ci 可补）']);
  }
  const agentsOk = existsSync(resolve(dir, 'AGENTS.md')) && /nuwa-sdlc-kit:begin/.test(readFileSync(resolve(dir, 'AGENTS.md'), 'utf8'));
  rows.push(['AGENTS.md 托管区间', agentsOk ? 'ok' : 'MISSING']);
  log(`nuwa-sdlc-kit v${VERSION} 体检 — ${cfg.name ?? basename(dir)}（profile: ${profile}）`);
  for (const [f, st] of rows) log(`${st === 'ok' ? '✓' : '✗'} ${st.padEnd(18)} ${f}`);
  // slim：full 面遗留件只提示不计失败（转换/手工清理均不破坏本地内容件）
  if (profile === 'slim') {
    const leftovers = FULL_CONTENT.filter(f => existsSync(resolve(dir, f)));
    if (leftovers.length) log(`· full 面遗留件（本地所有，可手工删）: ${leftovers.join(', ')}`);
  }
  process.exit(rows.some(r => r[1] !== 'ok') ? 1 : 0);
} else {
  log(`nuwa-sdlc-kit v${VERSION}
  node cli.mjs init  [--dir .] [--name X] [--profile slim|full] [--src re1,re2] [--test cmd] [--protected p1,p2] [--env-prefix SDLC] [--grill extra.md] [--plans-dirs plans,specs] [--pre-commit] [--ci github|gitlab|both]
                    # profile 默认：新仓 slim（地板层）；老仓（.sdlc.json 无 profile 字段）视为 full
  node cli.mjs verify:init --dir <repo> --recipe <repo-relative.json>  # 可选接入，不改 profile/hooks
  node cli.mjs verify --dir <repo> --output <outside-repo-dir> [--reuse]
  node cli.mjs check [--dir .]     # 引擎漂移与缺失体检（按 profile）
  node cli.mjs upgrade [--dir .]   # 仅覆盖引擎件，内容件不动；--profile <档> 转换安装面（full→slim 会清理引擎件/接线/kit CI）`);
}
