"""Structured worker delivery references shared with the dashboard."""
import re
from urllib.parse import urlsplit


def _text(value):
    return value if isinstance(value, str) and value.strip() else None


def delivery_fields(*sources):
    """Accept only explicit structured delivery references, never parse free text."""
    result = {}
    for source in sources:
        if not isinstance(source, dict):
            continue
        nested = source.get('delivery') if isinstance(source.get('delivery'), dict) else {}
        for data in (source, nested):
            commit = _text(data.get('commit'))
            branch = _text(data.get('branch'))
            pr = _text(data.get('prUrl')) or _text(data.get('pullRequestUrl'))
            if commit and re.fullmatch(r'[a-fA-F0-9]{7,64}', commit): result['commit'] = commit
            if branch and len(branch) <= 255 and not any(ord(c) < 32 for c in branch): result['branch'] = branch
            if pr and len(pr) <= 2048 and not any(ord(c) < 32 for c in pr):
                try:
                    url = urlsplit(pr)
                    if url.scheme in ('https', 'http') and url.hostname and not url.username and not url.password:
                        result['prUrl'] = pr
                except ValueError:
                    pass
    return result
