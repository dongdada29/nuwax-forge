import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("im_mentions", Path(__file__).resolve().parents[1] / "skills/nuwax-stack/scripts/im_mentions.py")
im = importlib.util.module_from_spec(spec)
spec.loader.exec_module(im)


class MentionTests(unittest.TestCase):
    def setUp(self):
        self.profile = {"runtime": {"baseUrl": "https://example.test", "agentId": 30},
                        "handoff": {"sourceGroupId": "233790311912964096", "structuredMentionUserId": 20, "agentSubjectId": 40}}
        self.message = {"convId": "233790311912964096", "msgId": "238133239070326784", "seq": 2,
                        "senderId": 10, "senderType": 1, "msgStatus": 1,
                        "mentionUserIds": [20], "mentionAll": False, "body": {"text": "处理这个问题"}}

    def page(self, messages):
        return {"code": "0000", "data": {"list": messages, "hasMore": False, "nextSeq": None}}

    def test_structured_mention_and_replay_have_same_task_identity(self):
        a = im.select(self.profile, self.page([self.message]), 0)
        b = im.select(self.profile, self.page([copy.deepcopy(self.message)]), 0)
        self.assertEqual(a, b)
        self.assertEqual(a["candidates"][0]["msgId"], "238133239070326784")
        self.assertEqual(a["afterSeq"], 2)
        self.assertEqual(im.select(self.profile, self.page([self.message]), 2)["candidates"], [])

    def test_text_all_bot_withdrawal_and_own_echo_do_not_trigger(self):
        changes = [{"mentionUserIds": [], "body": {"text": "引用 @罗东"}},
                   {"mentionUserIds": [], "mentionAll": True}, {"senderType": 2},
                   {"msgStatus": 2}, {"senderId": 40}]
        for change in changes:
            with self.subTest(change=change):
                self.assertFalse(im.select(self.profile, self.page([{**self.message, **change}]), 0)["candidates"])

    def test_registered_extra_mention_target_is_claimed_and_unlisted_is_ignored(self):
        p = copy.deepcopy(self.profile)
        p["handoff"]["structuredMentionUserIds"] = [50]
        agent_direct = {**self.message, "mentionUserIds": [50]}
        self.assertEqual(im.select(p, self.page([agent_direct]), 0)["candidates"][0]["msgId"], self.message["msgId"])
        self.assertEqual(im.select(self.profile, self.page([agent_direct]), 0)["candidates"], [])
        self.assertFalse(im.select(p, self.page([{**self.message, "mentionUserIds": [60]}]), 0)["candidates"])

    def test_registered_extra_target_config_is_validated(self):
        for bad in ["50", 50, {"id": 50}]:
            with self.subTest(bad=bad):
                p = copy.deepcopy(self.profile)
                p["handoff"]["structuredMentionUserIds"] = bad
                with self.assertRaises(ValueError):
                    im.select(p, self.page([self.message]), 0)

    def test_other_origin_group_or_agent_never_shares_task_key(self):
        first = im.select(self.profile, self.page([self.message]), 0)["candidates"][0]["taskId"]
        for field, value in [("baseUrl", "https://other.test"), ("agentId", 31)]:
            p = copy.deepcopy(self.profile); p["runtime"][field] = value
            self.assertNotEqual(first, im.select(p, self.page([self.message]), 0)["candidates"][0]["taskId"])
        with self.assertRaises(ValueError):
            im.select(self.profile, self.page([{**self.message, "convId": "99"}]), 0)

    def test_lost_precision_or_missing_metadata_is_rejected(self):
        for patch in [{"msgId": float(self.message["msgId"])}, {"mentionUserIds": None}, {"seq": 2.0}]:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                im.select(self.profile, self.page([{**self.message, **patch}]), 0)

    def test_broken_pagination_or_failed_business_response_never_yields_cursor(self):
        p = self.page([self.message]); p["data"].update(hasMore=True, nextSeq=3)
        with self.assertRaises(ValueError): im.select(self.profile, p, 0)
        p["data"]["nextSeq"] = 2
        self.assertEqual(im.select(self.profile, p, 0)["nextSeq"], 2)
        p["code"] = "4030"
        with self.assertRaises(ValueError): im.select(self.profile, p, 0)
        with self.assertRaises(ValueError): im.select(self.profile, self.page([{**self.message, "seq": 3}, self.message]), 0)


if __name__ == "__main__":
    unittest.main()
