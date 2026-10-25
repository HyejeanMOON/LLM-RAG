"""RAG 主流程：检索切片 → 拼提示词 → 流式调用所选 LLM。"""
from typing import Iterator

from ..llm import create_llm
from ..retrieval import retrieve as run_retrieval
from . import providers, settings

SYSTEM_PROMPT = """你是一个基于检索资料回答问题的助手。
用户消息中会给出若干编号的参考片段（<source id="N">），请只依据这些片段回答问题：
- 在用到某个片段的句子后标注来源，例如 [1] 或 [2][3]。
- 如果片段中没有足够的信息回答问题，请直接说明“资料中没有找到相关信息”，不要编造。
- 默认使用与用户提问相同的语言回答。"""


def retrieve(question: str, overrides: dict | None = None, doc_ids: list[str] | None = None) -> list[dict]:
    """按设置里的默认检索策略检索，overrides 可以临时覆盖其中的参数。"""
    return run_retrieval(question, settings.retrieval_params(overrides), doc_ids)


def build_user_message(question: str, hits: list[dict]) -> str:
    if not hits:
        return f"<sources>\n（没有检索到相关片段）\n</sources>\n\n问题：{question}"
    sources = "\n\n".join(
        f'<source id="{i}" file="{h["doc_name"]}">\n{h["text"]}\n</source>'
        for i, h in enumerate(hits, 1)
    )
    return f"<sources>\n{sources}\n</sources>\n\n问题：{question}"


def _clean_history(history: list[dict], turns: int) -> list[dict]:
    """只保留 user/assistant 交替的最近几轮，保证第一条是 user。"""
    msgs = [
        {"role": m["role"], "content": m["content"]}
        for m in history
        if m.get("role") in ("user", "assistant") and (m.get("content") or "").strip()
    ]
    cleaned = []
    for m in msgs:
        if cleaned and cleaned[-1]["role"] == m["role"]:
            cleaned[-1] = m
        else:
            cleaned.append(m)
    while cleaned and cleaned[0]["role"] != "user":
        cleaned.pop(0)
    if cleaned and cleaned[-1]["role"] == "user":
        cleaned.pop()
    return cleaned[-turns * 2:] if turns > 0 else []


def answer_stream(question: str, hits: list[dict], provider_id: str | None = None,
                  history: list[dict] | None = None) -> Iterator[str]:
    cfg = providers.get_config(provider_id)
    llm = create_llm(cfg)
    messages = _clean_history(history or [], settings.get("history_turns"))
    messages.append({"role": "user", "content": build_user_message(question, hits)})
    yield from llm.stream(SYSTEM_PROMPT, messages)
