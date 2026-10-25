import json

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from ..llm import LLMError
from ..schemas import ChatRequest, SearchRequest
from ..services import providers, rag

router = APIRouter(prefix="/api", tags=["chat"])


@router.post("/search")
def search(body: SearchRequest):
    """只做向量检索，不调用 LLM，用来调试检索效果。"""
    return rag.retrieve(body.query, body.top_k, body.doc_ids, body.min_score)


def _sse(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/chat")
def chat(body: ChatRequest):
    """SSE 流：先发 sources（检索到的片段），再逐段发 delta，最后 done 或 error。"""
    def gen():
        try:
            hits = rag.retrieve(body.query, body.top_k, body.doc_ids, body.min_score)
            yield _sse("sources", hits)
            history = [m.model_dump() for m in body.history]
            for text in rag.answer_stream(body.query, hits, body.provider_id, history):
                yield _sse("delta", {"text": text})
            yield _sse("done", {})
        except providers.NotFound:
            yield _sse("error", {"message": "LLM 配置不存在，请先在“模型设置”里添加"})
        except LLMError as e:
            yield _sse("error", {"message": str(e)})
        except Exception as e:  # 不让异常把流直接断掉，前端拿不到原因
            yield _sse("error", {"message": f"服务器错误：{e}"})

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
