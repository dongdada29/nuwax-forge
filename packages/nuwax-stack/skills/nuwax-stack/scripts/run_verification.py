#!/usr/bin/env python3
"""有限的仓内验证桥接：kit recipe -> crew execution -> TaskStore proof."""
import argparse
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import time
import uuid

from task_state import TaskStore, validate_verification


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--crew-root", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--task-key", required=True)
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--reuse", action="store_true")
    args = parser.parse_args()
    begin = time.monotonic()
    repo = Path(args.repo).resolve(strict=True)
    crew_root = Path(args.crew_root).resolve(strict=True)
    sys.path.insert(0, str(crew_root))
    from crew import registry, router, runner
    config = json.loads((repo / ".sdlc.json").read_text())
    binding = config["verification"]
    recipe = json.loads((repo / binding["recipe"]).read_text())
    predicates = [stage["predicate"] for stage in recipe["stages"]]
    head = subprocess.check_output(["git", "--no-optional-locks", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    if not args.node:
        raise ValueError("未指定 node 运行器（--node 或 PATH）")
    node = str(Path(args.node).resolve(strict=True))
    scripts = Path(__file__).resolve().parent
    with_store = TaskStore(args.state, repo, node)
    owner = "verification-bridge-" + uuid.uuid4().hex
    claimed = False
    try:
        try:
            current = with_store.read(args.task_key)
        except ValueError:
            try:
                current = with_store.create(args.task_key, recipe["id"], predicates, head)
            except sqlite3.IntegrityError:
                current = with_store.read(args.task_key)
        if current["predicates"] != predicates:
            raise ValueError("配方完成条件变化，请使用新的任务键")
        with_store.claim(args.task_key, owner, seconds=3600)
        claimed = True
        if args.reuse and current["phase"] == "done" and current.get("evidence"):
            manifest = current["evidence"][0]["artifact"]
            try:
                validate_verification(manifest, repo, predicates, recipe["level"], node)
            except (ValueError, OSError, KeyError):
                pass
            else:
                print(json.dumps({"passed": True, "reused": True, "taskKey": args.task_key,
                                  "manifest": manifest, "elapsedSeconds": round(time.monotonic() - begin, 3),
                                  "internalModelRequests": 0}))
                return 0
        current = with_store.checkpoint(args.task_key, owner, current["revision"],
                                        {"phase": "verifying", "head": head, "next_action": "执行固定配方"})
        task = {"schemaVersion": 2, "taskKey": args.task_key, "attemptId": str(uuid.uuid4()),
                "kind": "review", "risk": "normal", "objective": recipe["id"], "repo": str(repo),
                "acceptance": predicates, "runtime": {"profileId": "local-recipe-v1",
                    "engineExecutable": node, "engineVersion": subprocess.check_output([node, "--version"], text=True).strip(),
                    "domain": "local-no-platform-login", "contextMode": "no-model"},
                "budget": {"maxExecutors": 1, "maxWallSeconds": 180},
                "verification": {"manifest": "{artifacts}/verification.json", "validatorArgv": [
                    sys.executable, "-B", str(scripts / "verification.py"), "--repo", "{worktree}",
                    "--manifest", "{artifacts}/verification.json", "--level", recipe["level"], "--node", node]}}
        reg = registry.validate({"executors": [{"name": "repository-recipe", "tier": "S",
            "provider": "local", "verified": True, "roles": ["review"], "dailyCap": 100,
            "invocation": {"proposed": False, "argv": [node, str(repo / binding["runner"]),
                "--root", "{worktree}", "--recipe", binding["recipe"], "--output", "{artifacts}"]}}]})
        plan = router.route(task, reg)
        result = runner.run_plan(plan, worktree=str(repo), brief="", ledger_path=Path(args.state) / "usage.jsonl",
                                 artifacts_dir=Path(args.state) / "artifacts", timeout=180)
        if not result["acceptancePassed"]:
            print(json.dumps({"passed": False, "execution": result}, ensure_ascii=False))
            return 1
        manifest = Path(result["artifacts"]) / "verification.json"
        with_store.accept_verification(args.task_key, owner, current["revision"], manifest, recipe["level"])
        print(json.dumps({"passed": True, "reused": False, "taskKey": args.task_key, "manifest": str(manifest),
                          "elapsedSeconds": round(time.monotonic() - begin, 3), "internalModelRequests": 0}, ensure_ascii=False))
        return 0
    finally:
        if claimed:
            with_store.release(args.task_key, owner)
        with_store.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError) as error:
        print(json.dumps({"passed": False, "failure": str(error)}, ensure_ascii=False))
        sys.exit(1)
