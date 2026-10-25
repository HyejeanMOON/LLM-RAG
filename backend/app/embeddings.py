"""文本向量化（embedding）。

默认用 fastembed 在本地运行 BAAI/bge-small-zh-v1.5（中文效果好、免费、无需 API Key，
首次运行会从 HuggingFace 下载约 90MB 模型）。

RAG_EMBEDDER=hash 时使用纯 Python 的字符 n-gram 哈希向量，不需要下载模型，
检索质量明显较差，只用于离线环境或跑测试。
"""
import hashlib
import math
from functools import lru_cache

from . import config


class FastEmbedder:
    def __init__(self, model_name: str):
        from fastembed import TextEmbedding

        self.name = f"fastembed:{model_name}"
        # 模型缓存放在数据目录，Docker 重启后不用重新下载
        self._model = TextEmbedding(model_name, cache_dir=str(config.DATA_DIR / "models"))

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [v.tolist() for v in self._model.embed(texts)]

    def embed_query(self, text: str) -> list[float]:
        return list(self._model.query_embed(text))[0].tolist()


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


@lru_cache(maxsize=1)
def get_embedder():
    if config.EMBEDDER == "hash":
        return HashEmbedder()
    return FastEmbedder(config.EMBED_MODEL)
