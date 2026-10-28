"""Bounded Codex trace accounting. Inactivity is not model latency."""
from datetime import datetime
import json
from pathlib import Path


def _seconds(stamp):
    return datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()


def summarize_codex(trace, rollout=None):
    result = {"userTurns": 0, "modelRequests": None, "toolCalls": None,
              "inputTokens": None, "cachedInputTokens": None, "outputTokens": None,
              "activeSeconds": None, "idleSeconds": None, "openTurn": False}
    thread_id = None
    commands = []
    for line in Path(trace).read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "thread.started":
            thread_id = event.get("thread_id")
        if event.get("type") == "turn.completed":
            result["userTurns"] += 1
        item = event.get("item", {})
        if event.get("type") == "item.completed" and item.get("type") == "command_execution":
            commands.append({"command": item.get("command"), "exitCode": item.get("exit_code")})
    result.update(threadId=thread_id, commands=commands)
    if rollout is None:
        return result
    # Retain only accounting fields, never full messages or tool output.
    events, owner = [], None
    with Path(rollout).open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            try:
                event = json.loads(line)
                payload = event.get("payload") or {}
                stamp = _seconds(event["timestamp"])
            except (ValueError, KeyError):
                continue
            if event.get("type") == "session_meta" and owner is None:
                owner = payload
            events.append((stamp, event.get("type"), payload.get("type"),
                           {k: payload[k] for k in ("started_at", "turn_id", "info") if k in payload}))
    if not events:
        return result
    born = _seconds(owner["timestamp"]) if owner and owner.get("timestamp") else events[0][0]
    live = next((i for i, (stamp, kind, subtype, payload) in enumerate(events)
                 if kind == "event_msg" and subtype == "task_started" and
                 payload.get("started_at", stamp) >= int(born)), None)
    if live is None:
        return result
    active, start, last_usage, baseline, final_usage = 0.0, None, None, None, None
    result["modelRequests"], result["toolCalls"] = 0, 0
    for stamp, kind, subtype, payload in events[live:]:
        if kind == "event_msg" and subtype == "task_started":
            if start is None:
                start = stamp
        elif kind == "event_msg" and subtype in ("task_complete", "turn_aborted"):
            if start is not None:
                active += max(0, stamp - start)
                start = None
        if kind == "response_item" and subtype in ("function_call", "custom_tool_call"):
            result["toolCalls"] += 1
        if kind == "event_msg" and subtype == "token_count" and payload.get("info"):
            info = payload["info"]
            total = info.get("total_token_usage", {})
            local = info.get("last_token_usage", {})
            signature = (total.get("input_tokens", 0), total.get("output_tokens", 0))
            if total and signature != last_usage:
                if baseline is None:
                    baseline = {k: total.get(k, 0) - local.get(k, 0)
                                for k in ("input_tokens", "cached_input_tokens", "output_tokens")}
                result["modelRequests"] += 1
                last_usage, final_usage = signature, total
    if start is not None:
        active += max(0, events[-1][0] - start)
        result["openTurn"] = True
    result["activeSeconds"] = round(active, 3)
    result["idleSeconds"] = round(max(0, events[-1][0] - events[0][0] - active), 3)
    if final_usage is not None:
        for output, key in (("inputTokens", "input_tokens"), ("cachedInputTokens", "cached_input_tokens"),
                            ("outputTokens", "output_tokens")):
            result[output] = max(0, final_usage.get(key, 0) - baseline[key])
    return result
