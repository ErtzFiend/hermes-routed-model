# Routed Model Plugin

Expose which model a routed request actually served in the Hermes Desktop status bar and dashboard. Requested aliases are not proof of the underlying served model; missing provider metadata remains unknown.

## Components

- `agent-hooks/routed-model.py`: captures `post_api_request` metadata into `$HERMES_HOME/state/routed-model/`.
- `dashboard/plugin_api.py`: exposes `/api/plugins/routed-model/latest` and `/health`.
- `desktop/plugin.js`: session-aware status-bar chip plus a settings page with polling controls, staleness threshold, captured-call details, and backend error reporting.

## Installation

1. Install the package into `$HERMES_HOME/plugins/routed-model/` using Hermes's plugin installer or a reviewed checkout.
2. Copy `agent-hooks/routed-model.py` into `$HERMES_HOME/agent-hooks/routed-model.py` and make it executable on Unix.
3. Configure the shell hook in `config.yaml`:

   ```yaml
   hooks:
     post_api_request:
       - command: agent-hooks/routed-model.py
         timeout: 20
   ```

4. Enable the plugin and start a new agent session as required by your Hermes version. The dashboard discovers the packaged API router. Desktop also needs the package's desktop half on the machine running the native app.

## Missing status-bar chip with a remote backend

Backend installation and native Desktop installation are separate. An enabled backend plugin does not prove that the desktop component exists on the computer running the app. A remote-backend availability label is not, by itself, evidence of an API or SDK failure.

Check the native app's Hermes home for `desktop-plugins/routed-model/plugin.js`. If it is missing, install the reviewed package on the desktop host too, or restore its `desktop/plugin.js` into that directory. Use the desktop host's actual Hermes home, not the remote server's home; the two can differ. Preserve and review an existing desktop copy before replacing it.

The native app normally reconciles unified packages into its app-level `desktop-plugins/` folder. Hermes also added server-side reconciliation for Webapp/headless-host loading in [upstream PR #145853](https://github.com/NousResearch/hermes-agent/pull/145853). That server-side behavior does not establish that a different native desktop machine has the file installed.

The app may hot-reload disk plugins; if it does not, reopen Hermes. In the plugin's settings page, verify the chip is enabled and inspect the captured-call readout. The chip intentionally hides when disabled or when no eligible capture is available. Verify the backend hook is recording the focused session before treating an empty chip as a rendering defect.

## Tests

```bash
python -m unittest discover -s tests -v
node --test tests/plugin.test.mjs
```

The Node tests import the actual packaged desktop module with SDK/React stubs and exercise contribution registration, settings persistence, captured-call readout, error reporting, and the disabled chip. They are behavioral unit tests, not proof that a native app loaded the plugin or that a live provider reported a served model.

## Compatibility

Uses `@hermes/plugin-sdk`, React, the SDK REST bridge, storage, settings contributions, and clipboard API. The backend uses Python 3.10+ and FastAPI; the hook uses the standard library. The plugin makes no external model requests itself.

## License

MIT License. Copyright (c) 2026 ErtzFiend.
