"""Compatibility shim; the dashboard implementation lives in devkit-dashboard."""
from .cli import _dashboard_module

_dashboard_module()
from forge_dashboard.views import *  # noqa: F401,F403,E402
