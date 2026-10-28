# 模型 + Agent 能力矩阵（2026-10-25）

机器可读版：[capability-matrix.json](../capability-matrix.json)。分级含义：**L5** 旗舰（复杂架构/跨仓重构/疑难调试）· **L4** 主力（多文件实施/审查）· **L3** 标准（单文件/文档）· **L2** 轻量（分诊/总结/批量）· **FX** 专用执行器。状态=本机当前实测。

## 模型

| 级别 | 模型 | 载体（怎么调） | 成本 | 状态 |
|---|---|---|---|---|
| L5 | gpt-6-astra / gpt-5.6-luna·sol·terra | opencode（OpenAI oauth） | 订阅额度 | 待实测 |
| L5 | claude-opus-5.5 (h/m/l) | `agy --model claude-opus-5-5-medium -p` | Antigravity 订阅 | 配额受限 |
| L5 | gemini-4-argon (h/m/l) | `agy --model gemini-4-argon-high -p` | Antigravity 订阅 | 待实测 |
| L5 | codex 内置模型 | `codex exec --cd {worktree} {brief}` | Codex PRO $100 | ✅ 历史验证 |
| L4 | gpt-5.5(-fast) / gpt-5.3-codex-spark | opencode（OpenAI oauth） | 订阅额度 | 待实测 |
| L4 | claude-sonnet-5.5 (h/m/l) | `agy --model claude-sonnet-5-5-medium -p` | Antigravity 订阅 | 配额受限 |
| L4 | **zhipu/glm-5.3** | `opencode run -m zhipu/glm-5.3 {brief}` | 智谱 Token Plan Max | ✅ 已实测 |
| L4 | grok 默认模型 | `grok -p {brief}` | Grok PRO $20 | ✅ 已实测 |
| L4 | cursor 内置模型 | `cursor-agent -p {brief}` | Cursor 订阅 | ✅ 已实测 |
| L4 | claude-code 自配模型 | `claude -p {brief}` | 按所配模型 | ✅ 历史验证 |
| L4 | glm-5.3（1M 上下文，Coding Plan 账户通道） | `node ~/tools/zcode-cli/zcode.cjs -p {brief}`（需 ZCODE_AGENT_PROVIDER=account:bigmodel-individual-coding-plan） | 智谱 Coding Plan Max（5h 重置） | ✅ 已实测 |
| L4 | glm-5.3（cc-switch 通道，smol/slow/plan 分档） | `omp {brief}` | 智谱 Coding Plan Max（5h 重置） | ✅ 已实测 |
| L4 | DeepSeek（DSH harness） | `dsh --profile headless {brief}` | API 计费兜底 | ✅ 已实测 |
| L3 | gpt-5.4(-fast/-mini) | opencode（OpenAI oauth） | 订阅额度 | 待实测 |
| L3 | **gemini-3.8-flash (h/m/l)** | `agy --model gemini-3.8-flash-medium -p` | Antigravity 订阅 | ✅ 已实测 |
| L2 | zhipu/glm-5.3-flash | `opencode run -m zhipu/glm-5.3-flash {brief}` | Token Plan Max | 待实测 |
| L2 | glm-5.3-flash（ZCode 通道） | 同上 zcode 载体 | 智谱 Coding Plan Max | ✅ 随 zcode 已实测 |
| L2 | 免费档：glm-5.3-flash / deepseek-v4.1-flash / mimo-v2.6-flash / minimax-m3.1 / nemotron-3 / beam / flint-40b / longcat-2.5 | `opencode run -m opencode/<name>-free {brief}` | **免费** | 待实测 |

## Agent / 专用执行器

| 执行器 | 职责 | 级别 |
|---|---|---|
| 东的助理MBP128（33300105） | 唯一调度入口：接单/派工/验收/汇报 | FX-调度 |
| nuwax-crew（本项目） | brief → 派工计划（分层/交叉复核/降级/冷却切换） | FX-路由 |
| ego-browser（平台技能 13558） | 网页浏览与线上验证 | FX-验证 |
| 女娲Nuwax（A2A 协作群） | 平台能力与资料查询 | FX-查询 |
| DSH lead（接管会话） | 配置、验收、规则修订 | FX-协调 |

## 分配速查

- **难活（L5）**：codex →（配额受限解除后）claude-opus-5.5 / gemini-4-argon → gpt-6 系（oauth）
- **常规实施（L4）**：glm-5.3（便宜大碗）→ cursor → grok → claude-code
- **批量轻活（L2）**：免费档（opencode/*-free）→ glm-5.3-flash
- **调研**：grok；**网页验证**：ego-browser；**平台查询**：女娲 A2A
- 任一执行器 429/订阅受限：`crew health --mark <名> --reason quota --reset-in <倒计时>`，路由即时换人，冷却到期自动恢复
