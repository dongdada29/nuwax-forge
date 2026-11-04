import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from crew import dashboard, usage  # noqa: E402

REG = {"executors": [
    {"name": "codex", "tier": "S", "subscription": "Codex PRO", "costClass": "subscription", "verified": True, "dailyCap": 40},
    {"name": "pi", "tier": "B", "subscription": "本机 MLX", "costClass": "local", "verified": True, "dailyCap": 50},
]}


def rows(*spec):
    return [{"ts": ts, "taskKey": k, "executor": e, "role": "implement", "status": s} for ts, k, e, s in spec]


class UsageTests(unittest.TestCase):
    def test_aggregate_by_executor_and_subscription(self):
        r = rows(
            ("2026-10-23T02:00:00+00:00", "a", "codex", "dispatched"),
            ("2026-10-23T02:01:00+00:00", "a", "codex", "success"),
            ("2026-10-23T03:00:00+00:00", "b", "codex", "failed"),
            ("2026-10-23T03:30:00+00:00", "c", "pi", "completed"),
        )
        out = usage.aggregate(r, REG, today="2026-10-23", days=7,
                              now=__import__("datetime").datetime(2026, 10, 23, 4, tzinfo=__import__("datetime").timezone.utc))
        self.assertEqual(out["perExecutor"]["codex"]["total"], 3)
        self.assertEqual(out["perExecutor"]["codex"]["ok"], 1)
        self.assertEqual(out["perExecutor"]["codex"]["today"], 3)
        self.assertEqual(out["perSubscription"]["Codex PRO"]["total"], 3)
        self.assertEqual(out["perSubscription"]["本机 MLX"]["total"], 1)
        self.assertEqual(out["perDay"]["2026-10-23"]["codex"], 3)

    def test_empty_ledger_returns_zeroed_executors(self):
        out = usage.aggregate([], REG)
        self.assertEqual(out["perExecutor"]["pi"]["total"], 0)
        self.assertEqual(out["perSubscription"], {})

    def test_unregistered_executor_falls_into_bucket(self):
        r = rows(("2026-10-23T02:00:00+00:00", "x", "ghost", "success"))
        out = usage.aggregate(r, REG)
        self.assertEqual(out["perSubscription"]["未注册执行器"]["total"], 1)


class DashboardTests(unittest.TestCase):
    def test_engine_labels_and_explicit_delivery_are_distinct(self):
        registry = {'executors': [
            {'name': 'zhipu-glm', 'provider': 'zhipu', 'invocation': {'command': 'env -u XDG_CONFIG_HOME HOME=/x opencode run -m zhipu/glm-5.3 {brief}'}},
            {'name': 'zcode', 'provider': 'zai', 'invocation': {'command': 'env TOKEN=redacted node /app/zcode.cjs {brief}'}},
            {'name': 'omp', 'invocation': {'command': 'omp {brief}'}},
            {'name': 'dsh', 'invocation': {'command': 'dsh {brief}'}},
            {'name': 'cursor', 'invocation': {'command': 'env -u XDG_CONFIG_HOME HOME=/x /usr/local/bin/cursor-agent -p {brief} --trust'}},
            {'name': 'antigravity', 'invocation': {'command': ['env', 'HOME=/x', '/usr/local/bin/agy', '-p', '{brief}']}},
        ]}
        self.assertEqual([dashboard.configured_engine(e) for e in registry['executors']], ['OpenCode', 'Z Code', 'OMP', 'DeepSeek Harness', 'Cursor', 'Antigravity'])
        data = usage.aggregate([], registry, today='2026-10-23')
        record = {'source': 'crew', 'taskKey': 't', 'executor': 'zcode', 'role': 'worker', 'status': 'success',
                  'branch': 'feature/<x>', 'commit': 'da5734d279', 'prUrl': 'https://example.org/o/r/pull/1'}
        page = dashboard.build_html(data, registry, {}, [], [], generated_at='test', records=[record])
        for value in ('OpenCode', 'Z Code', 'OMP', 'DeepSeek Harness', '<b>Cursor</b><small>cursor · 已登记', '<b>Antigravity</b><small>antigravity · 已登记', 'da5734d279', 'feature/&lt;x&gt;', 'https://example.org/o/r/pull/1'):
            self.assertIn(value, page)
        self.assertNotIn('feature/<x>', page)
        self.assertNotIn('TOKEN=redacted', page)

    def test_charts_keep_crew_status_scope_and_show_empty_days(self):
        entries = rows(("2026-10-23T01:00:00+00:00", "a", "codex", "dispatched"),
                       ("2026-10-23T02:00:00+00:00", "a", "codex", "success"))
        data = usage.aggregate(entries, REG, today="2026-10-23")
        records = [
            {"source": "crew", "taskKey": "a", "executor": "codex", "role": "worker", "status": "success"},
            {"source": "host-guard", "taskKey": "b", "executor": "codex", "role": "router", "status": "unknown"},
            {"source": "host-guard", "taskKey": "b", "executor": "worker<x>", "role": "worker", "status": "failed"},
        ]
        page = dashboard.build_html(data, REG, {}, [], entries, generated_at="test", records=records)
        self.assertIn('Crew 状态分布，共 1 条尝试记录', page)
        self.assertIn('2026-10-23：2 条台账记录', page)
        self.assertIn('2026-10-22：0 条台账记录', page)
        self.assertIn('worker&lt;x&gt;', page)
        self.assertNotIn('worker<x>', page)

    def test_write_dashboard_contains_sections_and_escapes(self):
        matrix = [{"key": "NW-1", "title": "**待分诊**条目 <x>", "status": "pending-triage", "evidence": "e"},
                  {"key": "NW-2", "title": "已完成", "status": "done-verified-web", "evidence": "e2"}]
        flow = rows(("2026-10-23T02:00:00+00:00", "a", "codex", "success"))
        u = usage.aggregate(flow, REG)
        with tempfile.TemporaryDirectory() as td:
            out = dashboard.write_dashboard(Path(td) / "sub" / "d.html", usage=u, registry=REG,
                                            health={"pi": {"until": "x", "reason": "quota"}},
                                            matrix=matrix, flow_rows=flow)
            page = Path(out).read_text(encoding="utf-8")
        for needle in ("订阅使用量", "执行器池", "任务看板", "派工流水", "Codex PRO", "&lt;x&gt;",
                       "❄ 冷却", "待分诊/待决策", "已验证完成"):
            self.assertIn(needle, page)

    def test_board_buckets_fallback_status(self):
        matrix = [{"key": "Z", "title": "t", "status": "weird-status"}]
        cols = dashboard.board_columns(matrix)
        titles = {t: items for t, _, items in cols}
        self.assertIn(titles["挂起/其它"][0]["key"], "Z")


if __name__ == "__main__":
    unittest.main()

    def test_flow_rows_tolerate_legacy_atutc_records(self):
        legacy = [{"atUtc": "2026-10-23T02:00:00+00:00", "taskKey": "x", "executor": "codex", "role": "implement", "status": "success"}]
        u = usage.aggregate([], REG)
        with tempfile.TemporaryDirectory() as td:
            out = dashboard.write_dashboard(Path(td) / "d.html", usage=u, registry=REG,
                                            health={}, matrix=[], flow_rows=legacy)
            page = Path(out).read_text(encoding="utf-8")
        self.assertIn("2026-10-23T02:00", page)
