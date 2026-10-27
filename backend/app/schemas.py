from typing import Literal

from pydantic import BaseModel, Field, model_validator

from .i18n import t


class ChunkingOptions(BaseModel):
    strategy: Literal["structure", "fixed", "paragraph", "recursive", "semantic"] | None = None
    chunk_size: int | None = Field(default=None, ge=20, le=4000)
    chunk_overlap: int | None = Field(default=None, ge=0, le=1000)
    add_title: bool | None = None
    semantic_percentile: int | None = Field(default=None, ge=1, le=99)

    @model_validator(mode="after")
    def _overlap_lt_size(self):
        if self.chunk_size is not None and self.chunk_overlap is not None and self.chunk_overlap >= self.chunk_size:
            raise ValueError(t("重叠长度必须小于切片长度", "Overlap must be smaller than the chunk size"))
        return self


class DocumentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1)
    chunking: ChunkingOptions | None = None  # 不传表示用全局默认
    tags: list[str] = []


class DocumentUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = Field(default=None, min_length=1)
    chunking: ChunkingOptions | None = None
    use_default_chunking: bool = False  # true：去掉这篇文档的单独设置，改回全局默认
    tags: list[str] | None = None


class ChunkPreviewRequest(BaseModel):
    content: str | None = None   # 直接给文本，或者
    doc_id: str | None = None    # 给文档 id
    chunking: ChunkingOptions = ChunkingOptions()


class RetrievalOptions(BaseModel):
    """检索策略，全部可选；没给的字段用设置里的默认值。"""
    method: Literal["vector", "bm25", "hybrid"] | None = None
    metric: Literal["cosine", "dot", "l2"] | None = None
    top_k: int | None = Field(default=None, ge=1, le=50)
    min_score: float | None = Field(default=None, ge=-1, le=1)
    fetch_k: int | None = Field(default=None, ge=1, le=200)
    fusion: Literal["rrf", "weighted"] | None = None
    hybrid_alpha: float | None = Field(default=None, ge=0, le=1)
    rrf_k: int | None = Field(default=None, ge=1, le=1000)
    use_mmr: bool | None = None
    mmr_lambda: float | None = Field(default=None, ge=0, le=1)
    use_rerank: bool | None = None
    index: Literal["exact", "hnsw"] | None = None
    ann_candidates: int | None = Field(default=None, ge=1, le=1000)

    def overrides(self) -> dict:
        return self.model_dump(exclude_none=True)


class FilterFields(BaseModel):
    """元数据过滤：指定文档、含任一标签、更新日期范围（YYYY-MM-DD）。"""
    doc_ids: list[str] | None = None
    tags: list[str] | None = None
    date_from: str | None = None
    date_to: str | None = None

    def filters(self) -> dict:
        return {"doc_ids": self.doc_ids, "tags": self.tags, "date_from": self.date_from, "date_to": self.date_to}


class SearchRequest(FilterFields):
    query: str = Field(min_length=1)
    retrieval: RetrievalOptions = RetrievalOptions()


class Strategy(RetrievalOptions):
    label: str = ""


class CompareRequest(FilterFields):
    query: str = Field(min_length=1)
    strategies: list[Strategy] = Field(min_length=1, max_length=6)


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(SearchRequest):
    provider_id: str | None = None
    history: list[ChatMessage] = []


class ProviderCreate(BaseModel):
    name: str = Field(min_length=1)
    type: Literal["anthropic", "openai"]
    model: str = Field(min_length=1)
    base_url: str = ""
    api_key: str = ""
    extra: dict = {}


class ProviderUpdate(BaseModel):
    name: str | None = None
    type: Literal["anthropic", "openai"] | None = None
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = None  # None = 不修改
    extra: dict | None = None


class EmbeddingOptions(BaseModel):
    backend: Literal["fastembed", "openai", "hash"] | None = None
    model: str | None = Field(default=None, min_length=1)
    provider_id: str | None = None


class IndexOptions(BaseModel):
    space: Literal["cosine", "l2", "ip"] | None = None
    max_neighbors: int | None = Field(default=None, ge=2, le=128)
    ef_construction: int | None = Field(default=None, ge=10, le=2000)
    ef_search: int | None = Field(default=None, ge=1, le=2000)


class QueryOptions(BaseModel):
    history_turns: int | None = Field(default=None, ge=0, le=20)
    condense_history: bool | None = None
    multi_query: bool | None = None
    multi_query_n: int | None = Field(default=None, ge=1, le=8)
    hyde: bool | None = None


class ContextOptions(BaseModel):
    max_chars: int | None = Field(default=None, ge=200, le=200000)
    neighbor_window: int | None = Field(default=None, ge=0, le=5)
    order: Literal["score", "document", "edges"] | None = None


class GenerationOptions(BaseModel):
    system_prompt: str | None = Field(default=None, min_length=1)
    user_template: str | None = Field(default=None, min_length=1)
    source_template: str | None = Field(default=None, min_length=1)
    max_tokens: int | None = Field(default=None, ge=0, le=128000)   # 0 表示清空，用模型配置
    temperature: float | None = Field(default=None, ge=-1, le=2)     # 负数表示清空
    effort: Literal["", "low", "medium", "high", "xhigh", "max"] | None = None

    @model_validator(mode="after")
    def _templates(self):
        if self.user_template is not None and "{sources}" not in self.user_template:
            raise ValueError(t("用户消息模板里必须包含 {sources}", "The user template must contain {sources}"))
        if self.user_template is not None and "{question}" not in self.user_template:
            raise ValueError(t("用户消息模板里必须包含 {question}", "The user template must contain {question}"))
        if self.source_template is not None and "{text}" not in self.source_template:
            raise ValueError(t("片段模板里必须包含 {text}", "The source template must contain {text}"))
        return self


class SettingsUpdate(BaseModel):
    chunking: ChunkingOptions | None = None
    embedding: EmbeddingOptions | None = None
    index: IndexOptions | None = None
    query: QueryOptions | None = None
    retrieval: RetrievalOptions | None = None
    context: ContextOptions | None = None
    generation: GenerationOptions | None = None


class EmbeddingTest(BaseModel):
    texts: list[str] = Field(min_length=2, max_length=10)


# ---------- 评测 ----------

class EvalItem(BaseModel):
    question: str = Field(min_length=1)
    reference_answer: str = ""
    evidence: list[str] = []
    answerable: bool = True
    source: str = ""


class EvalSetCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    items: list[EvalItem] = []


class EvalSetUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    items: list[EvalItem] | None = None


class EvalGenerate(BaseModel):
    provider_id: str | None = None
    n: int = Field(default=5, ge=1, le=50)
    n_unanswerable: int = Field(default=0, ge=0, le=20)
    doc_ids: list[str] | None = None


class EvalRunCreate(BaseModel):
    set_id: str
    name: str = Field(min_length=1, max_length=200)
    metrics: list[str] = []
    provider_id: str | None = None        # 生成回答用的模型
    judge_provider_id: str | None = None  # 当裁判的模型，不填用同一个
    overrides: dict[str, dict] = {}       # 临时覆盖 query / retrieval / context / generation 参数
    match_threshold: float = Field(default=0.6, ge=0.1, le=1)
    concurrency: int = Field(default=4, ge=1, le=8)


class EvalPairwise(BaseModel):
    run_a: str
    run_b: str
    judge_provider_id: str | None = None
