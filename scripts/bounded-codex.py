#!/usr/bin/env python3
"""Compatibility wrapper; installed runtime owns the supervisor implementation."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'packages/cli/lib/client_workflow'))
from bounded import *
if __name__ == '__main__':
    raise SystemExit(main())
