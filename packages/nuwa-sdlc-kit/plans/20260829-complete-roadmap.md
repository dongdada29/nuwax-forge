# [20260829] nuwa-sdlc-kit 补齐 Roadmap + 自测 深度实施方案

## 0. 预检清单 (Pre-Flight Checklist)
- [x] 仓库结构已全量读取（cli.mjs / kit/engine/* / kit/content/* / install.sh / scripts/publish-s3.sh）
- [x] 版本基线：kit/VERSION = 1.0.0；本方案产出 v1.1.0
- [x] 零依赖约定确认：全部实现只用 node: 内置模块（node:test 亦内置）
- [ ] 本会话 bash 工具故障（posix_spawn 失败）——**执行期需重试**；若仍不可用，代码全部落地但验证命令交由用户/下一会话执行
- [x] 已确认决策（AskUserQuestion 结果）：
  - 范围 = **全部补齐**（Roadmap 4 项 + 本仓测试 + 瑕疵清理）
  - CI 平台 = **GitHub Actions**
  - npx = **完整 npm 发布**（bin + publish workflow + 版本同步脚本）
  - *nuwaclaw 跨仓落地不在本轮范围（husky 基线红属目标仓问题）*

## 1. 核心变更摘要
- **目标**: 补齐 README Roadmap 全部 4 项（CI evals 门禁 / pre-commit 秘钥地板 / Deploy 闸门 hook + Maintain 分带样例 / npx 封装），并给本仓补 node:test 测试、清理 cli.mjs 瑕疵，版本升到 1.1.0。
- **待确认项**:
  - 已确认：范围/CI 平台/npx 程度（见 0 节）。
  - 遗留待确认（不阻塞）：npm `repository.url` 的 GitHub org 名——package.json 先写占位 `github.com/nuwa/nuwa-sdlc-kit`，发布前用户改一行。
  - *已决定：deploy-gate 三带语义 = block（硬禁）/ ask（环境变量人工批准）/ allow（显式放行），与 plan-gate 的"宁放勿拦"风格一致。*

## 2. 涉及文件清单 (Scope)
| 操作 | 文件路径 | 关键改动点 |
| :--- | :--- | :--- |
| Edit | `cli.mjs` | 修瑕疵；引擎清单改为 src→dst 映射（新增 2 个引擎件）；播种 samples/ci；`--pre-commit` 装钩子；check 覆盖新件 |
| Create | `kit/engine/deploy-gate.mjs` | 新引擎 hook：发布命令按 allow/ask/block 分带拦截 |
| Create | `kit/engine/evals.mjs` | 新引擎件：对已装 hooks 灌样本事件断言 exit code（CI 门禁核心，装到 `scripts/sdlc-evals.mjs`） |
| Edit | `kit/engine/settings.json` | 增加 deploy-gate 的 PreToolUse 接线（matcher Bash） |
| Create | `kit/content/samples/deploy-gate.example.json` | deployGate 配置样例（带 `_说明` 键，保持合法 JSON） |
| Create | `kit/content/samples/maintain-bands.md` | Maintain 监控分带样例（P0/P1/P2 行为约定 + 指标示例） |
| Create | `kit/content/samples/pre-commit.secrets.sh` | pre-commit 秘钥扫描地板（agent 无关强制） |
| Create | `kit/content/ci/github-sdlc-evals.yml` | GitHub Actions evals 门禁模板（规则文件变更触发） |
| Create | `package.json` | bin 封装（nuwa-sdlc / nuwa-sdlc-kit）、files、test 脚本 |
| Create | `test/cli.test.mjs` | init/upgrade/check/settings 合并幂等性测试 |
| Create | `test/engine.test.mjs` | 对临时安装目录跑 evals.mjs 全绿断言 |
| Create | `.github/workflows/test.yml` | 本仓自测 CI（node:test 矩阵） |
| Create | `.github/workflows/npm-publish.yml` | tag v* 触发 npm publish + npx 冒烟 |
| Create | `scripts/bump-version.mjs` | kit/VERSION + package.json + 引擎文件头 三处版本同步 |
| Edit | `kit/VERSION` | 1.0.0 → 1.1.0 |
| Edit | `kit/engine/guard-paths.mjs`、`kit/engine/plan-gate.mjs` | 仅文件头版本注释 1.0.0 → 1.1.0（bump 脚本统一改） |
| Edit | `README.md` | Roadmap 勾选、npx 用法、deploy-gate/分带文档指针 |

## 3. 核心数据结构与接口 (Data Structures & Interfaces)

**`.sdlc.json` 新增节（运行时配置，引擎跨仓逐字节相同）：**

```jsonc
// 目标仓 .sdlc.json 新增（均可缺省；缺省=用引擎内置默认带）
{
  "deployGate": {
    "patterns": [
      { "re": "\\bgit push\\b[^&|;]*(--force|-f)(\\s|$)", "mode": "block" },
      { "re": "\\b(pnpm|npm|yarn|bun) run deploy\\b", "mode": "ask" },
      { "re": "\\bkubectl (apply|delete|rollout)\\b", "mode": "ask" },
      { "re": "\\baws s3 (cp|sync|rm)\\b", "mode": "ask" },
      { "re": "\\bdocker push\\b", "mode": "ask" }
    ]
  }
}
// mode: "ask"(默认)=exit 2 直到 <ENVPREFIX>_APPROVE_DEPLOY=1；"block"=硬禁不受环境变量影响；"allow"=放行
```

**cli.mjs 引擎清单（原字符串数组改为映射）：**

```js
const ENGINE = [
  ['guard-paths.mjs', '.claude/hooks/guard-paths.mjs'],
  ['plan-gate.mjs', '.claude/hooks/plan-gate.mjs'],
  ['deploy-gate.mjs', '.claude/hooks/deploy-gate.mjs'],
  ['evals.mjs', 'scripts/sdlc-evals.mjs'],
];
```

**evals 用例表（kit/engine/evals.mjs 的核心数据结构）：**

```js
// [名称, hook文件, 事件工厂(fixture目录→事件), 预期exit, 附加env]
const CASES = [
  ['guard: write .env → 2',            'guard-paths.mjs', f => ev('Write', f, { file_path: join(f, '.env') }), 2, {}],
  ['guard: write .env.example → 0',    'guard-paths.mjs', f => ev('Write', f, { file_path: join(f, '.env.example') }), 0, {}],
  ['guard: bash cat id_rsa → 2',       'guard-paths.mjs', f => ev('Bash', f, { command: 'cat ~/.ssh/id_rsa' }), 2, {}],
  ['guard: protectedWrite → 2',        'guard-paths.mjs', f => ev('Edit', f, { file_path: join(f, 'docs/spec.md') }), 2, {}],
  ['gate: src 首改无 plans → 2',        'plan-gate.mjs',  f => ev('Edit', f, { file_path: join(f, 'packages/a/src/x.ts') }, 'eval1'), 2, {}],
  ['gate: 同会话二改 → 0(marker)',      'plan-gate.mjs',  f => ev('Edit', f, { file_path: join(f, 'packages/a/src/y.ts') }, 'eval1'), 0, {}],
  ['gate: SKIP env → 0',               'plan-gate.mjs',  f => ev('Edit', f, { file_path: join(f, 'packages/a/src/x.ts') }, 'eval2'), 0, { SDLC_SKIP_PLAN_GATE: '1' }],
  ['deploy: force push → 2',           'deploy-gate.mjs', f => ev('Bash', f, { command: 'git push origin main --force' }), 2, {}],
  ['deploy: block+批准env 仍 → 2',     'deploy-gate.mjs', f => ev('Bash', f, { command: 'git push origin main --force' }), 2, { SDLC_APPROVE_DEPLOY: '1' }],
  ['deploy: ask 未批准 → 2',           'deploy-gate.mjs', f => ev('Bash', f, { command: 'docker push repo:1' }), 2, {}],
  ['deploy: ask+批准 → 0',             'deploy-gate.mjs', f => ev('Bash', f, { command: 'docker push repo:1' }), 0, { SDLC_APPROVE_DEPLOY: '1' }],
];
```

## 4. 详细实施步骤 (Implementation Details)

### 步骤 1: cli.mjs 瑕疵清理
- **文件**: `cli.mjs`
- **改动**（两处字面替换）:
```js
// L7: 删除未使用 import —— 'import { execFileSync } from 'node:child_process';' 整行删除
// L97: seedIfAbsent(srcRoot && join(srcRoot, f), dst) → seedIfAbsent(join(srcRoot, f), dst)
```

### 步骤 2: 新引擎 hook `kit/engine/deploy-gate.mjs`（完整代码）
```js
// nuwa-sdlc-kit v1.1.0 · engine file — 托管件，upgrade 会覆盖手工修改
// Deploy 闸门（SDLC Stage 4）：发布/破坏性 Bash 命令按 .sdlc.json deployGate 分带拦截。
//   { "deployGate": { "patterns": [{ "re": "...", "mode": "ask|block|allow" }, ...] } }
// mode 语义：ask=默认，需 <ENVPREFIX>_APPROVE_DEPLOY=1 人工批准；block=硬禁（不受环境变量影响）；
//           allow=显式放行（仅记录语义，用于在默认带中开洞）。
// 协议：stdin 事件 JSON；exit 0 放行 / exit 2 阻断（stderr 给 agent）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const loadCfg = cwd => {
  try { return JSON.parse(readFileSync(resolve(cwd, '.sdlc.json'), 'utf8')); } catch { return {}; }
};

const DEFAULTS = [
  { re: '\\bgit push\\b[^&|;]*(--force|-f)(\\s|$)', mode: 'block' },
  { re: '\\b(pnpm|npm|yarn|bun) run deploy\\b', mode: 'ask' },
  { re: '\\bkubectl (apply|delete|rollout)\\b', mode: 'ask' },
  { re: '\\baws s3 (cp|sync|rm)\\b', mode: 'ask' },
  { re: '\\bdocker push\\b', mode: 'ask' },
];

let raw = '';
process.stdin.on('data', d => (raw += d));
process.stdin.on('end', () => {
  let ev;
  try { ev = JSON.parse(raw); } catch { process.exit(0); }
  if ((ev.tool_name ?? '') !== 'Bash') process.exit(0);
  const cwd = ev.cwd || process.cwd();
  const cfg = loadCfg(cwd);
  const prefix = cfg.envPrefix ?? 'SDLC';
  const command = String(ev.tool_input?.command ?? '');
  if (!command) process.exit(0);

  const patterns = cfg.deployGate?.patterns ?? DEFAULTS;
  const approved = process.env[`${prefix}_APPROVE_DEPLOY`] === '1';
  const deny = (msg) => { console.error(msg); process.exit(2); };
  const head = command.length > 80 ? command.slice(0, 80) + '…' : command;

  for (const p of patterns) {
    if (!new RegExp(p.re, 'i').test(command)) continue;
    const mode = p.mode ?? 'ask';
    if (mode === 'allow') process.exit(0);
    if (mode === 'block') {
      deny(`[deploy-gate:${cfg.name ?? 'repo'}] 「block」带命令被拒：${head}\n` +
        `发布属人工决策：请人评审后调整 .sdlc.json deployGate.patterns（本带不受 ${prefix}_APPROVE_DEPLOY 影响）。`);
    }
    if (!approved) {
      deny(`[deploy-gate:${cfg.name ?? 'repo'}] 「ask」带命令需人工批准：${head}\n` +
        `· 人工批准：export ${prefix}_APPROVE_DEPLOY=1 后重跑本命令；\n` +
        `· 永久放行/收紧：改 .sdlc.json deployGate.patterns（样例见 samples/deploy-gate.example.json）。`);
    }
    process.exit(0); // ask 带 + 已批准
  }
  process.exit(0);
});
```

### 步骤 3: 新引擎件 `kit/engine/evals.mjs`（完整代码）
```js
#!/usr/bin/env node
// nuwa-sdlc-kit v1.1.0 · engine file — 托管件（安装位置 scripts/sdlc-evals.mjs）
// 规则层 evals 门禁：对已安装的引擎 hooks 灌样本 PreToolUse 事件，断言 exit code。
// 用法：node scripts/sdlc-evals.mjs [--dir <repo>]；exit 1 = 有失败。CI 于规则文件变更时触发。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const i = process.argv.indexOf('--dir');
const dir = resolve(i >= 0 ? process.argv[i + 1] : '.');
const hook = name => join(dir, '.claude/hooks', name);
const ev = (tool_name, cwd, tool_input, session_id) =>
  JSON.stringify({ tool_name, cwd, tool_input, ...(session_id ? { session_id } : {}) });

const CASES = [ /* 见第 3 节用例表，逐条字面落盘 */ ];

