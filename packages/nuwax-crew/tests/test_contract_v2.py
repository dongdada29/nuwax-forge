import unittest
from crew import contract, registry, router


class ContractV2Tests(unittest.TestCase):
    def test_route_preserves_runtime_evidence_budget_and_argv(self):
        task = {"schemaVersion": 2, "attemptId": "a-1", "taskKey": "task-real", "kind": "review",
                "objective": "verify", "acceptance": ["cache"], "runtime": {"profileId": "local"},
                "budget": {"maxExecutors": 1, "maxWallSeconds": 10, "maxModelRequests": 5},
                "verification": {"manifest": "{artifacts}/verification.json",
                                 "validatorArgv": ["python3", "verify.py", "{worktree}"]}}
        reg = registry.validate({"executors": [{"name": "verified", "tier": "S", "provider": "fixture",
            "verified": True, "roles": ["review"], "dailyCap": 10,
            "invocation": {"argv": ["python3", "executor.py", "{brief}"], "proposed": False}}]})
        plan = router.route(task, reg)
        for key in ("schemaVersion", "attemptId", "runtime", "verification", "budget"):
            self.assertEqual(plan[key], task[key])
        self.assertEqual(plan["taskKey"], "task-real")
        self.assertIsInstance(plan["assignments"][0]["command"], list)

    def test_invalid_or_sensitive_runtime_fields_and_budgets_fail_early(self):
        base = {"taskKey": "task", "kind": "review", "objective": "verify"}
        for patch in ({"runtime": {"apiKey": "fixture-only"}}, {"budget": {"maxWallSeconds": -1}},
                      {"budget": {"maxModelRequests": True}}, {"verification": {"manifest": "x", "validatorArgv": "shell text"}}):
            with self.assertRaises(contract.ContractError):
                contract.validate({**base, **patch})
