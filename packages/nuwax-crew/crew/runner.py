"""派工执行：把计划里的 shell 命令真实跑起来，采集输出并落台账。只执行带命令的 shell 通道派工。"""

from __future__ import annotations

import shlex
import json
import os
import signal
import re
import subprocess
import time
import uuid
import platform
import hashlib
import math
from datetime import datetime, timezone
from pathlib import Path

from . import ledger
from .execution_budget import ExecutionBudget, command_metadata, model_assignment


class RunError(ValueError):
    pass


def _resolve(command, worktree: str, brief: str, artifacts: str = "", *, step_artifacts: str = "", brief_file: str = "", context_manifest: str = ""):
    replacements = {"{worktree}": worktree, "{brief}": brief, "{artifacts}": artifacts,
                    "{stepArtifacts}": step_artifacts, "{briefFile}": brief_file, "{contextManifest}": context_manifest}
    def replace(value, shell=False):
        # 单次替换，不让 brief 内自带的占位符再次展开；argv/shell 的原有语义保留。
        return re.sub(r"\{(?:worktree|brief|artifacts|stepArtifacts|briefFile|contextManifest)\}",
                      lambda m: shlex.quote(replacements[m[0]]) if shell else replacements[m[0]], value)
    if isinstance(command, list):
        return [replace(a) for a in command]
    # brief/worktree 一律 shell 引号包裹：正文可含空格/括号/换行
    return replace(command, shell=True)


def _safe(value):
    return re.sub(r"[^A-Za-z0-9_-]", "_", str(value))[:120] or "run"


def _stop(proc):
    try:
        if os.name == "posix":
            os.killpg(proc.pid, signal.SIGTERM)
        elif proc.poll() is None:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        if os.name == "posix":
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            proc.kill()
        proc.wait()
    if os.name == "posix":
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def _cancel_signal(_signum, _frame):
    raise KeyboardInterrupt


