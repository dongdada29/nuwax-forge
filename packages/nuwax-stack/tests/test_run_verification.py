"""run_verification.py 端到端行为：可重复执行、--reuse 恢复、同任务并发唯一胜出。

需要 pilot 目录下的 nuwax-crew 源码与 nuwa-sdlc-kit verify.mjs 作为真实执行方；
缺少兄弟工作树时跳过，不造假通过。
"""
import importlib.util
import json
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CREW = ROOT.parent / "nuwax-crew"
VERIFY_MJS = ROOT.parent / "nuwa-sdlc-kit" / "kit" / "engine" / "verify.mjs"
BRIDGE = ROOT / "skills/nuwax-stack/scripts/run_verification.py"
TASK_STATE = ROOT / "skills/nuwax-stack/scripts/task_state.py"


def load_store():
    spec = importlib.util.spec_from_file_location("task_state_bridge", TASK_STATE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@unittest.skipUnless(CREW.is_dir() and VERIFY_MJS.is_file(), "需要 pilot 兄弟工作树 nuwax-crew 与 nuwa-sdlc-kit")
class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.node = shutil.which("node")
        self.state = self.base / "state"

    def fixture_repo(self, argv):
        repo = self.base / "repo"
        (repo / "src").mkdir(parents=True)
        (repo / "src/input.txt").write_text("stable\n")
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
        subprocess.run(["git", "-C", str(repo), "-c", "user.name=Fixture", "-c",
                        "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], check=True)
        shutil.copy(VERIFY_MJS, repo / "verify.mjs")
        recipe = {"schemaVersion": 1, "id": "bridge-fixture", "level": "source-tooling", "inputs": ["src"],
                  "stages": [{"id": "check", "predicate": "fixture-pass", "argv": argv}]}
        (repo / "recipe.json").write_text(json.dumps(recipe))
        (repo / ".sdlc.json").write_text(json.dumps({"verification": {"recipe": "recipe.json", "runner": "verify.mjs"}}))
        return repo

    def bridge(self, repo, *extra, env=None):
        return subprocess.run([sys.executable, "-B", str(BRIDGE), "--repo", str(repo), "--crew-root", str(CREW),
                               "--state", str(self.state), "--task-key", "pilot", "--node", self.node, *extra],
                              capture_output=True, text=True, env=env)

    def bridge_popen(self, repo):
        return subprocess.Popen([sys.executable, "-B", str(BRIDGE), "--repo", str(repo), "--crew-root", str(CREW),
                                 "--state", str(self.state), "--task-key", "pilot", "--node", self.node],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def read_task(self, repo):
        module = load_store()
        store = module.TaskStore(self.state, repo, self.node)
        self.addCleanup(store.close)
        return store.read("pilot")

    def test_repeated_execution_then_reuse_recovery(self):
        repo = self.fixture_repo(["{node}", "-e", "console.log('ok')"])
        first = json.loads(self.bridge(repo).stdout)
        self.assertTrue(first["passed"])
        self.assertFalse(first["reused"])
        second = json.loads(self.bridge(repo).stdout)
        self.assertTrue(second["passed"])
        self.assertFalse(second["reused"])
        self.assertNotEqual(first["manifest"], second["manifest"])
        reused = json.loads(self.bridge(repo, "--reuse").stdout)
        self.assertTrue(reused["reused"])
        self.assertEqual(reused["manifest"], second["manifest"])
        task = self.read_task(repo)
        self.assertEqual(task["phase"], "done")
        self.assertIsNone(task["lease_owner"])
        self.assertTrue(all(item["passed"] for item in task["evidence"]))

    def test_concurrent_same_task_has_single_winner_and_released_lease(self):
        repo = self.fixture_repo(["{node}", "-e", "console.log('ok')"])
        first, second = self.bridge_popen(repo), self.bridge_popen(repo)
        outputs = [proc.communicate() for proc in (first, second)]
        self.assertEqual(sorted([first.returncode, second.returncode]), [0, 1])
        for proc, (stdout, _) in zip((first, second), outputs):
            self.assertEqual(json.loads(stdout)["passed"], proc.returncode == 0)
        loser = json.loads(outputs[0][0]) if first.returncode else json.loads(outputs[1][0])
        self.assertIn("执行者", loser.get("failure", ""))
        task = self.read_task(repo)
        self.assertEqual(task["phase"], "done")
        self.assertIsNone(task["lease_owner"])

    def test_failing_recipe_reports_failure_and_keeps_task_open(self):
        repo = self.fixture_repo(["{node}", "-e", "process.exit(3)"])
        result = self.bridge(repo)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["passed"])
        self.assertFalse(payload["execution"]["processPassed"])
        task = self.read_task(repo)
        self.assertNotEqual(task["phase"], "done")
        self.assertIsNone(task["lease_owner"])

    def test_missing_node_runner_reports_clean_failure(self):
        repo = self.fixture_repo(["{node}", "-e", "console.log('ok')"])
        done = subprocess.run([sys.executable, "-B", str(BRIDGE), "--repo", str(repo), "--crew-root", str(CREW),
                               "--state", str(self.state), "--task-key", "pilot",
                               "--node", str(self.base / "missing-node")],
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 1)
        payload = json.loads(done.stdout)
        self.assertFalse(payload["passed"])
        self.assertTrue(payload["failure"])

    def test_explicit_node_off_path_still_validates(self):
        fake = self.base / "node-off-path"
        fake.write_text("#!/bin/sh\nexec " + shlex.quote(self.node) + " \"$@\"\n")
        fake.chmod(0o755)
        repo = self.fixture_repo(["{node}", "-e", "console.log('ok')"])
        done = subprocess.run([sys.executable, "-B", str(BRIDGE), "--repo", str(repo), "--crew-root", str(CREW),
                               "--state", str(self.state), "--task-key", "pilot", "--node", str(fake)],
                              capture_output=True, text=True,
                              env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(self.base)})
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        payload = json.loads(done.stdout)
        self.assertTrue(payload["passed"])
        task = self.read_task(repo)
        self.assertEqual(task["phase"], "done")


if __name__ == "__main__":
    unittest.main()
