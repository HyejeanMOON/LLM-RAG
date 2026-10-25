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
