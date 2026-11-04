# 有限任务

以下 CLI 均表示 `node <本Skill>/scripts/forge.mjs`。仅按所选 runtime 准备 task.json，不加载全部宿主参考。

```sh
CLI agent doctor --runtime codex --json
CLI agent prepare --spec /absolute/task.json --brief-file /absolute/brief.txt --state /absolute/fresh-state
# 查看 state 中的 doctor、command、context-manifest、budget-guard；prepared 才运行
CLI agent run --state /absolute/fresh-state
CLI agent reconcile --state /absolute/fresh-state
```

state 必须在目标 Git 根和安装版目录之外，且是不存在的新目录。模型、权限与预算显式指定。brief 只写目标、允许写入目录、必要输入、验收和停止条件；不包含本 Skill 的派工指令。

```json
{
  "schemaVersion": 1,
  "taskKey": "bounded-001",
  "worktree": "/absolute/isolated-git-root",
  "runtime": {"kind":"codex","contextMode":"fresh-exec","model":"explicit-available-model"},
  "permissions": {"mode":"read-only"},
  "budget": {"maxTokens":20000,"maxWallSeconds":120,"maxAttempts":1},
  "budgetSpec": {"schemaVersion":1,"id":"bounded-001","mode":"model","taskKind":"text-implementation","model":{"name":"explicit-available-model"},"expectedCalls":1,"initialContextTokens":1000,"perCallOutputTokens":1000,"budgetTokens":20000},
  "context": {"maxBytes":65536,"maxTokens":16000,"maxFiles":4,"contextFiles":[]}
}
```

DSH 改 runtime 为 `{"kind":"deepseek-harness","contextMode":"fresh-exec","provider":"deepseek-official","model":"deepseek-flash"}`。认证仅由执行环境和客户端处理；Skill/安装器不读取或复制真实凭据。未获授权时只 doctor/prepare，不 run。run 一次性、无自动重试；reconcile 离线复核本次 JSONL，不能拿 exit 0 代替预算及产品验收。

要查看这次 state 与 Crew/Stack 的任务、角色和模型分布，按需读 [dashboard.md](dashboard.md)。Agent state 只覆盖显式提供的运行，宿主 Router 的快照需另行提供，且不同来源不可直接加总。

向 Worker 派工时，必须把 Git 管理的交付物的 PR 要求写入其短 brief，不能假设 Worker 会加载本 Skill。每个 Worker 对 Git 管理的交付物（包括代码、配置、文档）都遵循 PR 流程：在已批准的目标仓和分支范围内使用独立工作分支，完成验证后推送工作分支并创建指向目标分支的 PR，优先使用 GitHub PR；仓库不在 GitHub 时使用其现有评审流程；将 PR 链接、分支、提交和验证结果记录在任务交付中。不得直接向目标分支推送；没有权限、凭据或远端时保留本地成果并报告阻塞。创建 PR 不等于合并、发布或验收通过；合并须有用户授权并遵守目标仓的审核与检查规则。
