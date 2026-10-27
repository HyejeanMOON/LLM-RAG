"""测试集来源：内置示例，或者用 LLM 从文档切片自动生成（合成数据）。

自动生成的思路（类似 RAGAS 的 testset generation 简化版）：随机抽几个切片，
让 LLM 针对每个切片出一道题、写参考答案，并原样摘出能回答问题的句子作为证据。
生成的题目难免有瑕疵（太简单、证据摘错），建议生成后人工过一遍。
"""
import json
import random

from .. import config
from ..i18n import get_lang, t
from ..services import documents
from .judge import JudgeError, ask_json
from .metrics import coverage

QA_PROMPT = """You write evaluation questions for a retrieval-augmented QA system.
Given a PASSAGE from a document, write one question that a user might realistically ask and that this passage answers.
- The question must make sense on its own (don't say "according to the passage").
- "answer": a concise reference answer, based only on the passage.
- "evidence": copy the sentence(s) from the passage that contain the answer, verbatim.
- Write the question and answer in the same language as the passage.
Output: {"question": "...", "answer": "...", "evidence": ["..."]}"""

UNANSWERABLE_PROMPT = """You write evaluation questions for a retrieval-augmented QA system over a company document.
Here are some passages from the document so you know its topic. Write {n} questions that a user might plausibly ask about this company,
but that the document does NOT answer (the information is simply not there). Use the same language as the passages.
Output: {{"questions": ["...", "..."]}}"""


def sample_set(lang: str | None = None) -> dict:
    path = config.BASE_DIR / "sample_docs" / f"eval_xinghe.{lang or get_lang()}.json"
    return json.loads(path.read_text(encoding="utf-8"))


def _all_chunks(doc_ids: list[str] | None) -> list[dict]:
    docs = [d for d in documents.list_documents() if not doc_ids or d["id"] in doc_ids]
    return [{**c, "doc_name": d["name"]} for d in docs for c in documents.get_chunks(d["id"])]


def generate(cfg, n: int, n_unanswerable: int = 0, doc_ids: list[str] | None = None, seed: int | None = None) -> tuple[list[dict], list[str]]:
    """返回 (题目列表, 出错信息列表)。"""
    chunks = [c for c in _all_chunks(doc_ids) if len(c["text"]) >= 40]  # 太短的切片出不了好题
    if not chunks:
        raise ValueError(t("没有可以出题的切片（先添加文档）", "No chunks to generate questions from (add documents first)"))
    rng = random.Random(seed)
    picked = rng.sample(chunks, min(n, len(chunks)))
    items, errors = [], []
    for c in picked:
        try:
            out = ask_json(cfg, QA_PROMPT, f"PASSAGE:\n{c['text']}")
        except JudgeError as e:
            errors.append(str(e))
            continue
        q, a = str(out.get("question") or "").strip(), str(out.get("answer") or "").strip()
        if not q:
            continue
        # 证据必须真的出现在切片里，否则退回用整个切片
        ev = [e for e in out.get("evidence") or [] if isinstance(e, str) and coverage(e, c["text"]) >= 0.8]
        items.append({"question": q, "reference_answer": a, "evidence": ev or [c["text"]], "answerable": True,
                      "source": f"{c.get('doc_name', '')}#{c['index']}"})
    if n_unanswerable:
        context = "\n\n".join(c["text"][:300] for c in picked[:5])
        try:
            out = ask_json(cfg, UNANSWERABLE_PROMPT.format(n=n_unanswerable), f"PASSAGES:\n{context}")
            for q in (out.get("questions") or [])[:n_unanswerable]:
                if isinstance(q, str) and q.strip():
                    items.append({"question": q.strip(), "reference_answer": "", "evidence": [], "answerable": False, "source": "generated"})
        except JudgeError as e:
            errors.append(str(e))
    return items, errors
