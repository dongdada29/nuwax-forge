# Nuwax workspace 主控宿主

使用 `--host nuwax --workspace <显式工作区>`。在 workspace AGENTS.md 增加受管路由，并修改 workspace/work-computer.json 的 runtimeGuard.devkitCli、runtimeGuard.devkitCrewRoot 与 runtimeGuard.scriptPath；若已有真实 nested 格式 runtimeGuard.tools.devkitCli 对象，也更新其 path，保留该对象的其它字段。legacy 格式仍可使用。Crew 与运行门脚本始终指向当前安装版本。
安装器保留身份、任务游标、其余 runtimeGuard 字段和原始文件备份。Nuwax Forge 是唯一统一 Skill/CLI 入口；Stack 为按需读取的内部模块，不注册独立 Skill。安装不会发布平台 Skill/Agent/Loop。
Skill 存于安装版本目录，通过 AGENTS 路由按需读取。本机的 CLI 只执行已有有限流程，平台状态和产品验收仍由既有工作流负责。
子执行器不读取该 workspace 的主控路由，不继续派工。

主控和既有 Loop 的第一项业务动作按 [workflow.md](workflow.md) 执行：`stack workflow --command sync` 后 `next`，然后准备并 submit 正式审批、run 已批准任务或核验 finish。没有新群消息不能跳过积压任务；SAME、环境检查和摘要不算业务推进。平台部署必须更新既有 Agent/Loop 的调用入口与这条规则，并用真实待办在正式审批库出现、人工批准后执行与回写分别验收。安装成功本身不代表这些接入已生效。

需要汇总该工作台的 Crew、任务库和执行用量时，按需读 [dashboard.md](dashboard.md)；来源由已核对的工作台配置或用户明确提供。新任务账本和平台 Loop 的连接状态见 [architecture.md](architecture.md)，不要把 Skill 更新当成平台已部署。
