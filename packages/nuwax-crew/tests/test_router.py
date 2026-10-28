import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from crew import contract, ledger, registry, router  # noqa: E402

REG = registry.load(ROOT / "registry.example.json")


def task(**over):
    base = {"taskKey": "t-1", "kind": "implementation", "risk": "high", "repo": "pc-web",
            "objective": "修复 NW-124", "acceptance": ["原测试不回退"]}
    base.update(over)
    return base


class RouterTests(unittest.TestCase):
    def test_high_risk_gets_cross_review_from_different_provider(self):
        plan = router.route(task(), REG)
        self.assertEqual(plan["status"], "planned")
        roles = [a["role"] for a in plan["assignments"]]
        self.assertEqual(roles, ["implement", "review"])
        providers = {a["provider"] for a in plan["assignments"]}
        self.assertEqual(len(providers), 2)

    def test_low_risk_routes_to_cheap_tier_first(self):
        reg = copy.deepcopy(REG)
        for e in reg["executors"]:
            if e["name"] == "opencode":
                e["verified"] = True
            if e["name"] == "pi":
                e["enabled"] = False  # 隔离 local 档，专测订阅档内的便宜优先
        plan = router.route(task(risk="low", kind="triage", repo=None, acceptance=[]), reg)
        self.assertEqual(plan["assignments"][0]["executor"], "opencode")
        self.assertEqual(plan["assignments"][0]["role"], "triage")

    def test_unverified_executor_never_gets_production_task(self):
        reg = copy.deepcopy(REG)
        for e in reg["executors"]:
            if e["tier"] in {"S", "A", "B"}:
                e["verified"] = False
        plan = router.route(task(), reg)
        self.assertEqual(plan["status"], "unroutable")

    def test_quota_exhausted_executor_downgrades(self):
        reg = copy.deepcopy(REG)
        for e in reg["executors"]:
            if e["name"] == "antigravity":
                e["verified"] = True
        counts = {"codex": 40, "claude-code": 40}
        plan = router.route(task(), reg, counts=counts)
        self.assertEqual(plan["status"], "planned")
        self.assertNotIn("codex", [a["executor"] for a in plan["assignments"]])
        self.assertIn("antigravity", [a["executor"] for a in plan["assignments"]])

    def test_same_task_key_dispatches_once(self):
        plan = router.route(task(), REG, dispatched={"t-1"})
        self.assertEqual(plan["status"], "already-dispatched")
        forced = router.route(task(), REG, dispatched={"t-1"}, force=True)
        self.assertEqual(forced["status"], "planned")

    def test_fixed_routes_are_pinned(self):
        plan = router.route(task(kind="web-verification", risk="low", repo=None, acceptance=[]), REG)
        self.assertEqual(plan["assignments"][0]["executor"], "ego-browser")
        plan = router.route(task(kind="platform-query", taskKey="t-2", repo=None, acceptance=[]), REG)
        self.assertEqual(plan["assignments"][0]["executor"], "nuwax-a2a")

    def test_plan_never_exceeds_concurrency(self):
        plan = router.route(task(budget={"maxExecutors": 3}), REG)
        self.assertLessEqual(len(plan["assignments"]), 3)

    def test_zhipu_channels_ranked_before_other_subscriptions(self):
        reg = {"executors": [
            {"name": "zcode", "tier": "B", "provider": "zai", "roles": ["implementation", "triage"],
             "verified": True, "dailyCap": 40, "costClass": "zhipu"},
            {"name": "other-sub", "tier": "B", "provider": "x", "roles": ["triage"],
             "verified": True, "dailyCap": 40, "costClass": "subscription"},
            {"name": "api-bill", "tier": "B", "provider": "y", "roles": ["triage"],
             "verified": True, "dailyCap": 40, "costClass": "api"},
        ]}
        plan = router.route(task(kind="triage", risk="low", repo=None, acceptance=[]), reg)
        self.assertEqual(plan["assignments"][0]["executor"], "zcode")
        self.assertEqual([f["executor"] for f in plan["fallbacks"][:1]], ["other-sub"])

    def test_local_still_beats_zhipu(self):
        reg = {"executors": [
            {"name": "pi", "tier": "B", "provider": "local", "roles": ["triage"], "verified": True,
             "dailyCap": 50, "costClass": "local"},
            {"name": "zcode", "tier": "B", "provider": "zai", "roles": ["triage"], "verified": True,
             "dailyCap": 40, "costClass": "zhipu"},
        ]}
        plan = router.route(task(kind="triage", risk="low", repo=None, acceptance=[]), reg)
        self.assertEqual(plan["assignments"][0]["executor"], "pi")


