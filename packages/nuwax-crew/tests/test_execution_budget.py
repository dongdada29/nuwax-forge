"""真实 shell/argv marker 验收预算边界；全部离线，绝不调用模型。"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from crew import runner, router  # noqa: E402


def spec(**changes):
    value = {"schemaVersion": 1, "id": "fixture-only", "mode": "model", "model": {"name": "fixture"},
             "taskKind": "text-implementation", "expectedCalls": 1, "initialContextTokens": 100,
             "perCallOutputTokens": 10, "budgetTokens": 10000}
    value.update(changes)
    return value


class ExecutionBudgetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.wt = self.base / "work tree"
        self.wt.mkdir()
        self.ledger = self.base / "ledger.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def assignment(self, name="marker", actual=None):
        if actual is None:
            actual = {"usage": {"input_tokens": 100, "output_tokens": 10}}
        return {"executor": name, "role": "check", "command": [sys.executable, "-c",
            "import pathlib,sys; pathlib.Path(sys.argv[1]).touch(); pathlib.Path(sys.argv[2]).write_text(sys.argv[3])",
            str(self.wt / name), "{stepArtifacts}/usage.json", json.dumps(actual)]}

    def plan(self, *assignments):
        return {"taskKey": "fixture-task", "mode": "model", "budget": {"maxTokens": 10000, "maxWallSeconds": 30},
                "budgetSpec": spec(), "assignments": list(assignments or [self.assignment()])}

    def execute(self, plan, brief="有限离线任务"):
        return runner.run_plan(plan, worktree=str(self.wt), brief=brief, ledger_path=self.ledger,
                               artifacts_dir=self.base / "artifacts")

    def assert_blocked(self, plan, reason=None, brief="有限任务"):
        out = self.execute(plan, brief)
        self.assertEqual(out["results"][0]["status"], "blocked")
        self.assertFalse((self.wt / "marker").exists())
        self.assertFalse(out["processPassed"])
        if reason:
            self.assertEqual(out["results"][0]["reason"], reason)
        self.assertTrue((Path(out["artifacts"]) / "execution.json").is_file())
        return out

    def test_high_exceeds_no_marker_and_persisted_prediction(self):
        p = self.plan()
        p["budgetSpec"]["budgetTokens"] = 1
        out = self.assert_blocked(p, "prediction-high-exceeds-budget")
        self.assertGreater(out["results"][0]["budget"]["estimate"]["totalTokens"]["high"], 1)
        self.assertIn('"status": "blocked"', self.ledger.read_text())

    def test_missing_budget_and_prediction_unknown_no_marker(self):
        for change in ("spec", "tokens", "output"):
            with self.subTest(change=change):
                p = self.plan()
                if change == "spec":
                    del p["budgetSpec"]
                elif change == "tokens":
                    del p["budget"]["maxTokens"]
                else:
                    del p["budgetSpec"]["perCallOutputTokens"]
                self.assert_blocked(p)

    def test_model_cannot_disguise_as_no_model_or_zero_calls(self):
        for budget_spec in (spec(mode="no-model", expectedCalls=0), spec(expectedCalls=0)):
            p = self.plan()
            p["budgetSpec"] = budget_spec
            self.assert_blocked(p, "model-spec-mismatch")

    def test_within_really_runs_and_settles_scope_cache(self):
        out = self.execute(self.plan())
        self.assertTrue((self.wt / "marker").exists())
        self.assertTrue(out["processPassed"])
        self.assertTrue(out["budgetPassed"])
        self.assertTrue(out["results"][0]["managed"])
        self.assertEqual(out["budget"]["remainingTokens"], 9890)
        self.assertEqual(out["results"][0]["settlement"]["reconciliation"]["actual"]["usageScope"], "run-segment")

    def test_serial_shared_budget_charges_actual_and_blocks_next_high(self):
        p = self.plan(self.assignment(actual={"usage": {"input_tokens": 9950, "output_tokens": 10}}), self.assignment("later"))
        out = self.execute(p)
        self.assertTrue((self.wt / "marker").exists())
        self.assertFalse((self.wt / "later").exists())
        self.assertEqual(out["results"][1]["reason"], "prediction-high-exceeds-remaining")
        self.assertEqual(out["budget"]["knownSpentTokens"], 9960)

    def test_serial_known_actual_releases_only_high_reservation(self):
        out = self.execute(self.plan(self.assignment(), self.assignment("later")))
        self.assertTrue((self.wt / "later").exists())
        self.assertEqual(out["budget"]["remainingTokens"], 9780)
        self.assertEqual(len(out["budget"]["steps"]), 2)

    def test_single_step_known_actual_exceeds_own_limit_blocks_next(self):
        p = self.plan(self.assignment(actual={"usage": {"input_tokens": 3000, "output_tokens": 10}}), self.assignment("later"))
        p["budgetSpec"]["budgetTokens"] = 2000
        out = self.execute(p)
        self.assertFalse((self.wt / "later").exists())
        self.assertEqual(out["results"][1]["reason"], "actual-budget-exceeded")
        self.assertFalse(out["budgetPassed"])

    def test_cumulative_claude_and_missing_actual_keep_unknown_stop_next(self):
        actuals = [{"modelUsage": {"inputTokens": 1, "outputTokens": 1, "cacheReadInputTokens": 0}}, {"usage": {}}]
        for actual in actuals:
            with self.subTest(actual=actual):
                p = self.plan(self.assignment(actual=actual), self.assignment("later"))
                p["taskKey"] = str(actual)
                out = self.execute(p)
                self.assertFalse((self.wt / "later").exists())
                self.assertEqual(out["results"][1]["reason"], "shared-usage-unknown")
                self.assertIsNone(out["budget"]["remainingTokens"])
                self.assertFalse(out["budgetPassed"])
                self.assertIsNone(out["results"][0]["settlement"]["chargedTokens"])

    def test_excludes_cache_charged_comparably_and_raw_retained(self):
        actual = {"usageScope": "run-segment", "inputSemantics": "excludes-cache",
                  "usage": {"inputTokens": 100, "outputTokens": 10, "cachedReadTokens": 9000}}
        out = self.execute(self.plan(self.assignment(actual=actual), self.assignment("later")))
        actual_out = out["results"][0]["settlement"]["reconciliation"]["actual"]
        self.assertEqual(actual_out["usage"]["inputTokens"], 100)
        self.assertEqual(out["budget"]["knownSpentTokens"], 9220)
        self.assertEqual(out["budget"]["remainingTokens"], 780)

    def test_context_limits_and_explicit_file_no_spawn(self):
        p = self.plan()
        p["context"] = {"maxBytes": 100}
        self.assert_blocked(p, "invalid-budget-or-context", brief="z" * 101)
        p = self.plan()
        file = self.wt / "large.txt"
        file.write_text("x" * 65537)
        p["context"] = {"contextFiles": ["large.txt"]}
        self.assert_blocked(p, "invalid-budget-or-context")

    def test_actual_brief_floor_cannot_be_bypassed_by_tiny_spec(self):
        p = self.plan()
        p["budgetSpec"].update(initialContextTokens=0, budgetTokens=500)
        out = self.assert_blocked(p, "prediction-high-exceeds-budget", brief="x" * 1800)
        self.assertGreaterEqual(out["results"][0]["budget"]["estimate"]["contextFloorTokens"], 600)

    def test_no_long_command_or_brief_repeated_in_summary_and_metadata(self):
        long = "fixed $(touch should-not-exist) ' \" " + "x" * 2000
        a = self.assignment()
        a["command"].extend(["{brief}", long])
        out = self.execute(self.plan(a), brief=long)
        self.assertFalse((self.wt / "should-not-exist").exists())
        self.assertNotIn(long, json.dumps(out))
        self.assertNotIn(long, Path(out["results"][0]["log"]).read_text())
        manifest = Path(out["artifacts"]) / "step-1/context-manifest.json"
        self.assertTrue(manifest.is_file())
        original = json.loads((Path(out["artifacts"]) / "step-1/command.json").read_text())
        self.assertEqual(original[-2:], [long, long])

    def test_manual_attempt_cap_and_failure_stop(self):
        p = self.plan()
        self.assertTrue(self.execute(p)["processPassed"])
        again = self.execute(p)
        self.assertEqual(again["results"][0]["reason"], "invalid-execution-budget")
        self.assertIn("max-attempts-exhausted", again["results"][0]["budget"]["error"])
        p = self.plan(self.assignment("failure"), self.assignment("later"))
        p["taskKey"] = "fail-stops"
        p["assignments"][0]["command"] = [sys.executable, "-c", "raise SystemExit(3)"]
        out = self.execute(p)
        self.assertEqual(len(out["results"]), 1)
        self.assertFalse((self.wt / "later").exists())

    def test_legacy_unmanaged_and_runtime_model_declaration(self):
        p = self.plan()
        del p["mode"], p["budgetSpec"]
        legacy = self.execute(p)
        self.assertFalse(legacy["results"][0]["managed"])
        self.assertEqual(legacy["budget"]["coverage"], "legacy-unmanaged")
        p["runtime"] = {"model": "fixture", "contextMode": "fresh-exec"}
        p["assignments"][0] = self.assignment("runtime-marker")
        out = self.execute(p)
        self.assertEqual(out["results"][0]["reason"], "missing-budget-spec")
        self.assertFalse((self.wt / "runtime-marker").exists())

    def test_declared_no_model_coverage_and_fresh_exec_not_unmanaged(self):
        p = {"taskKey": "no-model", "mode": "no-model", "assignments": [self.assignment()]}
        out = self.execute(p)
        self.assertEqual(out["budget"]["coverage"], "declared-no-model")
        self.assertFalse(out["results"][0]["managed"])
        p = {"taskKey": "fresh-exec", "runtime": {"contextMode": "fresh-exec"}, "assignments": [self.assignment("fresh")]}
        out = self.execute(p)
        self.assertEqual(out["results"][0]["status"], "blocked")
        self.assertFalse((self.wt / "fresh").exists())

    def test_managed_timeout_stops_before_later_and_unknown_is_not_zero(self):
        p = self.plan(self.assignment(), self.assignment("later"))
        p["budget"]["maxWallSeconds"] = 1
        p["assignments"][0]["command"] = [sys.executable, "-c", "import time; time.sleep(30)"]
        out = self.execute(p)
        self.assertEqual(len(out["results"]), 1)
        self.assertEqual(out["results"][0]["failure"], "timeout")
        self.assertFalse((self.wt / "later").exists())
        self.assertIsNone(out["budget"]["remainingTokens"])

    def test_route_to_run_retains_model_budget_contract(self):
        task = self.plan()
        task.update(kind="triage", risk="low", objective="有限只读固定任务", acceptance=[])
        reg = {"executors": [{"name": "fixture", "tier": "B", "provider": "local", "roles": ["triage"],
                               "verified": True, "dailyCap": 10, "invocation": {"argv": self.assignment()["command"]}}]}
        task["budgetSpec"]["budgetTokens"] = 1
        planned = router.route(task, reg)
        self.assertEqual(planned["mode"], "model")
        self.assertEqual(planned["budget"]["maxTokens"], 10000)
        self.assert_blocked(planned, "prediction-high-exceeds-budget")

    def test_malformed_budget_fail_closed(self):
        for value in ([], {"maxTokens": True}, {"maxTokens": 10000, "maxAttempts": 0}, {"maxTokens": 10000, "maxAttempts": 2}, {"maxTokens": 10000, "retries": 4}):
            p = self.plan()
            p["budget"] = value
            self.assert_blocked(p, "invalid-execution-budget")


if __name__ == "__main__":
    unittest.main()
