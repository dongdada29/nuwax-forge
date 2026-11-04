# DSH startup task evidence

本次接线复用已安装 DSH 0.2.1-rc.5 / Cordis 4.0.5 的普通插件机制，不实现运行时、派发器、进程监督、任务库或预算算法。来源固定为上游 tag `dsh-v0.2.1-rc.5`，SHA `b830ec950faba0a46dda564be3e2d854afed94f1`：`apps/cli/src/profile-boot.ts` 的 createAppReady/commit、`packages/boot/cmdline/src/index.ts` 的 AppReady/provideCmdline，以及 `packages/boot/app-boot/src/index.ts` 的 auditStartupEntries/inactiveEntries。API 来源是固定上游引用；实际安装构建另以 `dsh --version`、包版本和本机工件哈希核对，未独立证明安装构建与该 commit 字节一致。当前真实验收为 macOS arm64、DSH 0.2.1-rc.5、Cordis 4.0.5。

观察插件为 `packages/cli/lib/dsh-task-observer.mjs`，`inject=['loader','appReady','profileContext']`。通过宿主 profileContext.installAnchor 解析并调用上游 getDshRuntimeVersion，实际版本不匹配时拒绝观察；不从 Forge 的 node_modules 猜测 DSH 版本。通过 ctx.effect 注册 onReady 的取消监听，在启动提交后读取 loader.entries() 快照。完整 ID 为 `include:target`，不能用 options.id 的 `target` 替代。内联状态值 2 ACTIVE、3 FAILED、0 PENDING；不运行时导入 TS const enum。不会调用 fiber.await、修改目标生命周期或记录原始错误/config。

在调用方私有 `$DSH_HOME/profiles/audit/package.json` 配置 `{"name":"dsh-profile-audit","private":true,"dependencies":{},"dsh":{"profile":{"bundles":[]}}}`，再以 `cordis.patch.yml` 组合两个普通插件。目标插件仍然只需原来的 DSH/Cordis 入口：

```json
[{"insert":[
  {"id":"target","name":"/absolute/target.mjs"},
  {"id":"observer","name":"/absolute/dsh-task-observer.mjs","config":{
    "schemaVersion":1,"taskRef":{"source":"forge:instance-name","taskKey":"task-1"},
    "attemptId":"attempt-1","runId":"run-1",
    "invocationId":"CALLER_GENERATED_32_OR_MORE_LOWERCASE_HEX_CHARACTERS",
    "targetEntryIds":["include:target"],"runtimeVersion":"0.2.1-rc.5",
    "reportPath":"/absolute/existing-private-directory/new-report.json"
  }}
]}]
```

调用方每次启动用 `randomBytes(16).toString('hex')` 生成新 invocationId，并独立保留 expected binding。source 必须包含实例命名空间（例如 forge:instance-name）。所有字段必填，目标非空且去重。报告路径必须绝对、规范、尚不存在；父目录由调用方预先创建并独占控制，不允许符号链接。采用有界 JSON、排他临时文件、fsync 和同目录硬链接原子发布，拒绝覆盖。父目录必须可信：路径检查不提供对恶意并发替换目录的防护。报告不是签名或身份认证，拥有目录写权限者仍能伪造；调用关联不是身份认证。随机值的新鲜性由调用方保证。

```js
import { evaluateTaskEvidence } from './packages/cli/lib/dsh-task-evidence.mjs';
// expectedBinding 来自启动方；outcome 是真实 spawnSync 返回值。
const result = evaluateTaskEvidence(expectedBinding, outcome);
```

结果带 schemaVersion、kind、scope=startup、observedAt 和 taskRef/attemptId/runId/invocationId，可供后续显式导入任务系统；本切片不直接写 TaskStore，也不修改公共 CLI 入口。processPassed 要求真实进程 status=0、signal=null、无 error，且未报告 cleanupFailed；pluginReady 要求所有指定目标均 active。passed 同时要求两者。缺失、disabled、pending、failed、重复条目和 unknown 均不能成功；未知状态保留 unknown。证据缺失、污染、过大、绑定不匹配均拒绝。init 抛错可能只有 warning 且 exit 0，不能以退出码或 appReady 代替目标 ready。acceptancePassed、usage、budget 始终 null，不从装载状态推算 token，不放宽权限。

运行离线测试：`node --test packages/cli/test/dsh-task-*.test.mjs`。显式选择可信本机 binary 才运行真实集成：`NUWAX_DSH_BINARY=/usr/local/bin/dsh node --test packages/cli/test/dsh-task-*.test.mjs`。集成使用临时 HOME/DSH_HOME/DSH_AGENTS_HOME/cwd、清空 bundles，仅加载本地 fixtures 和观察插件；测试复用既有 Forge supervise，子进程有 5 秒超时及自有后代清理；版本探针有 3 秒超时。测试不组合模型、网络、认证服务，不使用既有用户 profile。也可通过既有 `dsh-plugin run --profile audit --binary /usr/local/bin/dsh` 运行准备好的隔离 profile。

这只是本次 startup 快照，不是持续 liveness 或功能/产品验收。未验收五平台、SSH/jobs 或真实模型；较新上游 0.2.2-alpha.3（SHA `8bd073392eef6f54e921a093b95076248eb08cbb`）的能力不计入本次安装能力。

## 独立验收

2026-11-04 在真实安装 DSH 上分别通过原生 CLI 与既有 Forge dsh-plugin 桥接验收：正常插件为 active；初始化异常为 failed；缺依赖为 pending；不存在的目标为 missing；禁用目标为 disabled。共 10 个真实场景，失败对照均保留 processPassed=true、pluginReady=false、passed=false。离线用例另覆盖关联错配、旧 invocation、证据污染和大小限制、排他发布与符号链接拒绝、多目标、未知状态及清理失败。完整本机命令、运行哈希和预算账本由交付记录保存。

复用来源（固定引用）：

- [DSH profile 启动与就绪](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/apps/cli/src/profile-boot.ts)
- [AppReady / profile 宿主服务](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/boot/cmdline/src/index.ts)
- [DSH Loader 启动审计](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/boot/app-boot/src/index.ts)

现有工具取消、jobs、SSH 的加载和生命周期继续由 DSH 所属实现负责，本切片不替换、不新增这些机制；它们尚未接入本切片的任务操作或验收。