class ContractTests(unittest.TestCase):
    def test_implementation_requires_repo_and_acceptance(self):
        with self.assertRaises(contract.ContractError):
            contract.validate(task(repo=None))
        with self.assertRaises(contract.ContractError):
            contract.validate(task(acceptance=[]))

    def test_triage_does_not_require_repo(self):
        got = contract.validate(task(kind="triage", repo=None, acceptance=[]))
        self.assertEqual(got["kind"], "triage")

    def test_bad_kind_and_risk_rejected(self):
        with self.assertRaises(contract.ContractError):
            contract.validate(task(kind="shopping"))
        with self.assertRaises(contract.ContractError):
            contract.validate(task(risk="urgent"))


class LedgerTests(unittest.TestCase):
    def test_record_and_counts(self):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "usage.jsonl"
            ledger.record(path, task_key="a", executor="codex", role="implement", status="dispatched",
                          ts="2026-10-21T02:00:00+00:00")
            ledger.record(path, task_key="b", executor="codex", role="implement", status="dispatched",
                          ts="2026-10-21T03:00:00+00:00")
            ledger.record(path, task_key="a", executor="codex", role="implement", status="dispatched",
                          ts="2026-10-20T03:00:00+00:00")
            self.assertEqual(ledger.today_counts(path, "2026-10-21")["codex"], 2)
            self.assertEqual(ledger.dispatched_keys(path), {"a", "b"})
            self.assertEqual(ledger.summary(path)["dispatched"], 3)

    def test_non_dispatch_rows_do_not_count(self):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "usage.jsonl"
            ledger.record(path, task_key="a", executor="codex", role="implement", status="failed")
            self.assertEqual(ledger.today_counts(path, "2026-10-21")["codex"], 0)


class RegistryTests(unittest.TestCase):
    def test_duplicate_name_rejected(self):
        bad = {"executors": [{"name": "x", "tier": "S"}, {"name": "x", "tier": "B"}]}
        with self.assertRaises(registry.RegistryError):
            registry.validate(bad)

    def test_bad_tier_rejected(self):
        with self.assertRaises(registry.RegistryError):
            registry.validate({"executors": [{"name": "x", "tier": "Z"}]})


if __name__ == "__main__":
    unittest.main()


class DispatchTests(unittest.TestCase):
    def test_mark_dispatched_then_completed(self):
        import tempfile
        from crew import dispatch
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "usage.jsonl"
            plan = router.route(task(), REG)
            rows = dispatch.mark(plan, path, "dispatched")
            self.assertEqual(len(rows), 2)  # implement + review
            self.assertEqual(ledger.dispatched_keys(path), {"t-1"})
            done = dispatch.mark(plan, path, "completed", roles={"review"})
            self.assertEqual(len(done), 1)
            self.assertEqual(ledger.today_counts(path)["codex"], 1)  # completed 不计配额

    def test_bad_status_rejected(self):
        import tempfile
        from crew import dispatch
        with tempfile.TemporaryDirectory() as td:
            plan = router.route(task(), REG)
            with self.assertRaises(ValueError):
                dispatch.mark(plan, Path(td) / "u.jsonl", "done")

    def test_load_plan_requires_key_fields(self):
        import tempfile
        from crew import dispatch
        with tempfile.TemporaryDirectory() as td:
            bad = Path(td) / "plan.json"
            bad.write_text('{"taskKey": "x"}')
            with self.assertRaises(ValueError):
                dispatch.load_plan(bad)


