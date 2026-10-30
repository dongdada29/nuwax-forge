# DeepSeek Harness 主控宿主

当前核对版本 0.2.1-rc.5 的 dsh-skill-filesystem 默认发现项目 Git 根 `.dsh/skills`、`.agents/skills`，以及 `$DSH_HOME/skills` 和 `$DSH_AGENTS_HOME/skills`。
安装选择 `--host deepseek-harness --host-root <DSH_HOME>`（必须显式指定已核对的路径，或设置 `$DSH_HOME`）；也可显式指定 `<project>/.dsh`。不写 cordis/profile/global settings，不导入桌面认证。
目录 bundle 的 SKILL.md 用 name/description 发现，references 按需读取。详细源码依据见分发包 docs/INSTALLATION.md。

执行前运行 `agent doctor --runtime deepseek-harness --json`。
新 headless 子会话使用任务私有 DSH_HOME。既有适配器禁用子代理；子会话不应发现或加载本主控 Skill。
由 prepare 产出独立 patch，禁止复制主控 profile、历史或用户配置。
