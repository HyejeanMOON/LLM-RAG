"""把长文档切成小块（chunk），支持多种切分策略。

- structure（标题 + 句子，默认）：先按 Markdown 标题分节，节内按句子切开，再把句子拼成
  不超过 chunk_size 的块，相邻块保留 overlap 个字符的重叠。
- fixed（固定长度）：不看内容，每 chunk_size 个字符切一刀，滑动窗口重叠 overlap。
- paragraph（按段落）：以空行分段，短段落合并、长段落再按句子切。
- recursive（递归切分）：依次尝试用 段落 → 换行 → 句号 → 逗号 → 空格 → 单字 来切，
  直到每块都不超过 chunk_size（类似 LangChain 的 RecursiveCharacterTextSplitter）。
- semantic（语义切分）：把相邻句子向量化，在语义变化最大的地方断开
  （相邻句子的余弦距离超过第 semantic_percentile 百分位的位置）。

除 fixed 外，切块都不跨 Markdown 小节；add_title 为真时每块前面加上所在小节的标题，
让检索时也能匹配到“这段属于哪一节”。
"""
import re
from dataclasses import asdict, dataclass
from typing import Literal

import numpy as np

Strategy = Literal["structure", "fixed", "paragraph", "recursive", "semantic"]


@dataclass
class ChunkingParams:
    strategy: Strategy = "structure"
    chunk_size: int = 300
    chunk_overlap: int = 50
    add_title: bool = True
    semantic_percentile: int = 80   # 语义切分：距离超过这个百分位就断开，越小切得越碎

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict | None) -> "ChunkingParams":
        known = cls.__dataclass_fields__
        return cls(**{k: v for k, v in (d or {}).items() if k in known})

_SENTENCE_END = re.compile(r"(?<=[。！？!?；;])|(?<=\.)\s")
_HEADING = re.compile(r"^#{1,6}\s+(.*)$")


def split_sections(text: str) -> list[tuple[str, str]]:
    """返回 [(标题, 正文)]，标题前的内容标题为空。"""
    sections, title, body = [], "", []
    for line in text.splitlines():
        m = _HEADING.match(line.strip())
        if m:
            if "".join(body).strip():
                sections.append((title, "\n".join(body)))
            title, body = m.group(1).strip(), []
        else:
            body.append(line)
    if "".join(body).strip():
        sections.append((title, "\n".join(body)))
    return sections


def split_sentences(text: str) -> list[str]:
    sentences = []
    for para in re.split(r"\n\s*\n", text):
        para = " ".join(line.strip() for line in para.splitlines()).strip()
        sentences += [s.strip() for s in _SENTENCE_END.split(para) if s and s.strip()]
    return sentences


def pack(sentences: list[str], chunk_size: int, overlap: int) -> list[str]:
    chunks, current = [], ""
    for sent in sentences:
        # 单个句子超长时硬切
        while len(sent) > chunk_size:
            if current:
                chunks.append(current)
                current = ""
            chunks.append(sent[:chunk_size])
            sent = sent[chunk_size - overlap:]
        if len(current) + len(sent) <= chunk_size:
            current += sent
        else:
            chunks.append(current)
            # 用上一块的结尾作为新块的开头，形成重叠
            current = (current[-overlap:] if overlap else "") + sent
    if current:
        chunks.append(current)
    return chunks


def fixed_windows(text: str, size: int, overlap: int) -> list[str]:
    step = size - overlap
    return [text[i:i + size] for i in range(0, max(len(text) - overlap, 1), step) if text[i:i + size].strip()]


def split_paragraphs(text: str) -> list[str]:
    return [" ".join(l.strip() for l in p.splitlines()).strip() for p in re.split(r"\n\s*\n", text) if p.strip()]


def paragraph_chunks(text: str, size: int, overlap: int) -> list[str]:
    """短段落合并成一块；超过 size 的段落单独按句子切。"""
    chunks, current = [], ""
    for para in split_paragraphs(text):
        if len(para) > size:
            if current:
                chunks.append(current)
                current = ""
            chunks += pack(split_sentences(para), size, overlap)
        elif not current:
            current = para
        elif len(current) + 1 + len(para) <= size:
            current += "\n" + para
        else:
            chunks.append(current)
            current = para
    if current:
        chunks.append(current)
    return chunks