// fixture：临时"仓" + 最小 .sdlc.json（protectedWrite 命中 guard 用例；srcPaths 命中 gate 用例）
const fx = mkdtempSync(join(tmpdir(), 'sdlc-evals-'));
writeFileSync(join(fx, '.sdlc.json'), JSON.stringify({
  name: 'evalfx',
  srcPaths: ['packages/[^/]+/src/'],
  protectedWrite: ['docs/spec.md'],
  deployGate: { patterns: [{ re: '\\bdocker push\\b', mode: 'ask' }] },
}));
mkdirSync(join(fx, 'packages/a/src'), { recursive: true });

let fails = 0;
for (const [name, file, make, want, env] of CASES) {
  const r = spawnSync(process.execPath, [hook(file)], {
    input: make(fx), encoding: 'utf8', env: { ...process.env, ...env },
  });
  const got = r.status;
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? '✓' : '✗'} ${name}  (exit ${got}${ok ? '' : `, want ${want}${r.stderr ? ` — ${String(r.stderr).split('\n')[0]}` : ''}`})`);
}
rmSync(fx, { recursive: true, force: true });
if (fails) { console.error(`\n${fails} 个 eval 失败`); process.exit(1); }
console.log('\n全部 eval 通过');
```
- **顺序依赖说明**: `gate: 同会话二改` 依赖首改用例已写入 marker（session `eval1`），用例表按序执行是契约，不得乱序。

