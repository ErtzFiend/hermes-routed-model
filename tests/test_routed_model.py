from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
import io
import concurrent.futures
from pathlib import Path

# Add dashboard dir and agent-hooks dir to path for testing
plugin_dir = Path(__file__).parent.parent
sys.path.insert(0, str(plugin_dir / "dashboard"))
sys.path.insert(0, str(plugin_dir / "agent-hooks"))

import importlib.util
spec = importlib.util.spec_from_file_location("routed_model", plugin_dir / "agent-hooks" / "routed-model.py")
hook = importlib.util.module_from_spec(spec)
sys.modules["routed_model"] = hook
spec.loader.exec_module(hook)

import plugin_api
from fastapi import FastAPI
from fastapi.testclient import TestClient


class TestRoutedModel(unittest.TestCase):

    def test_build_entry_routed(self):
        payload = {
            "session_id": "test-session-123",
            "profile": "default",
            "extra": {
                "model": "openrouter/auto",
                "response_model": "deepseek/deepseek-v4.1-flash",
                "response": {
                    "model": "deepseek/deepseek-v4.1-flash",
                    "upstream_provider": "BaseTen"
                },
                "api_call_count": 1,
                "finish_reason": "stop"
            }
        }
        entry = hook.build_entry(payload)
        self.assertEqual(entry["requested_model"], "openrouter/auto")
        self.assertEqual(entry["served_model"], "deepseek/deepseek-v4.1-flash")
        self.assertEqual(entry["serving_provider"], "BaseTen")
        self.assertTrue(entry["routed"])
        self.assertEqual(entry["session_id"], "test-session-123")
        self.assertEqual(entry["api_call_count"], 1)

    def test_build_entry_unrouted(self):
        payload = {
            "session_id": "sess-456",
            "extra": {
                "model": "gpt-4o",
                "response_model": "gpt-4o",
                "response": {"model": "gpt-4o"}
            }
        }
        entry = hook.build_entry(payload)
        self.assertEqual(entry["requested_model"], "gpt-4o")
        self.assertEqual(entry["served_model"], "gpt-4o")
        self.assertFalse(entry["routed"])

    def test_hook_stdin_execution(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            os.environ["HERMES_HOME"] = str(tmp_path)
            
            payload = {
                "session_id": "stdin-sess-1",
                "extra": {
                    "model": "openrouter/auto",
                    "response_model": "claude-3-5-sonnet",
                    "response": {"model": "claude-3-5-sonnet", "upstream_provider": "Anthropic"}
                }
            }
            
            old_stdin = sys.stdin
            sys.stdin = io.StringIO(json.dumps(payload))
            try:
                ret = hook.main()
                self.assertEqual(ret, 0)
            finally:
                sys.stdin = old_stdin
                
            last_json = tmp_path / "state" / "routed-model" / "last.json"
            self.assertTrue(last_json.exists())
            data = json.loads(last_json.read_text(encoding="utf-8"))
            self.assertEqual(data["served_model"], "claude-3-5-sonnet")

    def test_hook_malformed_and_missing_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            os.environ["HERMES_HOME"] = str(tmp_path)
            
            # Test malformed JSON
            for bad_input in ["not json at all", "[1, 2, 3]", "\"just a string\"", "", "null"]:
                old_stdin = sys.stdin
                sys.stdin = io.StringIO(bad_input)
                try:
                    ret = hook.main()
                    self.assertEqual(ret, 0)
                finally:
                    sys.stdin = old_stdin
                    
            # Test missing metadata / empty dict
            old_stdin = sys.stdin
            sys.stdin = io.StringIO("{}")
            try:
                ret = hook.main()
                self.assertEqual(ret, 0)
            finally:
                sys.stdin = old_stdin

    def test_concurrent_state_updates(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            os.environ["HERMES_HOME"] = str(tmp_path)
            
            def run_hook(i):
                payload = {
                    "session_id": "concurrent-sess",
                    "extra": {
                        "model": "openrouter/auto",
                        "response_model": f"model-{i}",
                        "response": {"model": f"model-{i}", "upstream_provider": f"prov-{i}"},
                        "api_call_count": i
                    }
                }
                old_stdin = sys.stdin
                sys.stdin = io.StringIO(json.dumps(payload))
                try:
                    return hook.main()
                finally:
                    sys.stdin = old_stdin

            with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
                futures = [executor.submit(run_hook, i) for i in range(20)]
                concurrent.futures.wait(futures)

            session_file = tmp_path / "state" / "routed-model" / "sessions" / "concurrent-sess.json"
            self.assertTrue(session_file.exists())
            sess_data = json.loads(session_file.read_text(encoding="utf-8"))
            self.assertGreaterEqual(sess_data["calls"], 1)
            self.assertLessEqual(sess_data["calls"], 20)
            self.assertEqual(len(sess_data["history"]), sess_data["calls"])

    def test_plugin_api_endpoints(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            os.environ["HERMES_HOME"] = str(tmp_path)
            root = tmp_path / "state" / "routed-model"
            sessions = root / "sessions"
            sessions.mkdir(parents=True, exist_ok=True)

            session_data = {
                "session_id": "s-1",
                "updated_ts": 1000.0,
                "calls": 2,
                "last": {
                    "ts": 1000.0,
                    "session_id": "s-1",
                    "requested_model": "openrouter/auto",
                    "served_model": "model-a",
                    "serving_provider": "prov-a",
                    "api_call_count": 2,
                    "routed": True
                },
                "history": [
                    {
                        "ts": 900.0,
                        "session_id": "s-1",
                        "requested_model": "openrouter/auto",
                        "served_model": "model-b",
                        "serving_provider": "prov-b",
                        "api_call_count": 1,
                        "routed": True
                    },
                    {
                        "ts": 1000.0,
                        "session_id": "s-1",
                        "requested_model": "openrouter/auto",
                        "served_model": "model-a",
                        "serving_provider": "prov-a",
                        "api_call_count": 2,
                        "routed": True
                    }
                ]
            }
            (sessions / "s-1.json").write_text(json.dumps(session_data), encoding="utf-8")
            (root / "last.json").write_text(json.dumps(session_data["last"]), encoding="utf-8")

            app = FastAPI()
            app.include_router(plugin_api.router, prefix="/api/plugins/routed-model")
            client = TestClient(app)

            # Test /latest with session_id
            resp = client.get("/api/plugins/routed-model/latest?session_id=s-1")
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertTrue(data["ok"])
            self.assertEqual(data["source"], "session")
            self.assertEqual(data["calls_in_session"], 2)
            self.assertEqual(data["entry"]["served_model"], "model-a")
            self.assertEqual(len(data["model_mix"]), 2)

            # Test /latest without session_id (fallback to last.json)
            resp = client.get("/api/plugins/routed-model/latest")
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data["source"], "last")

            # Test /health
            resp = client.get("/api/plugins/routed-model/health")
            self.assertEqual(resp.status_code, 200)
            health_data = resp.json()
            self.assertTrue(health_data["ok"])
            self.assertEqual(health_data["sessions_tracked"], 1)
            self.assertTrue(health_data["last_write"])


if __name__ == "__main__":
    unittest.main()
