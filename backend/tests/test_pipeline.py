import json

import pytest

from app.context import ContextParams, assemble


def _hit(i, score, doc="d"):
    return {"doc_id": doc, "doc_name": doc, "index": i, "text": f"片段{i}", "score": score, "scores": {}}


def _chunks(doc_id):
    return [{"index": i, "text": f"片段{i}"} for i in range(10)]


def test_context_neighbors_merge_and_order():
    hits = [_hit(5, 0.9), _hit(1, 0.8), _hit(6, 0.7)]
    blocks, info = assemble(hits, ContextParams(neighbor_window=1), _chunks)
    assert [b["indexes"] for b in blocks] == [[4, 5, 6, 7], [0, 1, 2]]  # 5 和 6 的范围合并
    assert blocks[0]["hit_indexes"] == [5, 6]
    blocks, _ = assemble(hits, ContextParams(order="document", neighbor_window=1), _chunks)
    assert [b["index"] for b in blocks] == [0, 4]


def test_context_edges_order_and_budget():
    hits = [_hit(i, 1 - i / 10) for i in (0, 2, 4, 6, 8)]
    blocks, _ = assemble(hits, ContextParams(order="edges"), _chunks)
    assert [b["index"] for b in blocks] == [0, 4, 8, 6, 2]   # 最相关的在两头
    blocks, info = assemble(hits, ContextParams(max_chars=7), _chunks)
    assert len(blocks) == 2 and info["dropped"] == 3 and info["chars"] == 6


class FakeLLM:
    """根据系统提示词判断是哪种调用，返回固定内容，并记录收到的消息。"""
    calls = []

    def __init__(self, cfg):
        self.cfg = cfg

    def stream(self, system, messages):
        FakeLLM.calls.append((system, messages, self.cfg))
        if "改写成一个不依赖上下文" in system:
            yield "出差住在北京每晚最多能报销多少？"
        elif "检索查询" in system:
            yield "1. 北京出差住宿报销上限\n2. 北京酒店每晚报销标准"
        elif "假想" in system or "知识库文档里" in system:
            yield "一线城市（北京、上海）每晚住宿不超过 650 元。"
        else:
            yield "回答"


@pytest.fixture()
def fake_llm(monkeypatch):
    FakeLLM.calls = []
    monkeypatch.setattr("app.services.rag.create_llm", FakeLLM)
    monkeypatch.setattr("app.query.create_llm", FakeLLM)
    return FakeLLM


def _events(text):
    out = {}
    for block in text.strip().split("\n\n"):
        lines = dict(l.split(": ", 1) for l in block.splitlines())
        out.setdefault(lines["event"], []).append(json.loads(lines["data"]))
    return out


def test_query_rewriting_trace(client, fake_llm):
    client.put("/api/settings", json={"query": {"condense_history": True, "multi_query": True, "multi_query_n": 2, "hyde": True}})
    ev = _events(client.post("/api/chat", json={
        "query": "那北京呢？",
        "history": [{"role": "user", "content": "上海住宿能报多少"}, {"role": "assistant", "content": "650 元 [1]"}],
    }).text)
    trace = ev["trace"][0]
    assert trace["condensed_query"] == "出差住在北京每晚最多能报销多少？"
    assert trace["multi_queries"] == ["北京出差住宿报销上限", "北京酒店每晚报销标准"]
    assert "650" in trace["hyde_text"]
    assert len(trace["retrieval"]["per_query"]) == 3
    assert "multi_query_rrf" in ev["sources"][0][0]["scores"]
    # 最终提示词：带上历史，用户消息里是原问题
    msgs = trace["prompt"]["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant", "user"] and msgs[-1]["content"].endswith("问题：那北京呢？")
    # 改写类调用用低 effort
    assert fake_llm.calls[0][2].extra["effort"] == "low"


