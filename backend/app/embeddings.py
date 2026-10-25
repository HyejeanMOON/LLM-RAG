"""文本向量化（embedding），可以在前端切换。

三种后端：
- fastembed：在本地 CPU 上运行开源模型（默认 BAAI/bge-small-zh-v1.5），免费、不需要 Key，
  首次使用会从 HuggingFace 下载模型（设置 HF_ENDPOINT 可以用镜像）。
- openai：调用 OpenAI 兼容的 /embeddings 接口（OpenAI、通义、智谱、Ollama 等），
  复用“LLM 模型”里某个 OpenAI 兼容配置的地址和 Key。
- hash：纯 Python 的字符 n-gram 哈希向量，不需要模型，检索质量差，只用于离线测试和对照。

不同模型的向量维度、语义空间都不同，所以每个模型使用独立的向量集合，切换后要重建索引。
"""
import hashlib
import math
from dataclasses import dataclass
from functools import lru_cache
from typing import Literal

from . import config

Backend = Literal["fastembed", "openai", "hash"]

# 前端下拉框里的常用模型（也可以手动填写任何 fastembed 支持的模型名）
FASTEMBED_MODELS = [
    {"model": "BAAI/bge-small-zh-v1.5", "dim": 512, "size": "90MB", "lang": "中文", "note": "中文小模型，速度快，默认"},
    {"model": "jinaai/jina-embeddings-v2-base-zh", "dim": 768, "size": "640MB", "lang": "中英", "note": "中英混合，支持 8192 token 长文本"},
    {"model": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2", "dim": 384, "size": "220MB", "lang": "多语言", "note": "50 种语言，小而快"},
    {"model": "intfloat/multilingual-e5-large", "dim": 1024, "size": "2.2GB", "lang": "多语言", "note": "效果好但大，需要 query:/passage: 前缀（已自动处理）"},
    {"model": "Qwen/Qwen3-Embedding-0.6B-Q", "dim": 1024, "size": "1.1GB", "lang": "多语言", "note": "通义千问向量模型（量化版），支持 32K token"},
    {"model": "jinaai/jina-embeddings-v3", "dim": 1024, "size": "2.3GB", "lang": "多语言", "note": "多语言、多任务"},
    {"model": "minishlab/potion-multilingual-128M", "dim": 256, "size": "510MB", "lang": "多语言", "note": "静态词向量模型，极快但效果一般"},
    {"model": "BAAI/bge-small-en-v1.5", "dim": 384, "size": "67MB", "lang": "英文", "note": "英文小模型"},
]


@dataclass(frozen=True)
class EmbeddingConfig:
    backend: Backend = "fastembed"
    model: str = "BAAI/bge-small-zh-v1.5"
    provider_id: str | None = None   # backend=openai 时使用哪个 LLM 配置的地址和 Key
    # 下面两项由服务层根据 provider_id 填入，不保存到设置里
    base_url: str = ""
    api_key: str = ""

    def public(self) -> dict:
        return {"backend": self.backend, "model": self.model, "provider_id": self.provider_id}


class FastEmbedder:
    def __init__(self, model_name: str):
        from fastembed import TextEmbedding

        self.name = f"fastembed:{model_name}"
        # 模型缓存放在数据目录，Docker 重启后不用重新下载
        self._model = TextEmbedding(model_name, cache_dir=str(config.DATA_DIR / "models"))
        # E5 系列训练时给问题和文档加了不同前缀，使用时也要加，否则效果明显下降
        self._e5 = "e5" in model_name.lower()

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if self._e5:
            texts = [f"passage: {t}" for t in texts]
        return [v.tolist() for v in self._model.embed(texts)]

    def embed_query(self, text: str) -> list[float]:
        if self._e5:
            return list(self._model.embed([f"query: {text}"]))[0].tolist()
        return list(self._model.query_embed(text))[0].tolist()


class OpenAIEmbedder:
    def __init__(self, model: str, base_url: str, api_key: str):
        import openai

        self.name = f"openai:{model}"
        self.model = model
        self.client = openai.OpenAI(api_key=api_key or "not-needed", base_url=base_url or None)

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        out = []
        for i in range(0, len(texts), 64):  # 大多数接口限制单次条数
            resp = self.client.embeddings.create(model=self.model, input=texts[i:i + 64])
            out += [d.embedding for d in sorted(resp.data, key=lambda d: d.index)]
        return out

    def embed_query(self, text: str) -> list[float]:
        return self.embed_documents([text])[0]


class HashEmbedder:
    """离线后备：把字符 1~3-gram 哈希到固定维度并做 L2 归一化。"""

    def __init__(self, dim: int = 1024):
        self.name = f"hash:{dim}"
        self.dim = dim

    def _embed(self, text: str) -> list[float]:
        vec = [0.0] * self.dim
        text = text.lower()
        for n in (1, 2, 3):
            for i in range(len(text) - n + 1):
                gram = text[i:i + n]
                if gram.isspace():
                    continue
                h = int(hashlib.md5(gram.encode()).hexdigest(), 16)
                vec[h % self.dim] += 1.0 if n > 1 else 0.3
        norm = math.sqrt(sum(x * x for x in vec)) or 1.0
        return [x / norm for x in vec]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._embed(t) for t in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._embed(text)


@lru_cache(maxsize=8)
def get_embedder(cfg: EmbeddingConfig):
    if cfg.backend == "hash":
        return HashEmbedder()
    if cfg.backend == "openai":
        return OpenAIEmbedder(cfg.model, cfg.base_url, cfg.api_key)
    return FastEmbedder(cfg.model)