### 步骤 4: `kit/engine/settings.json` 追加接线
```json
{
  "matcher": "Bash",
  "hooks": [{ "type": "command", "command": "node .claude/hooks/deploy-gate.mjs" }]
}
```
（追加到 PreToolUse 数组末尾；mergeSettings 既有去重逻辑按 command 字符串工作，无需改。）

### 步骤 5: cli.mjs 结构化改造
- **引擎清单**: 顶部加 `const ENGINE = [...映射]`（见第 3 节）；`copyEngine` 改签名：
```js
function copyEngine([src, dstRel]) {
  const dst = resolve(dir, dstRel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(join(KIT, 'kit/engine', src), dst);
  return dst;
}
// init/upgrade 分支: const engine = ENGINE.map(copyEngine);
```
- **check 分支**: 引擎循环遍历 ENGINE（src↔dst 成对 sha 比对，evals.mjs 比对 `scripts/sdlc-evals.mjs`）。
- **seedContentTree 追加**（在 skills 循环后）：
```js
for (const f of ['samples/deploy-gate.example.json', 'samples/maintain-bands.md', 'samples/pre-commit.secrets.sh']) {
  const dst = resolve(dir, f);
  if (seedIfAbsent(join(srcRoot, f), dst)) seeded.push(f); else kept.push(f);
}
const CI = '.github/workflows/sdlc-evals.yml';
if (seedIfAbsent(join(srcRoot, 'ci/github-sdlc-evals.yml'), resolve(dir, CI))) seeded.push(CI); else kept.push(CI);
```
- **init 新旗标 `--pre-commit`**（布尔，用 `args.includes('--pre-commit')`，放在 upsertAgentsSection 之后）：
```js
import { chmodSync } from 'node:fs'; // fs import 行追加
if (args.includes('--pre-commit')) {
  const hookDst = resolve(dir, '.git/hooks/pre-commit');
  if (!existsSync(hookDst)) {
    mkdirSync(dirname(hookDst), { recursive: true });
    copyFileSync(join(srcRoot, 'samples/pre-commit.secrets.sh'), hookDst);
    chmodSync(hookDst, 0o755);
    log(`+ .git/hooks/pre-commit（秘钥地板，--pre-commit 安装）`);
  } else log(`= .git/hooks/pre-commit 已存在，未动`);
}
```
- **check 内容清单追加**: `samples/*` 三件 + `.github/workflows/sdlc-evals.yml` + `scripts/sdlc-evals.mjs`（后者走 ENGINE 循环）。

