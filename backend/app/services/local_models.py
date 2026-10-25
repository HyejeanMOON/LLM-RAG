"""发现本机运行的模型服务（Ollama / LM Studio / llama.cpp / vLLM…），列出已经装好的模型。

这些服务都提供 OpenAI 兼容的 /v1/models 和 /v1/chat/completions，所以添加时接口类型选“OpenAI 兼容”即可。
Ollama 另外有 /api/tags，能拿到模型大小、参数量、量化方式，这里优先用它。
"""
import os
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit, urlunsplit

import httpx

# 常见本地服务的默认端口（8000 是本项目自己，vLLM 请手动填地址）
KNOWN = [
    ("Ollama", 11434),
    ("LM Studio", 1234),
    ("llama.cpp", 8080),
]
TIMEOUT = 1.5


def in_docker() -> bool:
    return os.path.exists("/.dockerenv")


def _hosts() -> list[str]:
    # 在 Docker 容器里，localhost 是容器自己，宿主机要用 host.docker.internal
    return ["host.docker.internal", "localhost"] if in_docker() else ["localhost", "host.docker.internal"]


def _root(base_url: str) -> str:
    """http://x:11434/v1 → http://x:11434"""
    u = urlsplit(base_url.rstrip("/"))
    path = u.path[:-3] if u.path.endswith("/v1") else u.path
    return urlunsplit((u.scheme, u.netloc, path, "", ""))


def _ollama_models(client: httpx.Client, root: str) -> list[dict] | None:
    try:
        r = client.get(root + "/api/tags")
        if r.status_code != 200 or "models" not in r.json():
            return None
    except (httpx.HTTPError, ValueError):
        return None
    out = []
    for m in r.json()["models"]:
        d = m.get("details") or {}
        out.append({
            "id": m.get("model") or m.get("name"),
            "size_gb": round(m["size"] / 1e9, 1) if m.get("size") else None,
            "parameter_size": d.get("parameter_size"),
            "quantization": d.get("quantization_level"),
            "family": d.get("family"),
        })
    return out


def _openai_models(client: httpx.Client, base_url: str) -> list[dict] | None:
    try:
        r = client.get(base_url.rstrip("/") + "/models")
        if r.status_code != 200:
            return None
        data = r.json().get("data")
    except (httpx.HTTPError, ValueError, AttributeError):
        return None
    if not isinstance(data, list):
        return None
    return [{"id": m["id"]} for m in data if isinstance(m, dict) and m.get("id")]


def probe(base_url: str, server: str | None = None) -> dict | None:
    """探测一个地址；不通返回 None。base_url 是 OpenAI 兼容地址（通常以 /v1 结尾）。"""
    base_url = base_url.rstrip("/")
    if not base_url.endswith("/v1") and server in {n for n, _ in KNOWN}:
        base_url += "/v1"
    with httpx.Client(timeout=TIMEOUT, trust_env=False) as client:  # 本地地址不走代理
        models = _ollama_models(client, _root(base_url))
        if models is not None:
            return {"server": "Ollama", "base_url": base_url if base_url.endswith("/v1") else base_url + "/v1", "models": models}
        models = _openai_models(client, base_url)
        if models is not None:
            return {"server": server or "OpenAI 兼容", "base_url": base_url, "models": models}
    return None


def discover(base_url: str | None = None) -> dict:
    if base_url:
        targets = [(None, base_url)]
    else:
        targets = [(name, f"http://{h}:{port}/v1") for h in _hosts() for name, port in KNOWN]
    with ThreadPoolExecutor(max_workers=len(targets)) as ex:
        results = list(ex.map(lambda t: probe(t[1], t[0]), targets))
    found, seen = [], set()
    for r in results:
        # localhost 和 host.docker.internal 可能是同一个服务，按 (服务, 端口, 模型) 去重
        if r:
            key = (r["server"], urlsplit(r["base_url"]).port, tuple(m["id"] for m in r["models"]))
            if key not in seen:
                seen.add(key)
                found.append(r)
    return {"in_docker": in_docker(), "servers": found, "tried": [u for _, u in targets]}
