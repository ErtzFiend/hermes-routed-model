"""routed-model — agent-side half of the Desktop status-bar chip.

The capture is NOT here on purpose. It lives in a ``post_api_request`` shell hook
(``config.yaml`` -> ``agent-hooks/routed-model.py``) so it:

  * runs on every surface that builds an agent (CLI, gateway, desktop, cron)
    without depending on this plugin being imported;
  * survives ``hermes update``, a plugin reload, and a profile that never enabled
    the plugin;
  * is a readable standalone script rather than a hidden in-process callback.

The other halves: ``dashboard/plugin_api.py`` serves the captured state at
``/api/plugins/routed-model/latest``, and ``desktop/plugin.js`` is the chip the
Desktop app loads from its own ``desktop-plugins/`` root.

This module exists only to make the package a valid agent plugin: the loader
logs ``Failed to load plugin 'routed-model': No __init__.py`` on every discovery
run when a directory under ``plugins/`` has no Python module, and that warning
repeats per session in a busy gateway. It registers nothing — a second capture
path would race the shell hook for the same state file.
"""

from __future__ import annotations

from typing import Any

__all__ = ["register"]


def register(ctx: Any) -> None:
    """No-op: declared so the package loads cleanly (see the module docstring)."""
    return None
