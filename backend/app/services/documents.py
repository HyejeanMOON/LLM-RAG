"""文档的增删改查：原文进 SQLite，切片向量进 Chroma。"""
import json
import uuid
from datetime import datetime, timezone

from .. import db
from ..chunker import ChunkingParams, chunk_text
from . import settings


class NotFound(LookupError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _effective_chunking(custom: dict | None) -> ChunkingParams:
    """文档单独设置了切分策略就用它，否则用全局默认。"""
    return ChunkingParams.from_dict(custom) if custom else settings.chunking_params()


def _index(doc_id: str, name: str, content: str, custom: dict | None) -> int:
    store = settings.current_store()
    chunks = chunk_text(content, _effective_chunking(custom), store.embedder)
    store.replace_document(doc_id, name, chunks)
    return len(chunks)


def _custom(raw: str | None) -> dict | None:
    return json.loads(raw) if raw else None


def _tags_out(raw: str) -> list[str]:
    return [t for t in (raw or "").split(",") if t]


def _tags_in(tags: list[str] | None) -> str:
    return ",".join(dict.fromkeys(t.strip().replace(",", " ") for t in tags or [] if t.strip()))


def list_documents() -> list[dict]:
    with db.tx() as conn:
        rows = conn.execute(
            "SELECT id, name, file_type, chunk_count, length(content) AS char_count, chunking, tags, created_at, updated_at "
            "FROM documents ORDER BY updated_at DESC"
        ).fetchall()
    docs = []
    for r in rows:
        d = dict(r)
        custom = _custom(d.pop("chunking"))
        d["chunking_custom"] = custom is not None
        d["chunking_strategy"] = _effective_chunking(custom).strategy
        d["tags"] = _tags_out(d["tags"])
        docs.append(d)
    return docs


def get_document(doc_id: str) -> dict:
    with db.tx() as conn:
        r = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
    if not r:
        raise NotFound(doc_id)
    d = dict(r)
    custom = _custom(d["chunking"])
    d["char_count"] = len(d["content"])
    d["chunking_custom"] = custom is not None
    d["chunking"] = _effective_chunking(custom).to_dict()  # 实际生效的策略
    d["tags"] = _tags_out(d["tags"])
    return d


def create_document(name: str, content: str, file_type: str = "md", chunking: dict | None = None,
                    tags: list[str] | None = None) -> dict:
    doc_id = uuid.uuid4().hex[:12]
    count = _index(doc_id, name, content, chunking)
    now = _now()
    with db.tx() as conn:
        conn.execute(
            "INSERT INTO documents (id, name, content, file_type, chunk_count, chunking, tags, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (doc_id, name, content, file_type, count, json.dumps(chunking) if chunking else None, _tags_in(tags), now, now),
        )
    return get_document(doc_id)


_UNSET = object()


def update_document(doc_id: str, name: str | None = None, content: str | None = None, chunking=_UNSET,
                    tags: list[str] | None = None) -> dict:
    """chunking：不传表示不改；传 None 表示改回全局默认；传 dict 表示这篇文档单独使用该策略。"""
    with db.tx() as conn:
        r = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
    if not r:
        raise NotFound(doc_id)
    name = name if name is not None else r["name"]
    content = content if content is not None else r["content"]
    custom = _custom(r["chunking"]) if chunking is _UNSET else chunking
    tags_raw = r["tags"] if tags is None else _tags_in(tags)
    only_tags = (name == r["name"] and content == r["content"] and custom == _custom(r["chunking"]))
    # 内容、名称、切分策略任一变化都重新切片（名称存在切片元数据里，回答时用来标注来源）；只改标签不用
    count = r["chunk_count"] if only_tags else _index(doc_id, name, content, custom)
    if not only_tags:
        settings.current_store().purge_others(doc_id)
    with db.tx() as conn:
        conn.execute(
            "UPDATE documents SET name = ?, content = ?, chunk_count = ?, chunking = ?, tags = ?, updated_at = ? WHERE id = ?",
            (name, content, count, json.dumps(custom) if custom else None, tags_raw, _now(), doc_id),
        )
    return get_document(doc_id)


def delete_document(doc_id: str):
    get_document(doc_id)
    settings.current_store().delete_document(doc_id)
    with db.tx() as conn:
        conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))


def get_chunks(doc_id: str) -> list[dict]:
    get_document(doc_id)
    return settings.current_store().get_chunks(doc_id)


def all_tags() -> list[str]:
    with db.tx() as conn:
        rows = conn.execute("SELECT tags FROM documents").fetchall()
    return sorted({t for r in rows for t in _tags_out(r["tags"])})


def expected_chunks() -> int:
    with db.tx() as conn:
        return conn.execute("SELECT COALESCE(SUM(chunk_count), 0) FROM documents").fetchone()[0]


def resolve_filter(doc_ids: list[str] | None = None, tags: list[str] | None = None,
                   date_from: str | None = None, date_to: str | None = None) -> list[str] | None:
    """元数据过滤：把“指定文档 / 含任一标签 / 更新日期范围”换算成允许检索的文档 id。
    返回 None 表示不过滤，返回空列表表示没有文档符合条件。"""
    if not (doc_ids or tags or date_from or date_to):
        return None
    sql, args = "SELECT id, tags FROM documents WHERE 1=1", []
    if doc_ids:
        sql += f" AND id IN ({','.join('?' * len(doc_ids))})"
        args += doc_ids
    if date_from:
        sql += " AND substr(updated_at, 1, 10) >= ?"
        args.append(date_from[:10])
    if date_to:
        sql += " AND substr(updated_at, 1, 10) <= ?"
        args.append(date_to[:10])
    with db.tx() as conn:
        rows = conn.execute(sql, args).fetchall()
    wanted = set(tags or [])
    return [r["id"] for r in rows if not wanted or wanted & set(_tags_out(r["tags"]))]


def preview_chunks(content: str, chunking: ChunkingParams) -> dict:
    """只切分不入库，用来在前端预览不同策略的效果。"""
    chunks = chunk_text(content, chunking, settings.current_store().embedder)
    lengths = [len(c) for c in chunks] or [0]
    return {
        "chunks": chunks,
        "stats": {
            "count": len(chunks),
            "avg_len": round(sum(lengths) / len(lengths), 1),
            "min_len": min(lengths),
            "max_len": max(lengths),
        },
    }


def reindex_all() -> dict:
    """全局切分策略或 embedding 模型变化后，从原文重建整个向量库。"""
    store = settings.current_store()
    store.reset()
    with db.tx() as conn:
        rows = conn.execute("SELECT id, name, content, chunking FROM documents").fetchall()
    for r in rows:
        count = _index(r["id"], r["name"], r["content"], _custom(r["chunking"]))
        with db.tx() as conn:
            conn.execute("UPDATE documents SET chunk_count = ? WHERE id = ?", (count, r["id"]))
    return {"documents": len(rows), "chunks": store.count()}
