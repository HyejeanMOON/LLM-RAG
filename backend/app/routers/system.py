import time

import numpy as np
from fastapi import APIRouter, HTTPException

from ..embeddings import FASTEMBED_MODELS, get_embedder
from ..i18n import get_lang, t
from ..schemas import EmbeddingOptions, EmbeddingTest, SettingsUpdate
from ..services import documents, settings

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/health")
def health():
    try:
        store = settings.current_store()
    except Exception as e:  # 例如 embedding 模型下载失败
        return {"status": "error", "message": t(f"向量模型加载失败：{e}", f"Failed to load the embedding model: {e}"), "documents": len(documents.list_documents())}
    expected = documents.expected_chunks()
    return {
        "status": "ok",
        "embedder": store.embedder.name,
        "documents": len(documents.list_documents()),
        "chunks": store.count(),
        # 当前向量集合里的切片数和文档表对不上，说明换过 embedding 模型或索引参数，需要重建
        "needs_reindex": store.count() != expected,
    }


@router.get("/settings")
def get_settings():
    return settings.get_all()


@router.get("/settings/defaults")
def get_defaults():
    return settings.defaults()


@router.post("/settings/{section}/reset")
def reset_section(section: str):
    if section not in settings.SECTIONS:
        raise HTTPException(404, t("没有这个设置分组", "No such settings section"))
    return settings.reset_section(section)


@router.put("/settings")
def update_settings(body: SettingsUpdate):
    values = body.model_dump(exclude_none=True)
    current = settings.get_all()
    c = {**current["chunking"], **values.get("chunking", {})}
    if c["chunk_overlap"] >= c["chunk_size"]:
        raise HTTPException(400, t("重叠长度必须小于切片长度", "Overlap must be smaller than the chunk size"))
    g = values.get("generation")
    if g:
        # 0 / 负数 / 空字符串 表示“清空，使用模型配置里的值”
        if g.get("max_tokens") == 0:
            g["max_tokens"] = None
        if g.get("temperature") is not None and g["temperature"] < 0:
            g["temperature"] = None
        if g.get("effort") == "":
            g["effort"] = None
    if "embedding" in values:
        merged = {**current["embedding"], **values["embedding"]}
        if merged["backend"] == "openai" and not merged.get("provider_id"):
            raise HTTPException(400, t("使用 OpenAI 兼容向量接口时需要选择一个模型配置（提供地址和 Key）", "The OpenAI-compatible embedding backend needs a model config (for its endpoint and key)"))
    return settings.update(values)


@router.get("/embedding/models")
def embedding_models():
    if get_lang() == "en":
        return [{**m, "lang": m["lang_en"], "note": m["note_en"]} for m in FASTEMBED_MODELS]
    return FASTEMBED_MODELS


@router.post("/embedding/test")
def embedding_test(body: EmbeddingTest, backend: str | None = None, model: str | None = None, provider_id: str | None = None):
    """向量化实验：把几句话向量化，返回维度、耗时和两两余弦相似度。可以临时指定别的模型对比。"""
    overrides = EmbeddingOptions(backend=backend, model=model, provider_id=provider_id).model_dump(exclude_none=True)
    try:
        embedder = get_embedder(settings.embedding_config(overrides))
        start = time.perf_counter()
        vecs = np.asarray(embedder.embed_documents(body.texts), dtype=np.float32)
        elapsed = (time.perf_counter() - start) * 1000
    except Exception as e:
        raise HTTPException(400, t(f"向量化失败：{e}", f"Embedding failed: {e}"))
    norms = np.linalg.norm(vecs, axis=1)
    unit = vecs / np.maximum(norms[:, None], 1e-12)
    return {
        "embedder": embedder.name,
        "dim": int(vecs.shape[1]),
        "elapsed_ms": round(elapsed, 1),
        "norms": [round(float(n), 4) for n in norms],
        "similarity": np.round(unit @ unit.T, 4).tolist(),
        "preview": [[round(float(x), 4) for x in v[:8]] for v in vecs],
    }
