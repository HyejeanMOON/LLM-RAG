"""LLM-as-a-Judge：让一个 LLM 当裁判给 RAG 的输出打分。

指标设计参考 RAGAS（faithfulness / answer relevancy / context precision / context recall /
answer correctness）和 G-Eval（先列评分步骤再打 1~5 分）。每个函数返回 (分数 0~1 或 None, 细节)，
细节里保留裁判的逐条判断和理由，前端可以展开查看，方便理解分数是怎么来的。
"""
import json
import re
from dataclasses import replace

from ..i18n import get_lang
from ..llm import ProviderConfig, create_llm
from .metrics import cosine

MAX_CONTEXT_CHARS = 1500  # 每个片段最多给裁判看多少字，控制成本


class JudgeError(ValueError):
    pass


def complete(cfg: ProviderConfig, system: str, user: str, max_tokens: int = 2048) -> str:
    # 裁判任务用低 effort / 低温度，结果更稳定也更便宜
    extra = {**cfg.extra, "effort": "low", "max_tokens": max_tokens}
    if cfg.type == "openai":
        extra["temperature"] = 0
    return "".join(create_llm(replace(cfg, extra=extra)).stream(system, [{"role": "user", "content": user}])).strip()


def parse_json(text: str):
    """从模型输出里取出 JSON（允许包在 ```json 代码块里或前后有多余文字）。"""
    fenced = re.search(r"```(?:json)?\s*(.+?)```", text, re.S)
    if fenced:
        text = fenced.group(1)
    start = min([i for i in (text.find("{"), text.find("[")) if i >= 0], default=-1)
    end = max(text.rfind("}"), text.rfind("]"))
    if start < 0 or end < start:
        raise JudgeError(f"no JSON in judge output: {text[:200]}")
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError as e:
        raise JudgeError(f"invalid JSON from judge: {e}: {text[:200]}") from e


def ask_json(cfg: ProviderConfig, system: str, user: str) -> dict:
    lang = "Chinese" if get_lang() == "zh" else "English"
    system = f"{system}\n\nRespond with JSON only, no other text. Write every free-text field (reasons, statements) in {lang}."
    out = parse_json(complete(cfg, system, user))
    if not isinstance(out, dict):
        raise JudgeError("judge output is not a JSON object")
    return out


def _passages(contexts: list[str]) -> str:
    return "\n\n".join(f"[{i}] {c[:MAX_CONTEXT_CHARS]}" for i, c in enumerate(contexts, 1)) or "(none)"


def _flag(v) -> int:
    if isinstance(v, str):
        return 1 if v.strip().lower() in {"1", "yes", "true", "y", "是"} else 0
    return 1 if v else 0


# ---------- 忠实度（Faithfulness） ----------

STATEMENTS_PROMPT = """Break the ANSWER into short, self-contained factual statements. Each statement must be understandable without the others (replace pronouns with what they refer to).
Ignore greetings, citations like [1], and sentences that only say the information was not found.
Output: {"statements": ["...", "..."]}"""

VERIFY_PROMPT = """You are checking whether statements are supported by the CONTEXT.
For each statement, verdict 1 if it can be directly inferred from the context, 0 if it cannot (contradicted or not mentioned). Do not use outside knowledge.
Output: {"verdicts": [{"statement": "...", "verdict": 1, "reason": "..."}]}"""


def faithfulness(cfg, question: str, answer: str, contexts: list[str]):
    stmts = ask_json(cfg, STATEMENTS_PROMPT, f"QUESTION: {question}\n\nANSWER:\n{answer}").get("statements") or []
    stmts = [s for s in stmts if isinstance(s, str) and s.strip()]
    if not stmts:
        return None, {"statements": [], "note": "no factual statements in the answer"}
    listing = "\n".join(f"{i}. {s}" for i, s in enumerate(stmts, 1))
    verdicts = ask_json(cfg, VERIFY_PROMPT, f"CONTEXT:\n{_passages(contexts)}\n\nSTATEMENTS:\n{listing}").get("verdicts") or []
    verdicts = [{"statement": v.get("statement", ""), "verdict": _flag(v.get("verdict")), "reason": v.get("reason", "")} for v in verdicts]
    if not verdicts:
        raise JudgeError("judge returned no verdicts")
    return sum(v["verdict"] for v in verdicts) / len(verdicts), {"verdicts": verdicts}


# ---------- 答案相关性（Answer Relevancy） ----------

