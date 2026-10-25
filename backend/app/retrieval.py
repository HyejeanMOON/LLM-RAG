"""可配置的检索算法。

流程：
  1. 打分（method）
     - vector：向量相似度，metric 可选 cosine（余弦）/ dot（点积）/ l2（欧氏距离，越小越近）
     - bm25  ：关键词检索（Okapi BM25，中文按单字 + 双字切词，英文按单词）
     - hybrid：向量 + BM25 融合，fusion 可选 rrf（按排名倒数融合）/ weighted（分数归一化后加权）
  2. 取前 fetch_k 个候选
  3. 可选 rerank：用交叉编码器（cross-encoder）对候选重新打分排序
  4. 可选 MMR：在相关性和多样性之间折中，避免选出几条几乎一样的片段
  5. 按余弦相似度阈值 min_score 过滤，取前 top_k 个

每个结果都带上所有算法的分数（scores），方便在前端对比。
索引方式（index）：
  - exact：用 numpy 对全部切片精确计算（暴力检索），结果最准，几万个切片以内足够快；
  - hnsw ：先用 Chroma 的 HNSW 图做近似最近邻（ANN）召回 ann_candidates 个候选，
           再和 BM25 的前 ann_candidates 个候选合并，只在候选里打分。数据量大时快得多，
           但可能漏掉真正最相近的片段（召回率 < 100%），可以在“检索调试”里和 exact 对比。
"""
import math
import re
from collections import Counter
from dataclasses import asdict, dataclass
from functools import lru_cache
from typing import Literal

import numpy as np


Method = Literal["vector", "bm25", "hybrid"]
Metric = Literal["cosine", "dot", "l2"]
Fusion = Literal["rrf", "weighted"]

RERANK_MODEL = "BAAI/bge-reranker-base"


@dataclass
class RetrievalParams:
    method: Method = "vector"
    metric: Metric = "cosine"
    top_k: int = 4
    min_score: float = 0.0        # 余弦相似度阈值，低于它的丢弃
    fetch_k: int = 20             # MMR / rerank 的候选数量
    fusion: Fusion = "rrf"
    hybrid_alpha: float = 0.5     # weighted 融合时向量分数的权重
    rrf_k: int = 60
    use_mmr: bool = False
    mmr_lambda: float = 0.5       # 1 = 只看相关性，0 = 只看多样性
    use_rerank: bool = False
    index: Literal["exact", "hnsw"] = "exact"
    ann_candidates: int = 50      # hnsw 模式下向量和 BM25 各召回多少个候选

    def to_dict(self) -> dict:
        return asdict(self)


# ---------- 分词与 BM25 ----------

_TOKEN = re.compile(r"[a-z0-9]+|[一-鿿]+")


def tokenize(text: str) -> list[str]:
    """英文/数字按单词；中文连续片段切成单字 + 相邻双字（不依赖分词词典）。"""
    tokens = []
    for m in _TOKEN.finditer(text.lower()):
        w = m.group()
        if w[0].isascii():
            tokens.append(w)
        else:
            tokens.extend(w)
            tokens.extend(w[i:i + 2] for i in range(len(w) - 1))
    return tokens


def bm25_scores(query: str, docs: list[str], k1: float = 1.5, b: float = 0.75) -> np.ndarray:
    n = len(docs)
    if n == 0:
        return np.zeros(0)
    doc_tokens = [Counter(tokenize(d)) for d in docs]
    lengths = np.array([sum(c.values()) for c in doc_tokens], dtype=np.float64)
    avgdl = lengths.mean() or 1.0
    df = Counter(t for c in doc_tokens for t in c)
    scores = np.zeros(n)
    for term in set(tokenize(query)):
        if term not in df:
            continue
        idf = math.log(1 + (n - df[term] + 0.5) / (df[term] + 0.5))
        tf = np.array([c.get(term, 0) for c in doc_tokens], dtype=np.float64)
        scores += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * lengths / avgdl))
    return scores


# ---------- 工具函数 ----------

