"""把长文档切成带重叠的小块（chunk）。

策略：
1. 先按 Markdown 标题（# / ## …）把文档分成若干小节，chunk 不跨小节；
2. 小节内再按段落、句子（中英文标点）切开；
3. 把句子拼成不超过 chunk_size 个字符的块，相邻块保留 overlap 个字符的重叠，
   避免关键信息正好被切断；
4. 每个块前面加上所在小节的标题，让检索时也能匹配到“这段属于哪一节”。
"""
import re

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


def chunk_text(text: str, chunk_size: int = 300, overlap: int = 50) -> list[str]:
    if overlap >= chunk_size:
        raise ValueError("overlap 必须小于 chunk_size")
    texts = []
    for title, body in split_sections(text):
        prefix = f"【{title}】" if title else ""
        texts += [prefix + c for c in pack(split_sentences(body), chunk_size, overlap)]
    return texts
