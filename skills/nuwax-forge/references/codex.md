# Codex 主控宿主

安装入口选择 `--host codex --host-root <agents-root>`；默认标准用户目录 `~/.agents`。
注册为 `<host-root>/skills/nuwax-forge/SKILL.md`，保留自动发现，不修改 config、Hook 或其他 Skill。
使用当前 Skill 的 scripts/forge.mjs 入口，不能回指源码 checkout。

新 Codex 子执行会话由 CLI 的 exec --json --ephemeral --ignore-user-config --ignore-rules 创建。
现有适配器关闭项目说明注入和 multi_agent；不要在 brief 中要求读取主控 Skill。
先用 `agent doctor --runtime codex --json` 确认协议；它不验证认证或模型能力。
