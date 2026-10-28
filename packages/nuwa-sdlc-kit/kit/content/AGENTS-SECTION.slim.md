<!-- nuwa-sdlc-kit:begin v1（安装器托管区间，勿手工增删行；本节外的 AGENTS.md 内容归仓库所有） -->

## AI SDLC 规则层（slim）

- **小修直接改**：BUG 修复、小调整按行为风险判断，改前一句话说清「改什么、为什么」，改完跑受影响测试（入口：`{{TEST_COMMAND}}`），不生成计划/规格工件，不按文件数量升级流程。
- **复杂需求最多一份计划**：跨模块、新契约或需拍板的需求，用 `templates/plan.md` 在 `plans/` 维护一份计划（已有计划直接更新）；不建 intent/spec 链。
- **按风险投入**：已覆盖路径的小修不强制新增测试，不为走流程写文档；重构可用已有测试或产物对比证明等价。
- **合并前查一遍**：大量代码合入主干前按 `REVIEW.md` 清单检查一次整个待合并批次；日常小 commit 不要求。
- **地板（hooks 强制，agent 无关）**：秘钥/受保护路径由 `.claude/hooks/guard-paths.mjs` 拦截（`.env*`/证书/credential 类拒读写，example 豁免）；发布/破坏性命令由 `.claude/hooks/deploy-gate.mjs` 分带拦截（force push 硬禁，发布类需 `{{ENVPREFIX}}_APPROVE_DEPLOY=1` 批准，带配见 `.sdlc.json` deployGate）。
- **单一事实源**：本文件是正文{{ENTRY_NOTE}}；勿复制出第二份。
- **非 Claude Code agent 兼容**：hooks 在 Claude Code 与 ZCode 均强制；codex / opencode / cursor 读本文件即可，规则即全部文字，无隐藏要求。

<!-- nuwa-sdlc-kit:end -->
