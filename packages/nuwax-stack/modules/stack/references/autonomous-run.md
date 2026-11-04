# 自主执行循环

一次明确任务授权覆盖范围内的日常分析、局部修复、验证和个人台账更新。不要把每轮继续执行变成新的审批。产品取舍、范围外改动或必要权限确实缺失时才请求用户决定。

## 开始

先恢复现有任务状态，再确定目标仓、授权操作、来源条目与可检查的完成条件。完成条件针对用户行为，例如“同一慢请求内重复点击只产生一次发送”，不能只写“构建通过”。

团队原文档始终只读。只更新已登记的自有台账；源码改动限定在任务仓和必要文件内。盘点脏文件与并行工作，必要时创建独立工作区，不清理或覆盖他人的未提交修改。

## 每一轮

1. 检查完成条件和外部状态，有证据已完成则结束，勿重复执行。
2. 选择最小、有依据的一次推进，实施后运行对应行为验证。失败时区分产品问题、环境问题和验证器问题，不能削弱完成条件来获得通过。
3. 保留有效改动；撤销无效改动时只撤销本任务这一轮的改动，禁止 `reset --hard` 等全仓清理。提交取决于该任务授权和仓内规则，不能混入其他工作。
4. 保存仓路径、分支/HEAD、改动、验证命令及结果、完成条件、下一步和需要等待的事件，更新个人台账。
5. 条件未满足且可以继续，就自主进入下一轮。出现重复失败先换假设或修复环境；只有真正依赖外部决策时才转待决策。

使用 [scripts/task_state.py](../scripts/task_state.py) 管理可恢复的本地状态。脚本记录状态与验证证据，不会替 Agent 执行任意命令或提供后台唤醒。

### 本地 Ticket 与 Assignment 账本（受限第一阶段）

通过一次性 `nuwax-forge stack task-state --command <操作> --input <JSON 文件>` 记录 Trigger、显式准入的 Ticket 和 Assignment 尝试。输入 JSON 必须有仓外 `stateDirectory` 与 `repoRoot`；文件上限 64 KiB。操作为 `trigger-record`、`trigger-read`、`ticket-admit`、`ticket-read`、`assignment-prepare`、`assignment-start`、`assignment-report`、`assignment-finish`。例如：

```json
{"stateDirectory":"/外部状态目录","repoRoot":"/目标仓","source":"im","sourceId":"消息稳定ID","threadId":"会话或主题ID","classification":"candidate","identity":{"senderId":"可信来源记录ID"},"summary":"短摘要","resourceRefs":["本地资源指针"]}
```

Trigger 只存小型元数据与资源指针；`context-only` 永远不能创建 Ticket。`ticket-admit` 需要 `admission.kind=explicit`、非空 `actor`/`evidenceRef`，以及相对仓库的 `mandate.writePaths`、argv 数组 `mandate.argvCommands` 和可选 `maxModelCalls`。Assignment 使用独立 `attemptId`，状态依次为 prepared、running、reported，再进入 succeeded、failed、blocked 或 cancelled。每次操作提交 `owner` 和最新 `expectedRevision`，由当前有效 lease 校验并追加事件。

Admission 与 Mandate 目前只是本机声明记录，不能替代 Nuwax 身份校验，也不会在执行时强制权限。CLI 不启动 daemon、不调用模型、不执行这些 argv、不访问平台或发送通知；usage 缺失以 `null` 保存，表示未知而非 0。

## 唤醒与停止

等待模型、CI、构建或外部事件时优先使用平台已提供的完成事件；需要心跳时使用用户授权范围内的平台调度。必须记录实际返回的任务/订阅 ID 和下一次唤醒时间。没有真实唤醒机制时标为等待接入，不能宣称“后台持续运行”。不要仅靠提示词建立无限自调用，也不要另造轮询 daemon。

每次新会话按检查点恢复，不把整个群聊历史持续塞进一个长上下文。条件全部满足并持久记录后标已完成；源码已改但行为未验证时仍为验证中或待验收。失败、暂停或等待均不等于完成。

## 提交归属（强制）

凡由本 Agent（含其派工的执行器）产生的 Git 提交，必须可区分归属，采用业界通行做法双保险：

1. **按次提交的身份**（归属依据=发起方）：凡本 Agent（含分派执行器）发起的提交，用环境变量按次指定 author/committer：
   `GIT_AUTHOR_NAME="PA-MBP128" GIT_AUTHOR_EMAIL="noreply@pa-mbp128.local" GIT_COMMITTER_NAME="PA-MBP128" GIT_COMMITTER_EMAIL="noreply@pa-mbp128.local" git commit …`
   隔离 worktree（任务工作区）内可改用 worktree 本地身份，效果等同。**严禁在任何仓库执行 `git config user.name/user.email`，严禁 `--global/--system`**——仓库级配置无法区分同仓内人机提交（10-23 事故根因）；本人手动提交永远保持本人身份。中性署名（PA=Personal Agent），不泄露本人姓名与平台 Agent ID，也不随平台改名失效。
2. **双 trailer**（Git 官方 trailer 约定，GitHub 会渲染共同作者）：提交说明末尾固定
   `Co-Authored-By: PA-MBP128 <noreply@pa-mbp128.local>`（总署名）
   `Agent-Executor: <执行器> / <模型> (<角色>)`（实际执行者；多个执行器各一行）
   示例：`Agent-Executor: codex / gpt-6.1-sol (implement)`、`Agent-Executor: claude-code / deepseek-v4.1 (review)`；
   本 Agent 亲自实施写 `Agent-Executor: pa-mbp128-agent / deepseek-v4.1-flash (implement)`。

提交前用 [scripts/commit_attribution.py](../scripts/commit_attribution.py) 自检（可加 `--expect-executor` 校验具体执行器行）；缺任一行视为不合格，必须 amend 补齐。不回改历史提交，规则向前生效。

## 给用户的回报

报告完成条件是否满足、有效变更、验证证据及剩余问题。用户已授权关键决策私信时，向用户指定身份发送一个含选项与影响的简短决策请求，记录实际发送结果；不要把“准备发送”当已通知，也不在全员群广播个人决策。
