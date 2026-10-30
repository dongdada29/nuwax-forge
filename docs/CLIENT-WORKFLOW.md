# Client workflow

安装五个同版 devkit tarball 后使用 `nuwax-devkit client-workflow`。Node >=22、Python >=3.10、兼容具名 permissions 的 Codex CLI 需由调用方准备。runtime 位于 CLI 的 `lib/client_workflow/`，不依赖源码仓的 scripts 或用户名。所有执行使用 argv 数组。

```sh
nuwax-devkit client-workflow --spec /absolute/evidence/spec.json --state /absolute/evidence/fresh-run
nuwax-devkit client-workflow seal --spec /absolute/evidence/spec.json --state /absolute/evidence/fresh-run
```

最小可移植 spec（替换全部占位绝对路径和宿主标识；budget 字段必须全部显式给出）：

```json
{
  "project": "/absolute/client-checkout",
  "node": "/absolute/runtime/node",
  "python": "/absolute/runtime/python3",
  "codex": "/absolute/runtime/codex",
  "codexHome": "/absolute/codex-state",
  "sessions": "/absolute/codex-state/sessions",
  "hostSession": "/absolute/telemetry/host.jsonl",
  "hostThread": "HOST-SESSION-ID",
  "hostTurn": "THIS-TURN-ID",
  "marker": "UNIQUE-USER-REQUEST-MARKER",
  "budget": {
    "hostNextInputTokens": 500000,
    "hostFinalReplyTokens": 100000,
    "totalTokens": 2000000,
    "dispatchStopTokens": 1600000,
    "hostReserveTokens": 400000,
    "executorCapTokens": 200000,
    "baselineCapTokens": 200000,
    "launchReserveTokens": 110000,
    "wallSeconds": 360,
    "processWallSeconds": 150,
    "startupGraceSeconds": 45,
    "hostToolRoundtrips": 8
  }
}
```

默认 direct，无模型请求、无自动 resume、无隐式 `~/.codex`、不修改全局配置。需已有固定 client source-tooling 配方、绑定、runner 及干净 Git checkout。输入及 state 逐级 realpath 后校验；state 必须是 project/devkit 外全新目录，禁止覆盖输入、已有证据。失败目录保留供检查；重跑另选 state，maxAttempts=1。

显式对照模式增加 `"mode":"compare"`、`"executorModel":"gpt-6.1-sol"`、`"baselineModel":"gpt-6.1-sol"`、`"reasoning":"medium"`。外层 fresh exec 短上下文执行器仅执行一个固定 pair 命令；pair 监督唯一基准模型和 direct。prompt 不接受用户命令或正文扩展。不继承父 history。模型必须实际执行唯一固定命令，否则失败；不重试。同轮结果以本次 state/pair.json 为准；失败或 blocked 不提供降幅。

每个待测 client 命令均使用相同的局部 `-c permissions.client-workflow.extends=":workspace"`、显式 state workspace root、`network.enabled=true` 和 `codex sandbox -P client-workflow`。`-p` 不是该权限选择器。网络授权范围较广，并非仅回环。macOS 不支持 seatbelt 内再次 sandbox_apply，故编排器和 Codex 协调器在外层运行；被测 client 命令保持文件沙箱。不得在已经受限的 seatbelt 内启动此流程。测试调用方应确认显式 CODEX_HOME 的配置可信。

验收固定为 source-tooling：22 tests 全通过、独立 validator、manifest/artifact SHA、SQLite phase=done、owner=null、4 条相同 manifest hash 证据。compare 另核对 inputDigest 一致。doctor.ready=false 可以通过此层验收，结果保留 doctor 状态。未执行产品构建、重复构建、GUI、安装包、发布或真实设备验收。

预算使用 host 自 marker 前快照起的增量，加全部 owned 子 session。input+output 为总量；cache/reasoning 是子集，不重复相加。0 有效；缺测、坏数字、重复 session、计量回退、身份错配均失败关闭。supervisor 使用相同严格 reader 处理 fixture 和实际进程，实时检查 owned session、总量、墙钟并终止自己拥有的进程组；启动有有界 telemetry grace。启动前和各 phase 预留 launch、下一次宿主完整输入与最终回复。compare 的 executor/baseline 未开始或缺测时保留声明 cap；已观察用量从同一 cap 扣减，只有 final_answer 后有 token_count 且 task_complete 才释放尾部。显式 ownedActors 数组通过 name/session/thread/capTokens 纳入外部执行器，按 session id 和 realpath 去重，不扫描默认目录。宿主无法被此工具硬中断，在途及未刷盘用量、provider 内部重试和账单未知。hostToolRoundtrips 在下一次可控派发边界拦截；无法硬中断当前原生宿主 API 请求，不是 provider 配额。每个 paid exec 前运行同一 Codex executable、具名沙箱与 Node 的零模型自退探针，真实证明 TERM 清理能力。仍存活才升级 KILL；EPERM 保留 blocked/cleanupFailed 报告且禁止后续模型。validator 是有界子进程，预算在其前后检查；不是逐 token 抢占。

`TOTAL-SNAPSHOT.json` 始终 `final=false`。用户请求起点由 host marker 时间确定；必须有 marker 前基线和 marker 后 usage。手动 seal 绑定明确 hostTurn 的 task_complete，截断该事件之后的 host 与 child 记录；不读取下一 user turn 用量。最终 reply 的后续 usage 缺失时输出 unknown；completion 缺失输出 pending，均不写 TOTAL-FINAL。成功后手动重入幂等，保留原封账；不覆盖已有 evidence。最终总 wall 为用户请求至指定 completion 的时间。未提供自动后台 seal，避免隐式后台任务。

外部 actor 示例：`"ownedActors":[{"name":"implementation","session":"/absolute/exact-session.jsonl","thread":"EXACT-ID","capTokens":450000}]`。未刷盘不是零成本；TOTAL-SNAPSHOT 的 committedTokens 包括实际用量、在途 actor 剩余 cap 和宿主输入/回复预留。seal 无 final_answer、后置 usage 或精确 completion 时 pending/unknown；不采纳下一 user turn。
