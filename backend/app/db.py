"""SQLite：保存文档原文、LLM 提供商配置和全局设置。

向量只存在 Chroma 里；文档原文保存在这里，这样修改文档、换 embedding 模型时
都能从原文重新切片、重建索引。
"""
import json
import sqlite3
import threading
from contextlib import contextmanager

from . import config

_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    content     TEXT NOT NULL,
    file_type   TEXT NOT NULL,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    chunking    TEXT,                   -- 这篇文档单独的切分策略(JSON)，NULL 表示用全局默认
    tags        TEXT NOT NULL DEFAULT '',  -- 逗号分隔的标签，用于检索时按元数据过滤
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS providers (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL,           -- anthropic | openai
    base_url   TEXT NOT NULL DEFAULT '',
    api_key    TEXT NOT NULL DEFAULT '',
    model      TEXT NOT NULL,
    extra      TEXT NOT NULL DEFAULT '{}',  -- JSON，例如 {"effort": "medium"}
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- 评测：测试集、题目、评测任务、每题结果
CREATE TABLE IF NOT EXISTS eval_sets (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS eval_items (
    id               TEXT PRIMARY KEY,
    set_id           TEXT NOT NULL,
    position         INTEGER NOT NULL,
    question         TEXT NOT NULL,
    reference_answer TEXT NOT NULL DEFAULT '',
    evidence         TEXT NOT NULL DEFAULT '[]',  -- JSON：能回答问题的原文片段
    answerable       INTEGER NOT NULL DEFAULT 1,  -- 0 表示文档里没有答案，期望模型拒答
    source           TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS eval_runs (
    id          TEXT PRIMARY KEY,
    set_id      TEXT NOT NULL,
    name        TEXT NOT NULL,
    config      TEXT NOT NULL,             -- JSON：模型、裁判、指标、参数覆盖、实际生效的参数
    status      TEXT NOT NULL,             -- running | done | failed | cancelled | interrupted
    done        INTEGER NOT NULL DEFAULT 0,
    total       INTEGER NOT NULL DEFAULT 0,
    error       TEXT NOT NULL DEFAULT '',
    summary     TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL,
    finished_at TEXT
);
CREATE TABLE IF NOT EXISTS eval_results (
    run_id   TEXT NOT NULL,
    item_id  TEXT NOT NULL,
    position INTEGER NOT NULL,
    data     TEXT NOT NULL,                -- JSON：回答、检索结果、各指标分数和裁判细节
    PRIMARY KEY (run_id, item_id)
);
"""


def _connect() -> sqlite3.Connection:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


@contextmanager
def tx():
    """串行化写操作，简单可靠（单用户场景足够）。"""
    with _lock:
        conn = _connect()
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()


def init():
    with tx() as conn:
        conn.executescript(SCHEMA)
        # 旧版本数据库没有 chunking 列，补上
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(documents)")}
        if "chunking" not in cols:
            conn.execute("ALTER TABLE documents ADD COLUMN chunking TEXT")
        if "tags" not in cols:
            conn.execute("ALTER TABLE documents ADD COLUMN tags TEXT NOT NULL DEFAULT ''")


def get_setting(key: str, default=None):
    with tx() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default


def set_setting(key: str, value):
    with tx() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value, ensure_ascii=False)),
        )
