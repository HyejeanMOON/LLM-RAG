"""Chroma 向量库：保存每个切片的向量，并按余弦相似度检索。"""
from functools import lru_cache

import chromadb

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

    def _get_collection(self):
        return self.client.get_or_create_collection(
            name=self.collection_name,
            metadata={"hnsw:space": "cosine", "embedder": self.embedder.name},
        )

    def reset(self):
        self.client.delete_collection(self.collection_name)
        self.collection = self._get_collection()

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

    def delete_document(self, doc_id: str):
        self.collection.delete(where={"doc_id": doc_id})

    def get_chunks(self, doc_id: str) -> list[dict]:
        res = self.collection.get(where={"doc_id": doc_id}, include=["documents", "metadatas"])
        items = [
            {"index": m["index"], "text": d}
            for d, m in zip(res["documents"], res["metadatas"])
        ]
        return sorted(items, key=lambda x: x["index"])

    def search(self, query: str, top_k: int = 4, doc_ids: list[str] | None = None) -> list[dict]:
        if self.collection.count() == 0:
            return []
        where = None
        if doc_ids:
            where = {"doc_id": doc_ids[0]} if len(doc_ids) == 1 else {"doc_id": {"$in": doc_ids}}
        res = self.collection.query(
            query_embeddings=[self.embedder.embed_query(query)],
            n_results=top_k,
            where=where,
            include=["documents", "metadatas", "distances"],
        )
        return [
            {
                "doc_id": meta["doc_id"],
                "doc_name": meta["doc_name"],
                "index": meta["index"],
                "text": doc,
                "score": round(1 - dist, 4),  # 余弦相似度，越大越相关
            }
            for doc, meta, dist in zip(res["documents"][0], res["metadatas"][0], res["distances"][0])
        ]

    def count(self) -> int:
        return self.collection.count()


@lru_cache(maxsize=1)
def get_store() -> VectorStore:
    return VectorStore(get_embedder())
