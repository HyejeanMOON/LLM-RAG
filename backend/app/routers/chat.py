import json
import time

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from ..i18n import t
from ..llm import LLMError
from ..schemas import ChatRequest, CompareRequest, SearchRequest
from ..services import documents, providers, rag, settings

router = APIRouter(prefix="/api", tags=["chat"])


@router.post("/search")
def search(body: SearchRequest):
    """只做向量检索，不调用 LLM，用来调试检索效果。"""
    try:
        return rag.retrieve(body.query, body.retrieval.overrides(), documents.resolve_filter(**body.filters()))
    except Exception as e:  # 例如重排序模型下载失败
        raise HTTPException(500, t(f"检索失败：{e}", f"Retrieval failed: {e}"))


@router.post("/search/compare")
def compare(body: CompareRequest):
    """同一个问题用多种检索策略各跑一遍，前端并排对比。"""
    results = []
    doc_ids = documents.resolve_filter(**body.filters())
    for i, s in enumerate(body.strategies):
        overrides = s.overrides()
        label = overrides.pop("label", "") or t(f"策略 {i + 1}", f"Strategy {i + 1}")
        start = time.perf_counter()
        try:
            info: dict = {}
            hits, error = rag.retrieve(body.query, overrides, doc_ids, trace=info), None
        except Exception as e:
            hits, error = [], t(f"检索失败：{e}", f"Retrieval failed: {e}")
        results.append({
            "label": label,
            "params": settings.retrieval_params(overrides).to_dict(),
            "hits": hits,
            "error": error,
            "elapsed_ms": round((time.perf_counter() - start) * 1000, 1),
            "searched": info.get("searched") if not error else None,
        })
    return results


def _sse(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/chat")
def chat(body: ChatRequest):
    """SSE 流：先发 trace（流程每一步的中间结果）和 sources（最终放进提示词的片段），
    再逐段发 delta，最后 done 或 error。"""
    def gen():
        try:
            sources, trace, stream = rag.run_pipeline(
                body.query, body.provider_id, [m.model_dump() for m in body.history],
                body.retrieval.overrides(), body.filters(),
            )
            yield _sse("trace", trace)
            yield _sse("sources", sources)
            start = time.perf_counter()
            for text in stream:
                yield _sse("delta", {"text": text})
            yield _sse("done", {"generation_ms": round((time.perf_counter() - start) * 1000)})
        except providers.NotFound:
            yield _sse("error", {"message": t("LLM 配置不存在，请先在“LLM 模型”页添加", "LLM config not found. Add one on the LLM models page first.")})
        except LLMError as e:
            yield _sse("error", {"message": str(e)})
        except Exception as e:  # 不让异常把流直接断掉，前端拿不到原因
            yield _sse("error", {"message": t(f"服务器错误：{e}", f"Server error: {e}")})

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
