<!-- nuwa-sdlc-kit:begin v1（安装器托管区间，勿手工增删行；本节外的 AGENTS.md 内容归仓库所有） -->

## AI SDLC 规则层

- **需求分级，按大小走流程（勿为小修生成工件拖时间）**：① 小修/BUG 修复——改动 ≤3 文件、无新接口契约、无跨模块联动、无需产品拍板，且改前能一句话说清「改什么、为什么」——不建 intent/spec/plan，直接改 + 跑该域质量门测试；② 中等需求只出 `plans/*-plan.md` 一件；③ 新功能/大需求/跨模块才走完整链 skills `requirement-analysis` → `plans/*-intent.md`、`grill-with-docs` → `specs/<slug>.md` → Plan mode 产物 `plans/*-plan.md`（模板在 `templates/`）。
- 源码首改会被 `.claude/hooks/plan-gate.mjs` 提醒一次（同会话只问一次）：**小修/BUG 直接重试刚才的编辑即放行，无需任何工件**；大需求先备 `plans/` 工件再动源码。`{{ENVPREFIX}}_SKIP_PLAN_GATE=1` 停用；秘钥由 `.claude/hooks/guard-paths.mjs` 拦截（`.env*`/证书/credential 类拒读写，example 豁免）。
- 大量代码合并主干分支前（提测/发版/特性分支大批量合入）走 skills `pre-commit-quality-review`（slash command `/quality-review` 可直接点名）三问自查整个待合并批次——功能逻辑内聚 / 代码分层 / 可维护性，带证据给结论、质量门测试绿了再合并；日常小 commit 可跳过。
- PR 评审对照根目录 `REVIEW.md` 五遍清单（nit≤5；writer 不自批）。
- **单一事实源**：本文件是正文{{ENTRY_NOTE}}；勿复制出第二份。

### 非 Claude Code agent 兼容

- 本文件、`templates/`、`REVIEW.md`、skills 正文全是纯 markdown：skills 双落点播种 `.claude/skills/` 与 `.agents/skills/`（后者供 ZCode workspace 级自动发现）；codex / opencode / cursor 等**直接读任一副本即可**，需要某条流程时让 agent `cat <落点>/<name>/SKILL.md` 照做。
- 强制机制差异：PreToolUse hooks 在 Claude Code（`.claude/settings.json`）与 ZCode（`.zcode/config.json`，v1.3.0 起由安装器合入）都强制执行；其余 agent 的兜底 = 提交前按同一规则自查，非协商护栏建议下沉 git pre-commit / CI（agent 无关的强制地板）。
- verifier 等价物：任何 agent 跑 `{{TEST_COMMAND}}` 按报告格式贴结论即可，不必有子代理机制。

<!-- nuwa-sdlc-kit:end -->
