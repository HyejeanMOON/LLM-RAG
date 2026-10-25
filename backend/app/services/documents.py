"""文档的增删改查：原文进 SQLite，切片向量进 Chroma。"""
import uuid
from datetime import datetime, timezone

from .. import db
from ..chunker import chunk_text
from ..store import get_store
from . import settings


class NotFound(LookupError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _row(r, with_content=False) -> dict:
    d = dict(r)
    if not with_content:
        d.pop("content", None)
    return d


def _index(doc_id: str, name: str, content: str) -> int:
    chunks = chunk_text(content, settings.get("chunk_size"), settings.get("chunk_overlap"))
    get_store().replace_document(doc_id, name, chunks)
    return len(chunks)


def list_documents() -> list[dict]:
    with db.tx() as conn:
        rows = conn.execute(
            "SELECT id, name, file_type, chunk_count, length(content) AS char_count, created_at, updated_at "
            "FROM documents ORDER BY updated_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def get_document(doc_id: str) -> dict:
    with db.tx() as conn:
        r = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
    if not r:
        raise NotFound(doc_id)
    d = _row(r, with_content=True)
    d["char_count"] = len(d["content"])
    return d


def create_document(name: str, content: str, file_type: str = "md") -> dict:
    doc_id = uuid.uuid4().hex[:12]
    count = _index(doc_id, name, content)
    now = _now()
    with db.tx() as conn:
        conn.execute(
            "INSERT INTO documents (id, name, content, file_type, chunk_count, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (doc_id, name, content, file_type, count, now, now),
        )
    return get_document(doc_id)


def update_document(doc_id: str, name: str | None = None, content: str | None = None) -> dict:
    doc = get_document(doc_id)
    name = name if name is not None else doc["name"]
    content = content if content is not None else doc["content"]
    # 内容或名称变了都重新切片（名称存在切片元数据里，回答时用来标注来源）
    count = _index(doc_id, name, content)
    with db.tx() as conn:
        conn.execute(
            "UPDATE documents SET name = ?, content = ?, chunk_count = ?, updated_at = ? WHERE id = ?",
            (name, content, count, _now(), doc_id),
        )
    return get_document(doc_id)


def delete_document(doc_id: str):
    get_document(doc_id)
    get_store().delete_document(doc_id)
    with db.tx() as conn:
        conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))


def get_chunks(doc_id: str) -> list[dict]:
    get_document(doc_id)
    return get_store().get_chunks(doc_id)


def reindex_all() -> dict:
    """切片参数或 embedding 模型变化后，从原文重建整个向量库。"""
    store = get_store()
    store.reset()
    with db.tx() as conn:
        rows = conn.execute("SELECT id, name, content FROM documents").fetchall()
    for r in rows:
        count = _index(r["id"], r["name"], r["content"])
        with db.tx() as conn:
            conn.execute("UPDATE documents SET chunk_count = ? WHERE id = ?", (count, r["id"]))
    return {"documents": len(rows), "chunks": store.count()}