REVERSE_QUESTIONS_PROMPT = """Given an ANSWER, write {n} different questions that this answer would be a good answer to.
Also set "noncommittal" to 1 if the answer is evasive, vague or says it doesn't know (e.g. "I couldn't find this"), otherwise 0.
Output: {{"questions": ["...", "..."], "noncommittal": 0}}"""


def answer_relevancy(cfg, embedder, question: str, answer: str, n: int = 3):
    out = ask_json(cfg, REVERSE_QUESTIONS_PROMPT.format(n=n), f"ANSWER:\n{answer}")
    gen = [q for q in out.get("questions") or [] if isinstance(q, str) and q.strip()]
    if not gen:
        raise JudgeError("judge generated no questions")
    vecs = embedder.embed_documents([question, *gen])
    sims = [cosine(vecs[0], v) for v in vecs[1:]]
    noncommittal = _flag(out.get("noncommittal"))
    score = 0.0 if noncommittal else sum(sims) / len(sims)
    return score, {"generated_questions": [{"question": q, "similarity": s} for q, s in zip(gen, sims)], "noncommittal": noncommittal}


# ---------- 上下文精确率 / 召回率 / 相关性 ----------

CONTEXT_PRECISION_PROMPT = """Given a QUESTION, its REFERENCE ANSWER and retrieved PASSAGES (numbered by rank), decide for each passage whether it was useful for arriving at the reference answer (1) or not (0).
Output: {"verdicts": [{"index": 1, "useful": 1, "reason": "..."}]}  (one entry per passage, in order)"""

CONTEXT_RECALL_PROMPT = """Break the REFERENCE ANSWER into short factual statements. For each statement, decide whether it can be attributed to the retrieved PASSAGES (1) or not (0).
Output: {"statements": [{"statement": "...", "attributed": 1, "reason": "..."}]}"""

CONTEXT_RELEVANCE_PROMPT = """Given a QUESTION and retrieved PASSAGES, decide for each passage whether it contains information relevant to answering the question (1) or not (0).
Output: {"verdicts": [{"index": 1, "relevant": 1, "reason": "..."}]}  (one entry per passage, in order)"""


def _per_passage(cfg, prompt: str, user: str, key: str, n: int) -> list[dict]:
    verdicts = ask_json(cfg, prompt, user).get("verdicts") or []
    by_index = {}
    for i, v in enumerate(verdicts, 1):
        idx = v.get("index", i) if isinstance(v.get("index", i), int) else i
        by_index[idx] = {"index": idx, key: _flag(v.get(key)), "reason": v.get("reason", "")}
    # 裁判漏掉的片段按 0 处理
    return [by_index.get(i, {"index": i, key: 0, "reason": "(missing from judge output)"}) for i in range(1, n + 1)]


def context_precision(cfg, question: str, reference: str, contexts: list[str]):
    if not contexts:
        return 0.0, {"verdicts": []}
    v = _per_passage(cfg, CONTEXT_PRECISION_PROMPT,
                     f"QUESTION: {question}\n\nREFERENCE ANSWER: {reference}\n\nPASSAGES:\n{_passages(contexts)}", "useful", len(contexts))
    # 排名加权：Σ(Precision@k × v_k) / 有用片段数，有用的片段越靠前分越高
    useful, total = 0, 0.0
    for k, item in enumerate(v, 1):
        if item["useful"]:
            useful += 1
            total += useful / k
    return (total / useful if useful else 0.0), {"verdicts": v}


def context_recall(cfg, question: str, reference: str, contexts: list[str]):
    out = ask_json(cfg, CONTEXT_RECALL_PROMPT, f"QUESTION: {question}\n\nREFERENCE ANSWER:\n{reference}\n\nPASSAGES:\n{_passages(contexts)}")
    stmts = [{"statement": s.get("statement", ""), "attributed": _flag(s.get("attributed")), "reason": s.get("reason", "")}
             for s in out.get("statements") or [] if isinstance(s, dict)]
    if not stmts:
        raise JudgeError("judge returned no statements")
    return sum(s["attributed"] for s in stmts) / len(stmts), {"statements": stmts}


def context_relevance(cfg, question: str, contexts: list[str]):
    if not contexts:
        return 0.0, {"verdicts": []}
    v = _per_passage(cfg, CONTEXT_RELEVANCE_PROMPT, f"QUESTION: {question}\n\nPASSAGES:\n{_passages(contexts)}", "relevant", len(contexts))
    return sum(x["relevant"] for x in v) / len(v), {"verdicts": v}


# ---------- 答案正确性（RAGAS 式）和 G-Eval ----------

