# 离线安装与回退

本入口分发六个现有工作区包与 nuwax-forge 薄 Skill，不增加编排引擎或 MCP。

原生 Bot → Forge 桥从 `integrations/ds-bot-forge` 的固定文件清单装入 CLI 的 `lib/bots/bridge-runtime`；离线 bundle 与 `npm run pack` 使用同一来源，不另装第七个包，也不改写源码目录。
依赖 Node>=22、Python>=3.10。离线包专用 runtime 白名单只复制 CLI JS/Python、contracts schema/GUI 模块、crew Python、Stack 0.4.7 私有资源与现有验证桥接及 kit 引擎/模板（排除测试、历史设计档案与缓存；不改变普通 npm pack 的 package.json.files），不运行 npm install、不联网、不需要 registry 或 tar；分发包没有 node_modules，安装时才构建标准包解析布局。

```sh
node scripts/build-bundle.mjs --out /absolute/new-offline-bundle
# 将整个目录离线传给目标机器；下列命令均从分发包运行
node /absolute/new-offline-bundle/install.mjs install --host codex --root /absolute/managed/codex --host-root /absolute/codex-home
node /absolute/new-offline-bundle/install.mjs install --host deepseek-harness --root /absolute/managed/dsh --host-root /absolute/project/.dsh
node /absolute/new-offline-bundle/install.mjs install --host nuwax --root /absolute/managed/nuwax --workspace /absolute/workspace
node /absolute/new-offline-bundle/install.mjs rollback --root /absolute/managed/codex
node /absolute/new-offline-bundle/install.mjs uninstall --root /absolute/managed/codex
```

必须明确 host。root 默认 `~/.local/share/nuwax-forge/<host>`，Codex host-root 默认标准用户 Skill 根 `~/.agents`，DSH 必须提供已核对的 `--host-root` 或 `$DSH_HOME`（不猜默认 home）。Nuwax 必须显式 workspace，且已有 work-computer.json。路径要是绝对的 canonical realpath；拒绝任何 symlink 分量（macOS `/tmp` 请先解析为 `/private/tmp`）、根、home 祖先、相互交叠和路径穿越。不会修改 shell/PATH、平台、Hook、宿主 config 或已有会话。

manifest.json 包含版本及所有文件 SHA256；内容地址版本目录 `versions/<version>-<manifest hash>` 保存原子切换前的版本。hash 是离线完整性检查，不是发布者签名；请通过可信渠道获取分发包。安装先核对全清单，再运行安装版 CLI doctor（Node/Python/六包解析），通过后才注册。公共 Skill 的 `installation.json` 仅声明 `{ "schemaVersion": 2, "command": "nuwax-forge" }`，不含用户名、绝对路径或版本。随完整版本携带的 Skill 从自身位置解析相邻 CLI；注册到宿主的副本仅增加相对 `runtimeRoot`，从该受管根的 active/history 选择当前版本，升级不改该绑定；独立共享 Skill 使用 PATH 中的标准 `nuwax-forge` 命令。旧 schemaVersion=1 只读兼容，升级后不再生成。受管状态和工作台绝对路径属于本机私有登记，不是可共享配置；跨机器安装请重新登记，完整版本及保持相对布局的运行入口可迁移。清除诊断用包解析覆盖变量，保证自检基于安装版。

同包重装幂等；已有非受管 Skill/非空安装根拒绝。升级保留全部原版本及 byte-exact 原始 AGENTS/config。受管目标有人工修改时拒绝升级、回滚和卸载，避免覆盖。managed.json 保存原内容与版本历史；安装根应由当前用户私有保管，不要放凭据在安装包或任务 brief 中。事务文件在写入宿主前保存恢复快照；异常会尝试恢复，崩溃留下 install.lock 或 managed.json.transaction 时停止，核对快照并手动恢复后再清理，不盲目重试。

rollback 还原上一版本注册；uninstall 恢复最初 AGENTS/config、移除本 Skill 注册，保留受管根中的版本和备份供审计（不再有活动路由）。清理受管根可在卸载后由用户处理。不会删除其他 Skill、AGENTS 段落、配置、身份或任务游标。Nuwax 更新 runtimeGuard.devkitCli/devkitCrewRoot，并在原有 runtimeGuard.tools.devkitCli 对象存在时更新其 path、保留同对象其余字段；AGENTS/config 中已知旧 Stack Skill 路径替换为安装版内部模块路径，AGENTS 的明确旧入口及唤醒加载声明改为 Forge，保留平台13555和其它业务约束。devkitCrewRoot 始终指向安装版本，不新增平台技能；平台唯一入口为 nuwax-forge，Stack 为私有内部模块。CLI agent doctor/prepare 不验证真实认证或业务模型；run 须遵守当前任务已获得的授权范围。

## DSH 发现机制的当前依据

2026-10-30 只读核对本机 DeepSeek Harness 0.2.1-rc.5 的 app.asar：

- `dsh/node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js` 的 Config.includeDefaultRoots 默认 true；roots(cwd) 返回 Git 项目根 `.dsh/skills`（rank 100）、`.agents/skills`（200）、customSkillDirs（300）、dshHome/skills（400）和 agentsHome/skills（500）。discoverRoot 对目录加载 SKILL.md，并解析 frontmatter name/description。无 disable-model-invocation 时默认允许模型发现。
- `dsh/node_modules/@deepseek-ai/dsh-home-paths/lib/index.js` 的 resolveDshHome 按显式配置、DSH_HOME、`~/.dsh` 解析；agentsHome 按 DSH_AGENTS_HOME、`~/.agents` 解析。
- stock base cordis profile 注册 skill、skill-filesystem、tool-skill。因此本实现直接复制标准目录 bundle，不生成或应用全局配置 patch。自定义宿主禁用 includeDefaultRoots 时应由宿主所有者处理，不自动改全局设置。

这证明受支持的发现入口；本轮不会启动桌面业务会话验证自动选择。隔离 headless 子任务不安装主控 Skill；CLI 同时禁用 subagent、使用短 brief，避免再次派工。

零模型回归：`node --test scripts/offline-install.test.mjs`。覆盖完整构建、三宿主安装、真实安装版 doctor、篡改/冲突拒绝、幂等、升级回滚与原内容恢复；测试只用临时 fixture。

默认在 `~/.local/bin/nuwax-forge` 安装受管 launcher；可用 `--bin-dir <绝对目录>` 指定，不改 PATH，不覆盖非受管同名文件。三宿主共存时各受管根需使用独立 bin 目录，用户入口选择 Codex 的 `~/.local/bin`。

Nuwax launcher 使用工作台 `runtimeGuard.tools.python.path` 中已登记的绝对 Python 路径，自检也使用同一解释器。该绑定只作用于 Forge 进程，不修改系统 PATH；doctor、Stack、Crew、看板和验证流程统一继承 `NUWAX_DEVKIT_PYTHON`，命令显式提供的 `--python` 优先。未登记时继续使用宿主默认 Python，安装前须通过版本检查。

旧安装迁移：`node <bundle>/migrate.mjs --legacy-bundle <旧bundle> --legacy-root <旧root> --root <新root> --host <宿主> --host-root <宿主root> --backup <私有新目录> --bin-dir <绝对bin>`；Nuwax 使用 `--workspace`。先备份旧注册、managed 与 profile，再旧版卸载恢复并安装新版，失败自动恢复。`--disable-skill <旧独立Skill>` 只移动到私有备份，保留 symlink；恢复使用 `node <bundle>/migrate.mjs --restore <backup>`。旧版本保留，不改 TaskStore 或 shell 设置。
