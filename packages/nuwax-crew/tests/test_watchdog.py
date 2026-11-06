import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from crew import watchdog  # noqa: E402


def row(task_key="t-1", executor="codex", status="dispatched", ts=None,
        elapsed=None, **extra) -> dict:
    now = datetime.now(timezone.utc)
    out = {"ts": ts or now.isoformat(timespec="seconds"), "taskKey": task_key,
           "executor": executor, "role": "worker", "status": status}
    out.update({k: v for k, v in {"elapsedSeconds": elapsed, **extra}.items() if v is not None})
    return out


class EvaluateTest(unittest.TestCase):
    def test_empty_and_ok_rows_produce_no_alerts(self):
        self.assertEqual(watchdog.evaluate([]), [])
        ok = [row("t-1", status="dispatched"), row("t-1", status="completed")]
        self.assertEqual(watchdog.evaluate(ok), [])

    def test_task_spin(self):
        rows = [row("t-1", status="dispatched") for _ in range(3)]
        rows += [row("t-1", status="failed", elapsed=10)]  # spin 判定不因失败而放宽
        alerts = watchdog.evaluate(rows)
        self.assertEqual([a["rule"] for a in alerts], ["task-spin"])
        self.assertEqual(alerts[0]["subject"], "t-1")
        self.assertEqual(alerts[0]["evidence"]["dispatched"], 3)
        self.assertEqual(alerts[0]["evidence"]["failed"], 1)

    def test_fail_streak_when_below_spin_threshold(self):
        rows = [row("t-2", status="dispatched"), row("t-2", status="failed"),
                row("t-2", status="dispatched"), row("t-2", status="failed")]
        alerts = watchdog.evaluate(rows)
        rules = [a["rule"] for a in alerts]
        self.assertIn("attempt-fail-streak", rules)
        self.assertNotIn("task-spin", rules)

    def test_success_suppresses_task_alerts(self):
        rows = [row("t-3", status="dispatched") for _ in range(3)]
        rows.append(row("t-3", status="success"))
        self.assertEqual(watchdog.evaluate(rows), [])

    def test_time_burn_no_output(self):
        rows = [row("t-4", status="dispatched", elapsed=1800),
                row("t-4", status="failed", elapsed=1000),
                row("t-4", status="failed", elapsed=1000)]
        alerts = watchdog.evaluate(rows)
        self.assertEqual([a["rule"] for a in alerts], ["attempt-fail-streak", "time-burn-no-output"])
        self.assertEqual(alerts[1]["evidence"]["elapsedSeconds"], 3800)

    def test_executor_fail_streak_and_task_fail_coexist(self):
        rows = [row("t-a", "codex", "failed", elapsed=1), row("t-b", "codex", "failed", elapsed=1)]
        alerts = watchdog.evaluate(rows)
        # 每任务失败 1 次 < fail_streak 2；executor 全败 2 次 < 3 → 全无告警
        self.assertEqual(alerts, [])
        rows.append(row("t-c", "codex", "failed", elapsed=1))
        alerts = watchdog.evaluate(rows)
        self.assertEqual([a["rule"] for a in alerts], ["executor-fail-streak"])

    def test_window_filters_old_rows(self):
        now = datetime.now(timezone.utc)
        old = row("t-old", status="failed", ts=(now - timedelta(days=30)).isoformat(timespec="seconds"))
        rows = [old] * 3
        self.assertEqual(watchdog.evaluate(rows, now=now), [])

    def test_custom_thresholds(self):
        rows = [row("t-5", status="dispatched"), row("t-5", status="dispatched")]
        self.assertEqual(watchdog.evaluate(rows, spin_dispatched=2)[0]["rule"], "task-spin")


class PatrolTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ledger = Path(self.tmp.name) / "ledger.jsonl"
        self.alerts = Path(self.tmp.name) / "alerts.jsonl"
        self.now = datetime(2026, 11, 6, 12, 0, tzinfo=timezone.utc)

    def write_ledger(self, rows):
        with self.ledger.open("a", encoding="utf-8") as fh:
            for r in rows:
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")

    def test_patrol_appends_and_suppresses(self):
        self.write_ledger([row("t-1", status="dispatched") for _ in range(3)])
        first = watchdog.patrol(self.ledger, self.alerts, now=self.now)
        self.assertEqual(first["newAlerts"], 1)
        self.assertEqual(first["suppressed"], 0)
        # 六小时内重复巡查：同 key 告警被抑制
        again = watchdog.patrol(self.ledger, self.alerts, now=self.now + timedelta(hours=1))
        self.assertEqual(again["newAlerts"], 0)
        self.assertEqual(again["suppressed"], 1)
        # 超过抑制窗口后重新告警
        later = watchdog.patrol(self.ledger, self.alerts, now=self.now + timedelta(hours=7))
        self.assertEqual(later["newAlerts"], 1)
        self.assertEqual(later["suppressed"], 0)
        lines = [json.loads(x) for x in self.alerts.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0]["kind"], "crew-watchdog-alert")
        self.assertEqual(lines[0]["key"], "task-spin:t-1")

    def test_patrol_missing_ledger_is_noop(self):
        summary = watchdog.patrol(self.ledger, self.alerts, now=self.now)
        self.assertEqual(summary["newAlerts"], 0)
        self.assertFalse(self.alerts.exists())

    def test_alerts_file_with_bad_lines_does_not_crash(self):
        self.alerts.write_text("not-json\n", encoding="utf-8")
        self.write_ledger([row("t-1", status="failed"), row("t-1", status="failed")])
        summary = watchdog.patrol(self.ledger, self.alerts, now=self.now)
        self.assertEqual(summary["newAlerts"], 1)


if __name__ == "__main__":
    unittest.main()
