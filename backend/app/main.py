"""FastAPI 入口。

开发：uvicorn app.main:app --reload --port 8000（前端另起 vite，代理 /api）
部署：先 npm run build 前端，后端会直接托管 frontend/dist，单端口访问。
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import config, db
from .i18n import LanguageMiddleware
from .routers import chat, documents, evaluation, providers, system
from .services import providers as provider_svc
from .services import documents as document_svc
from .services import evaluation as evaluation_svc


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    provider_svc.seed_defaults()
    evaluation_svc.mark_interrupted()
    if not document_svc.list_documents():
        sample = config.BASE_DIR / "sample_docs" / "xinghe_handbook.md"
        if sample.exists():
            document_svc.create_document(sample.name, sample.read_text(encoding="utf-8"), "md")
    yield


app = FastAPI(title="RAG 知识库问答", lifespan=lifespan)
app.add_middleware(LanguageMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)
for r in (documents.router, providers.router, chat.router, system.router, evaluation.router):
    app.include_router(r)

if config.FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=config.FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        # 前端是单页应用，非 /api 的路径都返回 index.html
        file = config.FRONTEND_DIST / path
        if path and file.is_file():
            return FileResponse(file)
        return FileResponse(config.FRONTEND_DIST / "index.html")
