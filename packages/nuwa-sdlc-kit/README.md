# nuwa-sdlc-kit

## 可选固定验证入口

仓库已有真实验证配方时，可单独接入：

```sh
node cli.mjs verify:init --dir <repo> --recipe .verification/client-tooling.json
node cli.mjs verify --dir <repo> --output <仓外证据目录>
```

verify:init 只登记 verification 配置并复制 scripts/sdlc-verify.mjs，保留既有 slim/full、hooks 与仓库配方。init/upgrade 仅在已经 opt-in 的仓库刷新该运行器；未接入的 slim 安装面不变。

配方 schemaVersion=1，包含 id、level、inputs 和 stages；每阶段用 argv 数组、predicate、可选 timeoutMs/JSON 断言声明操作。运行器保存真实退出码、日志哈希、输入文件指纹和环境，失败立即停止。输出目录必须在仓外，只清理自身启动的进程组。

`--reuse` 显式启用已有证据复用：代码、Node/主机环境与日志哈希必须仍匹配。产品构建计数只覆盖配方声明的 build 阶段；测试 fixture、未知子命令和模型服务端耗时不混入该指标。通过结果仍须按 level 区分源代码、UI、安装包和真机验收。

把 [Anthropic《AI-Native SDLC Playbook》](https://claude.com/blog/the-ai-native-sdlc-playbook)的规则层做成**可一键安装、可升级、多 agent 兼容**的工程套件。源自 nuwax / nuwa-cli / nuwa-browser / nuwax-client / nuwax-swarm 五仓的实战移植，抽出的公共件沉淀于此。

## 三层内容观（升级语义的根）

| 层 | 内容 | 升级行为 |
|---|---|---|
| **引擎件**（kit 托管） | slim：`guard-paths.mjs`、`deploy-gate.mjs`；full 另含 `plan-gate.mjs`、`scripts/sdlc-evals.mjs`；`.claude/settings.json` / `.zcode/config.json` 合并项 | `upgrade` 覆盖。差异全部走目标仓 `.sdlc.json` 运行时配置，**引擎文件跨仓逐字节相同** |
| **内容件**（播种一次，本地所有） | full：`templates/` 三件、skills（`.claude/skills/` + `.agents/skills/` 双落点）、`REVIEW.md`（五遍清单）、verifier、`samples/`、CI workflow（GitHub 仓播 `.github/workflows/sdlc-evals.yml`，GitLab 仓播 `.gitlab-ci.yml`）；slim：`templates/plan.md` 单件 + 单遍 `REVIEW.md` | 安装器**永不覆盖**；仓库自行演化 |
| **入口层** | `AGENTS.md` 托管区间（`nuwa-sdlc-kit:begin/end` 注释对内；slim/full 各自模板渲染） | 只替换区间内内容；区间外归仓库 |

介绍页（S3 静态页）：https://s3.nuwax.com:9443/nuwax-packages/agent-engines/nuwa-sdlc-kit/site/index.html
使用说明（S3 直链，随发布同步）：https://s3.nuwax.com:9443/nuwax-packages/agent-engines/nuwa-sdlc-kit/docs/README.md

## 安装

```bash
# 方式一：Nuwax S3 一键装（MinIO，bucket 公开可读；自签端点脚本自动回退 -k）
curl -fsSLk https://s3.nuwax.com:9443/nuwax-packages/agent-engines/nuwa-sdlc-kit/install.sh | bash
# 做：拉 latest.json → 下载 tar.gz → sha256 校验 → 装到 ~/.nuwa-sdlc-kit/<版本>/ → 软链 ~/.local/bin/nuwa-sdlc
# 确认 ~/.local/bin 在 PATH 里

# 方式二：npx 直装（npm 已发包，免装 kit）——默认 slim 地板档，完整工件链加 --profile full
npx --yes @nuwax-ai/nuwa-sdlc-kit init --dir <目标仓> --name myrepo --test 'pnpm test'

# 方式三：本仓直用
node /path/to/nuwa-sdlc-kit/cli.mjs init --dir <目标仓> \
  --name myrepo \
  --profile slim \           # slim=地板档（新仓默认）| full=完整工件链（v1.4.0 面）
  --src 'packages/[^/]+/src/,apps/[^/]+/src/' \   # 仅 full：plan-gate 的源码区正则
  --test 'pnpm test' \
  --protected 'docs/spec.md' \
  --env-prefix SDLC \
  --grill ./grill-extra.md \ # 仅 full：本仓特有拷问项
  --pre-commit              # 顺带安装 .git/hooks/pre-commit 秘钥地板（可选）
```

方式一装完 kit 后，在目标项目做一次初始化（项目目录维度）：

```bash
nuwa-sdlc init \
  --name <仓标识> \
  --src 'src/' \                    # plan-gate 的源码区正则（逗号分隔多个）
  --test 'pnpm exec vitest run' \   # 全量测试命令（verifier/模板引用）
  --env-prefix NUWACLAW \           # 停用开关前缀 → <PREFIX>_SKIP_PLAN_GATE=1
  --protected 'agents.yaml' \       # 受保护写入路径（可选）
  --grill ./grill-extra.md          # 本仓特有拷问项（可选）
```

真实样例（nuwax 仓在用）：`nuwa-sdlc init --name nuwax --src 'src/' --test 'pnpm exec vitest run' --env-prefix NUWACLAW --grill /tmp/nuwax-grill.md`

init 幂等：重复执行时内容件标记 `已存在，未动`；`.sdlc.json` 一经写入不被覆盖。

## 体检与升级

```bash
nuwa-sdlc check [--dir <repo>]    # 引擎漂移/缺失体检（按 .sdlc.json profile 分档，exit 1 = 有问题）
nuwa-sdlc upgrade [--dir <repo>]  # 仅刷新引擎件+settings 合并+托管区间，内容件不动
nuwa-sdlc upgrade [--dir <repo>] --profile slim   # 转换安装面（full→slim 清理引擎件/接线/kit CI；反向同理）
```

已有项目升级：新版本发布后重跑一键装（方式一）+ `nuwa-sdlc upgrade --dir <仓>` 即可跟平引擎件与 AGENTS 托管区；**内容件新增**（如 v1.3.0 的 `pre-commit-quality-review` skill 与 `.agents/skills/` 双落点）须重跑 `nuwa-sdlc init --dir <仓>` 幂等补种——已存在的文件一律不动、`.sdlc.json` 保留，且 cfg 默认取旧值，裸 init 不会冲掉既有渲染。

## 多 agent 兼容（三档）

1. **通用层**：AGENTS.md / templates / REVIEW.md / skills 正文全是 markdown——codex、opencode、cursor 等直接读；skills 双落点播种 `.claude/skills/`（Claude Code 原生触发）+ `.agents/skills/`（ZCode workspace 级自动发现触发，ZCode 不扫描 `.claude/`；其余客户端任一副本可 `cat` 照做）。
2. **逐工具适配**：PreToolUse hooks 在 Claude Code（`.claude/settings.json` 合并）与 ZCode（`.zcode/config.json` 合入，v1.3.0 起）都强制执行；verifier 的等价物 = 跑测试命令按格式贴结论；经 nuwa-cli serve 托管的引擎可走 ACP 层强制（见 Roadmap）。
3. **地板层**：非协商护栏建议下沉 git pre-commit / CI（agent 无关强制点）。

## Deploy 闸门、evals 与监控分带（v1.1.0+）

- `.claude/hooks/deploy-gate.mjs` 对 Bash 发布类命令分带拦截：**block**（如 force push，硬禁，只认配置修改）、**ask**（默认，人工 `export SDLC_APPROVE_DEPLOY=1` 批准后放行）、**allow**（在默认带中开洞）。带表在 `.sdlc.json` 的 `deployGate.patterns` 配置，完整样例见 `samples/deploy-gate.example.json`。
- `scripts/sdlc-evals.mjs`（CI 入口 `node scripts/sdlc-evals.mjs --dir .`）：对已装 hooks 灌样本事件断言 exit code，11 条用例覆盖秘钥护栏 / 计划门禁 / Deploy 闸门；`.github/workflows/sdlc-evals.yml` 在规则文件变更时自动触发。CI 模板按远端自动挑选：GitHub 仓播 `.github/workflows/sdlc-evals.yml`，GitLab 仓播 `.gitlab-ci.yml`；`init --ci github|gitlab|both` 可显式指定（origin 含 gitlab、已有 `.gitlab-ci.yml`、或命中 `NUWA_SDLK_GITLAB_HOSTS`（逗号分隔，如 `git.yichamao.com`）时自动识别）。
- Maintain 监控分带样例 `samples/maintain-bands.md`：P0 红（agent 停手止血）/ P1 黄（PR 必须引用工单）/ P2 绿（记录周报）。
- pre-commit 秘钥地板 `samples/pre-commit.secrets.sh`：agent 无关强制层，`init --pre-commit` 直接装入 `.git/hooks/`。

## 提交前质量自查 skill 与 skills 双落点（v1.3.0+）

- `skills/pre-commit-quality-review`：**大量代码合并主干分支前**（提测/发版/特性分支大批量合入）的三问自查——**功能逻辑内聚 / 代码分层 / 可维护性**，以待合并批次（主干分支...HEAD + 未提交改动）为单位带证据走查，质量门测试绿了再合并；日常小 commit 可跳过。承接「先功能后重构」节奏：功能跑通 → 重构收敛 → 三问=重构验收门。AGENTS.md 托管区规则 bullet 已挂钩。
- slash command `/quality-review`（v1.3.1）：双落点播种 `.claude/commands/`（Claude Code）+ `.agents/commands/`（ZCode workspace 级发现），可直接点名本流程；带参数限定走查范围。
- skills 全量双落点播种：`.claude/skills/`（Claude Code 原生触发）+ `.agents/skills/`（ZCode workspace 级自动发现；codex / opencode / cursor 直读任一副本）。`check` 体检覆盖双落点。
- **ZCode hooks 接线**：三道 PreToolUse 闸门（guard-paths / plan-gate / deploy-gate）由安装器合入 `<repo>/.zcode/config.json`（`hooks.enabled: true` + `events.PreToolUse`，幂等合并保留既有键）——ZCode 与 Claude Code 的 hook 协议同构（stdin 事件 JSON、exit 0 放行 / 2 阻断），引擎文件零适配复用；引擎 cwd 解析补 `ZCODE_PROJECT_DIR`/`CLAUDE_PROJECT_DIR` 环境变量兜底。**生效须重启 ZCode 会话**。
- init 重跑安全：cfg 默认取旧 `.sdlc.json`（显式 flag 仍优先），裸 init 重渲染 AGENTS 托管区不再用出厂默认冲掉 `envPrefix`/`test` 等占位符值。
- 文档跟平：nuwa-work 更名 nuwax-client（README/site 已同步）。

## 小修快车道——需求分级（v1.4.0+）

- **动机**：一刀切「需求→规格→计划链」让 agent 做小需求/BUG 修复也先生成 plan 工件，白白拉长交付时间。v1.4.0 起按需求大小分级。
- **三级口径**（AGENTS.md 托管区同文）：① 小修/BUG 修复——≤3 文件、无新接口契约、无跨模块联动、无需产品拍板，且改前能一句话说清「改什么、为什么」——不建 intent/spec/plan，直接改 + 跑该域质量门测试；② 中等需求只出 `plans/*-plan.md` 一件；③ 新功能/大需求/跨模块才走完整 intent → spec → plan 链。
- **三层联动**：AGENTS 托管区规则改分级表述；`plan-gate.mjs` 提醒语重排——小修快道置顶（重试即放行、无需任何工件），大需求才指向 requirement-analysis → grill-with-docs，agent 被拦后不再机械去写计划；`requirement-analysis` / `grill-with-docs` 描述与正文加「仅新功能/大需求适用，小修不适用」防误触发。
- 升级说明：`upgrade` 刷引擎件（plan-gate）+ AGENTS 托管区即生效；skills 是内容件不随 upgrade 覆盖，已装仓须重跑 `init` 幂等补种或手工同步本地副本。

## slim 默认安装面——profile 两档（v1.5.0+）

- **动机**：六仓实战复盘（2026-10-16）发现 v1.4.0 前的安装面在 Codex 重度开发下制造大量仪式性开销——仅 2026-09-28 一天 nuwax 就为微小 UI 调整生成 15 份 plan 工件，nuwax / nuwax-client 随后清掉约 9800 行仪式性测试/文档/工件；各仓精简后不约而同收敛到同一条地板：**秘钥守护 + 发布/破坏性操作门 + 一遍评审 + 复杂需求至多一份计划**。v1.5.0 把这条实战结论做回 kit 默认安装面。
- **两档**（`init --profile slim|full`，记入 `.sdlc.json` `profile` 字段）：
  - `slim`（**新仓默认**）：guard-paths + deploy-gate 双 hook（Claude/ZCode 双接线）、单遍 `REVIEW.md`、单件 `templates/plan.md`、精简 AGENTS 托管区；`.sdlc.json` 不写 `srcPaths`/`plansDirs` → 本地不装 plan-gate，**经 nuwa-cli ACP 托管的引擎（codex 等）计划 ask 也从根静默**（sdlcGate 读不到 srcPaths 即放行，秘钥/发布拦截不变）。
  - `full`（完整工件链，即 v1.4.0 面）：三 hook + evals + skills/commands 双落点 + intent/spec/plan 模板 + verifier + samples + CI evals 播种。
- **老仓零惊扰**：已装仓 `.sdlc.json` 无 `profile` 字段一律视为 `full`，裸 `init`/`upgrade` 行为与 v1.4.0 完全一致；显式 `--profile` 才转换。
- **转换**：`nuwa-sdlc init|upgrade --dir <仓> --profile slim`——删 plan-gate/evals 引擎件、剪除 settings/`.zcode` 接线、删 kit 播种的 CI evals 工作流（`.gitlab-ci.yml` 仅逐字节等于模板渲染结果才删）、`.sdlc.json` 剥 `srcPaths`/`plansDirs`；**内容件一律不删**（本地所有），以遗留清单打印供手工清理。回转 `--profile full` 补回引擎件与默认 `srcPaths`，内容件需重跑 `init` 补种。
- **check 分档**：slim 只验地板件与两份内容件；full 验 v1.4.0 全量面；slim 仓检出 full 面遗留件时只提示不计失败。

## 发布（维护者）

```bash
# S3 渠道（Nuwax MinIO，与 nuwa-cli / nuwa-browser 同仓布局）
bash scripts/publish-s3.sh   # 凭证走 ~/.aws [default]（MinIO 键）或 NUWAX_S3_* 环境变量；含前缀防呆
# 产物：s3://nuwax-packages/agent-engines/nuwa-sdlc-kit/{install.sh, latest.json, nuwa-sdlc-kit-<ver>.tar.gz, site/index.html, docs/README.md}

# npm 渠道：升版后打 tag，CI 自动发布并做 npx 冒烟
npm run bump -- 1.2.0 && git commit -am 'v1.2.0' && git tag v1.2.0 && git push origin main v1.2.0
```

## Roadmap

- [x] **slim 默认安装面·profile 两档（v1.5.0）** → 新仓默认只装地板（guard/deploy 双 hook + 单遍 REVIEW + 单件计划模板），`.sdlc.json` 不写 srcPaths 使 ACP 侧计划门静默；full = v1.4.0 全量面 opt-in；老仓无 profile 字段视为 full，`--profile` 显式转换（引擎件/接线/CI 清理，内容件保留列清单）
- [x] **小修快车道·需求分级（v1.4.0）** → 托管区分级规则 + plan-gate 提醒语小修快道置顶 + skills 触发口径排除小修；小需求/BUG 修复不再被拖去生成 plan 工件
- [x] **提交前质量自查 skill + skills 双落点（v1.3.0）** → `skills/pre-commit-quality-review`（writer 侧三问：内聚/分层/可维护性，挂在 AGENTS 托管区）；全部 skills 补播 `.agents/skills/` 供 ZCode workspace 级自动发现；init 重跑 cfg 默认取旧值防占位符被冲
- [x] CI 模板（规则文件变更触发 evals 门禁）→ `kit/content/ci/{github,gitlab}-sdlc-evals.yml`，随 init 按远端播种（详见下方 GitLab 条目）
- [x] pre-commit 地板样例（秘钥扫描，agent 无关强制）→ `kit/content/samples/pre-commit.secrets.sh`，`init --pre-commit` 直装
- [x] Deploy 闸门 hook（allow/ask/block）与 Maintain 监控分带配置样例 → `kit/engine/deploy-gate.mjs` + `samples/maintain-bands.md`
- [x] `npx @nuwax-ai/nuwa-sdlc-kit init`（package.json bin 封装）→ tag `v*` 自动发布（`.github/workflows/npm-publish.yml`）。npm 渠道唯一包名 `@nuwax-ai/nuwa-sdlc-kit`；旧无 scope 包 `nuwa-sdlc-kit` 已于 2026-09-03 从 npm 删除（unpublish）。注：publish 不带 `--provenance`——sigstore 溯源要求 public 源仓库，本仓私有永远 E422，转 public 后可加回
- [x] nuwaclaw（现 nuwax-client）落地收尾 → `78b52d3a`（ai-native-sdlc-w1 分支）：适配版 hooks 收敛回统一引擎，基线 33 个在途测试失败与本变更无关
- [x] **ACP 层多 agent 强制** → nuwa-cli serve 已接线（`faa584e`，decidePermission 顶端）：读工作区 `.sdlc.json` 对 `session/request_permission` 做 deny/ask 判定，serve 托管的所有引擎（codex/zcode/claude/pi/opencode）统一生效；参考实现 `kit/content/samples/acp-gate.nuwa-cli.reference.ts`
- [x] **介绍页** → `site/index.html`（瑞士 spec-sheet 浅色风：纸面墨线 + 信号橙 + 深色终端块），`publish-s3.sh` 随版本上传，线上 `…/nuwa-sdlc-kit/site/index.html`
- [x] **GitLab CI 门禁模板** → `kit/content/ci/gitlab-sdlc-evals.yml`（MR changes 路径触发 + node 20/22 矩阵），`init --ci github|gitlab|both` 按 origin 自动挑选，`check` 对 `.github/workflows/` 与 `.gitlab-ci.yml` 双兼容

## 已知落地

**五仓已全部跟平 kit v1.2.0（2026-09-04，`upgrade` 仅刷引擎件，各仓业务改动零夹带）**

- nuwax `0fc8e32aa` + `.gitlab-ci.yml`（`d95dd9ebc`）+ 跟平 `9fbb7e9c6`（feat-dong.0930）
- nuwa-cli `f9bd401` + `faa584e`（ACP 门禁）+ 跟平 `e241a88`（ai-native-sdlc-w1）
- nuwa-browser `400d8cf` + `5cc61db` + 跟平 `f1c9493`（main）
- nuwax-swarm `cfed95e` + 跟平 `bacda35`（ai-native-sdlc-w1）
- nuwax-client（原 nuwaclaw → nuwa-work → 现名）electron 重建后的 main 已重装 v1.2.0 `3261811c`（`--src 'overlay/' --test 'npm run base:test' --env-prefix NUWACLAW --ci github`）；旧落地 `78b52d3a` + `35b812db` 留在改名前分支

**五仓已全部跟平 kit v1.3.0（2026-09-14，`init` 幂等补种——skill 双落点 + ZCode hooks 接线；已存在内容件零改动、`.sdlc.json` 保留）**

- nuwax `64a6be6b7`（feat-dong.0930）
- nuwax-client `ee4c6b7b`（release/v1.0.x；补播缺失的 CI workflow）
- nuwa-cli `0f327bf`（ai-native-sdlc-w1）
- nuwa-browser `4334ac2`（main）
- nuwax-swarm `e9a7182`（ai-native-sdlc-w1；仅 kit 文件，在途业务改动零夹带）

注：`.zcode/config.json` 在 nuwax / nuwax-client / nuwa-browser 原被 `.zcode/` 整目录忽略，已改 `.zcode/*` + `!.zcode/config.json` 精确放行使接线随 git 共享（nuwax 的 `.git/info/exclude` 本地排除行一并移除）。以上均未推送。

**六仓已跟平 kit v1.4.0（2026-09-28，`upgrade` 刷引擎件+托管区；skills 内容件逐仓手工同步双落点）**

- nuwax `8a17c4e243`（feat-dong.0930，并行会话收编提交）
- nuwax-client `559dd697`（release/v1.0.x）
- nuwa-cli `39cc8a5`（ai-native-sdlc-w1）
- nuwax-browser `e6aa9e5`（main）
- nuwax-swarm `d95db62`（ai-native-sdlc-w1；在途业务改动零夹带）
- nuwax-client-plan `7039be0e`（feat/plan-mode-mcp）
- nuwax-avoid32 跳过：detached HEAD 基线对照检出，保持原样防污染
- v1.4.0 发布：S3 渠道 ✅（latest.json 已指向 1.4.0）；npm 渠道 publish 本身成功（`+ @nuwax-ai/nuwax-sdlc-kit@1.4.0`），但 registry 整包传播慢（旧包此前已整体消失、本次相当于重新上架），tag CI 的 npx 冒烟 5×10s 等不到而挂红——包上架后渠道即恢复，不影响 S3 主渠道

**四仓已转换 kit v1.5.0 slim 档（2026-10-18，`upgrade --profile slim`：删 plan-gate/evals 引擎件与 CI、剪双端接线、剥 srcPaths 使 ACP 计划门静默；秘钥/发布地板不变，各仓 slim 体检 8/8 绿）**

- nuwax `d92293f77`（dev；`.gitlab-ci.yml` 与 kit 模板逐字节一致一并删除——其内仅 evals job，业务 CI 在 GitHub Actions 不受影响；AGENTS 托管区外自有规则零改动）
- nuwa-cli `85456d1`（ai-native-sdlc-w1；ACP 层 sdlcGate 零改动，srcPaths 剥除后计划 ask 天然静默）
- nuwa-browser `75caa39`（main）
- nuwax-swarm `a6f26aa`（ai-native-sdlc-w1；在途业务改动零夹带）
- nuwax-client 不参与转换：已按实战结论手工精简为仓内地板版（`d463817f`），规则文本比 slim 托管区更贴仓情，保持现状
- **遗留 full 内容件已按 slim 规则二次清理并连同转换提交全部推远端（2026-10-19）**：nuwax `cf9666544`（dev → origin GitHub + gitlab 双远端）、nuwa-cli `40d5761`（ai-native-sdlc-w1）、nuwa-browser `c4b4184`（main → git.yichamao.com）、nuwax-swarm `d0f792e`（ai-native-sdlc-w1，远端新建分支）——删 skills 双落点+references / commands / verifier / intent·spec 模板 / samples，`REVIEW.md` 换单遍版，plan 模板换单件版；清理前逐文件与 kit 渲染基线比对：nuwax / nuwa-cli 的差异均为 prettier 格式噪声无仓知识，nuwa-browser / nuwax-swarm 原五遍清单与拷问项里的仓特有安全/架构/测试落位检查项收进 `REVIEW.md`「本仓专项」节保留。各仓 slim 体检 8/8 绿、无遗留提示
- v1.5.0 发布：S3 ✅（latest.json→1.5.0）；npm publish 实发成功（registry `latest` 已是 1.5.0），tag CI npx 冒烟再现传播延迟假红（同 v1.4.0，重试 5×10s 仍赶不上上架传播）
