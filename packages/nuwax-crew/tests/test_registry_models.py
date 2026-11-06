import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from crew import registry  # noqa: E402


def reg_with(models) -> dict:
    return {"executors": [{"name": "x", "tier": "B", "roles": ["triage"], "verified": True,
                           "costClass": "subscription", "models": models}]}


class ModelsDeclarationTest(unittest.TestCase):
    def test_example_registry_loads_with_models(self):
        reg = registry.load(ROOT / "registry.example.json")
        by_name = {e["name"]: e for e in reg["executors"]}
        self.assertEqual(len(by_name["free-pool"]["models"]), 6)
        self.assertTrue(all(m["class"] == "light" for m in by_name["free-pool"]["models"]))
        self.assertEqual([m["id"] for m in by_name["opencode"]["models"]],
                         ["glm-4.7-flash", "glm-4.7"])
        self.assertEqual([m["class"] for m in by_name["deepseek"]["models"]],
                         ["light", "heavy"])

    def test_missing_models_normalizes_empty(self):
        reg = registry.validate(reg_with(None))
        self.assertEqual(reg["executors"][0]["models"], [])

    def test_object_entries_validated(self):
        reg = registry.validate(reg_with([{"id": "m1", "class": "light", "contextK": 128,
                                           "verified": True, "evidence": "实跑"}]))
        m = reg["executors"][0]["models"][0]
        self.assertEqual(m, {"id": "m1", "class": "light", "contextK": 128,
                             "verified": True, "evidence": "实跑"})

    def test_class_optional_means_undeclared(self):
        reg = registry.validate(reg_with([{"id": "m1"}]))
        self.assertEqual(reg["executors"][0]["models"][0]["class"], "")

    def test_string_shorthand_is_id_only(self):
        reg = registry.validate(reg_with(["legacy-id", {"id": "m2", "class": "standard"}]))
        models = reg["executors"][0]["models"]
        self.assertEqual(models[0], {"id": "legacy-id", "class": "", "contextK": None,
                                     "verified": False, "evidence": ""})
        self.assertEqual(models[1]["class"], "standard")

    def test_rejects_bad_shapes(self):
        for bad, msg in [
            ({"notalist": 1}, "必须是数组"),
            ([42], "必须是对象或字符串"),
            ([{"class": "light"}], "必填且非空"),
            ([{"id": "m"}, {"id": "m"}], "重名"),
            ([{"id": "m", "class": "turbo"}], "class 只能是"),
            ([{"id": "m", "contextK": 0}], "contextK 必须是正整数"),
            ([{"id": "m", "verified": "yes"}], "verified 必须是布尔"),
        ]:
            with self.assertRaises(registry.RegistryError, msg=msg):
                registry.validate({"executors": [{"name": "x", "tier": "B", "roles": [],
                                                  "verified": True, "models": bad}]})

    def test_router_ignores_models_in_v0(self):
        # 路由行为不变：同一任务带不带 models 的注册表，路由结果一致
        from crew import router
        task = {"taskKey": "t", "kind": "triage", "risk": "low", "objective": "只读"}
        a = router.route(task, registry.validate(reg_with([{"id": "m", "class": "light"}])))
        b = router.route(task, registry.validate(reg_with(None)))
        self.assertEqual([x["executor"] for x in a["assignments"]],
                         [x["executor"] for x in b["assignments"]])


if __name__ == "__main__":
    unittest.main()
