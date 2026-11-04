# 文档导航

当前状态核对基线：2026-11-04，main `90ae4cfecb1610621d300bf60079d109bcc522a9`。本批 Bot、工具桥、DSH 看板及 PA 受限 intake 实现已合入主线；源码、测试通过与用户安装版本分别判断。

## 使用与能力

| 目的 | 入口 |
| --- | --- |
| 理解模块与证据边界 | [架构](ARCHITECTURE.md)、[能力与验收边界](CAPABILITIES.md) |
| 安装或升级 Forge | [离线安装](INSTALLATION.md) |
| 启动长期 Bot 团队 | [Bot 快速开始](BOT-QUICKSTART.md) |
| 查看 Bot 当前验收状态 | [Bot 接入汇总](BOT-INTEGRATION.md) |
| 让 Bot 准备一次有限执行 | [Bot → Forge 桥](BOT-FORGE-BRIDGE.md)：需操作者配置，仅 prepare/status |
| 把 Bot、PA intake 与 Forge 接成一条链 | [专用实例接线](BOT-PA-FORGE-WIRING.md)：三跳全默认关，专用实例开启 |
| 使用 Codex / DSH 有限执行器 | [Agent 适配](CLIENT-AGENTS.md)、[预算与上下文](AGENT-BUDGET-EFFICIENCY.md) |
| 查看任务与用量 | [CLI 看板](../packages/cli/README.md#运行看板)、[DSH 看板插件](DSH-DASHBOARD-INTEGRATION.md)、[预算下界展示](DASHBOARD-BUDGET-OBSERVATION.md) |
| 展示原 PA 任务与交付状态 | [PA 快照适配](PERSONAL-AGENT-ADAPTER.md)：只读本地导出，不控制 PA |
| 运行验证 | [集成测试入口](INTEGRATION-TESTS.md)、[预算](TOKEN-BUDGET.md)、[可选 GUI](MIDSCENE-LIVE.md) |

## 专项证据

- [非空记忆](BOT-MEMORY-ACCEPTANCE.md)：原模块、工具权限、隔离及正常关闭后的进程重启；fixture 宿主服务。
- [群与模型路由](BOT-GROUP-ROUTING-ACCEPTANCE.md)：原模块 admin-first、`@`、成员模型及自身私聊摘要行为；fixture 宿主服务。
- [真实 DSH 到本地 provider](BOT-PROVIDER-HOST-ACCEPTANCE.md)：原用户 API、两个模型路由和聊天回复回读；回复由本地模拟服务生成。
- [原生 DSH 插件就绪](DSH-PLUGIN-OBSERVATION.md)：进程成功与 pluginReady 分开。

真实模型自主选择工具、记忆摘要/审查、完整群详情布局、系统默认浏览器启动和其他平台体验仍未验收。群成员首次输入包含自身私聊摘要；这与读取其他 Bot 私聊分别判断，不能据 fixture 推断真实模型不会复述信息。详情以各专项报告的边界为准。

## 历史资料

[历史索引](archive/README.md) 收录 2026-10 的迁移、试点验收与改进提案。它们保留采集时的版本、路径、计数和问题，不作为当前能力清单或当前缺陷复现结论。
