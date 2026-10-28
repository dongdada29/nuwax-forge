import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = dirname(fileURLToPath(import.meta.url)) + '/..';
const cli = (args, env) => spawnSync(process.execPath, [join(KIT, 'cli.mjs'), ...args], { encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env });
const tmp = () => mkdtempSync(join(tmpdir(), 'sdlk-'));
const FULL_ARGS = ['--profile', 'full']; // 老仓/全量面口径；slim 见下方专项用例

test('init(full) 播种全部三层 + --pre-commit + 幂等', () => {
  const d = tmp();
  const r = cli(['init', '--dir', d, '--name', 't', '--test', 'npm test', '--pre-commit', ...FULL_ARGS]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const f of ['.sdlc.json', '.claude/hooks/guard-paths.mjs', '.claude/hooks/plan-gate.mjs',
    '.claude/hooks/deploy-gate.mjs', 'scripts/sdlc-evals.mjs', '.github/workflows/sdlc-evals.yml',
    'samples/deploy-gate.example.json', 'samples/maintain-bands.md', 'samples/pre-commit.secrets.sh',
    'AGENTS.md', 'CLAUDE.md', 'REVIEW.md', 'templates/plan.md',
    '.claude/skills/requirement-analysis/SKILL.md', '.git/hooks/pre-commit',
    '.claude/skills/pre-commit-quality-review/SKILL.md', '.agents/skills/pre-commit-quality-review/SKILL.md',
    '.agents/skills/requirement-analysis/SKILL.md', '.agents/skills/grill-with-docs/SKILL.md',
    '.claude/commands/quality-review.md', '.agents/commands/quality-review.md']) {
    assert.ok(existsSync(join(d, f)), `缺少 ${f}`);
  }
  // 托管区挂了新规则 bullet；skill/command 双落点均已渲染占位符
  assert.match(readFileSync(join(d, 'AGENTS.md'), 'utf8'), /pre-commit-quality-review/);
  for (const p of ['.claude/skills/pre-commit-quality-review/SKILL.md', '.agents/skills/pre-commit-quality-review/SKILL.md',
    '.claude/commands/quality-review.md', '.agents/commands/quality-review.md']) {
    const body = readFileSync(join(d, p), 'utf8');
    assert.match(body, /npm test/);
    assert.doesNotMatch(body, /\{\{/);
  }
  // 幂等：内容件不动、.sdlc.json 不覆盖
  writeFileSync(join(d, 'REVIEW.md'), '# local edit\n');
  const cfg = readFileSync(join(d, '.sdlc.json'), 'utf8');
  assert.equal(cli(['init', '--dir', d, ...FULL_ARGS]).status, 0);
  assert.match(readFileSync(join(d, 'REVIEW.md'), 'utf8'), /local edit/);
  assert.equal(readFileSync(join(d, '.sdlc.json'), 'utf8'), cfg);
  rmSync(d, { recursive: true, force: true });
});

test('init 默认 slim：只装地板层，无工件链与 CI 播种', () => {
  const d = tmp();
  const r = cli(['init', '--dir', d, '--name', 'slimt', '--test', 'npm run test:domain', '--pre-commit']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // 地板件在
  for (const f of ['.sdlc.json', '.claude/hooks/guard-paths.mjs', '.claude/hooks/deploy-gate.mjs',
    'AGENTS.md', 'CLAUDE.md', 'REVIEW.md', 'templates/plan.md', '.git/hooks/pre-commit']) {
    assert.ok(existsSync(join(d, f)), `缺少 ${f}`);
  }
  // full 专属件一律不装
  for (const f of ['.claude/hooks/plan-gate.mjs', 'scripts/sdlc-evals.mjs', '.github/workflows/sdlc-evals.yml',
    '.gitlab-ci.yml', 'templates/intent.md', 'templates/spec.md', '.claude/agents/verifier.md',
    'samples/deploy-gate.example.json', 'samples/maintain-bands.md', 'samples/pre-commit.secrets.sh',
    '.claude/skills/requirement-analysis/SKILL.md', '.agents/skills/requirement-analysis/SKILL.md',
    '.claude/skills/grill-with-docs/SKILL.md', '.claude/skills/pre-commit-quality-review/SKILL.md',
    '.claude/commands/quality-review.md', '.agents/commands/quality-review.md']) {
    assert.ok(!existsSync(join(d, f)), `不应存在 ${f}`);
  }
  // .sdlc.json：profile=slim 且不写 srcPaths/plansDirs（计划门本地与 ACP 侧均静默）
  const cfg = JSON.parse(readFileSync(join(d, '.sdlc.json'), 'utf8'));
  assert.equal(cfg.profile, 'slim');
  assert.ok(!('srcPaths' in cfg) && !('plansDirs' in cfg) && !('grillExtra' in cfg));
  // AGENTS 托管区为 slim 版：无 plan-gate 话术，地板话术在
  const agents = readFileSync(join(d, 'AGENTS.md'), 'utf8');
  assert.match(agents, /小修直接改/);
  assert.match(agents, /APPROVE_DEPLOY/);
  assert.match(agents, /npm run test:domain/);
  assert.doesNotMatch(agents, /SKIP_PLAN_GATE/);
  // 接线只有双 hook；REVIEW 单遍版；plan 模板已渲染
  assert.equal(JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8')).hooks.PreToolUse.length, 2);
  const zcmds = JSON.parse(readFileSync(join(d, '.zcode/config.json'), 'utf8')).hooks.events.PreToolUse.flatMap(e => e.hooks.map(h => h.command));
  assert.equal(zcmds.length, 2);
  assert.ok(zcmds.every(c => !c.includes('plan-gate')));
  assert.match(readFileSync(join(d, 'REVIEW.md'), 'utf8'), /一遍/);
  const plan = readFileSync(join(d, 'templates/plan.md'), 'utf8');
  assert.match(plan, /npm run test:domain/);
  assert.doesNotMatch(plan, /\{\{/);
  // 体检按 slim 口径通过
  const ck = cli(['check', '--dir', d]);
  assert.equal(ck.status, 0, ck.stdout);
  assert.match(ck.stdout, /profile: slim/);
  rmSync(d, { recursive: true, force: true });
});

test('裸 init 重跑已装仓不冲掉既有 cfg 渲染值（envPrefix/test）', () => {
  const d = tmp();
  assert.equal(cli(['init', '--dir', d, '--env-prefix', 'NUWACLAW', '--test', 'pnpm exec vitest run', ...FULL_ARGS]).status, 0);
  assert.match(readFileSync(join(d, 'AGENTS.md'), 'utf8'), /NUWACLAW_SKIP_PLAN_GATE/);
  assert.match(readFileSync(join(d, 'AGENTS.md'), 'utf8'), /pnpm exec vitest run/);
  // 裸重跑：cfg 默认取旧 .sdlc.json，托管区渲染值保持，不被出厂默认（SDLC/pnpm test）顶掉
  assert.equal(cli(['init', '--dir', d]).status, 0);
  const agents = readFileSync(join(d, 'AGENTS.md'), 'utf8');
  assert.match(agents, /NUWACLAW_SKIP_PLAN_GATE/);
  assert.match(agents, /pnpm exec vitest run/);
  assert.doesNotMatch(agents, /SDLC_SKIP_PLAN_GATE/);
  rmSync(d, { recursive: true, force: true });
});

test('老仓 .sdlc.json 无 profile 字段 = full：裸 init/upgrade 零惊扰不转换', () => {
  const d = tmp();
  assert.equal(cli(['init', '--dir', d, ...FULL_ARGS]).status, 0);
  // 手工去掉 profile 字段，模拟 v1.4.0 及以前的已装仓
  const cur = JSON.parse(readFileSync(join(d, '.sdlc.json'), 'utf8'));
  delete cur.profile;
  writeFileSync(join(d, '.sdlc.json'), JSON.stringify(cur, null, 2) + '\n');
  const cfgBytes = readFileSync(join(d, '.sdlc.json'), 'utf8');
  // 裸 upgrade：仍是 full 面，plan-gate 刷新不删，.sdlc.json 不改写
  assert.equal(cli(['upgrade', '--dir', d]).status, 0);
  assert.ok(existsSync(join(d, '.claude/hooks/plan-gate.mjs')));
  assert.ok(existsSync(join(d, 'scripts/sdlc-evals.mjs')));
  assert.equal(readFileSync(join(d, '.sdlc.json'), 'utf8'), cfgBytes);
  assert.equal(JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8')).hooks.PreToolUse.length, 3);
  assert.match(readFileSync(join(d, 'AGENTS.md'), 'utf8'), /SKIP_PLAN_GATE/);
  // 裸 init 重跑同样保 full，且不给 .sdlc.json 添 profile 字段
  assert.equal(cli(['init', '--dir', d]).status, 0);
  assert.ok(existsSync(join(d, '.claude/hooks/plan-gate.mjs')));
  assert.ok(!('profile' in JSON.parse(readFileSync(join(d, '.sdlc.json'), 'utf8'))));
  rmSync(d, { recursive: true, force: true });
});

test('full→slim 转换：引擎件/接线/CI 清理，内容件保留，体检通过', () => {
  const d = tmp();
  assert.equal(cli(['init', '--dir', d, '--test', 'npm test', ...FULL_ARGS]).status, 0);
  const reviewBefore = readFileSync(join(d, 'REVIEW.md'), 'utf8');
  const skillsBefore = readFileSync(join(d, '.claude/skills/requirement-analysis/SKILL.md'), 'utf8');
  assert.ok(existsSync(join(d, '.github/workflows/sdlc-evals.yml')));
  const r = cli(['init', '--dir', d, '--profile', 'slim']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /转换清理/);
  // full 专属引擎件与 kit CI 已删
  for (const f of ['.claude/hooks/plan-gate.mjs', 'scripts/sdlc-evals.mjs', '.github/workflows/sdlc-evals.yml']) {
    assert.ok(!existsSync(join(d, f)), `应删除 ${f}`);
  }
  // 接线剪除为双 hook
  const s = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.ok(JSON.stringify(s).indexOf('plan-gate') === -1);
  const z = JSON.parse(readFileSync(join(d, '.zcode/config.json'), 'utf8'));
  assert.equal(z.hooks.events.PreToolUse.length, 2);
  // .sdlc.json：profile=slim，计划门键剥除
  const cfg = JSON.parse(readFileSync(join(d, '.sdlc.json'), 'utf8'));
  assert.equal(cfg.profile, 'slim');
  assert.ok(!('srcPaths' in cfg) && !('plansDirs' in cfg));
  // AGENTS 托管区换 slim 版
  const agents = readFileSync(join(d, 'AGENTS.md'), 'utf8');
  assert.match(agents, /小修直接改/);
  assert.doesNotMatch(agents, /SKIP_PLAN_GATE/);
  // 内容件保留（本地所有）：full 版 REVIEW/技能原样
  assert.equal(readFileSync(join(d, 'REVIEW.md'), 'utf8'), reviewBefore);
  assert.equal(readFileSync(join(d, '.claude/skills/requirement-analysis/SKILL.md'), 'utf8'), skillsBefore);
  // slim 体检通过
  const ck = cli(['check', '--dir', d]);
  assert.equal(ck.status, 0, ck.stdout);
  rmSync(d, { recursive: true, force: true });
});

test('slim→full 回转：引擎件/接线/默认 srcPaths 补全，内容件不随 upgrade 播种', () => {
  const d = tmp();
  assert.equal(cli(['init', '--dir', d]).status, 0);
  const r = cli(['upgrade', '--dir', d, '--profile', 'full']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const f of ['.claude/hooks/plan-gate.mjs', 'scripts/sdlc-evals.mjs']) {
    assert.ok(existsSync(join(d, f)), `缺少 ${f}`);
  }
  assert.equal(JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8')).hooks.PreToolUse.length, 3);
  const cfg = JSON.parse(readFileSync(join(d, '.sdlc.json'), 'utf8'));
  assert.equal(cfg.profile, 'full');
  assert.ok(Array.isArray(cfg.srcPaths) && cfg.srcPaths.length > 0);
  assert.match(readFileSync(join(d, 'AGENTS.md'), 'utf8'), /SKIP_PLAN_GATE/);
  // upgrade 不播种内容件（既有契约）：skills 仍缺，full 体检应红——补内容需重跑 init
  assert.ok(!existsSync(join(d, '.claude/skills/requirement-analysis/SKILL.md')));
  assert.equal(cli(['check', '--dir', d]).status, 1);
  assert.equal(cli(['init', '--dir', d, ...FULL_ARGS]).status, 0);
  assert.ok(existsSync(join(d, '.claude/skills/requirement-analysis/SKILL.md')));
  assert.equal(cli(['check', '--dir', d]).status, 0);
  rmSync(d, { recursive: true, force: true });
});

test('ZCode 接线：.zcode/config.json 三闸门合入 + 保留既有键 + 幂等（full）', () => {
  const d = tmp();
  mkdirSync(join(d, '.zcode'), { recursive: true });
  writeFileSync(join(d, '.zcode/config.json'), JSON.stringify({ mcp: { servers: { x: { command: 'x' } } } }));
  assert.equal(cli(['init', '--dir', d, ...FULL_ARGS]).status, 0);
  const j = JSON.parse(readFileSync(join(d, '.zcode/config.json'), 'utf8'));
  assert.equal(j.hooks.enabled, true);
  const cmds = j.hooks.events.PreToolUse.flatMap(e => (e.hooks ?? []).map(h => h.command));
  for (const f of ['guard-paths', 'plan-gate', 'deploy-gate']) assert.ok(cmds.some(c => c.includes(f)), `缺 ${f}`);
  assert.ok(cmds.every(c => c.includes('${ZCODE_PROJECT_DIR}')));
  // 既有键（如 mcp.servers）原样保留
  assert.equal(j.mcp.servers.x.command, 'x');
  // 幂等：重跑不重复追加
  assert.equal(cli(['init', '--dir', d, ...FULL_ARGS]).status, 0);
  const j2 = JSON.parse(readFileSync(join(d, '.zcode/config.json'), 'utf8'));
  assert.equal(j2.hooks.events.PreToolUse.length, 3);
  assert.equal(cli(['check', '--dir', d]).status, 0);
  rmSync(d, { recursive: true, force: true });
});

test('settings 合并保留既有 deny 项并接入三条 hooks（full）', () => {
  const d = tmp();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm -rf)'] } }));
  assert.equal(cli(['init', '--dir', d, ...FULL_ARGS]).status, 0);
  const s = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
  assert.ok(s.permissions.deny.includes('Bash(rm -rf)'));
  assert.ok(s.permissions.deny.some(x => x.startsWith('Read(**/.env)')));
  assert.equal(s.hooks.PreToolUse.length, 3);
  rmSync(d, { recursive: true, force: true });
});

test('check: 干净=0；篡改引擎=1；upgrade 修复引擎且不动内容（full）', () => {
  const d = tmp();
  assert.equal(cli(['init', '--dir', d, ...FULL_ARGS]).status, 0);
  assert.equal(cli(['check', '--dir', d]).status, 0);
  writeFileSync(join(d, '.claude/hooks/guard-paths.mjs'), '// tampered\n');
  assert.equal(cli(['check', '--dir', d]).status, 1);
  writeFileSync(join(d, 'REVIEW.md'), '# local\n');
  assert.equal(cli(['upgrade', '--dir', d]).status, 0);
  assert.equal(cli(['check', '--dir', d]).status, 0);
  assert.match(readFileSync(join(d, 'REVIEW.md'), 'utf8'), /local/);
  rmSync(d, { recursive: true, force: true });
});

test('CI 门禁按 --ci / origin 挑模板（gitlab/both，默认 github；full 专属）', () => {
  // 显式 --ci gitlab：只播 .gitlab-ci.yml，且占位符已渲染
  const d = tmp();
  const r = cli(['init', '--dir', d, '--test', 'pnpm exec vitest run', '--ci', 'gitlab', ...FULL_ARGS]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(join(d, '.gitlab-ci.yml')));
  assert.ok(!existsSync(join(d, '.github/workflows/sdlc-evals.yml')));
  const yml = readFileSync(join(d, '.gitlab-ci.yml'), 'utf8');
  assert.match(yml, /\$CI_PIPELINE_SOURCE/);
  assert.match(yml, /pnpm exec vitest run/);
  assert.equal(cli(['check', '--dir', d]).status, 0);
  // origin 指向 gitlab 域名 → auto 识别为 gitlab
  const g = tmp();
  spawnSync('git', ['init', '-q'], { cwd: g });
  spawnSync('git', ['remote', 'add', 'origin', 'https://gitlab.example.com/x/y.git'], { cwd: g });
  assert.equal(cli(['init', '--dir', g, ...FULL_ARGS]).status, 0);
  assert.ok(existsSync(join(g, '.gitlab-ci.yml')));
  assert.ok(!existsSync(join(g, '.github/workflows/sdlc-evals.yml')));
  // self-host 域名 URL 无 gitlab 字样 → NUWA_SDLK_GITLAB_HOSTS 命中识别；不设则回落 github
  const s = tmp();
  spawnSync('git', ['init', '-q'], { cwd: s });
  spawnSync('git', ['remote', 'add', 'origin', 'https://git.yichamao.com/x/y.git'], { cwd: s });
  assert.equal(cli(['init', '--dir', s, ...FULL_ARGS], { NUWA_SDLK_GITLAB_HOSTS: 'git.yichamao.com,other.host' }).status, 0);
  assert.ok(existsSync(join(s, '.gitlab-ci.yml')));
  const s2 = tmp();
  spawnSync('git', ['init', '-q'], { cwd: s2 });
  spawnSync('git', ['remote', 'add', 'origin', 'https://git.yichamao.com/x/y.git'], { cwd: s2 });
  cli(['init', '--dir', s2, ...FULL_ARGS]);
  assert.ok(existsSync(join(s2, '.github/workflows/sdlc-evals.yml')));
  // --ci both：双通道并存，check 双兼容
  const b = tmp();
  assert.equal(cli(['init', '--dir', b, '--ci', 'both', ...FULL_ARGS]).status, 0);
  assert.ok(existsSync(join(b, '.github/workflows/sdlc-evals.yml')));
  assert.ok(existsSync(join(b, '.gitlab-ci.yml')));
  assert.equal(cli(['check', '--dir', b]).status, 0);
  [d, g, b].forEach(x => rmSync(x, { recursive: true, force: true }));
});

test('--profile 非法值直接报错', () => {
  const d = tmp();
  const r = cli(['init', '--dir', d, '--profile', 'tiny']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /slim\|full/);
  rmSync(d, { recursive: true, force: true });
});
