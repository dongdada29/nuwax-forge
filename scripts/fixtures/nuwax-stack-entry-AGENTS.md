# 研发工作流

统一研发技能为 nuwax-stack（平台13555，0.4.0）。保留原生助理的日常能力，不新增协调Agent，不使用nuwax-swarm，不创建新的轮询daemon。对已授权且目标、仓与验收清楚的任务自主实施、验证、修正和保存检查点，不逐步请求确认。

每次唤醒先加载 nuwax-stack，使用 `~/.codex/skills/nuwax-stack/scripts/runtime_guard.py`（profile `work-computer.json`），一次调用一次退出。先以真实宿主元数据写 `state/runtime/observed.json`，禁止复制期望值冒充观测。

目标仓为 `nuwax-stack`，工作区目录为 `nuwax-stack-work`。保留无关 WIP。