def test_generation_templates_and_params(client, fake_llm):
    r = client.put("/api/settings", json={"generation": {"user_template": "没有占位符"}})
    assert r.status_code == 422
    client.put("/api/settings", json={
        "generation": {"system_prompt": "你是测试助手", "user_template": "Q={question}\n{sources}", "source_template": "[{id}]{text}", "effort": "high", "temperature": 0.3},
        "context": {"neighbor_window": 1},
    })
    ev = _events(client.post("/api/chat", json={"query": "年假"}).text)
    system, messages, cfg = fake_llm.calls[-1]
    assert system == "你是测试助手"
    assert messages[-1]["content"].startswith("Q=年假\n[1]")
    assert cfg.extra["effort"] == "high" and "temperature" not in cfg.extra   # Claude 不传 temperature
    assert ev["trace"][0]["context"]["neighbor_window"] == 1
    assert len(ev["sources"][0][0]["indexes"]) >= 2
    # 清空
    client.put("/api/settings", json={"generation": {"effort": "", "temperature": -1}})
    g = client.get("/api/settings").json()["generation"]
    assert g["effort"] is None and g["temperature"] is None
    assert client.post("/api/settings/generation/reset").json()["generation"]["system_prompt"].startswith("你是一个基于检索资料")


def test_metadata_filters(client):
    a = client.post("/api/documents", json={"name": "a", "content": "班车八点发车。", "tags": ["行政", "交通"]}).json()
    b = client.post("/api/documents", json={"name": "b", "content": "班车九点发车。", "tags": ["旧版"]}).json()
    assert a["tags"] == ["行政", "交通"]
    assert client.get("/api/documents/tags").json() == ["交通", "旧版", "行政"]
    hits = client.post("/api/search", json={"query": "班车", "tags": ["交通"], "retrieval": {"top_k": 10}}).json()
    assert {h["doc_name"] for h in hits} == {"a"}
    hits = client.post("/api/search", json={"query": "班车", "date_to": "2000-01-01"}).json()
    assert hits == []
    # 只改标签不重新切片
    b2 = client.put(f"/api/documents/{b['id']}", json={"tags": ["交通"]}).json()
    assert b2["tags"] == ["交通"] and b2["chunk_count"] == b["chunk_count"]
    hits = client.post("/api/search", json={"query": "班车", "tags": ["交通"], "retrieval": {"top_k": 10}}).json()
    assert {h["doc_name"] for h in hits} == {"a", "b"}


def test_index_params_need_reindex_and_hnsw(client):
    assert client.get("/api/health").json()["needs_reindex"] is False
    client.put("/api/settings", json={"index": {"max_neighbors": 8, "ef_search": 20}})
    h = client.get("/api/health").json()
    assert h["needs_reindex"] is True and h["chunks"] == 0
    client.post("/api/documents/reindex")
    assert client.get("/api/health").json()["needs_reindex"] is False
    res = client.post("/api/search/compare", json={"query": "班车几点发车", "strategies": [
        {"index": "exact"}, {"index": "hnsw", "ann_candidates": 3},
    ]}).json()
    assert res[0]["searched"] == 9 and res[1]["searched"] <= 6
    assert res[0]["hits"][0]["index"] == res[1]["hits"][0]["index"]


def test_delete_purges_other_collections(client):
    d = client.post("/api/documents", json={"name": "x", "content": "独角兽在月亮上吃火锅。"}).json()
    client.put("/api/settings", json={"index": {"ef_search": 33}})
    client.post("/api/documents/reindex")
    client.delete(f"/api/documents/{d['id']}")
    client.put("/api/settings", json={"index": {"ef_search": 100}})   # 切回原来的集合
    hits = client.post("/api/search", json={"query": "独角兽吃火锅", "retrieval": {"top_k": 20}}).json()
    assert all(h["doc_id"] != d["id"] for h in hits)
    assert client.get("/api/health").json()["needs_reindex"] is False


def test_embedding_settings_and_lab(client):
    r = client.post("/api/embedding/test", json={"texts": ["猫喜欢吃鱼", "猫爱吃鱼", "今天股市大涨"]}).json()
    assert r["dim"] == 1024 and len(r["similarity"]) == 3
    assert r["similarity"][0][1] > r["similarity"][0][2]
    assert client.put("/api/settings", json={"embedding": {"backend": "openai"}}).status_code == 400
    assert any(m["model"] == "BAAI/bge-small-zh-v1.5" for m in client.get("/api/embedding/models").json())
