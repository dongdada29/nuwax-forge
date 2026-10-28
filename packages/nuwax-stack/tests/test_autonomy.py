import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ledger = load("ledger", "skills/nuwax-stack/scripts/ledger.py")
runtime = load("task_state", "skills/nuwax-stack/scripts/task_state.py")


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.policy = {"baseUrl": "https://agent.nuwax.com", "sourcePageIds": [1652, 1886, 108], "ownedLedgerPageId": 2852, "syncDirection": "source-to-owned-only", "writeSourceDocuments": False}
        self.record = {"source_page_id": 1886, "source_record_id": "NW-001", "title": "重复发送", "source_status": "待处理", "source_url": "https://agent.nuwax.com/repo/doc/source"}

    def test_only_registered_owned_document_is_writable(self):
        self.assertEqual(ledger.check_write_target(self.policy, "https://agent.nuwax.com", 2852), "2852")
        for page_id in [1652, 1886, 108, 99999]:
            with self.assertRaises(ValueError):
                ledger.check_write_target(self.policy, "https://agent.nuwax.com", page_id)
        with self.assertRaises(ValueError):
            ledger.check_write_target(self.policy, "https://testagent.xspaceagi.com", 2852)
        with self.assertRaises(ValueError):
            ledger.check_write_target({**self.policy, "ownedLedgerPageId": None}, "https://agent.nuwax.com", 2852)

    def test_source_refresh_preserves_personal_progress_and_is_not_completion(self):
        state = ledger.merge_sources({}, [self.record], self.policy, "first")
        state = ledger.update_progress(state, "1886:NW-001", "实施中", notes="已有改动", evidence=["commit:123"], next_action="运行行为验证")
        refreshed = ledger.merge_sources(state, [{**self.record, "source_status": "已处理"}], self.policy, "second")
        task = refreshed["tasks"]["1886:NW-001"]
        self.assertEqual(task["source"]["source_status"], "已处理")
        self.assertEqual(task["personal"], state["tasks"]["1886:NW-001"]["personal"])
        self.assertEqual(state["tasks"]["1886:NW-001"]["source"]["source_status"], "待处理")

    def test_replay_does_not_duplicate_tasks_or_source_change_events(self):
        state = ledger.merge_sources({}, [self.record], self.policy, "first")
        state = ledger.merge_sources(state, [self.record], self.policy, "second")
        self.assertEqual(len(state["tasks"]), 1)
        self.assertEqual(len(state["events"]), 1)

    def test_completion_without_evidence_is_rejected(self):
        state = ledger.merge_sources({}, [self.record], self.policy)
        with self.assertRaisesRegex(ValueError, "验证证据"):
            ledger.update_progress(state, "1886:NW-001", "已完成")


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "repo"
        self.root.mkdir()
        self.directory = Path(self.tmp.name) / "state"
        self.store = runtime.TaskStore(self.directory, self.root)
        self.addCleanup(lambda: self.store.close())
        self.store.create("task-1", "避免重复请求", ["连续两次点击只发送一次请求"], "head-1")

    def test_checkpoint_recovers_after_reopening_process_state(self):
        self.store.claim("task-1", "worker-a")
        self.store.checkpoint("task-1", "worker-a", 0, {"phase": "implementing", "next_action": "补 pending 检查"})
        self.store.close()
        self.store = runtime.TaskStore(self.directory, self.root)
        restored = self.store.read("task-1")
        self.assertEqual(restored["revision"], 1)
        self.assertEqual(restored["phase"], "implementing")
        self.assertEqual(restored["next_action"], "补 pending 检查")

    def test_concurrent_worker_and_stale_revision_are_rejected(self):
        self.store.claim("task-1", "worker-a")
        with self.assertRaises(ValueError):
            self.store.claim("task-1", "worker-b")
        self.store.checkpoint("task-1", "worker-a", 0, {"phase": "analyzing"})
        with self.assertRaises(ValueError):
            self.store.checkpoint("task-1", "worker-a", 0, {"phase": "implementing"})

    def test_done_requires_all_predicates_and_unchanged_evidence(self):
        self.store.claim("task-1", "worker-a")
        with self.assertRaisesRegex(ValueError, "尚未全部验证"):
            self.store.checkpoint("task-1", "worker-a", 0, {"phase": "done"})
        path = self.directory / "behavior-test.txt"
        path.write_text("PASS: 2 clicks, 1 request")
        proof = {"predicate": "连续两次点击只发送一次请求", "passed": True, "head": "head-1", "command": "isolated behavior test", "artifact": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        result = self.store.checkpoint("task-1", "worker-a", 0, {"phase": "done", "evidence": [proof]})
        self.assertEqual(result["phase"], "done")
        path.write_text("FAIL")
        with self.assertRaisesRegex(ValueError, "工件已变化"):
            self.store.checkpoint("task-1", "worker-a", 1, {"phase": "done"})

    def test_waiting_without_runtime_wake_is_not_claimed_running(self):
        self.store.claim("task-1", "worker-a")
        with self.assertRaisesRegex(ValueError, "实际唤醒"):
            self.store.checkpoint("task-1", "worker-a", 0, {"phase": "waiting"})
        self.assertEqual(self.store.read("task-1")["phase"], "queued")

    def test_state_is_kept_outside_target_repository(self):
        with self.assertRaises(ValueError):
            runtime.TaskStore(self.root / "state", self.root)


if __name__ == "__main__":
    unittest.main()