def _normalize(x: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(x, axis=-1, keepdims=True)
    return x / np.where(norms == 0, 1, norms)


def _minmax(x: np.ndarray) -> np.ndarray:
    lo, hi = x.min(), x.max()
    return np.zeros_like(x) if hi - lo < 1e-12 else (x - lo) / (hi - lo)


def _ranks(scores: np.ndarray) -> np.ndarray:
    """分数从高到低的名次，从 1 开始。"""
    order = np.argsort(-scores, kind="stable")
    ranks = np.empty(len(scores), dtype=int)
    ranks[order] = np.arange(1, len(scores) + 1)
    return ranks


def mmr_select(query_vec: np.ndarray, cand_vecs: np.ndarray, relevance: np.ndarray, k: int, lam: float) -> tuple[list[int], list[float]]:
    """Maximal Marginal Relevance：每次选 lam*相关性 - (1-lam)*与已选片段的最大相似度 最大的那个。"""
    cand = _normalize(cand_vecs)
    sim = cand @ cand.T
    selected, mmr_vals = [], []
    remaining = list(range(len(cand)))
    while remaining and len(selected) < k:
        if selected:
            redundancy = sim[np.ix_(remaining, selected)].max(axis=1)
        else:
            redundancy = np.zeros(len(remaining))
        vals = lam * relevance[remaining] - (1 - lam) * redundancy
        best = int(np.argmax(vals))
        selected.append(remaining.pop(best))
        mmr_vals.append(float(vals[best]))
    return selected, mmr_vals


@lru_cache(maxsize=1)
def _get_reranker():
    from fastembed.rerank.cross_encoder import TextCrossEncoder

    from . import config

    return TextCrossEncoder(RERANK_MODEL, cache_dir=str(config.DATA_DIR / "models"))


def rerank_scores(query: str, texts: list[str]) -> np.ndarray:
    return np.array(list(_get_reranker().rerank(query, texts)), dtype=np.float64)


# ---------- 主函数 ----------

def retrieve(store, query: str, params: RetrievalParams, doc_ids: list[str] | None = None,
             vector_text: str | None = None, trace: dict | None = None) -> list[dict]:
    """doc_ids 为 None 表示不过滤；vector_text 用于 HyDE：向量检索用它，BM25 仍用 query。"""
    corpus = store.load_corpus()
    allowed = None if doc_ids is None else set(doc_ids)
    idx = [i for i, m in enumerate(corpus["metas"]) if allowed is None or m["doc_id"] in allowed]
    q = np.asarray(store.embedder.embed_query(vector_text or query), dtype=np.float32)
    # BM25 的 IDF 依赖整个语料，所以先在全部（过滤后的）切片上算好
    bm25_all = dict(zip(idx, bm25_scores(query, [corpus["texts"][i] for i in idx])))

    if params.index == "hnsw" and idx:
        # 向量走 HNSW 近似召回，关键词走 BM25 召回，两路候选取并集
        ann_ids = set(store.ann_search(q.tolist(), params.ann_candidates, doc_ids))
        bm25_top = {i for i in sorted(idx, key=lambda i: -bm25_all[i])[: params.ann_candidates] if bm25_all[i] > 0}
        idx = [i for i in idx if corpus["ids"][i] in ann_ids or i in bm25_top]
    if trace is not None:
        trace.update({"corpus": len(corpus["ids"]), "searched": len(idx), "index": params.index})
    if not idx:
        return []
    texts = [corpus["texts"][i] for i in idx]
    metas = [corpus["metas"][i] for i in idx]
    vecs = corpus["embeddings"][idx]

    # 1. 各种基础分数都算出来，前端可以对比
    dot = vecs @ q
    cosine = _normalize(vecs) @ _normalize(q)
    l2 = np.linalg.norm(vecs - q, axis=1)
    bm25 = np.array([bm25_all[i] for i in idx])
    vector_score = {"cosine": cosine, "dot": dot, "l2": -l2}[params.metric]
    vec_rank, bm25_rank = _ranks(vector_score), _ranks(bm25)

    if params.method == "vector":
        base = vector_score
    elif params.method == "bm25":
        base = bm25
    elif params.fusion == "rrf":
        base = 1 / (params.rrf_k + vec_rank) + 1 / (params.rrf_k + bm25_rank)
    else:
        base = params.hybrid_alpha * _minmax(vector_score) + (1 - params.hybrid_alpha) * _minmax(bm25)

    # 2. 取候选
    need_candidates = params.use_mmr or params.use_rerank
    n_cand = max(params.fetch_k, params.top_k) if need_candidates else len(base)
    cand = list(np.argsort(-base, kind="stable")[:n_cand])
    final = {i: float(base[i]) for i in cand}
    extra: dict[int, dict] = {i: {} for i in cand}

    # 3. 重排序
    if params.use_rerank:
        rr = rerank_scores(query, [texts[i] for i in cand])
        for i, s in zip(cand, rr):
            final[i] = float(s)
            extra[i]["rerank"] = round(float(s), 4)
        cand.sort(key=lambda i: -final[i])

    # 4. MMR（相关性用当前排序分数归一化到 0~1，和片段间余弦相似度可比）
    if params.use_mmr:
        rel = _minmax(np.array([final[i] for i in cand]))
        picked, vals = mmr_select(q, vecs[cand], rel, len(cand), params.mmr_lambda)
        order = [cand[p] for p in picked]
        for i, v in zip(order, vals):
            extra[i]["mmr"] = round(v, 4)
            final[i] = v
        cand = order

    # 5. 阈值 + top_k
    results = []
    for i in cand:
        if cosine[i] < params.min_score:
            continue
        results.append({
            "doc_id": metas[i]["doc_id"],
            "doc_name": metas[i]["doc_name"],
            "index": metas[i]["index"],
            "text": texts[i],
            "score": round(final[i], 4),
            "scores": {
                "cosine": round(float(cosine[i]), 4),
                "dot": round(float(dot[i]), 4),
                "l2": round(float(l2[i]), 4),
                "bm25": round(float(bm25[i]), 4),
                "vector_rank": int(vec_rank[i]),
                "bm25_rank": int(bm25_rank[i]),
                **({"hybrid": round(float(base[i]), 4)} if params.method == "hybrid" else {}),
                **extra[i],
            },
        })
        if len(results) >= params.top_k:
            break
    return results
