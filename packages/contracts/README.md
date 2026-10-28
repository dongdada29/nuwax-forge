# @nuwax-ai/devkit-contracts

nuwax-devkit 共享契约包（零依赖 Node ESM）。**本地预发布 `0.1.0-devkit-local.1`，不发布。**

- `schemas/verification-v1.schema.json` —— **唯一正本**（自原 stack references 迁入）。
  stack 技能分发持有字节一致副本；`npm run sync` 同步、`npm run check` 校验，
  测试含字节漂移断言（单正本）。
- `gui/levels.mjs` —— level 边界正本：`source-tooling`（已实现）、`gui-toolchain-smoke`、
  `gui-product-scenario`（可选，pending live driver）。
- `gui/midscene-report.mjs` —— **合成 fixture 离线校验器**（不是 live 报告 parser，无 live 命令）：
  任务按 `(报告, group, execution, taskId)` 合并、usage 按 callId 去重、终态冲突检出、
  Boolean/Assert 输出必须与期望比较、finished/exit0 不构成通过、模型观测缺失记 unknown。
- `docs/task-runtime-v1.md` —— task/runtime 已实现字段声明（真实强校验在 `crew/contract.py` 运行时）。

测试：`npm test`（node --test）。