### 步骤 6: 内容样例三件 + CI 模板
**`kit/content/samples/pre-commit.secrets.sh`（完整）**:
```bash
#!/usr/bin/env bash
# nuwa-sdlc-kit v1.1.0 · sample — pre-commit 秘钥地板（agent 无关强制层）
# 安装：nuwa-sdlc init --pre-commit（拷入 .git/hooks/pre-commit 并加执行位）
# 豁免与引擎 guard-paths 同规：example/sample/template 后缀 + 构建噪音目录
set -eu

EXEMPT='(\.example|\.sample|\.template)$|^(node_modules|dist|target|buildtrees|vcpkg_installed)/'
PATTERN='(^|/)\.env(\.[^/]+)?$|\.pem$|\.key$|\.(pfx|p12)$|(^|/)id_(rsa|ed25519|ecdsa)$|[Cc]redential|[Ss]ecrets?\.(json|ya?ml|txt)$'

hits="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null | grep -Ev "$EXEMPT" | grep -E "$PATTERN" || true)"
if [ -n "$hits" ]; then
  echo "❌ [nuwa-sdlc-kit pre-commit] 疑似秘钥文件被暂存，提交被拒：" >&2
  echo "$hits" >&2
  echo "   人工评审后绕过：git commit --no-verify" >&2
  exit 1
fi
```