def run_plan(plan: dict, *, worktree: str, brief: str, ledger_path, artifacts_dir,
             timeout: int = 900, only_roles: set | None = None, input_files: list | None = None) -> dict:
    if not isinstance(plan, dict) or "taskKey" not in plan or "assignments" not in plan:
        raise RunError("派工计划缺少 taskKey/assignments")
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
        raise RunError("timeout 必须为有限正数")
    results = []
    attempt_id = plan.get("attemptId") or str(uuid.uuid4())
    root = Path(artifacts_dir).resolve() / _safe(attempt_id)
    root.mkdir(parents=True, exist_ok=False)
    started_at = datetime.now(timezone.utc).isoformat()
    wall_start = time.monotonic()
    budget = ExecutionBudget(plan, worktree=worktree, root=root, ledger_path=ledger_path, input_files=input_files)
    plan_budget = plan.get("budget", {})
    default_timeout = 900 if budget.managed else timeout
    budget_timeout = plan_budget.get("maxWallSeconds", default_timeout) if isinstance(plan_budget, dict) else default_timeout
    if not isinstance(budget_timeout, (int, float)) or isinstance(budget_timeout, bool) or budget_timeout <= 0:
        budget_timeout = timeout
    timeout = min(timeout, budget_timeout, 3600) if budget.managed else min(timeout, budget_timeout)
    for index, a in enumerate(plan.get("assignments", [])):
        if only_roles and a.get("role") not in only_roles:
            continue
        command = a.get("command")
        executor = a.get("executor", "?")
        role = a.get("role", "unknown")
        managed = model_assignment(plan, a)
        if not command:
            results.append({"executor": executor, "role": role, "status": "skipped",
                            "managed": managed,
                            "reason": "无 shell 命令（固定路由或 ACP 通道），需人工/其它通道执行"})
            continue
        step_root = root / f"step-{index + 1}"
        step_root.mkdir(mode=0o700)
        manifest_file, brief_file = step_root / "context-manifest.json", root / "brief.txt"
        cmd = _resolve(command, worktree, brief, str(root), step_artifacts=str(step_root),
                       brief_file=str(brief_file), context_manifest=str(manifest_file))
        metadata = command_metadata(cmd)
        decision = None
        if managed:
            decision = budget.prepare(a, brief=brief, command=cmd, step_root=step_root)
            (step_root / "budget-guard.json").write_text(json.dumps(decision, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            if not decision.get("allowed"):
                ledger.record(ledger_path, task_key=plan["taskKey"], executor=executor, role=role, status="blocked",
                              attempt_id=attempt_id, phase="budget-guard",
                              details={"reason": decision.get("reason"), "guardFile": str(step_root / "budget-guard.json"), "command": metadata})
                results.append({"executor": executor, "role": role, "status": "blocked", "managed": True,
                                "processPassed": False, "reason": decision.get("reason"), "budget": decision,
                                "command": metadata})
                break
            if not budget.started:
                ledger.record(ledger_path, task_key=plan["taskKey"], executor=executor, role=role,
                              status="attempt-started", attempt_id=attempt_id, phase="budget-guard")
                budget.started = True
            manifest_file.write_text(json.dumps(decision["context"], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            if not brief_file.exists():
                brief_file.write_text(brief, encoding="utf-8")
                brief_file.chmod(0o600)
            (step_root / "command.json").write_text(json.dumps(cmd, ensure_ascii=False) + "\n", encoding="utf-8")
            (step_root / "command.json").chmod(0o600)
        ledger.record(ledger_path, task_key=plan["taskKey"], executor=executor, role=role, status="dispatched",
                      attempt_id=attempt_id, phase="execution", details={"managed": managed, "command": metadata})
        log = root / f"{index + 1}-{_safe(executor)}-{_safe(role)}.log"
        started = time.monotonic()
        failure = None
        exit_code = None
        try:
            env = dict(os.environ)
            env.pop("ELECTRON_RUN_AS_NODE", None)
            if managed:
                env.update(NUWAX_CREW_BRIEF_FILE=str(brief_file), NUWAX_CREW_CONTEXT_MANIFEST=str(manifest_file),
                           NUWAX_CREW_STEP_ARTIFACTS=str(step_root))
            remaining = timeout - (time.monotonic() - wall_start)
            if remaining <= 0:
                raise subprocess.TimeoutExpired(cmd, timeout)
            with log.open("w", encoding="utf-8") as output:
                output.write("$ command " + json.dumps(metadata, ensure_ascii=False) + "\n")
                output.flush()
                previous_term = None
                try:
                    try:
                        previous_term = signal.signal(signal.SIGTERM, _cancel_signal)
                    except ValueError:
                        pass  # 非主线程调用 run_plan 时，不改变全局 signal handler。
                    proc = subprocess.Popen(cmd, shell=not isinstance(cmd, list), cwd=worktree, env=env,
                                            stdout=output, stderr=subprocess.STDOUT, start_new_session=os.name == "posix")
                    try:
                        exit_code = proc.wait(timeout=remaining)
                    finally:
                        _stop(proc)
                finally:
                    if previous_term is not None:
                        signal.signal(signal.SIGTERM, previous_term)
            ok = exit_code == 0
            status = "completed" if ok else "failed"
            failure = None if ok else "process-failed"
            with log.open("rb") as output:
                output.seek(max(0, log.stat().st_size - 1600))
                summary = output.read().decode("utf-8", "replace")[-400:]
        except subprocess.TimeoutExpired as err:
            ok = False
            status = "failed"
            failure = "timeout"
            with log.open("a", encoding="utf-8") as output:
                output.write(f"\n[timeout after {timeout}s]\n")
            summary = f"timeout after {timeout}s"
        except KeyboardInterrupt:
            ok, status, failure = False, "failed", "cancelled"
            summary = "cancelled by user; child process group stopped"
        except OSError as error:
            ok, status, failure = False, "failed", "environment"
            summary = str(error)
            log.write_text(summary, encoding="utf-8")
        elapsed = round(time.monotonic() - started, 3)
        settlement = budget.settle(a, decision=decision, step_root=step_root) if managed else None
        if settlement is not None:
            (step_root / "budget-reconcile.json").write_text(json.dumps(settlement, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            # 退出 0 仅表示命令成功；预算实耗未知/超支另列且影响 acceptance。
        if managed and brief:
            summary = summary.replace(brief, "[brief sha256:" + hashlib.sha256(brief.encode()).hexdigest()[:12] + "]")
        summary = summary[-400:]
        ledger.record(ledger_path, task_key=plan["taskKey"], executor=executor, role=role, status=status,
                      attempt_id=attempt_id, phase="execution", elapsed_seconds=elapsed,
                      details={"managed": managed, "chargedTokens": settlement.get("chargedTokens") if settlement else None,
                               "remainingTokens": budget.remaining if managed else None})
        results.append({"executor": executor, "role": role, "status": status,
                        "managed": managed, "command": metadata, "budget": decision, "settlement": settlement,
                        "log": str(log), "elapsedSeconds": elapsed,
                        "exitCode": exit_code, "failure": failure, "processPassed": ok, "summary": summary})
        if not ok:
            break
    ran = [r for r in results if r["status"] != "skipped"]
    process_passed = bool(ran) and len(ran) == len(results) and all(r["processPassed"] for r in ran)
    budget_passed = not budget.managed or (not budget.error and not budget.unknown and not budget.exceeded and budget.remaining is not None and budget.remaining >= 0
                                           and all(r["status"] != "blocked" for r in results))
    verification = {"status": "not-run", "passed": False}
    spec = plan.get("verification")
    if spec and process_passed:
        manifest = Path(_resolve([spec["manifest"]], worktree, brief, str(root))[0]).resolve()
        if not manifest.is_relative_to(root) or not manifest.is_file():
            verification = {"status": "failed", "passed": False, "failure": "missing-or-outside-manifest"}
        else:
            argv = _resolve(spec["validatorArgv"], worktree, brief, str(root))
            try:
                check = subprocess.run(argv, cwd=worktree, capture_output=True, text=True,
                                       timeout=min(60, max(0.001, timeout - (time.monotonic() - wall_start))))
                checked = json.loads(check.stdout)
                passed = check.returncode == 0 and checked.get("passed") is True
                verification = {"status": "passed" if passed else "failed", "passed": passed,
                                "manifest": str(manifest), "details": checked}
            except (OSError, ValueError, subprocess.TimeoutExpired) as error:
                verification = {"status": "failed", "passed": False, "failure": str(error)}
    out = {"schemaVersion": 2, "taskKey": plan["taskKey"], "attemptId": attempt_id,
           "worktree": worktree, "artifacts": str(root), "results": results,
           "startedAt": started_at, "elapsedSeconds": round(time.monotonic() - wall_start, 3),
           "runtime": {"hostname": platform.node(), "platform": platform.system(), "python": platform.python_version(),
                       "profile": plan.get("runtime", {}), "electronRunAsNodeRemoved": "ELECTRON_RUN_AS_NODE" in os.environ},
           "processPassed": process_passed, "verification": verification, "budget": budget.report(), "budgetPassed": budget_passed,
           "acceptancePassed": process_passed and budget_passed and verification["passed"]}
    (root / "execution.json").write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return out
