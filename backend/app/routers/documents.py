from fastapi import APIRouter, File, HTTPException, UploadFile

from .. import config
from ..parsers import UnsupportedFile, extract_text
from ..schemas import DocumentCreate, DocumentUpdate
from ..services import documents as svc

router = APIRouter(prefix="/api/documents", tags=["documents"])


def _get_or_404(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except svc.NotFound:
        raise HTTPException(404, "文档不存在")


@router.get("")
def list_documents():
    return svc.list_documents()


@router.post("")
def create_document(body: DocumentCreate):
    return svc.create_document(body.name, body.content, "md")


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


@router.post("/reindex")
def reindex():
    return svc.reindex_all()


@router.get("/{doc_id}")
def get_document(doc_id: str):
    return _get_or_404(svc.get_document, doc_id)


@router.put("/{doc_id}")
def update_document(doc_id: str, body: DocumentUpdate):
    return _get_or_404(svc.update_document, doc_id, body.name, body.content)


@router.delete("/{doc_id}", status_code=204)
def delete_document(doc_id: str):
    _get_or_404(svc.delete_document, doc_id)


@router.get("/{doc_id}/chunks")
def get_chunks(doc_id: str):
    return _get_or_404(svc.get_chunks, doc_id)
