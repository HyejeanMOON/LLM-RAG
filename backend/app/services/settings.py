"""检索与切片参数，保存在 SQLite settings 表。"""
from .. import db

DEFAULTS = {
    "chunk_size": 300,      # 每个切片最多多少字符
    "chunk_overlap": 50,    # 相邻切片重叠多少字符
    "top_k": 4,             # 每次检索取几个切片
    "min_score": 0.0,       # 相似度低于它的切片丢弃（0 表示不过滤）
    "history_turns": 3,     # 多轮对话时带上最近几轮问答
    "default_provider_id": None,
}


def get_all() -> dict:
    return {k: db.get_setting(k, v) for k, v in DEFAULTS.items()}


def get(key: str):
    return db.get_setting(key, DEFAULTS[key])


def update(values: dict) -> dict:
    for k, v in values.items():
        if k in DEFAULTS:
            db.set_setting(k, v)
    return get_all()
