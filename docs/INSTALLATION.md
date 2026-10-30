# 离线安装与回退

本入口只分发五个现有执行包与 nuwax-devkit 薄 Skill，不增加编排引擎或 MCP。
依赖 Node>=22、Python>=3.10。离线包专用 runtime 白名单只复制 CLI JS/Python、contracts schema/GUI 模块、crew Python、stack 验证桥接及 kit 引擎/模板（排除测试、历史设计档案与缓存；不改变普通 npm pack 的 package.json.files），不运行 npm install、不联网、不需要 registry 或 tar；分发包没有 node_modules，安装时才构建标准包解析布局。

```sh
node scripts/build-bundle.mjs --out /absolute/new-offline-bundle
# 将整个目录离线传给目标机器；下列命令均从分发包运行
node /absolute/new-offline-bundle/install.mjs install --host codex --root /absolute/managed/codex --host-root /absolute/codex-home
node /absolute/new-offline-bundle/install.mjs install --host deepseek-harness --root /absolute/managed/dsh --host-root /absolute/project/.dsh
node /absolute/new-offline-bundle/install.mjs install --host nuwax --root /absolute/managed/nuwax --workspace /absolute/workspace
node /absolute/new-offline-bundle/install.mjs rollback --root /absolute/managed/codex
node /absolute/new-offline-bundle/install.mjs uninstall --root /absolute/managed/codex
```

必须明确 host。root 默认 `~/.local/share/nuwax-devkit/<host>`，Codex host-root 默认标准用户 Skill 根 `~/.agents`，DSH 必须提供已核对的 `--host-root` 或 `$DSH_HOME`（不猜默认 home）。Nuwax 必须显式 workspace，且已有 work-computer.json。路径要是绝对的 canonical realpath；拒绝任何 symlink 分量（macOS `/tmp` 请先解析为 `/private/tmp`）、根、home 祖先、相互交叠和路径穿越。不会修改 shell/PATH、平台、Hook、宿主 config 或已有会话。

manifest.json 包含版本及所有文件 SHA256；内容地址版本目录 `versions/<version>-<manifest hash>` 保存原子切换前的版本。hash 是离线完整性检查，不是发布者签名；请通过可信渠道获取分发包。安装先核对全清单，再运行安装版 CLI doctor（Node/Python/五包解析），通过后才注册。Skill 的 installation.json 指向该受管版本的 CLI，不指向源码。清除诊断用包解析覆盖变量，保证自检基于安装版。

同包重装幂等；已有非受管 Skill/非空安装根拒绝。升级保留全部原版本及 byte-exact 原始 AGENTS/config。受管目标有人工修改时拒绝升级、回滚和卸载，避免覆盖。managed.json 保存原内容与版本历史；安装根应由当前用户私有保管，不要放凭据在安装包或任务 brief 中。事务文件在写入宿主前保存恢复快照；异常会尝试恢复，崩溃留下 install.lock 或 managed.json.transaction 时停止，核对快照并手动恢复后再清理，不盲目重试。

rollback 还原上一版本注册；uninstall 恢复最初 AGENTS/config、移除本 Skill 注册，保留受管根中的版本和备份供审计（不再有活动路由）。清理受管根可在卸载后由用户处理。不会删除其他 Skill、AGENTS 段落、配置、身份或任务游标。Nuwax 更新 runtimeGuard.devkitCli/devkitCrewRoot，并在原有 runtimeGuard.tools.devkitCli 对象存在时更新其 path、保留同对象其余字段；devkitCrewRoot 始终指向安装版本，不新增平台技能；平台唯一入口保持 nuwax-stack。CLI agent doctor/prepare 不验证真实认证或业务模型；run 须遵守当前任务已获得的授权范围。

## DSH 发现机制的当前依据

2026-10-30 只读核对本机 DeepSeek Harness 0.2.1-rc.5 的 app.asar：

- `dsh/node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js` 的 Config.includeDefaultRoots 默认 true；roots(cwd) 返回 Git 项目根 `.dsh/skills`（rank 100）、`.agents/skills`（200）、customSkillDirs（300）、dshHome/skills（400）和 agentsHome/skills（500）。discoverRoot 对目录加载 SKILL.md，并解析 frontmatter name/description。无 disable-model-invocation 时默认允许模型发现。
- `dsh/node_modules/@deepseek-ai/dsh-home-paths/lib/index.js` 的 resolveDshHome 按显式配置、DSH_HOME、`~/.dsh` 解析；agentsHome 按 DSH_AGENTS_HOME、`~/.agents` 解析。
- stock base cordis profile 注册 skill、skill-filesystem、tool-skill。因此本实现直接复制标准目录 bundle，不生成或应用全局配置 patch。自定义宿主禁用 includeDefaultRoots 时应由宿主所有者处理，不自动改全局设置。

这证明受支持的发现入口；本轮不会启动桌面业务会话验证自动选择。隔离 headless 子任务不安装主控 Skill；CLI 同时禁用 subagent、使用短 brief，避免再次派工。

零模型回归：`node --test scripts/offline-install.test.mjs`。覆盖完整构建、三宿主安装、真实安装版 doctor、篡改/冲突拒绝、幂等、升级回滚与原内容恢复；测试只用临时 fixture。
