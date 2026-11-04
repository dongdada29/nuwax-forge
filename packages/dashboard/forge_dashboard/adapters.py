"""Explicit source adapters. Registration is in-process; no automatic plugin loading."""
from . import sources
from .personal_agent import read_snapshot


class AdapterRegistry:
    def __init__(self):
        self._adapters = {}

    def register(self, name, read):
        if not isinstance(name, str) or not name or name in self._adapters or not callable(read):
            raise ValueError('invalid-or-duplicate-dashboard-adapter')
        self._adapters[name] = read

    def read(self, name, value):
        if name not in self._adapters:
            raise ValueError(f'unknown-dashboard-adapter: {name}')
        return self._adapters[name](value)


def default_adapters():
    registry = AdapterRegistry()
    registry.register('crew', sources.crew_records)
    registry.register('stack', sources.task_store_records)
    registry.register('host-guard', sources.host_guard_records)
    registry.register('forge-agent', sources.agent_state_record)
    registry.register('personal-agent', read_snapshot)
    return registry
