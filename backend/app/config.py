"""全局配置：都可以用环境变量覆盖。"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("RAG_DATA_DIR", BASE_DIR / "data"))
DB_PATH = DATA_DIR / "app.db"          # 文档原文、LLM 配置、检索参数
CHROMA_DIR = DATA_DIR / "chroma"       # 向量库

# 向量化方式：fastembed（默认，本地模型）或 hash（离线后备，质量差，仅用于测试）
EMBEDDER = os.environ.get("RAG_EMBEDDER", "fastembed")
EMBED_MODEL = os.environ.get("RAG_EMBED_MODEL", "BAAI/bge-small-zh-v1.5")

# 前端打包后的目录；存在时由后端直接托管，实现单端口部署
FRONTEND_DIST = Path(os.environ.get("RAG_FRONTEND_DIST", BASE_DIR.parent / "frontend" / "dist"))

CORS_ORIGINS = os.environ.get("RAG_CORS_ORIGINS", "http://localhost:5173").split(",")

MAX_UPLOAD_MB = int(os.environ.get("RAG_MAX_UPLOAD_MB", "20"))
