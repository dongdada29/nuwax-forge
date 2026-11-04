"""Synthetic local manifests; these tests never dispatch a worker or model."""
import copy
import json
from pathlib import Path
import socket
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT.parent / 'nuwax-crew'))
from forge_dashboard.sources import agent_state_record, summarize
from forge_dashboard.task_views import render_workbench
from forge_dashboard.workbench import build_workbench


class AgentBudgetObservationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / 'run-<untrusted>'
        self.state.mkdir()
        self.manifest = {'kind': 'client-agent-run-v1', 'taskKey': 'budget-<script>',
                         'modelDispatched': True, 'status': 'failed', 'usageKnown': False,
                         'chargedTokens': None, 'finishedAt': '2026-11-04T03:00:00Z',
                         'observedBudget': {'reportedTokensLowerBound': 25050, 'maxTokens': 20000,
                                            'verdict': 'exceeds'}}
        self.request = {'taskKey': self.manifest['taskKey'], 'budget': {'maxTokens': 20000},
                        'runtime': {'kind': 'codex', 'model': 'fixture'}}

    def load(self):
        for name, value in [('manifest', self.manifest), ('request', self.request)]:
            (self.state / (name + '.json')).write_text(json.dumps(value))
        return agent_state_record(self.state)

    def page(self, record):
        return render_workbench(build_workbench([record]))

    def test_proven_excess_visible_while_full_settlement_stays_unknown(self):
        record = self.load()
        page = self.page(record)
        self.assertIsNone(record['tokens'])
        self.assertEqual(record['observedBudget']['verdict'], 'exceeds')
        for expected in ('已报告 token 下界：25050', '预算上限：20000', '已证实超限', '完整结算 token：unknown'):
            self.assertIn(expected, page)
        group = summarize([record])[0]
        self.assertEqual((group['knownTokens'], group['knownCount'], group['unknownTokens']), (0, 0, 1))

    def test_low_or_equal_partial_bound_never_means_budget_passed(self):
        for lower in (0, 110, 20000, None):
            self.manifest['observedBudget'].update(reportedTokensLowerBound=lower, verdict='unknown')
            record = self.load()
            self.assertEqual(record['observedBudget']['verdict'], 'unknown')
            page = self.page(record)
            self.assertIn('部分报告不能证明预算达标', page)
            self.assertIn('完整结算 token：unknown', page)
            self.assertNotIn('已证实超限', page)
            self.assertIsNone(record['tokens'])

    def test_legacy_manifest_keeps_settled_totals_without_new_observation(self):
        del self.manifest['observedBudget']
        for known, charged, expected in [(True, 88, 88), (False, 88, None), (True, 0, 0)]:
            self.manifest.update(usageKnown=known, chargedTokens=charged)
            record = self.load()
            self.assertEqual(record['tokens'], expected)
            self.assertIsNone(record['observedBudget'])
            self.assertNotIn('本次运行的预算观察', self.page(record))

    def test_full_known_usage_not_added_to_partial_bound_again(self):
        self.manifest.update(usageKnown=True, chargedTokens=30000)
        record = self.load()
        self.assertEqual(record['observedBudget']['reportedTokensLowerBound'], 25050)
        self.assertEqual(summarize([record])[0]['knownTokens'], 30000)
        self.assertIn('完整结算 token：30000', self.page(record))

    def test_malformed_negative_boolean_string_and_unsafe_counts_fail_closed(self):
        original = copy.deepcopy(self.manifest['observedBudget'])
        for field in ('reportedTokensLowerBound', 'maxTokens'):
            for value in (-1, True, '25050', 1.5, 9007199254740992, [], {}):
                self.manifest['observedBudget'] = {**original, field: value}
                record = self.load()
                self.assertEqual(record['observedBudget']['verdict'], 'unknown', (field, value))
                self.assertIsNone(record['observedBudget']['reportedTokensLowerBound'])
                self.assertIn('观测字段无效或冲突', self.page(record))
                self.assertNotIn('已证实超限', self.page(record))
        for value in (None, [], 'exceeds', True):
            self.manifest['observedBudget'] = value
            self.assertEqual(self.load()['observedBudget']['verdict'], 'unknown')

    def test_verdict_cap_and_settled_total_conflicts_are_not_trusted(self):
        original = copy.deepcopy(self.manifest)
        for verdict in ('within', 'unknown', '<img onerror=bad>', [], True):
            self.manifest = copy.deepcopy(original)
            self.manifest['observedBudget']['verdict'] = verdict
            self.assertEqual(self.load()['observedBudget']['verdict'], 'unknown')
        self.manifest = copy.deepcopy(original)
        self.request['budget']['maxTokens'] = 40000
        self.assertEqual(self.load()['observedBudget']['verdict'], 'unknown')
        for budget in (None, {}, True, '20000', [], {'maxTokens': False}, {'maxTokens': -1}, {'maxTokens': '20000'}):
            self.request['budget'] = budget
            self.assertEqual(self.load()['observedBudget']['verdict'], 'unknown')
        self.request['budget'] = {'maxTokens': 20000}
        self.manifest.update(usageKnown=True, chargedTokens=100)
        record = self.load()
        self.assertEqual(record['observedBudget']['verdict'], 'unknown')
        self.assertIsNone(record['tokens'])
        self.assertIn('完整结算 token：unknown', self.page(record))

    def test_observation_and_run_labels_escape_untrusted_input(self):
        self.manifest['observedBudget']['note'] = '<script>bad()</script>'
        page = self.page(self.load())
        self.assertIn('run-&lt;untrusted&gt;', page)
        self.assertIn('budget-&lt;script&gt;', page)
        self.assertNotIn('<script>', page)
        self.assertNotIn('bad()', page)

    def test_read_only_local_input_unchanged_and_no_db_or_network_access(self):
        self.load()
        before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.state.iterdir()}
        with patch.object(socket, 'socket', side_effect=AssertionError('network')), patch.object(sqlite3, 'connect', side_effect=AssertionError('database')):
            record = agent_state_record(self.state)
            self.page(record)
        self.assertEqual(before, {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.state.iterdir()})

    def test_multiple_same_task_runs_show_separate_budget_observations(self):
        first = self.load()
        second = copy.deepcopy(first)
        second['statePath'] = '/another-run'
        second['observedBudget'] = {'reportedTokensLowerBound': 110, 'maxTokens': 20000, 'verdict': 'unknown', 'issue': ''}
        page = render_workbench(build_workbench([first, second]))
        self.assertEqual(page.count('本次运行的预算观察'), 2)
        self.assertIn('已报告 token 下界：25050', page)
        self.assertIn('已报告 token 下界：110', page)
        self.assertEqual(summarize([first, second])[0]['knownCount'], 0)


if __name__ == '__main__': unittest.main()
