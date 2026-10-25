"""Chroma 向量库：保存每个切片的文本、元数据和向量。

具体怎么检索（余弦 / 点积 / 欧氏、BM25、混合、MMR…）在 retrieval.py 里实现，
这里提供 load_corpus() 把切片和向量一次性取出来并缓存，文档变化时自动失效。
"""
import threading
from functools import lru_cache

import chromadb
import numpy as np

from . import config
from .embeddings import get_embedder


class VectorStore:
    def __init__(self, embedder):
        self.embedder = embedder
        self.client = chromadb.PersistentClient(path=str(config.CHROMA_DIR))
        # 不同 embedding 模型向量维度不同，所以每种模型一个独立的 collection
        safe = "".join(c if c.isalnum() else "_" for c in embedder.name)
        self.collection_name = f"chunks_{safe}"[:60]
        self.collection = self._get_collection()
        self._corpus = None
        self._corpus_lock = threading.Lock()

    def _get_collection(self):
        return self.client.get_or_create_collection(
            name=self.collection_name,
            metadata={"hnsw:space": "cosine", "embedder": self.embedder.name},
        )

    def reset(self):
        self.client.delete_collection(self.collection_name)
        self.collection = self._get_collection()
        self._corpus = None

    def replace_document(self, doc_id: str, doc_name: str, chunks: list[str]):
        """删除文档的旧切片，写入新切片（新增和修改文档都走这里）。"""
        self.delete_document(doc_id)
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

    def count(self) -> int:
        return self.collection.count()


@lru_cache(maxsize=1)
def get_store() -> VectorStore:
    return VectorStore(get_embedder())
