# Nuwax workspace 主控宿主

使用 `--host nuwax --workspace <显式工作区>`。仅在 workspace AGENTS.md 增加受管路由，并修改 workspace/work-computer.json 的 runtimeGuard.devkitCli 与 runtimeGuard.devkitCrewRoot；若已有真实 nested 格式 runtimeGuard.tools.devkitCli 对象，也更新其 path，保留该对象的其它字段。legacy 格式仍可使用。crewRoot 始终指向安装版本。
安装器保留身份、任务游标、其余 runtimeGuard 字段和原始文件备份。现有 nuwax-stack 仍是平台唯一统一技能入口；不发布新的平台 Skill/Agent/Loop。
Skill 存于安装版本目录，通过 AGENTS 路由按需读取。本机的 CLI 只执行已有有限流程，平台状态和产品验收仍由既有工作流负责。
子执行器不读取该 workspace 的主控路由，不继续派工。
