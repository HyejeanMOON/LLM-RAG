import numpy as np
import pytest

from app import retrieval
from app.retrieval import RetrievalParams, bm25_scores, mmr_select, tokenize


def test_tokenize_mixed():
    assert tokenize("RAG 检索ok") == ["rag", "检", "索", "检索", "ok"]


def test_bm25_prefers_rare_matching_terms():
    docs = ["猫喜欢吃鱼", "狗喜欢啃骨头", "今天天气很好"]
    s = bm25_scores("狗骨头", docs)
    assert s.argmax() == 1 and s[2] == 0


def test_mmr_skips_near_duplicates():
    q = np.array([1.0, 0.0])
    cands = np.array([[1.0, 0.0], [0.99, 0.01], [0.6, 0.8]])
    rel = np.array([1.0, 0.99, 0.6])
    assert mmr_select(q, cands, rel, 2, lam=1.0)[0] == [0, 1]   # 只看相关性
    assert mmr_select(q, cands, rel, 2, lam=0.3)[0] == [0, 2]   # 重视多样性，跳过重复的 1


@pytest.fixture()
def corpus(client):
    for d in client.get("/api/documents").json():  # 去掉示例手册，只留下面三篇
        client.delete(f"/api/documents/{d['id']}")
    for name, text in [
        ("a", "# 宠物\n我家的猫叫团子，今年三岁。"),
        ("a2", "# 宠物\n我家的猫叫团子，今年三岁了。"),
        ("b", "# 交通\n公司班车早上八点从滨和路地铁站发车。"),
    ]:
        client.post("/api/documents", json={"name": name, "content": text})
    return client


@pytest.mark.parametrize("opts", [
    {"method": "vector", "metric": "cosine"},
    {"method": "vector", "metric": "dot"},
    {"method": "vector", "metric": "l2"},
    {"method": "bm25"},
    {"method": "hybrid", "fusion": "rrf"},
    {"method": "hybrid", "fusion": "weighted", "hybrid_alpha": 0.3},
    {"method": "hybrid", "use_mmr": True, "mmr_lambda": 0.5},
])
def test_every_strategy_returns_scores(corpus, opts):
    hits = corpus.post("/api/search", json={"query": "班车几点发车", "retrieval": {**opts, "top_k": 3}}).json()
    assert len(hits) == 3
    assert hits[0]["doc_name"] == "b"
    for key in ("cosine", "dot", "l2", "bm25", "vector_rank", "bm25_rank"):
        assert key in hits[0]["scores"]
    if opts.get("use_mmr"):
        assert "mmr" in hits[0]["scores"]


def test_l2_and_cosine_agree_on_normalized_vectors(corpus):
    q = {"query": "猫几岁"}
    cos = corpus.post("/api/search", json={**q, "retrieval": {"metric": "cosine", "top_k": 5}}).json()
    l2 = corpus.post("/api/search", json={**q, "retrieval": {"metric": "l2", "top_k": 5}}).json()
    assert [(h["doc_id"], h["index"]) for h in cos] == [(h["doc_id"], h["index"]) for h in l2]
    assert cos[0]["score"] == cos[0]["scores"]["cosine"]
    assert l2[0]["score"] == -l2[0]["scores"]["l2"]


def test_mmr_diversifies_duplicate_docs(corpus):
    q = "团子是谁家的猫"
    plain = corpus.post("/api/search", json={"query": q, "retrieval": {"top_k": 2, "method": "bm25"}}).json()
    assert {h["doc_name"] for h in plain} == {"a", "a2"}
    mmr = corpus.post("/api/search", json={"query": q, "retrieval": {"top_k": 2, "method": "bm25", "use_mmr": True, "mmr_lambda": 0.3}}).json()
    assert len({h["doc_name"] for h in mmr} & {"a", "a2"}) == 1


def test_min_score_filters_by_cosine(corpus):
    hits = corpus.post("/api/search", json={"query": "班车", "retrieval": {"top_k": 10, "min_score": 0.99}}).json()
    assert hits == []


def test_rerank_reorders(corpus, monkeypatch):
    # 假的交叉编码器：文本越短分越高
    monkeypatch.setattr(retrieval, "rerank_scores", lambda q, texts: np.array([-len(t) for t in texts], float))
    hits = corpus.post("/api/search", json={"query": "猫", "retrieval": {"use_rerank": True, "top_k": 3}}).json()
    lens = [len(h["text"]) for h in hits]
    assert lens == sorted(lens) and "rerank" in hits[0]["scores"]


def test_compare_endpoint(corpus):
    res = corpus.post("/api/search/compare", json={"query": "班车", "strategies": [
        {"label": "向量", "method": "vector"},
        {"method": "bm25", "top_k": 2},
    ]}).json()
    assert [r["label"] for r in res] == ["向量", "策略 2"]
    assert res[1]["params"]["method"] == "bm25" and len(res[1]["hits"]) == 2
    assert all(r["error"] is None for r in res)


def test_rerank_failure_is_reported(corpus, monkeypatch):
    def boom(q, texts):
        raise RuntimeError("模型下载失败")
    monkeypatch.setattr(retrieval, "rerank_scores", boom)
    res = corpus.post("/api/search/compare", json={"query": "猫", "strategies": [{"use_rerank": True}]}).json()
    assert "模型下载失败" in res[0]["error"]


def test_default_strategy_used_by_chat(corpus, monkeypatch):
    corpus.put("/api/settings", json={"retrieval": {"method": "bm25", "top_k": 2}})
    s = corpus.get("/api/settings").json()["retrieval"]
    assert s["method"] == "bm25" and s["top_k"] == 2 and s["metric"] == "cosine"

    class FakeLLM:
        def __init__(self, cfg):
            pass

        def stream(self, system, messages):
            yield "ok"

    monkeypatch.setattr("app.services.rag.create_llm", FakeLLM)
    import json
    text = corpus.post("/api/chat", json={"query": "班车几点"}).text
    sources = json.loads(text.split("\n\n")[1].split("data: ", 1)[1])
    assert len(sources) == 2 and sources[0]["scores"]["bm25_rank"] == 1
