import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from app.services import local_models


def _serve(routes: dict):
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            body = routes.get(self.path)
            self.send_response(200 if body is not None else 404)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(body or {"error": "not found"}).encode())

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


@pytest.fixture
def ollama():
    srv = _serve({
        "/api/tags": {"models": [{
            "name": "gemma4:e4b", "model": "gemma4:e4b", "size": 9_600_000_000,
            "details": {"family": "gemma4", "parameter_size": "8.0B", "quantization_level": "Q4_K_M"},
        }]},
    })
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


@pytest.fixture
def lmstudio():
    srv = _serve({"/v1/models": {"object": "list", "data": [{"id": "google/gemma-4-e4b", "object": "model"}]}})
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


def test_discover_ollama_reads_tags(ollama):
    r = local_models.discover(ollama + "/v1")
    [s] = r["servers"]
    assert s["server"] == "Ollama"
    assert s["base_url"] == ollama + "/v1"
    assert s["models"][0] == {
        "id": "gemma4:e4b", "size_gb": 9.6, "parameter_size": "8.0B", "quantization": "Q4_K_M", "family": "gemma4",
    }


def test_discover_ollama_without_v1_suffix(ollama):
    [s] = local_models.discover(ollama)["servers"]
    assert s["base_url"] == ollama + "/v1"


def test_discover_openai_compatible_models(lmstudio):
    [s] = local_models.discover(lmstudio + "/v1")["servers"]
    assert s["models"] == [{"id": "google/gemma-4-e4b"}]


def test_discover_nothing_running():
    r = local_models.discover("http://127.0.0.1:9/v1")
    assert r["servers"] == []


def test_discover_endpoint(client, ollama):
    r = client.get("/api/providers/local/discover", params={"base_url": ollama + "/v1"})
    assert r.status_code == 200
    assert r.json()["servers"][0]["models"][0]["id"] == "gemma4:e4b"


def test_local_connection_error_hint():
    from app.llm.openai_provider import _connection_hint
    assert "ollama serve" in _connection_hint("http://localhost:11434/v1")
    assert "ollama" not in _connection_hint("https://api.deepseek.com")
