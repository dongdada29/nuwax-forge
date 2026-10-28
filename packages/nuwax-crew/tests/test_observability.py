import json
import tempfile
import unittest
from pathlib import Path
from crew.observability import summarize_codex


class AccountingTests(unittest.TestCase):
    def test_inherited_counter_duplicate_events_and_idle_are_separate(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            trace, rollout = root / "trace.jsonl", root / "rollout.jsonl"
            trace.write_text(json.dumps({"type": "turn.completed"}))
            events = [
                {"timestamp": "2026-10-27T00:00:00Z", "type": "session_meta",
                 "payload": {"timestamp": "2026-10-27T00:00:00Z", "id": "child"}},
                {"timestamp": "2026-10-27T00:00:00Z", "type": "session_meta",
                 "payload": {"timestamp": "2026-10-26T00:00:00Z", "id": "parent"}},
                {"timestamp": "2026-10-27T00:00:00Z", "type": "event_msg",
                 "payload": {"type": "task_started", "started_at": 0}},
                {"timestamp": "2026-10-27T00:00:10Z", "type": "event_msg", "payload": {"type": "task_started"}},
                {"timestamp": "2026-10-27T00:00:11Z", "type": "event_msg",
                 "payload": {"type": "token_count", "info": {"total_token_usage": {"input_tokens": 10100, "output_tokens": 501},
                                                          "last_token_usage": {"input_tokens": 100, "output_tokens": 1}}}},
                {"timestamp": "2026-10-27T00:00:12Z", "type": "event_msg",
                 "payload": {"type": "token_count", "info": {"total_token_usage": {"input_tokens": 10100, "output_tokens": 501},
                                                          "last_token_usage": {"input_tokens": 100, "output_tokens": 1}}}},
                {"timestamp": "2026-10-27T00:00:20Z", "type": "event_msg", "payload": {"type": "task_complete"}},
                {"timestamp": "2026-10-27T02:00:20Z", "type": "event_msg", "payload": {"type": "user_message"}},
            ]
            rollout.write_text("\n".join(json.dumps(e) for e in events))
            got = summarize_codex(trace, rollout)
            self.assertEqual(got["modelRequests"], 1)
            self.assertEqual(got["inputTokens"], 100)
            self.assertEqual(got["activeSeconds"], 10)
            self.assertEqual(got["idleSeconds"], 7210)

    def test_no_rollout_does_not_invent_model_request_count(self):
        with tempfile.TemporaryDirectory() as temp:
            trace = Path(temp) / "trace"
            trace.write_text(json.dumps({"type": "turn.completed"}))
            got = summarize_codex(trace)
            self.assertEqual(got["userTurns"], 1)
            self.assertIsNone(got["modelRequests"])
