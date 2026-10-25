"""检索前的问题处理：结合历史改写、多查询（Multi-Query）、HyDE。都需要调用一次 LLM。

- 结合历史改写（condense）：多轮对话里“那北京呢？”这种问题单独拿去检索什么也找不到，
  先让 LLM 结合历史改写成“出差住在北京每晚最多能报销多少？”。
- 多查询（Multi-Query）：让 LLM 把问题换几种说法，每种说法各检索一次，再用 RRF 融合，
  弥补用户措辞和文档措辞不一致的问题，提高召回。
- HyDE（Hypothetical Document Embeddings）：让 LLM 先“编”一段假想的答案，用这段文字的向量去检索。
  假想答案和真实文档的写法更像，向量距离往往比“问题 ↔ 文档”更近。它只影响向量检索，BM25 仍用原问题。
"""
import re
from dataclasses import asdict, dataclass, replace

from .llm import ProviderConfig, create_llm


@dataclass
class QueryParams:
    history_turns: int = 3          # 生成回答时带上最近几轮对话
    condense_history: bool = False  # 检索前结合历史把问题改写成独立问题
    multi_query: bool = False
    multi_query_n: int = 3
    hyde: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


CONDENSE_PROMPT = """根据对话历史，把用户最新的问题改写成一个不依赖上下文、可以单独用于检索的完整问题。
只输出改写后的问题，不要回答它，不要输出其他内容。使用与用户问题相同的语言。"""

MULTI_QUERY_PROMPT = """为了提高知识库检索的召回率，请把用户的问题改写成 {n} 个表达方式不同、意思相同的检索查询。
可以换同义词、换说法、补全省略的主语。每行一个，不要编号，不要输出其他内容。使用与用户问题相同的语言。"""

HYDE_PROMPT = """请写一段可能出现在知识库文档里、能够回答用户问题的文字，大约 100~200 字，直接写正文。
即使不确定具体数字也照常写出，不要说明你不知道。这段文字只用于向量检索，不会展示给用户。使用与用户问题相同的语言。"""


def _complete(cfg: ProviderConfig, system: str, user: str) -> str:
    # 改写类任务很简单：Claude 用低 effort，输出也不需要太长
    fast = replace(cfg, extra={**cfg.extra, "effort": "low", "max_tokens": 1024})
    return "".join(create_llm(fast).stream(system, [{"role": "user", "content": user}])).strip()


def condense(cfg: ProviderConfig, question: str, history: list[dict]) -> str:
    convo = "\n".join(f"{'用户' if m['role'] == 'user' else '助手'}：{m['content'][:500]}" for m in history)
    out = _complete(cfg, CONDENSE_PROMPT, f"<history>\n{convo}\n</history>\n\n最新问题：{question}")
    return out.splitlines()[0].strip() if out else question


def multi_queries(cfg: ProviderConfig, question: str, n: int) -> list[str]:
    out = _complete(cfg, MULTI_QUERY_PROMPT.format(n=n), question)
    lines = [re.sub(r"^\s*(\d+[.、)）]|[-*•])\s*", "", l).strip() for l in out.splitlines()]
    seen, queries = {question}, []
    for l in lines:
        if l and l not in seen:
            seen.add(l)
            queries.append(l)
    return queries[:n]


def hyde_document(cfg: ProviderConfig, question: str) -> str:
    return _complete(cfg, HYDE_PROMPT, question)
