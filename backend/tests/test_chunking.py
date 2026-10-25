import pytest

from app.chunker import ChunkingParams, chunk_text, recursive_chunks
from app.embeddings import HashEmbedder

DOC = """# 猫
团子是一只橘猫。它今年三岁。它最喜欢吃三文鱼。

它每天睡十六个小时。

# 天气
今天杭州下雨。明天会转晴。气温在二十度左右。
"""


def params(**kw):
    return ChunkingParams(**{"chunk_size": 30, "chunk_overlap": 5, **kw})


@pytest.mark.parametrize("strategy", ["structure", "fixed", "paragraph", "recursive", "semantic"])
def test_every_strategy_respects_size(strategy):
    chunks = chunk_text(DOC, params(strategy=strategy, add_title=False), HashEmbedder())
    assert chunks and all(len(c) <= 30 for c in chunks)
    joined = "".join(chunks)
    for word in ("三文鱼", "十六", "下雨"):
        assert word in joined


def test_structure_strategies_do_not_cross_sections_and_add_titles():
    for s in ("structure", "paragraph", "recursive", "semantic"):
        chunks = chunk_text(DOC, params(strategy=s, chunk_size=200), HashEmbedder())
        assert all(c.startswith(("【猫】", "【天气】")) for c in chunks)
        assert not any("团子" in c and "杭州" in c for c in chunks)


def test_fixed_ignores_structure_and_overlaps():
    chunks = chunk_text("一二三四五六七八九十", params(strategy="fixed", chunk_size=4, chunk_overlap=1))
    assert chunks == ["一二三四", "四五六七", "七八九十"]


def test_paragraph_keeps_paragraphs_whole():
    chunks = chunk_text(DOC, params(strategy="paragraph", chunk_size=100, add_title=False))
    assert chunks[0] == "团子是一只橘猫。它今年三岁。它最喜欢吃三文鱼。\n它每天睡十六个小时。"


def test_recursive_prefers_bigger_separators():
    text = "第一段第一句。第一段第二句。\n\n第二段很短。"
    assert recursive_chunks(text, 20, 0) == ["第一段第一句。第一段第二句。", "第二段很短。"]
    # 段落本身超长时退到句号
    assert recursive_chunks("甲甲甲甲。乙乙乙乙。丙丙丙丙。", 10, 0) == ["甲甲甲甲。乙乙乙乙。", "丙丙丙丙。"]


def test_semantic_splits_where_topic_changes():
    text = "猫猫猫喜欢鱼。猫猫猫喜欢睡。股票市场今天大涨。股票市场成交放量。"
    chunks = chunk_text(text, params(strategy="semantic", chunk_size=200, semantic_percentile=50), HashEmbedder())
    assert chunks == ["猫猫猫喜欢鱼。猫猫猫喜欢睡。", "股票市场今天大涨。股票市场成交放量。"]


def test_per_document_chunking_and_preview(client):
    d = client.post("/api/documents", json={"name": "猫", "content": DOC}).json()
    assert not d["chunking_custom"] and d["chunking"]["strategy"] == "structure"

    pv = client.post("/api/documents/preview-chunks", json={"doc_id": d["id"], "chunking": {"strategy": "fixed", "chunk_size": 20, "chunk_overlap": 0}}).json()
    assert pv["stats"]["max_len"] <= 20 and pv["stats"]["count"] == len(pv["chunks"])
    # 预览不改变已入库的切片
    before = client.get(f"/api/documents/{d['id']}/chunks").json()
    assert before[0]["text"].startswith("【猫】")

    d2 = client.put(f"/api/documents/{d['id']}", json={"chunking": {"strategy": "fixed", "chunk_size": 20, "chunk_overlap": 0}}).json()
    assert d2["chunking_custom"] and d2["chunking"]["strategy"] == "fixed" and d2["chunk_count"] == pv["stats"]["count"]
    listed = next(x for x in client.get("/api/documents").json() if x["id"] == d["id"])
    assert listed["chunking_strategy"] == "fixed" and listed["chunking_custom"]

    # 全局默认改变 + 重建索引不影响单独设置的文档
    client.put("/api/settings", json={"chunking": {"strategy": "paragraph"}})
    client.post("/api/documents/reindex")
    assert client.get(f"/api/documents/{d['id']}").json()["chunking"]["strategy"] == "fixed"

    d3 = client.put(f"/api/documents/{d['id']}", json={"use_default_chunking": True}).json()
    assert not d3["chunking_custom"] and d3["chunking"]["strategy"] == "paragraph"


def test_preview_rejects_bad_params(client):
    r = client.post("/api/documents/preview-chunks", json={"content": "abc", "chunking": {"chunk_size": 50, "chunk_overlap": 60}})
    assert r.status_code == 422
    r = client.post("/api/documents/preview-chunks", json={"content": "abc", "chunking": {"chunk_overlap": 600}})
    assert r.status_code == 400
