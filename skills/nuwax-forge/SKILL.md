---
name: nuwax-forge
description: 使用 Nuwax Forge 进行短上下文任务派工、预算对账、任务恢复和模型/Agent 运行看板；适用于 Codex、DeepSeek Harness 与 Nuwax 宿主，Stack 和 Crew 为内部模块。
---

# Nuwax Forge

通过本 Skill 的 `scripts/forge.mjs` 调用安装版 CLI。先执行 `node <本Skill>/scripts/forge.mjs doctor --json`，再按当前宿主读取一个 reference：

- Codex：[references/codex.md](references/codex.md)
- DeepSeek Harness：[references/deepseek-harness.md](references/deepseek-harness.md)
- Nuwax workspace：[references/nuwax.md](references/nuwax.md)

任务格式与命令见 [references/execution.md](references/execution.md)。用既有 `agent doctor → prepare → run → reconcile`，prepare 的 HIGH 预算检查通过后才可运行；预算由 CLI 实施，不以提示词代替。缺失/unknown 实耗不能记 0。预算是相位门，不是 provider 或宿主总 token 硬上限。

需要理解 Router、Worker、任务账本与各模块关系时读取[架构与任务状态](references/architecture.md)；需要查看任务、模型、执行器及用量分布时读取[运行看板](references/dashboard.md)。先用本 Skill 入口的 `help` 确认已安装版本支持所需命令；源码有功能不等于当前安装或平台已更新。

只向新执行会话交付短 brief、明确文件和验收命令；不要传父会话、全量历史或全部 Skill。子执行器只完成 brief，不加载本主控 Skill、不递归派工、不恢复旧会话。若当前会话已是子执行器，直接完成交付任务并退出，不再调用 agent run。模型运行须在用户授权范围内；doctor/prepare/reconcile 不调用模型。

源码完成、进程成功、预算结算、产品验收分别报告。安装不授予提交、推送、部署、平台修改或凭据访问权限。

Stack 研发工作流按需调用 `node <本Skill>/scripts/forge.mjs stack module --name index`，再读取对应模块。环境/租约/上下文/退避/派工统一走 `stack runtime --command check|lease|context|backoff|dispatch|record --profile <既有profile> [--input <JSON>]`，保留同一 TaskStore、游标与预算门。内部模块不注册为独立 Skill。
