"""Bridge between the agent and a local Needle model (cactus-needle).

The agent is Node; Needle is a Python package over a native engine. This
process keeps one Python interpreter and the loaded engine alive for a whole
agent run, and answers one JSON request per line on stdin with one JSON reply
per line on stdout.

Requests:
    {"id": 1, "op": "hello"}
    {"id": 2, "op": "warm"}
    {"id": 3, "op": "extract", "name": "...", "description": "...",
     "schema": {...JSON schema...}, "text": "...", "maxNewTokens": 256}
    {"id": 4, "op": "shutdown"}

Every reply carries the request's id and "ok". A failure is a reply with
"ok": false and an "error", never a crash: the agent treats a dead bridge as
"extraction unavailable" and carries on without it, so a message is worth more
than a traceback.

Only stdout carries the protocol. Anything else that writes to stdout - the
engine, a warning, a download progress bar - is redirected to stderr first,
because one stray line would desynchronise the reader.
"""

import json
import os
import sys

_protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
sys.stdout = sys.stderr

# Usage counts are on by default in the engine. Nothing here needs them, and
# the text being read is someone's project, so they are off unless the person
# running the agent has said otherwise.
os.environ.setdefault("NEEDLE_TELEMETRY", "0")
os.environ.setdefault("DO_NOT_TRACK", "1")

_needle = None
_import_error = None
try:
    import needle as _needle  # noqa: E402
except Exception as exc:  # ImportError, or a broken native dependency
    _import_error = "%s: %s" % (type(exc).__name__, exc)

_WEIGHTS = os.environ.get("CLOSENI_NEEDLE_WEIGHTS") or None
_agents = {}


def _version():
    try:
        from importlib.metadata import version
        return version("cactus-needle")
    except Exception:
        return getattr(_needle, "__version__", "unknown")


def _agent_for(tool):
    # One agent per schema. Constructing one binds the schema's grammar, so
    # reusing it across the steps of a plan is the difference between one bind
    # and twenty. stateless: every extraction is independent - a previous
    # step's text must never leak into the next step's fields.
    key = json.dumps(tool, sort_keys=True)
    agent = _agents.get(key)
    if agent is None:
        kwargs = {"tools": [tool], "auto_date": False, "stateless": True}
        if _WEIGHTS:
            kwargs["weights"] = _WEIGHTS
        agent = _needle.Needle(**kwargs)
        _agents[key] = agent
    return agent


def _extract(req):
    schema = req.get("schema")
    if not isinstance(schema, dict):
        return {"ok": False, "error": "schema must be a JSON object"}
    tool = {
        "name": str(req.get("name") or "record"),
        "description": str(req.get("description") or ""),
        "parameters": schema,
    }
    text = str(req.get("text") or "")
    max_new = int(req.get("maxNewTokens") or 256)
    response = _agent_for(tool).complete(text, max_new_tokens=max_new)

    calls = response.get("function_calls") or []
    held = response.get("suppressed_calls") or []
    # The record as the only tool, read the way needle.extract reads it: a
    # call the engine withheld is still the model's best reading, but it is
    # reported as withheld so the caller can refuse to act on it.
    chosen = calls[0] if calls else (held[0] if held else None)
    validation = response.get("validation") or {}
    return {
        "ok": True,
        "found": chosen is not None,
        "arguments": (chosen or {}).get("arguments") or {},
        "withheld": not calls and bool(held),
        "confidence": response.get("confidence"),
        "reasoning": response.get("reasoning") or "",
        "ungrounded": list(validation.get("ungrounded") or []),
    }


def _handle(req):
    op = req.get("op")
    if op == "hello":
        if _needle is None:
            return {"ok": False, "error": "cactus-needle is not importable from %s (%s). "
                    "Install it with: %s -m pip install cactus-needle"
                    % (sys.executable, _import_error, sys.executable)}
        return {"ok": True, "version": _version(), "python": sys.executable,
                "weights": _WEIGHTS or "base"}
    if _needle is None:
        return {"ok": False, "error": "cactus-needle is not installed"}
    if op == "warm":
        # The engine and weights are fetched on first use. Doing that here, on
        # request, keeps a 35 MB download out of the middle of a build.
        _agent_for({"name": "ping", "description": "Ping.",
                    "parameters": {"type": "object", "properties": {}}})
        return {"ok": True}
    if op == "extract":
        return _extract(req)
    return {"ok": False, "error": "unknown op: %r" % (op,)}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError as exc:
            _protocol.write(json.dumps({"id": None, "ok": False, "error": "bad request: %s" % exc}) + "\n")
            continue
        if req.get("op") == "shutdown":
            _protocol.write(json.dumps({"id": req.get("id"), "ok": True}) + "\n")
            break
        try:
            reply = _handle(req)
        except Exception as exc:
            reply = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}
        reply["id"] = req.get("id")
        _protocol.write(json.dumps(reply, ensure_ascii=False) + "\n")
    for agent in _agents.values():
        try:
            agent.close()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
