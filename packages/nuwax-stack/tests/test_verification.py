import hashlib
import importlib.util
import json
import platform
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("task_state_verification", ROOT / "skills/nuwax-stack/scripts/task_state.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class VerificationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.repo = self.base / "repo"
        (self.repo / "src").mkdir(parents=True)
        (self.repo / "src/input").write_text("initial")
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        subprocess.run(["git", "-C", str(self.repo), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.repo), "-c", "user.name=Fixture", "-c",
                        "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], check=True)
        self.head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.repo, text=True).strip()
        self.state_dir = self.base / "state"
        self.store = runtime.TaskStore(self.state_dir, self.repo)
        self.addCleanup(lambda: self.store.close())
        self.store.create("pilot", "verify tooling", ["cache-correct"], self.head)
        self.store.claim("pilot", "worker")
        self.proof = self.state_dir / "proof"
        self.proof.mkdir()
        (self.proof / "check.log").write_text("observable proof")
        recipe = {"id": "fixture", "level": "source-tooling", "inputs": ["src"],
                  "stages": [{"id": "check", "predicate": "cache-correct"}]}
        (self.repo / "recipe.json").write_text(json.dumps(recipe))
        files = runtime.verification_files(self.repo, ["src", "recipe.json"])
        digest = hashlib.sha256("".join(f["path"] + "\0" + f["sha256"] + "\n" for f in files).encode()).hexdigest()
        self.data = {"schemaVersion": 1, "kind": "nuwax-verification", "passed": True,
                     "recipe": "fixture", "recipePath": "recipe.json", "level": "source-tooling",
                     "source": {"root": str(self.repo), "head": self.head, "inputs": ["src", "recipe.json"],
                                "files": files, "inputDigest": digest},
                     "environment": {"hostname": platform.node(), "platform": "darwin" if platform.system() == "Darwin" else "win32" if platform.system() == "Windows" else platform.system().lower(),
                                     "arch": {"aarch64": "arm64", "x86_64": "x64", "AMD64": "x64"}.get(platform.machine(), platform.machine()),
                                     "node": subprocess.check_output([shutil.which("node"), "--version"], text=True).strip()},
                     "predicates": [{"id": "cache-correct", "passed": True}],
                     "stages": [{"id": "check", "passed": True, "exitCode": 0}],
                     "artifacts": [{"path": "check.log", "sha256": hashlib.sha256((self.proof / "check.log").read_bytes()).hexdigest()}],
                     "command": ["node", "verify"]}
        self.manifest = self.proof / "verification.json"
        self.save()

    def save(self):
        self.manifest.write_text(json.dumps(self.data))

    def test_import_then_reopen_preserves_completed_proof(self):
        done = self.store.accept_verification("pilot", "worker", 0, self.manifest, "source-tooling")
        self.assertEqual(done["phase"], "done")
        self.store.close()
        self.store = runtime.TaskStore(self.state_dir, self.repo)
        self.assertEqual(self.store.read("pilot")["revision"], 1)
        self.assertTrue(runtime.validate_verification(self.manifest, self.repo)["passed"])

    def test_release_preserves_state_and_allows_a_new_owner(self):
        with self.assertRaises(ValueError):
            self.store.release("pilot", "other")
        self.store.release("pilot", "worker")
        self.store.claim("pilot", "next")
        self.assertEqual(self.store.read("pilot")["lease_owner"], "next")

    def test_second_owner_cannot_claim_a_live_lease(self):
        with self.assertRaisesRegex(ValueError, "执行者"):
            self.store.claim("pilot", "intruder")
        self.assertEqual(self.store.read("pilot")["lease_owner"], "worker")

    def test_dirty_source_and_new_input_invalidate_same_head(self):
        (self.repo / "src/new").write_text("untracked source")
        with self.assertRaisesRegex(ValueError, "输入已变化"):
            self.store.accept_verification("pilot", "worker", 0, self.manifest)

    def test_artifact_tampering_is_rejected(self):
        (self.proof / "check.log").write_text("changed")
        with self.assertRaisesRegex(ValueError, "工件已变化"):
            self.store.accept_verification("pilot", "worker", 0, self.manifest)

    def test_wrong_layer_missing_predicate_and_false_result_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "层级"):
            self.store.accept_verification("pilot", "worker", 0, self.manifest, "packaged-desktop")
        self.data["predicates"] = []
        self.save()
        with self.assertRaisesRegex(ValueError, "条件缺失"):
            self.store.accept_verification("pilot", "worker", 0, self.manifest)
        self.data["passed"] = False
        self.save()
        with self.assertRaisesRegex(ValueError, "未通过"):
            self.store.accept_verification("pilot", "worker", 0, self.manifest)

    def _fixture_node(self, version="v0.0.0-bridge-fixture"):
        fake = self.base / "node-fixture"
        fake.write_text("#!/bin/sh\necho " + shlex.quote(version) + "\n")
        fake.chmod(0o755)
        return fake

    def test_explicit_node_reaches_validator_and_import_without_path(self):
        fake = self._fixture_node()
        self.data["environment"]["node"] = "v0.0.0-bridge-fixture"
        self.save()
        with self.assertRaisesRegex(ValueError, "运行环境已变化"):
            runtime.validate_verification(self.manifest, self.repo)
        self.assertTrue(runtime.validate_verification(self.manifest, self.repo, node_executable=fake)["passed"])
        directory = self.base / "state-explicit"
        proof = directory / "proof"
        proof.mkdir(parents=True)
        shutil.copy(self.proof / "check.log", proof / "check.log")
        manifest = proof / "verification.json"
        manifest.write_text(json.dumps(self.data))
        store = runtime.TaskStore(directory, self.repo, str(fake))
        self.addCleanup(store.close)
        store.create("explicit", "verify tooling", ["cache-correct"], self.head)
        store.claim("explicit", "worker")
        self.assertEqual(store.accept_verification("explicit", "worker", 0, manifest, "source-tooling")["phase"], "done")

    def test_missing_explicit_node_fails_instead_of_falling_back_to_path(self):
        with self.assertRaises(OSError):
            runtime.validate_verification(self.manifest, self.repo, node_executable=self.base / "no-such-node")

    def test_manifest_node_executable_is_never_executed(self):
        fake = self._fixture_node()
        marker = self.base / "executed-marker"
        evil = self.base / "evil-node"
        evil.write_text("#!/bin/sh\ntouch " + shlex.quote(str(marker)) + "\necho v0.0.0-bridge-fixture\n")
        evil.chmod(0o755)
        self.data["environment"]["node"] = "v0.0.0-bridge-fixture"
        self.data["environment"]["nodeExecutable"] = str(evil)
        self.save()
        self.assertTrue(runtime.validate_verification(self.manifest, self.repo, node_executable=fake)["passed"])
        self.assertFalse(marker.exists())

    def test_validator_cli_passes_explicit_node(self):
        fake = self._fixture_node()
        self.data["environment"]["node"] = "v0.0.0-bridge-fixture"
        self.save()
        script = ROOT / "skills/nuwax-stack/scripts/verification.py"
        argv = [sys.executable, "-B", str(script), "--repo", str(self.repo), "--manifest", str(self.manifest),
                "--level", "source-tooling"]
        good = subprocess.run(argv + ["--node", str(fake)], capture_output=True, text=True)
        self.assertEqual(good.returncode, 0)
        self.assertTrue(json.loads(good.stdout)["passed"])
        bad = subprocess.run(argv, capture_output=True, text=True)
        self.assertEqual(bad.returncode, 1)
        self.assertIn("运行环境已变化", bad.stdout)
