"""执行前/步间预算边界。预测与 scope/cache 归一全部委托同安装 Node CLI，Python 不复制公式。"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess


def model_assignment(plan, assignment):
    for holder in (plan, assignment):
        spec = holder.get("budgetSpec")
        if holder.get("mode") == "model" or holder.get("modelTask") is True or (isinstance(spec, dict) and spec.get("mode") == "model"):
            return True
        runtime = holder.get("runtime", {})
        runtime = runtime if isinstance(runtime, dict) else {}
        if holder.get("model") or runtime.get("contextMode") == "fresh-exec" or (runtime.get("model") and runtime.get("contextMode") != "no-model"):
            return True
    return False


def command_metadata(command):
    raw = json.dumps(command, ensure_ascii=False).encode("utf-8")
    return {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
            "kind": "argv" if isinstance(command, list) else "shell",
            "note": "原命令仅保存于仓外 command.json；此处不重复 prompt"}


def _node_bridge(request):
    package = Path(__file__).resolve().parents[1]
    node = os.environ.get("NUWAX_DEVKIT_NODE") or shutil.which("node")
    if not node:
        raise ValueError("模型任务需要本安装 Node>=22 预算 bridge；没有 node")
    # 源码五包目录，以及 npm 安装后的 @nuwax-ai 同级目录；无本机绝对路径。
    candidates = [package.parent / name / "lib/budget/bridge.mjs" for name in ("cli", "devkit-cli")]
    bridge = next((p for p in candidates if p.is_file()), None)
    if bridge is None:
        locate = subprocess.run([node, "-e", "const r=require('node:module').createRequire(process.argv[1]);process.stdout.write(r.resolve('@nuwax-ai/devkit-cli/package.json'))",
                                 str(package / "package.json")], capture_output=True, text=True, timeout=10)
        if locate.returncode != 0:
            raise ValueError("未找到同安装 @nuwax-ai/devkit-cli；单装 crew 的模型任务 fail closed")
        bridge = Path(locate.stdout).parent / "lib/budget/bridge.mjs"
    result = subprocess.run([node, str(bridge)], input=json.dumps(request, ensure_ascii=False),
                            capture_output=True, text=True, timeout=20)
    parsed = json.loads(result.stdout)
    if result.returncode != 0:
        raise ValueError(parsed.get("error", "budget bridge 失败"))
    return parsed


def _positive(value, label, maximum=None):
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or value <= 0 or (maximum and value > maximum):
        raise ValueError(label + " 必须为有限正数" + (" 且 ≤" + str(maximum) if maximum else ""))
    return value


class ExecutionBudget:
    def __init__(self, plan, *, worktree, root, ledger_path, input_files=None):
        self.plan, self.worktree, self.root = plan, Path(worktree).resolve(), root
        self.ledger_path = Path(ledger_path)
        self.managed = any(model_assignment(plan, a) for a in plan["assignments"])
        self.remaining = None
        self.reserved = 0
        self.known_spent = 0
        self.unknown = False
        self.exceeded = False
        self.error = None
        self.started = False
        self.history = plan.get("budgetHistory")
        self.input_files = [str(Path(p).resolve()) for p in (input_files or [])] + [str(self.ledger_path.resolve())]
        self.steps = []
        if not self.managed:
            return
        try:
            budget = plan.get("budget", {})
            if not isinstance(budget, dict):
                raise ValueError("budget 必须为对象")
            self.remaining = _positive(budget.get("maxTokens"), "budget.maxTokens")
            max_attempts = budget.get("maxAttempts", 1)
            if isinstance(max_attempts, bool) or not isinstance(max_attempts, int) or max_attempts != 1:
                raise ValueError("budget.maxAttempts 仅支持 1（不支持跨 attempt 预算/自动返修）")
            if budget.get("retries", 0) != 0:
                raise ValueError("自动 retries 不支持；只允许有界的显式新 attempt")
            for key in ("maxWallSeconds",):
                _positive(budget.get(key, 900), "budget." + key, 3600)
            if len(plan["assignments"]) > 32:
                raise ValueError("单次模型 plan 最多 32 个串行 assignment")
            if self.root.is_relative_to(self.worktree):
                raise ValueError("模型任务 artifacts 必须仓外")
            # 拒绝把模型输入/日志写回 devkit 安装目录或源码仓。
            package = Path(__file__).resolve().parents[1]
            source_root = next((p for p in package.parents if (p / ".git").exists()), package)
            if self.root.is_relative_to(source_root):
                raise ValueError("模型任务 artifacts 不得写入 devkit 源码/安装目录")
            if self.history:
                self.history = str(Path(self.history).resolve())
                if Path(self.history).is_relative_to(self.worktree) or Path(self.history).is_relative_to(source_root):
                    raise ValueError("budgetHistory 必须仓外")
                if Path(self.history).is_relative_to(self.root):
                    raise ValueError("budgetHistory 不得指向本次工件")
                for input_file in self.input_files:
                    if self.history == input_file or (Path(self.history).exists() and Path(input_file).exists() and Path(self.history).samefile(input_file)):
                        raise ValueError("budgetHistory 不得覆盖 plan/brief/ledger 输入文件")
            attempts = set()
            if self.ledger_path.exists():
                with self.ledger_path.open(encoding="utf-8") as stream:
                    for line in stream:
                        row = json.loads(line)
                        if row.get("taskKey") == plan["taskKey"] and row.get("status") == "attempt-started" and row.get("phase") == "budget-guard":
                            attempts.add(row.get("attemptId"))
            if len(attempts) >= max_attempts:
                raise ValueError("max-attempts-exhausted：不 resume 旧会话，请缩小任务并建立新 taskKey")
        except (ValueError, OSError) as error:
            self.error = str(error)

    def prepare(self, assignment, *, brief, command, step_root):
        if self.error:
            return {"managed": True, "allowed": False, "reason": "invalid-execution-budget", "error": self.error}
        if self.exceeded:
            return {"managed": True, "allowed": False, "reason": "actual-budget-exceeded"}
        try:
            config = assignment.get("context", self.plan.get("context", {}))
            spec = assignment.get("budgetSpec", self.plan.get("budgetSpec"))
            runtime = assignment.get("runtime", self.plan.get("runtime", {}))
            required_model = assignment.get("model", self.plan.get("model"))
            if isinstance(required_model, dict):
                required_model = required_model.get("name")
            if not required_model and isinstance(runtime, dict):
                required_model = runtime.get("model") if runtime.get("contextMode") != "no-model" else None
            decision = _node_bridge({"operation": "prepare", "spec": spec, "history": self.history,
                                     "remainingTokens": self.remaining, "brief": brief, "command": command,
                                     "context": config, "worktree": str(self.worktree), "requiredModel": required_model})
            if decision.get("allowed"):
                self.reserved = decision["reservedTokens"]
                self.remaining -= self.reserved
                self.steps.append({"reservedTokens": self.reserved, "remainingAfterReservation": self.remaining})
            return decision
        except (ValueError, OSError, subprocess.TimeoutExpired) as error:
            return {"managed": True, "allowed": False, "reason": "budget-bridge-error", "error": str(error)}

    def settle(self, assignment, *, decision, step_root):
        try:
            # 只接受本步新目录的实耗文件，不能复用先前步骤/历史用量降低共享扣款。
            usage_name = assignment.get("usageFile", "usage.json")
            usage_path = Path(usage_name.replace("{stepArtifacts}", str(step_root))).resolve()
            if not Path(usage_name).is_absolute() and "{stepArtifacts}" not in usage_name:
                usage_path = (step_root / usage_name).resolve()
            if not usage_path.is_relative_to(step_root) or not usage_path.is_file() or usage_path.stat().st_size > 1048576:
                actual = {"usage": {}}
            else:
                actual = json.loads(usage_path.read_text(encoding="utf-8"))
            result = _node_bridge({"operation": "settle", "estimate": decision["estimate"], "actual": actual,
                                   "history": self.history, "inputs": [["execution-input", p] for p in self.input_files]})
            charge = result["chargedTokens"]
            self.exceeded = result.get("reconciliation", {}).get("budget", {}).get("verdict") == "exceeds"
        except (ValueError, OSError, subprocess.TimeoutExpired, KeyError) as error:
            result, charge = {"chargedTokens": None, "error": str(error)}, None
        if charge is None:
            self.unknown = True
            self.remaining = None
        else:
            self.known_spent += charge
            self.remaining += self.reserved - charge
        self.reserved = 0
        result.update(remainingTokens=self.remaining, knownSpentTokens=self.known_spent)
        return result

    def report(self):
        runtime = self.plan.get("runtime", {})
        declared_no_model = self.plan.get("mode") == "no-model" or self.plan.get("modelTask") is False or (isinstance(runtime, dict) and runtime.get("contextMode") == "no-model")
        return {"managed": self.managed, "coverage": "declared-model-assignments" if self.managed else "declared-no-model" if declared_no_model else "legacy-unmanaged",
                "remainingTokens": self.remaining, "knownSpentTokens": self.known_spent,
                "actualUnknown": self.unknown, "actualExceeded": self.exceeded, "steps": self.steps, "configurationError": self.error,
                "note": "前置/步间 HIGH 预留+wall timeout；不流式硬中止 provider 内部 token，不自动重试/resume"}