**`kit/content/samples/deploy-gate.example.json`（完整）**:
```json
{
  "_说明": "把 deployGate 节合并进目标仓 .sdlc.json；re 为不区分大小写正则；mode: ask(人工批准)/block(硬禁)/allow(放行)",
  "deployGate": {
    "patterns": [
      { "re": "\\bgit push\\b[^&|;]*(--force|-f)(\\s|$)", "mode": "block", "_说明": "改写历史，永不自动放行" },
      { "re": "\\b(pnpm|npm|yarn|bun) run deploy\\b", "mode": "ask", "_说明": "标准发布入口" },
      { "re": "\\bkubectl (apply|delete|rollout)\\b", "mode": "ask" },
      { "re": "\\baws s3 (cp|sync|rm)\\b", "mode": "ask" },
      { "re": "\\bdocker push\\b", "mode": "ask" },
      { "re": "\\bterraform (apply|destroy)\\b", "mode": "ask" },
      { "re": "\\bnpm publish\\b", "mode": "ask" },
      { "re": "\\bpnpm (build|test)\\b", "mode": "allow", "_说明": "示例：在默认带中显式开洞" }
    ]
  }
}
```

**`kit/content/samples/maintain-bands.md`（骨架）**: P0 红=page 人 + agent 停手转人工（例：error rate > 1%、p99 > SLO、主干红）；P1 黄=开工单 + agent 可继续但 PR 必须引用（例：告警风暴、依赖 CVE）；P2 绿=记录进周报（例：配额水位）。每带给"指标示例 / 谁响应 / agent 行为约定"三行表格；文末注明"接入本仓监控后按实际指标维护，agent 行为约定建议同步进 AGENTS.md"。

