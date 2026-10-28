"""任务 brief 契约：校验范围、目标仓与验收标准。"""

from __future__ import annotations

from .registry import VALID_KINDS


class ContractError(ValueError):
    pass


def validate(task: dict) -> dict:
    if not isinstance(task, dict):
        raise ContractError("任务必须是对象")
    task_key = task.get("taskKey")
    if not isinstance(task_key, str) or not task_key.strip():
        raise ContractError("taskKey 必填且非空")
    kind = task.get("kind")
    if kind not in VALID_KINDS:
        raise ContractError(f"kind 非法：{kind!r}")
    risk = task.get("risk", "normal")
    if risk not in {"high", "normal", "low"}:
        raise ContractError(f"risk 非法：{risk!r}")
    objective = task.get("objective")
    if not isinstance(objective, str) or not objective.strip():
        raise ContractError("objective 必填且非空")
    acceptance = task.get("acceptance", [])
    if not isinstance(acceptance, list) or any(not isinstance(x, str) for x in acceptance):
        raise ContractError("acceptance 必须是字符串列表")
    if kind == "implementation":
        if not task.get("repo"):
            raise ContractError("实施类任务必须给 repo")
        if not acceptance:
            raise ContractError("实施类任务必须给可检查的验收标准")
    budget = task.get("budget", {})
    if not isinstance(budget, dict):
        raise ContractError("budget 必须是对象")
    max_exec = budget.get("maxExecutors")
    if max_exec is not None and (not isinstance(max_exec, int) or max_exec <= 0):
        raise ContractError("maxExecutors 必须是正整数")
    for budget_key in ("maxWallSeconds", "maxModelRequests", "maxTokens", "maxAttempts"):
        value = budget.get(budget_key)
        if value is not None and (isinstance(value, bool) or not isinstance(value, int) or value <= 0):
            raise ContractError(budget_key + " 必须是正整数")
    if budget.get("maxAttempts", 1) != 1:
        raise ContractError("maxAttempts 仅支持 1（不自动 retry/resume，不伪支持跨 attempt 预算）")
    if budget.get("retries", 0) != 0:
        raise ContractError("不支持自动 retries；只允许有界显式 attempt")
    if "mode" in task and task["mode"] not in {"model", "no-model"}:
        raise ContractError("mode 必须为 model/no-model")
    if "modelTask" in task and not isinstance(task["modelTask"], bool):
        raise ContractError("modelTask 必须为 boolean")
    if "model" in task and (not isinstance(task["model"], str) or not task["model"]):
        raise ContractError("model 必须为非空模型名")
    for key in ("budgetSpec", "context"):
        if key in task and not isinstance(task[key], dict):
            raise ContractError(key + " 必须为对象")
    if "budgetHistory" in task and (not isinstance(task["budgetHistory"], str) or not task["budgetHistory"]):
        raise ContractError("budgetHistory 必须为显式仓外文件路径")
    version = task.get("schemaVersion", 1)
    if version not in (1, 2):
        raise ContractError("不支持的任务契约版本")
    for key in ("runtime", "verification"):
        if key in task and not isinstance(task[key], dict):
            raise ContractError(key + " 必须是对象")
    runtime = task.get("runtime", {})
    permitted_runtime = {"profileId", "engineExecutable", "engineVersion", "model", "reasoning", "contextMode", "domain"}
    if set(runtime) - permitted_runtime or any(not isinstance(v, str) or not v or len(v) > 1024 for v in runtime.values()):
        raise ContractError("runtime 只能包含明确的非敏感运行配置字段")
    verification = task.get("verification")
    if verification is not None:
        if not isinstance(verification.get("manifest"), str) or not verification["manifest"]:
            raise ContractError("verification.manifest 必填")
        argv = verification.get("validatorArgv")
        if not isinstance(argv, list) or not argv or any(not isinstance(x, str) or not x for x in argv):
            raise ContractError("verification.validatorArgv 必须是 argv 数组")
    result = {
        "taskKey": task_key.strip(),
        "kind": kind,
        "risk": risk,
        "repo": task.get("repo"),
        "objective": objective.strip(),
        "acceptance": list(acceptance),
        "budget": {"maxExecutors": max_exec, **{k: budget[k] for k in ("maxWallSeconds", "maxModelRequests", "maxTokens", "maxAttempts", "retries") if k in budget}},
    }
    for key in ("schemaVersion", "attemptId", "runtime", "verification", "mode", "modelTask", "model", "budgetSpec", "context", "budgetHistory"):
        if key in task:
            result[key] = task[key]
    return result
