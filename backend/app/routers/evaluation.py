from fastapi import APIRouter, HTTPException

from ..i18n import t
from ..llm import LLMError
from ..schemas import EvalGenerate, EvalPairwise, EvalRunCreate, EvalSetCreate, EvalSetUpdate
from ..services import evaluation as svc
from ..services import providers

router = APIRouter(prefix="/api/eval", tags=["evaluation"])


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except svc.NotFound:
        raise HTTPException(404, t("测试集或评测记录不存在", "Test set or run not found"))
    except providers.NotFound:
        raise HTTPException(400, t("LLM 配置不存在，请先在“LLM 模型”页添加", "LLM config not found. Add one on the LLM models page first."))
    except LLMError as e:
        raise HTTPException(400, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/metrics")
def metric_list():
    return svc.metric_list()


@router.get("/sets")
def list_sets():
    return svc.list_sets()


@router.post("/sets")
def create_set(body: EvalSetCreate):
    """新建测试集；也用于导入（把导出的 JSON 原样 POST 回来）。"""
    return svc.create_set(body.name, [i.model_dump() for i in body.items])


@router.post("/sets/sample")
def create_sample_set():
    """按界面语言导入内置示例测试集（对应示例员工手册）。"""
    return svc.create_sample_set()


@router.get("/sets/{set_id}")
def get_set(set_id: str):
    return _call(svc.get_set, set_id)


@router.put("/sets/{set_id}")
def update_set(set_id: str, body: EvalSetUpdate):
    items = [i.model_dump() for i in body.items] if body.items is not None else None
    return _call(svc.update_set, set_id, body.name, items)


@router.delete("/sets/{set_id}", status_code=204)
def delete_set(set_id: str):
    _call(svc.delete_set, set_id)


@router.get("/sets/{set_id}/export")
def export_set(set_id: str):
    return _call(svc.export_set, set_id)


@router.post("/sets/{set_id}/generate")
def generate(set_id: str, body: EvalGenerate):
    """用 LLM 从文档切片自动出题，追加到测试集末尾。"""
    return _call(svc.generate_items, set_id, body.provider_id, body.n, body.n_unanswerable, body.doc_ids)


@router.get("/sets/{set_id}/runs")
def list_runs(set_id: str):
    _call(svc.get_set, set_id)
    return svc.list_runs(set_id)


@router.post("/runs")
def start_run(body: EvalRunCreate):
    """在后台开始评测，立即返回；前端轮询 GET /runs/{id} 看进度。"""
    return _call(svc.start_run, body.set_id, body.name, body.metrics, body.provider_id, body.judge_provider_id,
                 body.overrides, body.match_threshold, body.concurrency)


@router.get("/runs/{run_id}")
def get_run(run_id: str):
    return _call(svc.get_run, run_id)


@router.post("/runs/{run_id}/cancel")
def cancel_run(run_id: str):
    _call(svc.get_run, run_id, False)
    svc.cancel_run(run_id)
    return {"ok": True}


@router.delete("/runs/{run_id}", status_code=204)
def delete_run(run_id: str):
    _call(svc.delete_run, run_id)


@router.post("/pairwise")
def pairwise(body: EvalPairwise):
    """让裁判逐题比较两次评测的回答（交换顺序各判一次）。"""
    return _call(svc.pairwise, body.run_a, body.run_b, body.judge_provider_id)