RECURSIVE_SEPARATORS = ["\n\n", "\n", "。", "！", "？", "；", ". ", "，", ", ", " ", ""]


def _split_keep(text: str, sep: str) -> list[str]:
    """按分隔符切开，分隔符留在前一段末尾（句号等标点不丢）。"""
    parts = text.split(sep)
    return [p + sep for p in parts[:-1]] + [parts[-1]]


def recursive_chunks(text: str, size: int, overlap: int, seps: list[str] = RECURSIVE_SEPARATORS) -> list[str]:
    if len(text) <= size:
        return [text] if text.strip() else []
    sep = next((s for s in seps if s == "" or s in text), "")
    if sep == "":
        return fixed_windows(text, size, overlap)
    rest = seps[seps.index(sep) + 1:]

    # 把切开的小段尽量合并到 size 以内；还超长的小段用下一级分隔符继续递归
    chunks, window = [], []
    for piece in (p for p in _split_keep(text, sep) if p):
        if len(piece) > size:
            if window:
                chunks.append("".join(window))
                window = []
            chunks += recursive_chunks(piece, size, overlap, rest)
            continue
        if sum(map(len, window)) + len(piece) > size and window:
            chunks.append("".join(window))
            # 保留末尾若干小段作为重叠
            while window and (sum(map(len, window)) > overlap or sum(map(len, window)) + len(piece) > size):
                window.pop(0)
        window.append(piece)
    if window:
        chunks.append("".join(window))
    return [c.strip() for c in chunks if c.strip()]


def semantic_chunks(text: str, size: int, overlap: int, percentile: int, embedder) -> list[str]:
    sentences = split_sentences(text)
    if len(sentences) <= 1:
        return pack(sentences, size, overlap)
    vecs = np.asarray(embedder.embed_documents(sentences), dtype=np.float32)
    vecs /= np.maximum(np.linalg.norm(vecs, axis=1, keepdims=True), 1e-12)
    distances = 1 - np.sum(vecs[:-1] * vecs[1:], axis=1)   # 相邻句子的余弦距离
    threshold = np.percentile(distances, percentile)
    groups, current = [], [sentences[0]]
    for sent, dist in zip(sentences[1:], distances):
        if dist > threshold:
            groups.append(current)
            current = []
        current.append(sent)
    groups.append(current)
    # 语义组太长时再按长度切；语义切分本身不加重叠
    chunks = []
    for g in groups:
        chunks += pack(g, size, overlap) if sum(map(len, g)) > size else ["".join(g)]
    return chunks


def chunk_text(text: str, params: ChunkingParams | None = None, embedder=None) -> list[str]:
    p = params or ChunkingParams()
    if p.chunk_overlap >= p.chunk_size:
        raise ValueError("overlap 必须小于 chunk_size")
    if p.strategy == "fixed":
        return fixed_windows(text.strip(), p.chunk_size, p.chunk_overlap)

    texts = []
    for title, body in split_sections(text):
        if p.strategy == "structure":
            parts = pack(split_sentences(body), p.chunk_size, p.chunk_overlap)
        elif p.strategy == "paragraph":
            parts = paragraph_chunks(body, p.chunk_size, p.chunk_overlap)
        elif p.strategy == "recursive":
            parts = recursive_chunks(body.strip(), p.chunk_size, p.chunk_overlap)
        elif p.strategy == "semantic":
            if embedder is None:
                from .embeddings import get_embedder

                embedder = get_embedder()
            parts = semantic_chunks(body, p.chunk_size, p.chunk_overlap, p.semantic_percentile, embedder)
        else:
            raise ValueError(f"未知的切分策略：{p.strategy}")
        prefix = f"【{title}】" if title and p.add_title else ""
        texts += [prefix + c for c in parts]
    return texts
