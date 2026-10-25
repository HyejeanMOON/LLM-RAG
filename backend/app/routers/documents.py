from fastapi import APIRouter, File, HTTPException, UploadFile

from .. import config
from ..parsers import UnsupportedFile, extract_text
from ..schemas import ChunkPreviewRequest, DocumentCreate, DocumentUpdate
from ..services import documents as svc
from ..services import settings

router = APIRouter(prefix="/api/documents", tags=["documents"])


def _get_or_404(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except svc.NotFound:
        raise HTTPException(404, "文档不存在")
    except ValueError as e:
        raise HTTPException(400, str(e))


def _full_chunking(opts) -> dict | None:
    """前端可能只传了部分字段，用全局默认补齐后再保存。"""
    return settings.chunking_params(opts.model_dump(exclude_none=True)).to_dict() if opts else None


@router.get("")
def list_documents():
    return svc.list_documents()


@router.post("")
def create_document(body: DocumentCreate):
    return _get_or_404(svc.create_document, body.name, body.content, "md", _full_chunking(body.chunking), body.tags)


@router.post("/upload")
def upload_documents(files: list[UploadFile] = File(...)):
    """可一次上传多个文件；单个文件失败不影响其他文件。"""
    results = []
    for f in files:
        data = f.file.read()
        if len(data) > config.MAX_UPLOAD_MB * 1024 * 1024:
            results.append({"filename": f.filename, "error": f"文件超过 {config.MAX_UPLOAD_MB}MB"})
            continue
        try:
            text, file_type = extract_text(f.filename or "", data)
        except UnsupportedFile as e:
            results.append({"filename": f.filename, "error": str(e)})
            continue
        except Exception as e:  # 损坏的 PDF / docx 等
            results.append({"filename": f.filename, "error": f"解析失败：{e}"})
            continue
        doc = svc.create_document(f.filename, text, file_type)
        results.append({"filename": f.filename, "document": {k: v for k, v in doc.items() if k != "content"}})
    return results


@router.get("/tags")
def list_tags():
    return svc.all_tags()


@router.post("/preview-chunks")
def preview_chunks(body: ChunkPreviewRequest):
    """用指定策略试切一段文本或一篇已有文档，不入库。"""
    content = body.content
    if content is None:
        if not body.doc_id:
            raise HTTPException(400, "需要 content 或 doc_id")
        content = _get_or_404(svc.get_document, body.doc_id)["content"]
    params = settings.chunking_params(body.chunking.model_dump(exclude_none=True))
    try:
        return svc.preview_chunks(content, params)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/reindex")
def reindex():
    return svc.reindex_all()


@router.get("/{doc_id}")
def get_document(doc_id: str):
    return _get_or_404(svc.get_document, doc_id)


@router.put("/{doc_id}")
def update_document(doc_id: str, body: DocumentUpdate):
    kwargs = {}
    if body.use_default_chunking:
        kwargs["chunking"] = None
    elif body.chunking is not None:
        kwargs["chunking"] = _full_chunking(body.chunking)
    return _get_or_404(svc.update_document, doc_id, body.name, body.content, tags=body.tags, **kwargs)


@router.delete("/{doc_id}", status_code=204)
def delete_document(doc_id: str):
    _get_or_404(svc.delete_document, doc_id)


@router.get("/{doc_id}/chunks")
def get_chunks(doc_id: str):
    return _get_or_404(svc.get_chunks, doc_id)
