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
