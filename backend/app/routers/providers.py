from fastapi import APIRouter, HTTPException

from ..llm import LLMError, create_llm
from ..schemas import ProviderCreate, ProviderUpdate
from ..services import local_models
from ..services import providers as svc

router = APIRouter(prefix="/api/providers", tags=["providers"])


def _call(fn, *args):
    try:
        return fn(*args)
    except svc.NotFound:
        raise HTTPException(404, "LLM 配置不存在")
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("")
def list_providers():
    return svc.list_providers()


@router.get("/local/discover")
def discover_local(base_url: str | None = None):
    """找本机的 Ollama / LM Studio / llama.cpp，列出已安装的模型；给 base_url 时只探测这个地址。"""
    return local_models.discover(base_url)


@router.post("")
def create_provider(body: ProviderCreate):
    return _call(svc.create_provider, body.model_dump())


@router.put("/{pid}")
def update_provider(pid: str, body: ProviderUpdate):
    return _call(svc.update_provider, pid, body.model_dump())


@router.delete("/{pid}", status_code=204)
def delete_provider(pid: str):
    _call(svc.delete_provider, pid)


@router.post("/{pid}/default")
def set_default(pid: str):
    _call(svc.set_default, pid)
    return svc.list_providers()


@router.post("/{pid}/test")
def test_provider(pid: str):
    """发一句话测试连通性和 key 是否有效。"""
    cfg = _call(svc.get_config, pid)
    try:
        text = "".join(create_llm(cfg).stream("你是一个测试助手。", [{"role": "user", "content": "只回复两个字：成功"}]))
    except LLMError as e:
        return {"ok": False, "message": str(e)}
    except Exception as e:
        return {"ok": False, "message": f"调用失败：{e}"}
    return {"ok": True, "message": text.strip()[:200]}
