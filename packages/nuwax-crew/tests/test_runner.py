import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from crew import ledger, runner, unified_dashboard  # noqa: E402


def plan(*assignments):
    return {"taskKey": "t-run", "assignments": list(assignments)}


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.worktree = self.base / "wt"
        self.worktree.mkdir()
        self.ledger_path = self.base / "usage.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def execute(self, p, **kw):
        return runner.run_plan(p, worktree=str(self.worktree), brief="测试任务正文",
                               ledger_path=self.ledger_path,
                               artifacts_dir=self.base / "art", **kw)

    def test_success_path_records_dispatched_and_completed(self):
        out = self.execute(plan({"role": "implement", "executor": "echo-bot", "command": "echo OK-{brief}"}))
        self.assertEqual(out["results"][0]["status"], "completed")
        rows = [json.loads(l) for l in self.ledger_path.read_text().splitlines()]
        self.assertEqual([r["status"] for r in rows], ["dispatched", "completed"])
        log = Path(out["results"][0]["log"]).read_text(encoding="utf-8")
        self.assertIn("OK-测试任务正文", log)

    def test_worker_delivery_is_propagated_to_ledger_and_dashboard(self):
        delivery = {'branch': 'feature/test', 'commit': 'da5734d279', 'prUrl': 'https://example.org/o/r/pull/1'}
        script = "import json,pathlib,sys; (pathlib.Path(sys.argv[1])/'delivery.json').write_text(sys.argv[2])"
        p = plan({'role': 'implement', 'executor': 'test', 'command': [sys.executable, '-c', script, '{stepArtifacts}', json.dumps(delivery)]})
        out = self.execute(p)
        self.assertEqual(out['results'][0]['delivery'], delivery)
        records = unified_dashboard.crew_records([json.loads(line) for line in self.ledger_path.read_text().splitlines()])
        self.assertEqual({k: records[0][k] for k in delivery}, delivery)
        self.assertFalse(out['acceptancePassed'])  # A worker claim is not verification.

    def test_delivery_rejects_symlink_and_unsafe_references(self):
        target = self.base / 'outside.json'
        target.write_text('{"commit":"abcdef0"}')
        step = self.base / 'step'
        step.mkdir()
        (step / 'delivery.json').symlink_to(target)
        self.assertEqual(runner._read_delivery(step), {})
        self.assertEqual(unified_dashboard.delivery_fields({'commit': '$(bad)', 'prUrl': 'javascript:alert(1)'}), {})

    def test_failure_path_records_failed_and_keeps_log(self):
        out = self.execute(plan({"role": "implement", "executor": "bad", "command": "echo boom >&2; exit 3"}))
        self.assertEqual(out["results"][0]["status"], "failed")
        self.assertIn("boom", Path(out["results"][0]["log"]).read_text(encoding="utf-8"))

    def test_timeout_marks_failed(self):
        out = self.execute(plan({"role": "triage", "executor": "slow", "command": "sleep 30"}), timeout=1)
        self.assertEqual(out["results"][0]["status"], "failed")
        self.assertIn("timeout", out["results"][0]["summary"])

    def test_empty_command_is_skipped_not_run(self):
        out = self.execute(plan({"role": "fixed", "executor": "nuwax-a2a", "command": None}))
        self.assertEqual(out["results"][0]["status"], "skipped")
        self.assertFalse(self.ledger_path.exists())

    def test_role_filter_and_worktree_substitution(self):
        marker = self.worktree / "here.txt"
        out = self.execute(
            plan({"role": "review", "executor": "w", "command": "echo review-only"},
                 {"role": "implement", "executor": "i", "command": "pwd > {worktree}/here.txt"}),
            only_roles={"implement"})
        self.assertEqual([r["executor"] for r in out["results"]], ["i"])
        self.assertIn(str(self.worktree), marker.read_text(encoding="utf-8"))

    def test_argv_keeps_shell_metacharacters_literal(self):
        value = "literal $(touch unexpected) ' \" &"
        out = self.execute(plan({"role": "triage", "executor": "argv", "command": [sys.executable, "-c",
                                "import sys; print(sys.argv[1])", value]}))
        self.assertIn(value, Path(out["results"][0]["log"]).read_text())
        self.assertFalse((self.worktree / "unexpected").exists())

    def test_exit_zero_without_manifest_is_not_acceptance(self):
        p = plan({"role": "triage", "executor": "zero", "command": [sys.executable, "-c", "print('ok')"]})
        p.update(schemaVersion=2, verification={"manifest": "{artifacts}/missing.json",
                 "validatorArgv": [sys.executable, "-c", "print('{\"passed\":true}')"]})
        out = self.execute(p)
        self.assertTrue(out["processPassed"])
        self.assertFalse(out["acceptancePassed"])
        self.assertEqual(out["verification"]["failure"], "missing-or-outside-manifest")

    def test_all_skipped_is_not_process_or_acceptance_success(self):
        out = self.execute(plan({"role": "fixed", "executor": "skip", "command": None}))
        self.assertFalse(out["processPassed"])
        self.assertFalse(out["acceptancePassed"])

    def test_v2_stops_after_failure_and_keeps_attempt_metadata(self):
        p = plan({"role": "implement", "executor": "bad", "command": [sys.executable, "-c", "raise SystemExit(3)"]},
                 {"role": "review", "executor": "later", "command": [sys.executable, "-c", "print('must not run')"]})
        p["schemaVersion"] = 2
        out = self.execute(p)
        self.assertEqual(len(out["results"]), 1)
        self.assertEqual(out["results"][0]["exitCode"], 3)
        rows = [json.loads(line) for line in self.ledger_path.read_text().splitlines()]
        self.assertTrue(all(row["attemptId"] == out["attemptId"] for row in rows))

    def test_validator_exit_zero_with_passed_false_does_not_accept(self):
        p = plan({"role": "triage", "executor": "proof", "command": [sys.executable, "-c",
                 "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text('{}')", "{artifacts}/verification.json"]})
        p.update(schemaVersion=2, verification={"manifest": "{artifacts}/verification.json",
                 "validatorArgv": [sys.executable, "-c", "print('{\"passed\":false}')"]})
        out = self.execute(p)
        self.assertTrue(out["processPassed"])
        self.assertFalse(out["acceptancePassed"])
        self.assertEqual(out["verification"]["status"], "failed")


if __name__ == "__main__":
    unittest.main()
