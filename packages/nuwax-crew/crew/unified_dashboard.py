"""Compatibility shim for older Crew integrations."""
from .cli import _dashboard_module

_dashboard_module()
from forge_dashboard.sources import *  # noqa: F401,F403,E402
