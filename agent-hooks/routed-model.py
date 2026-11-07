#!/usr/bin/env python3
"""Record which model a routing provider ACTUALLY served for each Hermes API call.

Fired as a `post_api_request` shell hook. With `openrouter/auto` (or any alias /
fallback route) the requested model id is a placeholder; the provider's answer
carries the real one:

  * `extra.response_model` / `extra.response.model` — the canonical id that ran
    (streamed chunks' `model` field, e.g. "deepseek/deepseek-v4.1-flash")
  * `extra.response.upstream_provider`             — who served it ("BaseTen")

State (read back by the `routed-model` plugin's `/api/plugins/routed-model/latest`
route and shown in the Desktop status bar):

  $HERMES_HOME/state/routed-model/sessions/<session_id>.json   last call per session
  $HERMES_HOME/state/routed-model/last.json                    newest call, any session
  $HERMES_HOME/logs/routed-model.log                           one line per call

Deterministic, stdlib only, never raises: a hook must not disturb a turn.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

_HISTORY_CAP = 40


def _home() -> Path:
    env = os.environ.get("HERMES_HOME")
    return Path(env) if env else Path.home() / ".hermes"


def _atomic_write(path: Path, data: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=1, default=str), encoding="utf-8")
    os.replace(tmp, path)


def _log(line: str) -> None:
    try:
        log = _home() / "logs" / "routed-model.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        pass


def build_entry(payload: dict) -> dict:
    extra = payload.get("extra") if isinstance(payload.get("extra"), dict) else {}
    resp = extra.get("response") if isinstance(extra.get("response"), dict) else {}
    requested = str(extra.get("model") or "")
    served = str(extra.get("response_model") or resp.get("model") or "")
    return {
        "ts": time.time(),
        "iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "session_id": str(payload.get("session_id") or ""),
        "profile": str(payload.get("profile") or ""),
        "requested_model": requested,
        "served_model": served,
        "serving_provider": str(resp.get("upstream_provider") or ""),
        "provider": str(extra.get("provider") or ""),
        "base_url": str(extra.get("base_url") or ""),
        "api_call_count": extra.get("api_call_count"),
        "finish_reason": str(extra.get("finish_reason") or ""),
        "platform": str(extra.get("platform") or ""),
        # True when the route picked something other than what was asked for.
        "routed": bool(served and requested and served != requested),
    }


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        if not isinstance(payload, dict):
            return 0
        entry = build_entry(payload)
        if not entry["served_model"] and not entry["requested_model"]:
            return 0
        root = _home() / "state" / "routed-model"
        (root / "sessions").mkdir(parents=True, exist_ok=True)

        sid = entry["session_id"] or "unscoped"
        safe = "".join(c for c in sid if c.isalnum() or c in "-_.") or "unscoped"
        session_path = root / "sessions" / f"{safe}.json"

        try:
            prior = json.loads(session_path.read_text(encoding="utf-8"))
        except Exception:
            prior = {}
        history = prior.get("history") if isinstance(prior.get("history"), list) else []
        history.append(entry)
        _atomic_write(session_path, {
            "session_id": entry["session_id"],
            "updated_ts": entry["ts"],
            "last": entry,
            "calls": len(history),
            "history": history[-_HISTORY_CAP:],
        })
        _atomic_write(root / "last.json", entry)
        _log(f"{entry['iso']} session={entry['session_id']} requested={entry['requested_model']} "
             f"served={entry['served_model']} provider={entry['serving_provider']} "
             f"call={entry['api_call_count']}")
    except Exception as exc:  # a hook must never break a turn
        _log(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} ERROR {exc!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
