"""不需要 LLM 的评测指标。

检索指标需要“证据”：每道题标注一段或几段能回答问题的原文（evidence）。
检索到的切片和证据的字符二元组重合度 ≥ 阈值，就算这个切片“覆盖”了这段证据。
用原文片段而不是切片编号做标注，换切分策略、重建索引之后标注仍然有效。
"""
import math
import re
from collections import Counter

import numpy as np

# ---------- 文本归一化与分词 ----------

_PUNCT = re.compile(r"[\s\W_]+", re.UNICODE)
_WORD = re.compile(r"[a-z0-9]+|[一-鿿]")


def normalize(text: str) -> str:
    """小写、去掉空白和标点，用于精确匹配和证据比对。"""
    return _PUNCT.sub("", (text or "").lower())


def words(text: str) -> list[str]:
    """评测用的分词：英文 / 数字按单词，中文按单字（BLEU、ROUGE、F1 的常见做法）。"""
    return _WORD.findall((text or "").lower())


def _bigrams(s: str) -> set[str]:
    return {s[i:i + 2] for i in range(len(s) - 1)} if len(s) > 1 else {s} if s else set()


def coverage(evidence: str, chunk: str) -> float:
    """证据有多大比例出现在切片里（字符二元组的包含率，0~1）。"""
    e, c = normalize(evidence), normalize(chunk)
    if not e:
        return 0.0
    if e in c:
        return 1.0
    eb = _bigrams(e)
    return len(eb & _bigrams(c)) / len(eb)


# ---------- 检索指标 ----------

def match_evidence(chunks: list[str], evidence: list[str], threshold: float = 0.6) -> list[list[int]]:
    """对每个检索到的切片，返回它覆盖了哪些证据（证据下标列表）。"""
    return [[j for j, e in enumerate(evidence) if coverage(e, c) >= threshold] for c in chunks]


def retrieval_metrics(chunks: list[str], evidence: list[str], threshold: float = 0.6) -> tuple[dict, dict]:
    """返回 (分数, 细节)。K 取实际检索到的切片数。

    - 切片“相关”：覆盖了至少一段证据（Precision 用）
    - 切片“新命中”：覆盖了前面切片还没覆盖的证据（MAP、NDCG 用，避免同一段证据被重复计分）
    """
    k = len(chunks)
    matches = match_evidence(chunks, evidence, threshold)
    relevant = [bool(m) for m in matches]
    covered: set[int] = set()
    gains = []
    for m in matches:
        new = set(m) - covered
        gains.append(1 if new else 0)
        covered |= new

    n_ev = len(evidence)
    first = next((i for i, r in enumerate(relevant) if r), None)
    hits_so_far, ap = 0, 0.0
    for i, g in enumerate(gains, 1):
        if g:
            hits_so_far += 1
            ap += hits_so_far / i
    ideal = min(n_ev, k)
    dcg = sum(g / math.log2(i + 1) for i, g in enumerate(gains, 1))
    idcg = sum(1 / math.log2(i + 1) for i in range(1, ideal + 1))
    scores = {
        "hit_rate": 1.0 if covered else 0.0,
        "recall_at_k": len(covered) / n_ev,
        "precision_at_k": sum(relevant) / k if k else 0.0,
        "mrr": 1 / (first + 1) if first is not None else 0.0,
        "map_at_k": ap / ideal if ideal else 0.0,
        "ndcg_at_k": dcg / idcg if idcg else 0.0,
    }
    details = {"matches": matches, "covered": sorted(covered), "k": k}
    return scores, details


# ---------- 文本指标（需要参考答案） ----------

def exact_match(answer: str, reference: str) -> float:
    return 1.0 if normalize(answer) == normalize(reference) and normalize(reference) else 0.0


def token_f1(answer: str, reference: str) -> float:
    """SQuAD 式 Token F1：按词袋算精确率和召回率的调和平均。"""
    a, r = Counter(words(answer)), Counter(words(reference))
    same = sum((a & r).values())
    if not same:
        return 0.0
    p, rc = same / sum(a.values()), same / sum(r.values())
    return 2 * p * rc / (p + rc)


def _ngrams(tokens: list[str], n: int) -> Counter:
    return Counter(tuple(tokens[i:i + n]) for i in range(len(tokens) - n + 1))


def bleu(answer: str, reference: str, max_n: int = 4) -> float:
    """句子级 BLEU-4：1~4 元组修正精确率的几何平均 × 简短惩罚（加 1 平滑，避免短句直接为 0）。"""
    a, r = words(answer), words(reference)
    if not a or not r:
        return 0.0
    log_p = 0.0
    for n in range(1, max_n + 1):
        an, rn = _ngrams(a, n), _ngrams(r, n)
        overlap, total = sum((an & rn).values()), sum(an.values())
        if n == 1 and not overlap:
            return 0.0
        smooth = 1 if n > 1 else 0
        log_p += math.log((overlap + smooth) / (total + smooth))
    bp = 1.0 if len(a) > len(r) else math.exp(1 - len(r) / len(a))
    return bp * math.exp(log_p / max_n)


def _f(p: float, r: float) -> float:
    return 2 * p * r / (p + r) if p + r else 0.0


def rouge_n(answer: str, reference: str, n: int) -> float:
    an, rn = _ngrams(words(answer), n), _ngrams(words(reference), n)
    overlap = sum((an & rn).values())
    if not overlap:
        return 0.0
    return _f(overlap / sum(an.values()), overlap / sum(rn.values()))


def _lcs(a: list[str], b: list[str]) -> int:
    prev = [0] * (len(b) + 1)
    for x in a:
        cur = [0]
        for j, y in enumerate(b, 1):
            cur.append(prev[j - 1] + 1 if x == y else max(prev[j], cur[j - 1]))
        prev = cur
    return prev[-1]


def rouge_l(answer: str, reference: str) -> float:
    a, r = words(answer), words(reference)
    if not a or not r:
        return 0.0
    lcs = _lcs(a, r)
    return _f(lcs / len(a), lcs / len(r))


def cosine(u, v) -> float:
    u, v = np.asarray(u, dtype=np.float64), np.asarray(v, dtype=np.float64)
    nu, nv = np.linalg.norm(u), np.linalg.norm(v)
    return float(u @ v / (nu * nv)) if nu and nv else 0.0


def semantic_similarity(embedder, answer: str, reference: str) -> float:
    a, r = embedder.embed_documents([answer, reference])
    return cosine(a, r)


def text_metrics(answer: str, reference: str, wanted: set[str], embedder=None) -> dict:
    fns = {
        "exact_match": lambda: exact_match(answer, reference),
        "token_f1": lambda: token_f1(answer, reference),
        "bleu": lambda: bleu(answer, reference),
        "rouge_1": lambda: rouge_n(answer, reference, 1),
        "rouge_2": lambda: rouge_n(answer, reference, 2),
        "rouge_l": lambda: rouge_l(answer, reference),
        "semantic_similarity": lambda: semantic_similarity(embedder, answer, reference),
    }
    return {k: fn() for k, fn in fns.items() if k in wanted}
