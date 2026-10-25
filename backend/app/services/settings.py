"""RAG 流程每个环节的参数，保存在 SQLite settings 表，前端“RAG 流程”页面修改。

每个环节一个分组（section），对应一个 dataclass：
  chunking 切分 / embedding 向量化 / index 向量索引 / query 问题处理 /
  retrieval 检索 / context 上下文组装 / generation 生成
"""
from dataclasses import asdict, dataclass, fields

from .. import config, db
from ..chunker import ChunkingParams
from ..context import ContextParams
from ..embeddings import EmbeddingConfig, get_embedder
from ..query import QueryParams
from ..retrieval import RetrievalParams
from ..store import IndexConfig, get_store

DEFAULT_SYSTEM_PROMPT = """你是一个基于检索资料回答问题的助手。
用户消息中会给出若干编号的参考片段（<source id="N">），请只依据这些片段回答问题：
- 在用到某个片段的句子后标注来源，例如 [1] 或 [2][3]。
- 如果片段中没有足够的信息回答问题，请直接说明“资料中没有找到相关信息”，不要编造。
- 默认使用与用户提问相同的语言回答。"""


@dataclass
class GenerationParams:
    system_prompt: str = DEFAULT_SYSTEM_PROMPT
    # 用户消息模板：{sources} 换成拼好的参考片段，{question} 换成问题
    user_template: str = "<sources>\n{sources}\n</sources>\n\n问题：{question}"
    # 每个片段的模板：可用 {id} {doc_name} {text} {score}
    source_template: str = '<source id="{id}" file="{doc_name}">\n{text}\n</source>'
    max_tokens: int | None = None      # 为空则用模型配置里的值
    temperature: float | None = None   # 只对 OpenAI 兼容接口生效（新版 Claude 不接受 temperature）
    effort: str | None = None          # 只对 Claude 生效：low / medium / high

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class EmbeddingSettings:
    backend: str = "fastembed"
    model: str = "BAAI/bge-small-zh-v1.5"
    provider_id: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


SECTIONS = {
    "chunking": ChunkingParams,
    "embedding": EmbeddingSettings,
    "index": IndexConfig,
    "query": QueryParams,
    "retrieval": RetrievalParams,
    "context": ContextParams,
    "generation": GenerationParams,
}
FLAT_DEFAULTS = {"default_provider_id": None}


def _section_defaults(name: str) -> dict:
    if name == "embedding":  # 默认值来自环境变量，便于离线测试
        return EmbeddingSettings(backend=config.EMBEDDER, model=config.EMBED_MODEL).to_dict()
    return SECTIONS[name]().to_dict()


def get_all() -> dict:
    values = {k: db.get_setting(k, v) for k, v in FLAT_DEFAULTS.items()}
    for name in SECTIONS:
        # 合并默认值，以后加了新字段，旧数据也能用
        values[name] = {**_section_defaults(name), **(db.get_setting(name) or {})}
    return values


def defaults() -> dict:
    return {name: _section_defaults(name) for name in SECTIONS}


def section(name: str, overrides: dict | None = None):
    cls = SECTIONS[name]
    known = {f.name for f in fields(cls)}
    merged = {**get_all()[name], **(overrides or {})}
    return cls(**{k: v for k, v in merged.items() if k in known})


def chunking_params(overrides: dict | None = None) -> ChunkingParams:
    return section("chunking", overrides)


def retrieval_params(overrides: dict | None = None) -> RetrievalParams:
    return section("retrieval", overrides)


def get(key: str):
    return get_all()[key]


def update(values: dict) -> dict:
    current = get_all()
    for k, v in values.items():
        if k in SECTIONS:
            db.set_setting(k, {**current[k], **v})
        elif k in FLAT_DEFAULTS:
            db.set_setting(k, v)
    return get_all()


def reset_section(name: str) -> dict:
    db.set_setting(name, _section_defaults(name))
    return get_all()


def embedding_config(overrides: dict | None = None) -> EmbeddingConfig:
    e = section("embedding", overrides)
    base_url = api_key = ""
    if e.backend == "openai":
        from . import providers  # 避免循环导入

        if not e.provider_id:
            raise ValueError("使用 OpenAI 兼容向量接口时需要选择一个模型配置（提供地址和 Key）")
        p = providers.get_config(e.provider_id)
        base_url, api_key = p.base_url, p.api_key
    return EmbeddingConfig(backend=e.backend, model=e.model, provider_id=e.provider_id, base_url=base_url, api_key=api_key)


def current_embedder():
    return get_embedder(embedding_config())


def current_store():
    return get_store(current_embedder(), section("index"))
