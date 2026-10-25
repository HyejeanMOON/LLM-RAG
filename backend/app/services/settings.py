"""检索与切片参数，保存在 SQLite settings 表。"""
from .. import db
from ..chunker import ChunkingParams
from ..retrieval import RetrievalParams

DEFAULTS = {
    "chunking": ChunkingParams().to_dict(),    # 全局默认切分策略（文档可以单独覆盖）
    "retrieval": RetrievalParams().to_dict(),  # 问答默认使用的检索策略
    "history_turns": 3,     # 多轮对话时带上最近几轮问答
    "default_provider_id": None,
}


def get_all() -> dict:
    values = {k: db.get_setting(k, v) for k, v in DEFAULTS.items()}
    # 合并默认值，以后加了新字段，旧数据也能用
    for key in ("retrieval", "chunking"):
        values[key] = {**DEFAULTS[key], **(values[key] or {})}
    return values


def chunking_params(overrides: dict | None = None) -> ChunkingParams:
    return ChunkingParams.from_dict({**get_all()["chunking"], **(overrides or {})})


def retrieval_params(overrides: dict | None = None) -> RetrievalParams:
    known = RetrievalParams.__dataclass_fields__
    merged = {**get_all()["retrieval"], **(overrides or {})}
    return RetrievalParams(**{k: v for k, v in merged.items() if k in known})


def get(key: str):
    return get_all()[key] if key in ("retrieval", "chunking") else db.get_setting(key, DEFAULTS[key])


def update(values: dict) -> dict:
    for k, v in values.items():
        if k in DEFAULTS:
            db.set_setting(k, v)
    return get_all()