CORRECTNESS_PROMPT = """Compare the ANSWER with the REFERENCE ANSWER to the QUESTION. Classify statements into:
- TP: statements in the answer that are supported by the reference
- FP: statements in the answer that are not supported by (or contradict) the reference
- FN: statements in the reference that are missing from the answer
Output: {"TP": ["..."], "FP": ["..."], "FN": ["..."]}"""


def answer_correctness(cfg, embedder, question: str, answer: str, reference: str, weight: float = 0.75):
    out = ask_json(cfg, CORRECTNESS_PROMPT, f"QUESTION: {question}\n\nANSWER:\n{answer}\n\nREFERENCE ANSWER:\n{reference}")
    tp, fp, fn = (len(out.get(k) or []) for k in ("TP", "FP", "FN"))
    f1 = tp / (tp + 0.5 * (fp + fn)) if tp + fp + fn else 0.0
    vec = embedder.embed_documents([answer, reference])
    sim = cosine(vec[0], vec[1])
    # 事实层面的 F1 为主，语义相似度为辅（RAGAS 默认 0.75 : 0.25）
    return weight * f1 + (1 - weight) * sim, {"TP": out.get("TP") or [], "FP": out.get("FP") or [], "FN": out.get("FN") or [],
                                              "factual_f1": f1, "semantic_similarity": sim, "weight": weight}


GEVAL_PROMPT = """You are grading an answer produced by a retrieval-augmented assistant.
Evaluation criteria (score 1-5):
5 = fully correct and complete compared with the reference, no unsupported content
4 = correct with minor omissions
3 = partially correct, or correct but with some unsupported content
2 = mostly incorrect or missing the key point
1 = wrong, irrelevant, or a refusal when the reference has an answer
Evaluation steps: 1) identify the key facts in the reference; 2) check each against the answer; 3) look for claims not supported by the reference or context; 4) choose the score.
Output: {"steps": ["...", "..."], "score": 4}"""


def geval(cfg, question: str, answer: str, reference: str, contexts: list[str]):
    out = ask_json(cfg, GEVAL_PROMPT, f"QUESTION: {question}\n\nREFERENCE ANSWER:\n{reference}\n\nCONTEXT:\n{_passages(contexts)}\n\nANSWER TO GRADE:\n{answer}")
    try:
        s = min(5.0, max(1.0, float(out.get("score"))))
    except (TypeError, ValueError) as e:
        raise JudgeError("judge returned no score") from e
    return (s - 1) / 4, {"raw_score": s, "steps": out.get("steps") or []}


# ---------- 拒答（Negative Rejection） ----------

REFUSAL_PROMPT = """Decide whether the ANSWER declines to answer / says the information is not available (1), or gives a substantive answer (0).
Output: {"refused": 1, "reason": "..."}"""


def refusal(cfg, question: str, answer: str):
    out = ask_json(cfg, REFUSAL_PROMPT, f"QUESTION: {question}\n\nANSWER:\n{answer}")
    refused = _flag(out.get("refused"))
    return refused, {"refused": refused, "reason": out.get("reason", "")}


# ---------- 成对比较（Pairwise） ----------

PAIRWISE_PROMPT = """Two assistants answered the same QUESTION using retrieved documents. Using the REFERENCE ANSWER (if given) as ground truth, decide which answer is better: more correct, more complete, no made-up content, appropriate citations. Length alone is not a reason to prefer an answer.
Output: {"winner": "A" | "B" | "tie", "reason": "..."}"""


def pairwise(cfg, question: str, reference: str, answer_a: str, answer_b: str) -> dict:
    """交换顺序各问一次，消除“位置偏差”（裁判倾向于选排在前面的那个）；两次结论不一致算平局。"""
    def ask(first: str, second: str) -> tuple[str, str]:
        out = ask_json(cfg, PAIRWISE_PROMPT,
                       f"QUESTION: {question}\n\nREFERENCE ANSWER: {reference or '(none)'}\n\nANSWER A:\n{first}\n\nANSWER B:\n{second}")
        w = str(out.get("winner", "tie")).strip().upper()
        return (w if w in {"A", "B"} else "tie"), out.get("reason", "")

    w1, r1 = ask(answer_a, answer_b)
    w2, r2 = ask(answer_b, answer_a)
    w2 = {"A": "B", "B": "A"}.get(w2, "tie")  # 换回原来的标签
    winner = w1 if w1 == w2 else "tie"
    return {"winner": winner, "consistent": w1 == w2, "rounds": [{"order": "A,B", "winner": w1, "reason": r1}, {"order": "B,A", "winner": w2, "reason": r2}]}
