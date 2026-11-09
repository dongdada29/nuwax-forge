import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from crew import trigger  # noqa: E402

NOW = datetime(2026, 11, 6, 12, 0, tzinfo=timezone.utc)


def pr(number=31, *, draft=False, state="OPEN", updated=None, rollup=None, repo="dongdada29/nuwax-forge") -> dict:
    return {"source": "github-pr", "repo": repo, "number": number, "title": f"PR {number}",
            "isDraft": draft, "state": state,
            "updatedAt": updated or NOW.isoformat(timespec="seconds"),
            "headRefName": f"el/branch-{number}", "rollup": rollup or []}


def check(name="ci", *, status="COMPLETED", conclusion="FAILURE") -> dict:
    return {"name": name, "status": status, "conclusion": conclusion}


RULES = [
    {"id": "pr-checks-failed", "match": {"source": "github-pr", "state": "OPEN", "draft": False,
                                         "checks": "failure"},
     "kind": "triage", "risk": "low", "objective": "只读查看 {repo}#{number} CI 失败原因，不改任何文件",
     "acceptance": ["输出结论", "无文件修改"]},
    {"id": "pr-stale", "match": {"source": "github-pr", "state": "OPEN", "draft": False, "staleDays": 3},
     "kind": "triage", "risk": "low", "objective": "核查 {repo}#{number} 停滞 {staleDays} 天的阻塞点"},
]


class ChecksStateTest(unittest.TestCase):
    def test_rollup_classification(self):
        self.assertEqual(trigger.checks_state([]), "none")
        self.assertEqual(trigger.checks_state([check(conclusion="SUCCESS")]), "success")
        self.assertEqual(trigger.checks_state([check(status="IN_PROGRESS", conclusion=None)]), "pending")
        self.assertEqual(trigger.checks_state([check(conclusion="TIMED_OUT")]), "failure")
        self.assertEqual(trigger.checks_state([check(conclusion="SUCCESS"),
                                               check(name="other", conclusion="CANCELLED")]), "failure")


class ScreenTest(unittest.TestCase):
    def test_rules_shape(self):
        # 载入真实示例规则文件
        rules = trigger.load_rules(ROOT / "trigger-rules.example.json")
        self.assertEqual([r["id"] for r in rules], ["pr-checks-failed", "pr-stale"])
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.json"
            bad.write_text(json.dumps([{"id": "x", "match": {}}]), encoding="utf-8")
            with self.assertRaises(trigger.TriggerError):
                trigger.load_rules(bad)

    def test_failed_pr_and_draft_exclusion(self):
        events = [pr(rollup=[check()]), pr(number=32, draft=True, rollup=[check()]),
                  pr(number=33, rollup=[check(conclusion="SUCCESS")])]
        tasks = trigger.screen(events, RULES, now=NOW)
        # 31 失败命中；32 是 draft 排除；33 全绿只可能命中 stale（刚更新，不命中）
        self.assertEqual([t["taskKey"] for t in tasks],
                         ["ghpr:dongdada29/nuwax-forge#31:pr-checks-failed"])
        self.assertEqual(tasks[0]["kind"], "triage")
        self.assertIn("CI 失败原因", tasks[0]["objective"])
        self.assertEqual(tasks[0]["sourceEvent"]["number"], 31)

    def test_stale_uses_updatedAt_window(self):
        old = pr(number=40, updated=(NOW - timedelta(days=5)).isoformat(timespec="seconds"))
        recent = pr(number=41, updated=(NOW - timedelta(days=1)).isoformat(timespec="seconds"))
        tasks = trigger.screen([old, recent], RULES, now=NOW)
        self.assertEqual([t["taskKey"] for t in tasks],
                         ["ghpr:dongdada29/nuwax-forge#40:pr-stale"])
        self.assertIn("停滞 3 天", tasks[0]["objective"])

    def test_task_passes_contract_validate(self):
        from crew import contract
        tasks = trigger.screen([pr(rollup=[check()])], RULES, now=NOW)
        contract.validate({k: v for k, v in tasks[0].items() if k not in {"key", "sourceEvent"}})


class DedupAndRunTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / "trigger-state.json"

    def test_run_dedup_and_suppress(self):
        events = [pr(rollup=[check()])]
        first = trigger.run(events, RULES, self.state, now=NOW)
        self.assertEqual(first["matched"], 1)
        self.assertEqual(len(first["tasks"]), 1)
        # 同一事件 1 小时后再触发：抑制窗口（默认 24h）内不重复
        again = trigger.run(events, RULES, self.state, now=NOW + timedelta(hours=1))
        self.assertEqual(again["tasks"], [])
        self.assertEqual(again["suppressed"], 1)
        # 超过窗口重新触发
        later = trigger.run(events, RULES, self.state, now=NOW + timedelta(hours=25))
        self.assertEqual(len(later["tasks"]), 1)
        state = json.loads(self.state.read_text(encoding="utf-8"))
        self.assertEqual(len(state), 1)
        self.assertIn("ghpr:dongdada29/nuwax-forge#31:pr-checks-failed", state)

    def test_run_no_events_no_state_file(self):
        trigger.run([], RULES, self.state, now=NOW)
        self.assertFalse(self.state.exists())

    def test_state_prunes_old_entries(self):
        state = {"old-key": (NOW - timedelta(days=40)).isoformat(timespec="seconds")}
        trigger.save_state(self.state, state, now=NOW)
        self.assertEqual(json.loads(self.state.read_text(encoding="utf-8")), {})

    def test_cli_returns_plans_without_recording_unexecuted_dispatch(self):
        root = Path(self.tmp.name)
        (root / "events.json").write_text(json.dumps([pr(rollup=[check()])]), encoding="utf-8")
        (root / "rules.json").write_text(json.dumps(RULES[:1]), encoding="utf-8")
        (root / "registry.json").write_text(json.dumps({"executors": [{
            "name": "fixture", "tier": "B", "roles": ["triage"], "verified": True,
            "invocation": {"argv": [sys.executable, "-c", "raise RuntimeError('must not execute')"], "proposed": False},
        }]}), encoding="utf-8")
        ledger_path = root / "usage.jsonl"
        ledger_path.write_text("", encoding="utf-8")
        result = subprocess.run([
            sys.executable, "-B", "-m", "crew.cli", "trigger",
            "--events", str(root / "events.json"), "--rules", str(root / "rules.json"),
            "--state", str(self.state), "--registry", str(root / "registry.json"),
            "--ledger", str(ledger_path),
        ], cwd=ROOT, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value["dispatched"], [])
        self.assertEqual(value["plans"][0]["status"], "planned")
        self.assertEqual(ledger_path.read_text(encoding="utf-8"), "")


class CollectGithubTest(unittest.TestCase):
    def test_collect_normalizes_gh_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            gh = Path(tmp) / "gh"
            gh.write_text("#!/bin/sh\nprintf '%s' '[{\"number\":7,\"title\":\"T\",\"isDraft\":false,"
                          "\"state\":\"OPEN\",\"updatedAt\":\"2026-11-06T10:00:00Z\","
                          "\"headRefName\":\"b\",\"statusCheckRollup\":[{\"name\":\"ci\","
                          "\"status\":\"COMPLETED\",\"conclusion\":\"FAILURE\"}]}]'\n",
                          encoding="utf-8")
            gh.chmod(0o755)
            events = trigger.collect_github("dongdada29/nuwax-forge", gh_path=str(gh))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["source"], "github-pr")
        self.assertEqual(trigger.checks_state(events[0]["rollup"]), "failure")

    def test_collect_rejects_bad_repo_and_gh_failure(self):
        with self.assertRaises(trigger.TriggerError):
            trigger.collect_github("not-a-repo")
        with tempfile.TemporaryDirectory() as tmp:
            gh = Path(tmp) / "gh"
            gh.write_text("#!/bin/sh\necho 'billing broken' >&2\nexit 1\n", encoding="utf-8")
            gh.chmod(0o755)
            with self.assertRaises(trigger.TriggerError) as ctx:
                trigger.collect_github("a/b", gh_path=str(gh))
            self.assertIn("billing broken", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