**`kit/content/ci/github-sdlc-evals.yml`（完整，`{{TEST_COMMAND}}` 渲染进注释）**:
```yaml
# nuwa-sdlc-kit · 规则文件 evals 门禁（播种一次，本地所有；后续修改归本仓）
# 触发面 = 规则层文件：AGENTS/CLAUDE 指针、.claude/、templates/、REVIEW.md、plans/specs 工件
name: sdlc-evals
on:
  pull_request:
    paths: ['AGENTS.md', 'CLAUDE.md', '.claude/**', 'templates/**', 'REVIEW.md', 'plans/**', 'specs/**']
  push:
    branches: [main]
    paths: ['AGENTS.md', 'CLAUDE.md', '.claude/**', 'templates/**', 'REVIEW.md']
jobs:
  evals:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node: [20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '${{ matrix.node }}' }
      - name: 规则层 evals（引擎 hooks 行为断言）
        run: node scripts/sdlc-evals.mjs --dir .
      # 本仓业务测试自行追加 job（测试命令见 .sdlc.json：{{TEST_COMMAND}}）
```

### 步骤 7: package.json + 本仓测试
**`package.json`（完整）**:
```json
{
  "name": "nuwa-sdlc-kit",
  "version": "1.1.0",
  "description": "AI-Native SDLC 规则层套件：一键安装/升级/多 agent 兼容（hooks 门禁 + 模板 + skills）",
  "type": "module",
  "license": "MIT",
  "bin": { "nuwa-sdlc": "./cli.mjs", "nuwa-sdlc-kit": "./cli.mjs" },
  "engines": { "node": ">=18.14" },
  "files": ["cli.mjs", "install.sh", "kit/", "README.md"],
  "scripts": {
    "test": "node --test test/",
    "evals": "node kit/engine/evals.mjs --dir .",
    "bump": "node scripts/bump-version.mjs"
  },
  "repository": { "type": "git", "url": "git+https://github.com/nuwa/nuwa-sdlc-kit.git" },
  "keywords": ["sdlc", "claude-code", "hooks", "agents", "ai-native", "guardrails"]
}
```

**`test/cli.test.mjs`（核心用例，node:test + assert/strict）**:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = dirname(fileURLToPath(import.meta.url)) + '/..';
const cli = args => spawnSync(process.execPath, [join(KIT, 'cli.mjs'), ...args], { encoding: 'utf8' });
const tmp = () => mkdtempSync(join(tmpdir(), 'sdlk-'));

test('init 播种全部三层 + 幂等', () => {
  const d = tmp();
  assert.equal(cli(['init', '--dir', d, '--name', 't', '--test', 'npm test', '--pre-commit']).status, 0);
  for (const f of ['.sdlc.json', '.claude/hooks/guard-paths.mjs', '.claude/hooks/plan-gate.mjs',
    '.claude/hooks/deploy-gate.mjs', 'scripts/sdlc-evals.mjs', '.github/workflows/sdlc-evals.yml',
    'samples/pre-commit.secrets.sh', 'AGENTS.md', 'CLAUDE.md', 'REVIEW.md', 'templates/plan.md',
    '.claude/skills/requirement-analysis/SKILL.md', '.git/hooks/pre-commit']) {
    assert.ok(existsSync(join(d, f)), `缺少 ${f}`);
  }
  // 幂等：内容件不动、.sdlc.json 不覆盖
  writeFileSync(join(d, 'REVIEW.md'), '# local edit\n');
  const cfg = readFileSync(join(d, '.sdlc.json'), 'utf8');
  assert.equal(cli(['init', '--dir', d]).status, 0);
  assert.match(readFileSync(join(d, 'REVIEW.md'), 'utf8'), /local edit/);
  assert.equal(readFileSync(join(d, '.sdlc.json'), 'utf8'), cfg);
  rmSync(d, { recursive: true, force: true });
});

