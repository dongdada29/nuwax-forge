#!/usr/bin/env python3
"""在两个独立进程间验证任务检查点、真实测试证据和完成恢复；不调用模型。"""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("task_state", ROOT / "skills/nuwax-stack/scripts/task_state.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
PREDICATE = "全部仓库回归测试通过"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-dir", required=True, type=Path)
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    directory = args.artifact_dir.resolve()
    store = runtime.TaskStore(directory, ROOT)
    try:
        if args.worker:
            previous = store.read("runtime-smoke")
            if previous["phase"] != "verifying" or previous["revision"] != 1:
                raise ValueError("未能恢复预期检查点")
            command = [sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests", "-v"]
            result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
            artifact = directory / "regression-tests.txt"
            artifact.write_text(result.stdout + result.stderr, encoding="utf-8")
            if result.returncode:
                store.checkpoint("runtime-smoke", "smoke-worker", 1, {"phase": "blocked", "blocker": "真实测试失败", "next_action": "读取测试输出并修复"})
                raise SystemExit(result.returncode)
            proof = {"predicate": PREDICATE, "passed": True, "head": previous["head"], "command": " ".join(command), "artifact": str(artifact), "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest()}
            store.checkpoint("runtime-smoke", "smoke-worker", 1, {"phase": "done", "evidence": [proof], "next_action": "本地运行生命周期已验证；平台模型与唤醒另行验收"})
            return
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, capture_output=True, check=True).stdout.strip()
        store.create("runtime-smoke", "验证文档边界与自主状态助手的跨进程完成生命周期", [PREDICATE], head)
        store.claim("runtime-smoke", "smoke-worker")
        store.checkpoint("runtime-smoke", "smoke-worker", 0, {"phase": "verifying", "next_action": "独立进程恢复检查点并运行真实回归"})
        subprocess.run([sys.executable, "-B", str(Path(__file__).resolve()), "--artifact-dir", str(directory), "--worker"], check=True)
        restored = store.read("runtime-smoke")
        if restored["phase"] != "done" or restored["revision"] != 2:
            raise ValueError("最终完成状态未能恢复")
        receipt = {"scope": "local-runtime-lifecycle", "head": head, "phase": restored["phase"], "revision": restored["revision"], "evidence": restored["evidence"], "platform_model_executed": False, "platform_wake_verified": False}
        (directory / "receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(receipt, ensure_ascii=False))
    finally:
        store.close()


if __name__ == "__main__":
    main()
