"""上下文组装：把检索到的片段整理成发给 LLM 的参考资料。

- 相邻片段扩展（small-to-big）：检索用小切片更精准，但小切片信息不完整；
  命中后把同一文档前后 neighbor_window 个切片一起带上，相邻或重叠的范围合并成一段。
- 排序方式：
  score    按相关度从高到低；
  document 按文档和原文顺序，读起来更连贯；
  edges    把最相关的放在开头和结尾、最不相关的放中间。研究发现 LLM 对长上下文中间部分
           注意力较弱（"Lost in the Middle"），这样排可以减轻影响。
- 总字数上限 max_chars：超出的片段不再加入，避免上下文过长、成本过高。
"""
from dataclasses import asdict, dataclass
from typing import Callable, Literal


@dataclass
class ContextParams:
    max_chars: int = 6000
    neighbor_window: int = 0
    order: Literal["score", "document", "edges"] = "score"

    def to_dict(self) -> dict:
        return asdict(self)


def _edges_order(items: list) -> list:
    """[1,2,3,4,5]（按相关度） -> [1,3,5,4,2]：最相关的在两头。"""
    front, back = [], []
    for i, it in enumerate(items):
        (front if i % 2 == 0 else back).append(it)
    return front + back[::-1]


def assemble(hits: list[dict], params: ContextParams, get_chunks: Callable[[str], list[dict]]) -> tuple[list[dict], dict]:
    """返回 (blocks, info)。block 是最终放进提示词的一段参考资料。"""
    w = max(0, params.neighbor_window)
    # 1. 每个命中片段扩展成 [start, end] 范围，同一文档里重叠或相邻的范围合并
    by_doc: dict[str, list[dict]] = {}
    for rank, h in enumerate(hits):
        by_doc.setdefault(h["doc_id"], []).append({"start": h["index"] - w, "end": h["index"] + w, "hits": [h], "rank": rank})
    blocks = []
    for doc_id, ranges in by_doc.items():
        chunks = {c["index"]: c["text"] for c in get_chunks(doc_id)} if w else {}
        ranges.sort(key=lambda r: r["start"])
        merged = []
        for r in ranges:
            if merged and r["start"] <= merged[-1]["end"] + (1 if w else 0):
                m = merged[-1]
                m["end"] = max(m["end"], r["end"])
                m["hits"] += r["hits"]
                m["rank"] = min(m["rank"], r["rank"])
            else:
                merged.append(r)
        for m in merged:
            best = min(m["hits"], key=lambda h: hits.index(h))
            if w:
                idxs = [i for i in range(m["start"], m["end"] + 1) if i in chunks]
                text = "\n".join(chunks[i] for i in idxs)
            else:
                idxs = [best["index"]]
                text = best["text"]
            blocks.append({
                "doc_id": doc_id,
                "doc_name": best["doc_name"],
                "index": idxs[0],
                "indexes": idxs,
                "hit_indexes": sorted(h["index"] for h in m["hits"]),
                "text": text,
                "score": best["score"],
                "scores": best["scores"],
                "_rank": m["rank"],
            })

    # 2. 排序
    blocks.sort(key=lambda b: b["_rank"])
    if params.order == "document":
        blocks.sort(key=lambda b: (b["doc_name"], b["index"]))
    elif params.order == "edges":
        blocks = _edges_order(blocks)

    # 3. 总字数预算（按相关度优先保留，再恢复上面的顺序）
    kept, total = set(), 0
    for b in sorted(blocks, key=lambda b: b["_rank"]):
        if total + len(b["text"]) <= params.max_chars:
            kept.add(id(b))
            total += len(b["text"])
    if not kept and blocks:  # 第一段就超长：截断保留
        first = min(blocks, key=lambda b: b["_rank"])
        first["text"] = first["text"][: params.max_chars]
        kept.add(id(first))
        total = len(first["text"])
    final = [b for b in blocks if id(b) in kept]
    for b in final:
        b.pop("_rank")
    info = {"hits": len(hits), "blocks": len(final), "dropped": len(blocks) - len(final), "chars": total}
    return final, info
