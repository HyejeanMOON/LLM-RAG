"""检索与切片参数，保存在 SQLite settings 表。"""
from .. import db
from ..retrieval import RetrievalParams

DEFAULTS = {
    "chunk_size": 300,      # 每个切片最多多少字符
    "chunk_overlap": 50,    # 相邻切片重叠多少字符
    "retrieval": RetrievalParams().to_dict(),  # 问答默认使用的检索策略
    "history_turns": 3,     # 多轮对话时带上最近几轮问答
    "default_provider_id": None,
}


def get_all() -> dict:
    values = {k: db.get_setting(k, v) for k, v in DEFAULTS.items()}
    # 合并默认值，以后 RetrievalParams 加了新字段，旧数据也能用
    values["retrieval"] = {**DEFAULTS["retrieval"], **(values["retrieval"] or {})}
    return values


def retrieval_params(overrides: dict | None = None) -> RetrievalParams:
    known = RetrievalParams.__dataclass_fields__
    merged = {**get_all()["retrieval"], **(overrides or {})}
    return RetrievalParams(**{k: v for k, v in merged.items() if k in known})


def get(key: str):
    return get_all()[key] if key == "retrieval" else db.get_setting(key, DEFAULTS[key])


def update(values: dict) -> dict:
    for k, v in values.items():
        if k in DEFAULTS:
            db.set_setting(k, v)
    return get_all()