test('settings 合并保留既有 deny 项', () => {
  const d = tmp();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm -rf)'] } }));
  cli(['init', '--dir', d]);
  const s = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
  assert.ok(s.permissions.deny.includes('Bash(rm -rf)'));
  assert.ok(s.permissions.deny.some(x => x.startsWith('Read(**/.env)')));
  assert.equal(s.hooks.PreToolUse.length, 3);
  rmSync(d, { recursive: true, force: true });
});

test('check: 干净=0；篡改引擎=1(DRIFT)；upgrade 修复引擎且不动内容', () => {
  const d = tmp();
  cli(['init', '--dir', d]);
  assert.equal(cli(['check', '--dir', d]).status, 0);
  writeFileSync(join(d, '.claude/hooks/guard-paths.mjs'), '// tampered\n');
  assert.equal(cli(['check', '--dir', d]).status, 1);
  writeFileSync(join(d, 'REVIEW.md'), '# local\n');
  cli(['upgrade', '--dir', d]);
  assert.equal(cli(['check', '--dir', d]).status, 0);
  assert.match(readFileSync(join(d, 'REVIEW.md'), 'utf8'), /local/);
  rmSync(d, { recursive: true, force: true });
});
```

**`test/engine.test.mjs`（完整逻辑）**:
```js
test('evals.mjs 对临时安装目录全绿', () => {
  const d = tmp();
  cli(['init', '--dir', d]);
  const r = spawnSync(process.execPath, [join(KIT, 'kit/engine/evals.mjs'), '--dir', d], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /全部 eval 通过/);
  rmSync(d, { recursive: true, force: true });
});
```
（imports/helper 与 cli.test.mjs 相同。）

### 步骤 8: 本仓 CI 两个 workflow
**`.github/workflows/test.yml`**: on push/PR → matrix node [20, 22] → `npm test`（即 `node --test test/`）。
**`.github/workflows/npm-publish.yml`**:
```yaml
name: npm-publish
on:
  push: { tags: ['v*'] }
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions: { contents: read, id-token: write }   # npm provenance
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, registry-url: https://registry.npmjs.org/ }
      - run: npm test
      - run: npm publish --access public --provenance
        env: { NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}' }
      - name: npx 冒烟
        run: |
          mkdir /tmp/smoke && cd /tmp/smoke
          npx --yes nuwa-sdlc-kit@latest init --dir . --name smoke
          node node_modules/nuwa-sdlc-kit/cli.mjs check --dir . || true
