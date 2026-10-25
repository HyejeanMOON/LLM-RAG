"""RAG 主流程，每一步都可以在“RAG 流程”页面切换：

  问题处理（结合历史改写 / 多查询 / HyDE）
    → 元数据过滤 → 检索（向量 / BM25 / 混合 / 重排序 / MMR）
    → 上下文组装（相邻片段扩展 / 排序 / 字数上限）
    → 按模板拼提示词 → 流式调用所选 LLM

run_pipeline() 会把每一步的中间结果记录到 trace 里，前端可以展开查看，方便学习。
"""
import time
from dataclasses import replace
from typing import Iterator

from .. import query as q
from ..context import assemble
from ..llm import ProviderConfig, create_llm
from ..retrieval import retrieve as run_retrieval
from . import documents, providers, settings


def retrieve(question: str, overrides: dict | None = None, doc_ids: list[str] | None = None,
             vector_text: str | None = None, trace: dict | None = None) -> list[dict]:
    """按设置里的默认检索策略检索，overrides 可以临时覆盖其中的参数。"""
    return run_retrieval(settings.current_store(), question, settings.retrieval_params(overrides),
                         doc_ids, vector_text, trace)


def fuse_rrf(result_lists: list[list[dict]], top_k: int, k: int = 60) -> list[dict]:
    """多查询结果融合：同一个切片在各查询结果里的 1/(k+名次) 相加。"""
    fused: dict[tuple, dict] = {}
    for hits in result_lists:
        for rank, h in enumerate(hits, 1):
            key = (h["doc_id"], h["index"])
            if key not in fused:
                fused[key] = {**h, "scores": {**h["scores"], "multi_query_rrf": 0.0, "matched_queries": 0}}
            f = fused[key]
            f["scores"]["multi_query_rrf"] = round(f["scores"]["multi_query_rrf"] + 1 / (k + rank), 5)
            f["scores"]["matched_queries"] += 1
    out = sorted(fused.values(), key=lambda h: -h["scores"]["multi_query_rrf"])[:top_k]
    for h in out:
        h["score"] = h["scores"]["multi_query_rrf"]
    return out


def build_user_message(question: str, blocks: list[dict], gen) -> str:
    sources = "\n\n".join(
        gen.source_template.format(id=i, doc_name=b["doc_name"], text=b["text"], score=b["score"])
        for i, b in enumerate(blocks, 1)
    ) or "（没有检索到相关片段）"
    return gen.user_template.replace("{sources}", sources).replace("{question}", question)


def _clean_history(history: list[dict], turns: int) -> list[dict]:
    """只保留 user/assistant 交替的最近几轮，保证第一条是 user。"""
    msgs = [
        {"role": m["role"], "content": m["content"]}
        for m in history
        if m.get("role") in ("user", "assistant") and (m.get("content") or "").strip()
    ]
    cleaned = []
    for m in msgs:
        if cleaned and cleaned[-1]["role"] == m["role"]:
            cleaned[-1] = m
        else:
            cleaned.append(m)
    while cleaned and cleaned[0]["role"] != "user":
        cleaned.pop(0)
    if cleaned and cleaned[-1]["role"] == "user":
        cleaned.pop()
    return cleaned[-turns * 2:] if turns > 0 else []


def _apply_generation(cfg: ProviderConfig, gen) -> ProviderConfig:
    extra = dict(cfg.extra)
    if gen.max_tokens:
        extra["max_tokens"] = gen.max_tokens
    if gen.temperature is not None and cfg.type == "openai":
        extra["temperature"] = gen.temperature
    if gen.effort and cfg.type == "anthropic":
        extra["effort"] = gen.effort
    return replace(cfg, extra=extra)


def run_pipeline(question: str, provider_id: str | None = None, history: list[dict] | None = None,
                 retrieval_overrides: dict | None = None, filters: dict | None = None) -> tuple[list[dict], dict, Iterator[str]]:
    """返回 (sources, trace, 回答的文本流)。sources 是最终放进提示词的参考片段。"""
    t0 = time.perf_counter()
    timings = {}
    cfg = providers.get_config(provider_id)
    qp = settings.section("query")
    ctx = settings.section("context")
    gen = settings.section("generation")
    params = settings.retrieval_params(retrieval_overrides)
    history = _clean_history(history or [], qp.history_turns)
    trace: dict = {"question": question, "provider": f"{cfg.name}（{cfg.model}）"}

    # 1. 问题处理
    search_q = question
    if qp.condense_history and history:
        search_q = q.condense(cfg, question, history)
        trace["condensed_query"] = search_q
    queries = [search_q]
    if qp.multi_query:
        queries += q.multi_queries(cfg, search_q, qp.multi_query_n)
        trace["multi_queries"] = queries[1:]
    hyde_text = None
    if qp.hyde:
        hyde_text = q.hyde_document(cfg, search_q)
        trace["hyde_text"] = hyde_text
    timings["query_ms"] = round((time.perf_counter() - t0) * 1000)

    # 2. 元数据过滤 + 检索
    t1 = time.perf_counter()
    doc_ids = documents.resolve_filter(**(filters or {}))
    if doc_ids is not None:
        trace["filter"] = {**{k: v for k, v in (filters or {}).items() if v}, "matched_documents": len(doc_ids)}
    per_query = []
    result_lists = []
    for i, query in enumerate(queries):
        info: dict = {}
        hits = retrieve(query, retrieval_overrides, doc_ids, hyde_text if i == 0 else None, info)
        result_lists.append(hits)
        per_query.append({"query": query, "hits": len(hits), **info})
    hits = fuse_rrf(result_lists, params.top_k) if len(queries) > 1 else result_lists[0]
    trace["retrieval"] = {"params": params.to_dict(), "per_query": per_query, "hits": len(hits)}
    timings["retrieval_ms"] = round((time.perf_counter() - t1) * 1000)

    # 3. 上下文组装
    sources, info = assemble(hits, ctx, documents.get_chunks)
    trace["context"] = {**ctx.to_dict(), **info}

    # 4. 拼提示词
    messages = history + [{"role": "user", "content": build_user_message(question, sources, gen)}]
    gen_cfg = _apply_generation(cfg, gen)
    trace["prompt"] = {"system": gen.system_prompt, "messages": messages, "llm_params": gen_cfg.extra}
    trace["timings"] = timings

    stream = create_llm(gen_cfg).stream(gen.system_prompt, messages)
    return sources, trace, stream