class DisabledExecutorTests(unittest.TestCase):
    def test_disabled_executor_is_never_routed(self):
        reg = copy.deepcopy(REG)
        for e in reg["executors"]:
            if e["name"] == "opencode":
                e["verified"] = True
                e["enabled"] = False  # 模拟订阅过期下架
        plan = router.route(task(kind="triage", risk="low", repo=None, acceptance=[]), reg)
        self.assertNotIn("opencode", [a["executor"] for a in plan["assignments"]])
        self.assertNotIn("opencode", [f["executor"] for f in plan["fallbacks"]])

    def test_registry_rejects_non_boolean_enabled(self):
        with self.assertRaises(registry.RegistryError):
            registry.validate({"executors": [{"name": "x", "tier": "S", "enabled": "yes"}]})


class HealthFailoverTests(unittest.TestCase):
    def test_blocked_executor_switches_in_time(self):
        plan = router.route(task(), REG, blocked={"codex": ("2099-01-01T00:00:00+00:00", "quota-exhausted")})
        self.assertEqual(plan["status"], "planned")
        names = [a["executor"] for a in plan["assignments"]]
        self.assertNotIn("codex", names)
        self.assertTrue(any("冷却中已切换" in w and "codex" in w for w in plan["warnings"]))

    def test_health_reset_in_parsing_and_expiry(self):
        import tempfile
        from datetime import datetime, timezone
        from crew import health
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "health.json"
            row = health.mark(path, "grok", "quota", reset_in="2h30m")
            self.assertTrue(row["until"].startswith(datetime.now(timezone.utc).date().isoformat()))
            self.assertIn("grok", health.blocked(path))
            # 过期自动清理
            state = health.load(path)
            state["grok"]["until"] = "2000-01-01T00:00:00+00:00"
            health.save(path, state)
            self.assertEqual(health.blocked(path), {})
            self.assertNotIn("grok", health.load(path))

    def test_health_bad_reset_in_rejected(self):
        import tempfile
        from crew import health
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(health.HealthError):
                health.mark(Path(td) / "h.json", "x", "quota", reset_in="tomorrow")


class CostStrategyTests(unittest.TestCase):
    def test_subscription_preferred_over_api_within_tier(self):
        reg = copy.deepcopy(REG)
        for e in reg["executors"]:
            if e["name"] in ("codex", "claude-code"):
                e["verified"] = True
                e["costClass"] = "api" if e["name"] == "claude-code" else "subscription"
                e["dailyCap"] = 40
        # S 层两个都可用：codex(订阅) 应先于 claude-code(api)
        plan = router.route(task(), reg)
        self.assertEqual(plan["assignments"][0]["executor"], "codex")

    def test_api_executor_used_only_when_subscription_blocked(self):
        reg = copy.deepcopy(REG)
        for e in reg["executors"]:
            if e["name"] in ("codex", "claude-code"):
                e["verified"] = True
                e["costClass"] = "api" if e["name"] == "claude-code" else "subscription"
        plan = router.route(task(), reg, blocked={"codex": ("2099-01-01T00:00:00+00:00", "quota-exhausted"),
                                                 "antigravity": ("2099-01-01T00:00:00+00:00", "quota-exhausted")})
        # 订阅档全部冷却后，才轮到 API 计费兜底
        self.assertEqual(plan["assignments"][0]["executor"], "claude-code")

    def test_registry_rejects_bad_cost_class(self):
        with self.assertRaises(registry.RegistryError):
            registry.validate({"executors": [{"name": "x", "tier": "S", "costClass": "coupon"}]})


class LocalFirstTests(unittest.TestCase):
    def test_local_model_preferred_over_subscription_in_same_tier(self):
        reg = copy.deepcopy(REG)
        for e in reg["executors"]:
            if e["name"] in ("zhipu-glm", "glm-5.3-flash", "free-pool", "pi"):
                e["verified"] = True
        plan = router.route(task(kind="triage", risk="low", repo=None, acceptance=[]), reg)
        self.assertEqual(plan["assignments"][0]["executor"], "pi")  # local 档最优先
