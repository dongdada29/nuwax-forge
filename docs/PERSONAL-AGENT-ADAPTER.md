# Personal Agent 只读快照适配

Forge 复用 PA 的任务、执行记录和人工交付事实；不建立第二套任务库、审批或控制协议。本切片只读取显式本地文件，不扫描端口、会话或数据库，不请求 HTTP，不导入 PA SQLite，不读写其凭据或运行实例，也不调用模型。暂停、接管、继续、重试、取消、权限批准、接收和退回继续在原 PA 工作台完成。

## 输入与运行

`--personal-agent-snapshot <JSON>` 同时支持静态 HTML 与既有 Dashboard `--serve`。未传该参数时不会接入 PA。

```sh
nuwax-forge dashboard \
  --ledger /absolute/path/ledger.jsonl \
  --registry /absolute/path/registry.json \
  --personal-agent-snapshot /absolute/path/pa-export.json \
  --out /absolute/path/dashboard.html
```

空 Crew 数据也可运行：ledger 是空 JSONL 文件，registry 是 `{"executors":[]}`。现有 `--serve` 仅重新读取所给本地快照；它不会访问 PA API。参数由 Node CLI 透传到 Python Dashboard。

输入外层是 Forge 导出信封；每个 `snapshots` 元素保持 PA 原生 `TaskSnapshot` 形状：

```json
{
  "kind": "personal-agent-snapshot",
  "schemaVersion": 1,
  "instances": [{
    "instanceId": "my-pa-instance",
    "exportedAt": "2026-11-04T03:00:00Z",
    "snapshots": [{
      "task": {
        "id": "full-native-task-id",
        "goal": "原生任务目标",
        "status": "queued",
        "deliveryStatus": "pending",
        "updatedAt": "2026-11-04T02:00:00Z"
      },
      "events": [], "artifacts": [], "cursor": 0,
      "runs": [], "verifications": [], "approvals": []
    }]
  }]
}
```

PA 的完整原生类型见其 `packages/contracts/src/index.ts`（本次对照 PA `1f13eac`）；任务详情是既有 `GET /api/tasks/:id` 返回的 `TaskSnapshot`，列表 `GET /api/tasks` 仅有 `Task[]`，不能代替详情快照。由操作者通过已有授权渠道导出详情，显式设置稳定的 `instanceId`，再包装到上述信封。Forge 不负责请求、登录或配对，不复制访问令牌。配对属于 PA 工作台访问认证，与测试设备连接无关。

多个实例可以放进同一信封。实例 ID 由操作者指定；同一实例应始终复用同一 ID，不要把不同实例声明成相同 ID。示例完整 fixture 位于 `packages/dashboard/tests/fixtures/personal-agent-snapshot.json`，其中数据纯属构造，不连接实际 PA。

## 投影规则

- 来源为 `personal-agent:<instanceId>`，`taskKey` 是完整原生 `task.id`。跨实例/来源不按标题或名称合并，不接纳输入自带的 Forge `taskRef`。
- 原生 `Task.status` 保持不变，详情独立显示 `deliveryStatus=pending/accepted/returned`。`completed` 表示来源执行完成，仍归待验收展示；`accepted` 仅是 PA 的人工接收事实，不证明 GUI、真机、发布或产品验收。
- 每条原生 `AgentRunRecord` 是执行观察，保留 `runId` 与明确的 `attemptId`；同一 attempt 的多个角色 run 仍按现有工作台计算一次可识别尝试。缺失 attempt ID 为未知，不从 `activeAttemptId` 或事件推断；无 runs 的任务不会造执行记录。
- 原生契约未提供实测 token、调用数、实际模型、会话或路由父子关系，这些保持 unknown；不把配置中的模型当作执行证据，不从文本解析 PR，不将 `baselineSha` 当作交付提交。原生 `engine` 与 `role` 只按明确字段显示。
- 原生事件保留 `seq`、类型、时间与明确 attempt ID；时间线按既有事件时间倒序，同一时间的原生事件按 seq 倒序。事件只提取有限的 reason/message/summary/requirements 文本。
- `VerificationResult` 的命令、退出码、超时/取消与有限 stdout/stderr，以及 artifact 的名称/类型和有限内容进入既有事件时间线；命令仅显示，不执行，不读取工作区文件或打开交付路径。`branchName` 只作为明确分支引用。文本经既有 HTML 转义，内容最长有限截断。
- PA approval 仅作为时间线事实，未导入 Forge 审批表，不出现 PA 操作按钮。原生 payload 中的配置快照、ACP toolCall、凭据等不会被投影到 HTML。

`delivery:*` 是 task 当前交付状态的观察，时间取 `task.updatedAt`，不声称这是原始接收/退回事件时间。原生事件按自身 createdAt 展示。cursor/分页导出可能省略历史，快照展示不承诺事件完整性。

## 边界和验证

只接受至多 4 MiB 普通 JSON 文件；拒绝错误版本、异常数组、重复实例/任务/run/seq、跨任务关系和无效任务状态。读取有二次字节上限，不写输入；输出路径与输入相同或硬链接/符号链接别名时由既有输出保护拒绝。最多每数组 10000 条，展示文本有长度限制。

每个实例以 `exportedAt` 计算快照新鲜度，超过 15 分钟提示较旧；同时展示文件更新时间。重新复制旧文件不会把旧导出时间变新。快照新鲜仅说明导出时间，不证明任务进程仍存活，也不证明模型调用、业务验收或 PA 当前实时状态。

专项测试覆盖多实例隔离、长 ID、completed/accepted/returned、未知用量与关系、无尝试任务、事件顺序、证据转义、错误/过大/FIFO 输入、无网络/DB/输入写入和 CLI 输出防覆盖。实时 PA HTTP 接入、运行实例联调与原生控制未实现、未验收；本 PR 的可验证范围是本地导出快照到标准展示的只读切片。
