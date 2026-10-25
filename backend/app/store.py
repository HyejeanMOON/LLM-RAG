"""Chroma 向量库：保存每个切片的文本、元数据和向量。

具体怎么检索（余弦 / 点积 / 欧氏、BM25、混合、MMR…）在 retrieval.py 里实现，
这里提供 load_corpus() 把切片和向量一次性取出来并缓存，文档变化时自动失效。
"""
import hashlib
import json
import threading
from dataclasses import asdict, dataclass
from typing import Literal

import chromadb
import numpy as np

from . import config


@dataclass(frozen=True)
class IndexConfig:
    """Chroma 的 HNSW（分层可导航小世界图）近似最近邻索引参数，修改后需要重建索引。"""
    space: Literal["cosine", "l2", "ip"] = "cosine"  # 建图时用的距离
    max_neighbors: int = 16      # 每个节点最多连几条边（论文里的 M），越大越准、越占内存
    ef_construction: int = 100   # 建图时的候选队列长度，越大图质量越好、建得越慢
    ef_search: int = 100         # 查询时的候选队列长度，越大召回越高、越慢

    def to_dict(self) -> dict:
        return asdict(self)


_client = None
_stores: dict = {}
_stores_lock = threading.Lock()


def _get_client():
    global _client
    if _client is None:
        _client = chromadb.PersistentClient(path=str(config.CHROMA_DIR))
    return _client


class VectorStore:
    def __init__(self, embedder, index: IndexConfig = IndexConfig()):
        self.embedder = embedder
        self.index = index
        self.client = _get_client()
        # 不同 embedding 模型向量维度不同、HNSW 参数不同建出的图也不同，所以各用一个独立的 collection
        safe = "".join(c if c.isalnum() else "_" for c in embedder.name)[:40]
        digest = hashlib.md5(json.dumps(index.to_dict(), sort_keys=True).encode()).hexdigest()[:6]
        self.collection_name = f"chunks_{safe}_{digest}"
        self.collection = self._get_collection()
        self._corpus = None
        self._corpus_lock = threading.Lock()

    def _get_collection(self):
        return self.client.get_or_create_collection(
            name=self.collection_name,
            configuration={"hnsw": self.index.to_dict()},
            metadata={"embedder": self.embedder.name},
        )

    def reset(self):
        self.client.delete_collection(self.collection_name)
        self.collection = self._get_collection()
        self._corpus = None

    def replace_document(self, doc_id: str, doc_name: str, chunks: list[str]):
        """删除文档的旧切片，写入新切片（新增、修改、重建索引都走这里）。只影响当前集合。"""
        self.collection.delete(where={"doc_id": doc_id})
        if not chunks:
            return
        self.collection.add(
            ids=[f"{doc_id}#{i}" for i in range(len(chunks))],
            documents=chunks,
            embeddings=self.embedder.embed_documents(chunks),
            metadatas=[{"doc_id": doc_id, "doc_name": doc_name, "index": i} for i in range(len(chunks))],
        )
        self._corpus = None

    def delete_document(self, doc_id: str):
        self.collection.delete(where={"doc_id": doc_id})
        self._corpus = None
        self.purge_others(doc_id)

    def purge_others(self, doc_id: str):
        """文档被删除或修改后，其他 embedding 模型 / 索引参数的集合里的旧切片也删掉，
        避免切换回去后检索到过时内容（那些集合的切片数会对不上，健康检查会提示重建索引）。"""
        for c in self.client.list_collections():
            name = c if isinstance(c, str) else c.name
            if name != self.collection_name and name.startswith("chunks_"):
                self.client.get_collection(name).delete(where={"doc_id": doc_id})
        with _stores_lock:
            for st in _stores.values():
                if st is not self:
                    st._corpus = None

    def get_chunks(self, doc_id: str) -> list[dict]:
        res = self.collection.get(where={"doc_id": doc_id}, include=["documents", "metadatas"])
        items = [
            {"index": m["index"], "text": d}
            for d, m in zip(res["documents"], res["metadatas"])
        ]
        return sorted(items, key=lambda x: x["index"])

    def load_corpus(self) -> dict:
        """返回全部切片：ids、texts、metas、embeddings(np.ndarray)。有缓存。"""
        with self._corpus_lock:
            if self._corpus is None:
                res = self.collection.get(include=["documents", "metadatas", "embeddings"])
                emb = res["embeddings"]
                dim = len(self.embedder.embed_query("dim"))
                self._corpus = {
                    "ids": res["ids"],
                    "texts": res["documents"],
                    "metas": res["metadatas"],
                    "embeddings": np.asarray(emb, dtype=np.float32) if len(res["ids"]) else np.zeros((0, dim), np.float32),
                }
            return self._corpus

    def ann_search(self, query_vec: list[float], n: int, doc_ids: list[str] | None = None) -> list[str]:
        """用 HNSW 图做近似最近邻检索，返回切片 id。"""
        n = min(n, self.collection.count())
        if n == 0:
            return []
        where = None
        if doc_ids:
            where = {"doc_id": doc_ids[0]} if len(doc_ids) == 1 else {"doc_id": {"$in": doc_ids}}
        res = self.collection.query(query_embeddings=[query_vec], n_results=n, where=where, include=[])
        return res["ids"][0]

    def count(self) -> int:
        return self.collection.count()


def get_store(embedder, index: IndexConfig = IndexConfig()) -> VectorStore:
    key = (embedder.name, index)
    with _stores_lock:
        if key not in _stores:
            _stores[key] = VectorStore(embedder, index)
        return _stores[key]


def clear_cache():
    """测试用：数据目录变了以后丢掉旧的客户端和集合。"""
    global _client
    with _stores_lock:
        _stores.clear()
        _client = None
