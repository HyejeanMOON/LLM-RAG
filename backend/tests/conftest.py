import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture()
def client(tmp_path, monkeypatch):
    # 每个测试用独立数据目录 + 离线 hash 向量，不下载模型、不调用真实 LLM
    from app import config, embeddings, retrieval, store

    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "app.db")
    monkeypatch.setattr(config, "CHROMA_DIR", tmp_path / "chroma")
    monkeypatch.setattr(config, "EMBEDDER", "hash")
    embeddings.get_embedder.cache_clear()
    store.clear_cache()

    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as c:
        yield c
    store.clear_cache()
