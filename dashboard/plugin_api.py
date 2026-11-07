"""Backend for the `routed-model` plugin: read back the model a route actually served.

The capture happens in a `post_api_request` shell hook
(``$HERMES_HOME/agent-hooks/routed-model.py``), which writes

    $HERMES_HOME/state/routed-model/sessions/<session_id>.json
    $HERMES_HOME/state/routed-model/last.json

Routes mount under ``/api/plugins/routed-model/``:

    GET /latest?session_id=<id>&profile=<name>   last captured call + this
                                                 session's model mix
    GET /health                                  state dir + freshness

``model_mix`` exists because an `auto` route can re-pick per call: a 6-minute
agentic chat served by six different models is a fact about the session, not
about the latest call, and the latest call alone hides it.

Nothing here calls a model or the network: it reads the hook's state files.
"""

from __future__ import annotations

import json
import os
import re
import time
from collections import Counter
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter

router = APIRouter()

_SAFE = re.compile(r"^[A-Za-z0-9_.\-]{1,120}$")
_HISTORY_TAIL = 12
_MIX_TOP = 8


def _hermes_home(profile: Optional[str] = None) -> Path:
    home = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
    if profile and profile not in ("default", "") and _SAFE.match(profile):
        candidate = home / "profiles" / profile
        if candidate.is_dir():
            return candidate
    return home


def _state_root(profile: Optional[str] = None) -> Path:
    return _hermes_home(profile) / "state" / "routed-model"


def _read_json(path: Path) -> Optional[dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _mix(history: list[dict[str, Any]]) -> list[list[Any]]:
    """``[[model, calls], …]`` most-used first — the route's per-call rotation."""
    counts = Counter(str(h.get("served_model") or "") for h in history)
    counts.pop("", None)
    return [[model, n] for model, n in counts.most_common(_MIX_TOP)]


def _tail(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for h in history[-_HISTORY_TAIL:]:
        out.append({
            "iso": h.get("iso"),
            "requested_model": h.get("requested_model"),
            "served_model": h.get("served_model"),
            "serving_provider": h.get("serving_provider"),
            "api_call_count": h.get("api_call_count"),
        })
    return out


def _payload(profile: Optional[str], session_id: Optional[str]) -> dict:
    root = _state_root(profile)
    entry = None
    source = None
    calls = None
    history: list[dict[str, Any]] = []
    if session_id and _SAFE.match(session_id):
        session = _read_json(root / "sessions" / f"{session_id}.json")
        if session:
            entry = session.get("last") if isinstance(session.get("last"), dict) else None
            calls = session.get("calls")
            raw = session.get("history")
            history = [h for h in raw if isinstance(h, dict)] if isinstance(raw, list) else []
            source = "session"
    if entry is None:
        entry = _read_json(root / "last.json")
        source = "last" if entry else None
        history = []
    age = None
    if entry and isinstance(entry.get("ts"), (int, float)) and entry["ts"] is not None:
        age = max(0.0, time.time() - float(entry["ts"]))
    mix = _mix(history)
    return {
        "ok": True,
        "source": source,
        "session_id": session_id or "",
        "calls_in_session": calls,
        "models_in_session": len(mix) or None,
        "model_mix": mix,
        "history": _tail(history),
        "age_seconds": age,
        "entry": entry or {},
    }


@router.get("/latest")
async def latest(session_id: Optional[str] = None, profile: Optional[str] = None) -> dict:
    """Last captured API call — for `session_id` when known, else the newest overall."""
    return _payload(profile, session_id)


@router.get("/health")
async def health(profile: Optional[str] = None) -> dict:
    root = _state_root(profile)
    sessions = root / "sessions"
    return {
        "ok": True,
        "state_root": str(root),
        "state_root_exists": root.is_dir(),
        "sessions_tracked": len(list(sessions.glob("*.json"))) if sessions.is_dir() else 0,
        "last_write": _read_json(root / "last.json") is not None,
    }
