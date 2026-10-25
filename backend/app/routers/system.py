from fastapi import APIRouter, HTTPException

from ..embeddings import get_embedder
from ..schemas import SettingsUpdate
from ..services import documents, settings
from ..store import get_store

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/health")
def health():
    return {
        "status": "ok",
        "embedder": get_embedder().name,
        "documents": len(documents.list_documents()),
        "chunks": get_store().count(),
    }


@router.get("/settings")
def get_settings():
    return settings.get_all()


@router.put("/settings")
def update_settings(body: SettingsUpdate):
    values = body.model_dump(exclude_none=True)
    current = settings.get_all()
    if "retrieval" in values:
        values["retrieval"] = {**current["retrieval"], **values["retrieval"]}
    size = values.get("chunk_size", current["chunk_size"])
    overlap = values.get("chunk_overlap", current["chunk_overlap"])
    if overlap >= size:
        raise HTTPException(400, "重叠长度必须小于切片长度")
    return settings.update(values)
