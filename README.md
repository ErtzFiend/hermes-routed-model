# Routed Model Plugin

Expose which model the active route (e.g. `openrouter/auto`) actually served, for the Hermes Desktop status bar and dashboard.

## Overview

When using fallback or auto-routed providers (`openrouter/auto`, alias routes, etc.), the requested model ID is often a placeholder. The upstream provider responds with the canonical model ID and serving provider (e.g. BaseTen, Nvidia).

This standalone plugin package provides three integrated layers:
1. **Agent Shell Hook (`agent-hooks/routed-model.py`)**: Fired on `post_api_request`, recording per-call metadata into `$HERMES_HOME/state/routed-model/`.
2. **Backend API (`dashboard/plugin_api.py`)**: FastAPI router serving `/api/plugins/routed-model/latest` and `/health`, computing model mix per session and recent history tails.
3. **Desktop Status Bar Chip (`desktop/plugin.js`)**: Real-time status bar indicator (`⇄ auto → deepseek/deepseek-v4.1-flash`) with session-aware polling, stale checking, detail tooltips, and click-to-copy functionality.

## Integration & Cutover Instructions

1. **Install Plugin**: Place `routed-model` directory into `$HERMES_HOME/plugins/` (or install via archive).
2. **Install Hook**: Copy `agent-hooks/routed-model.py` to `$HERMES_HOME/agent-hooks/routed-model.py` (make executable: `chmod +x`).
3. **Configure Hook in `config.yaml`** (using the supported hooks schema):
   ```yaml
   hooks:
     post_api_request:
       - command: agent-hooks/routed-model.py
         timeout: 20
   ```
4. **Dashboard & Desktop**: The FastAPI router is auto-discovered under plugins API mount, and Desktop loads `desktop/plugin.js` from plugins root.

## SDK Compatibility & Limits

- **Desktop Plugin SDK**: Uses `@hermes/plugin-sdk` (`host`, `useValue`, `ctx.rest`, `ctx.os.writeClipboard`). Requires Desktop app supporting plugin v0.1+ runtime.
- **Backend**: Python 3.10+, FastAPI, stdlib only for the hook.
- **Network**: Zero external calls; reads local session/last state files atomically.

## License

MIT License.
Copyright (c) 2026 Jacob Hodge / Hermes Agent.