```
（冒烟步骤允许 check 非零——临时目录无 git，仅验证 npx 能拉到并执行。）

### 步骤 9: 版本同步脚本 + 升版
**`scripts/bump-version.mjs`（完整）**:
```js
#!/usr/bin/env node
// 用法：node scripts/bump-version.mjs <x.y.z> —— 同步 kit/VERSION、package.json、引擎文件头三处版本。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ver = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(ver ?? '')) { console.error('用法: node scripts/bump-version.mjs <x.y.z>'); process.exit(1); }
writeFileSync(join(ROOT, 'kit/VERSION'), ver + '\n');
const pkgPath = join(ROOT, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = ver;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
for (const f of readdirSync(join(ROOT, 'kit/engine'))) {
  if (!f.endsWith('.mjs')) continue;
  const p = join(ROOT, 'kit/engine', f);
  writeFileSync(p, readFileSync(p, 'utf8').replaceAll(/nuwa-sdlc-kit v\d+\.\d+\.\d+ · engine/g, `nuwa-sdlc-kit v${ver} · engine`));
}
console.log(`✅ 版本统一为 ${ver}（kit/VERSION、package.json、引擎文件头）`);
```
执行 `node scripts/bump-version.mjs 1.1.0`（guard-paths/plan-gate 文件头随之 1.0.0→1.1.0；新文件直接按 1.1.0 写）。

### 步骤 10: README 更新
- Roadmap 四项勾选为 `- [x]`（各附一行"落点"指引）；新增待办：nuwaclaw 落地收尾。
- "安装"节增加：`npx --yes nuwa-sdlc-kit init --dir . ...`（npm 渠道，与 S3/本仓直用并列）。
- 新增小节「Deploy 闸门与监控分带」：deployGate 三带语义、`SDLC_APPROVE_DEPLOY`、样例文件指针（samples/）。
- `--pre-commit` 加入 init 参数表。

## 5. 验证策略 (Verification Strategy)
- [ ] `npm test`（node:test：init 播种/幂等、settings 合并、check 漂移、upgrade 隔离、evals 全绿）——**本会话 bash 故障则交用户执行**
- [ ] `node kit/engine/evals.mjs --dir <临时安装目录>` 全绿
- [ ] `node cli.mjs init --dir /tmp/x --pre-commit` 后 `ls .git/hooks/pre-commit` 存在且可执行
- [ ] `node cli.mjs check --dir /tmp/x` exit 0；篡改任一引擎文件后 exit 1
- [ ] `node scripts/bump-version.mjs 1.1.0` 后 `cat kit/VERSION` = package.json version = 引擎头版本
- [ ] `npm pack --dry-run` 核对 files 清单含 cli.mjs/install.sh/kit/
- [ ] CI 侧（推送后 GitHub Actions）：test.yml 绿；打 tag 后 npm-publish.yml 发布成功且 npx 冒烟通过

## 6. 风险评估与回滚 (Risk & Rollback)

### 风险清单
| 风险点 | 等级 | 影响范围 | 缓解措施 |
|:---|:---|:---|:---|
| deploy-gate 误伤合法命令（如测试里的 aws s3 cp） | High | 目标仓 agent 工作流 | ask 带默认 + env 批准通道 + patterns 全量可配；evals 覆盖三带行为 |
| 已有安装（v1.0.0 目标仓）upgrade 后 settings 无 deploy-gate 接线 | Medium | 旧仓新 hook 不生效 | mergeSettings 从 kit settings.json 合并，upgrade 自动补；check 会标 MISSING |
| evals 用例顺序依赖（plan-gate marker） | Medium | CI 稳定性 | 用例表按序执行是文档化契约；session_id 隔离（eval1/eval2） |
| npm 发布带出多余文件 / repository.url 占位错 | Medium | npm 包质量 | files 白名单 + npm pack --dry-run 核对；发布前用户改 org 一行 |
| 本会话 bash 不可用，测试无法当场跑 | Medium | 交付信心 | 代码 100% 落盘 + 验证命令成文；CI 兜底 |
| plan-gate 在无 git 临时目录的 eval 行为 | Low | evals 确定性 | 已验证：git status 失败 → catch → inflow=false → 首改必问（exit 2），确定 |

### 回滚路径
#### 场景 1: 纯代码变更（本轮即此）
```bash
git revert <commit> && git push origin main
# 或单文件：git checkout HEAD~1 -- cli.mjs && git commit -m "rollback cli.mjs"
```
#### 场景 2: npm 包已发且有缺陷
```bash
# npm 不支持撤版本：deprecate + 快修发 patch
npm deprecate nuwa-sdlc-kit@1.1.0 "use 1.1.1"
node scripts/bump-version.mjs 1.1.1 && git tag v1.1.1 && git push origin v1.1.1
```
#### 场景 3: 目标仓 upgrade 后新 hook 行为不符预期
```bash
# 目标仓内：删掉 deploy-gate 接线或整条回退
node <kit>/cli.mjs upgrade 前先 git commit，出问题 git checkout HEAD~1 -- .claude/
# 或临时停用：export SDLC_APPROVE_DEPLOY=1（ask 带）/ 删 .sdlc.json deployGate 节
```
### 回滚验证清单
- [ ] 回滚后 `npm test` 全绿
- [ ] `node cli.mjs check --dir <旧仓>` 不回归（v1.0.0 语义）
- [ ] 已装仓 agent 会话无 hook 报错刷屏
