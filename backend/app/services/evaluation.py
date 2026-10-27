"""评测：测试集的增删改查、在后台线程里跑评测任务、成对比较。

一次评测 = 对测试集里的每道题跑一遍 RAG 流程（可以临时覆盖检索 / 问题处理 / 上下文 / 生成参数），
然后按选中的指标打分，最后对每个指标求平均。不同配置各跑一次，就能在前端并排比较。
"""
import json
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from .. import db
from ..evaluation import judge, metrics, testset
from ..i18n import get_lang, set_lang, t
from ..llm import create_llm
from . import providers, rag, settings

# 指标注册表：group 决定在哪一组显示；needs 是这个指标需要的东西
#   evidence 题目标注了证据   reference 有参考答案   answer 需要生成回答   judge 需要裁判 LLM
#   answerable 只对“文档里有答案”的题计算   unanswerable 只对“文档里没答案”的题计算
METRICS: dict[str, dict] = {
    # 检索（不需要 LLM）
    "hit_rate": {"group": "retrieval", "needs": {"evidence", "answerable"}},
    "recall_at_k": {"group": "retrieval", "needs": {"evidence", "answerable"}},
    "precision_at_k": {"group": "retrieval", "needs": {"evidence", "answerable"}},
    "mrr": {"group": "retrieval", "needs": {"evidence", "answerable"}},
    "map_at_k": {"group": "retrieval", "needs": {"evidence", "answerable"}},
    "ndcg_at_k": {"group": "retrieval", "needs": {"evidence", "answerable"}},
    # 回答和参考答案的文本相似度（不需要裁判）
    "exact_match": {"group": "text", "needs": {"answer", "reference", "answerable"}},
    "token_f1": {"group": "text", "needs": {"answer", "reference", "answerable"}},
    "bleu": {"group": "text", "needs": {"answer", "reference", "answerable"}},
    "rouge_1": {"group": "text", "needs": {"answer", "reference", "answerable"}},
    "rouge_2": {"group": "text", "needs": {"answer", "reference", "answerable"}},
    "rouge_l": {"group": "text", "needs": {"answer", "reference", "answerable"}},
    "semantic_similarity": {"group": "text", "needs": {"answer", "reference", "answerable"}},
    # LLM 裁判
    "faithfulness": {"group": "judge", "needs": {"answer", "judge"}},
    "answer_relevancy": {"group": "judge", "needs": {"answer", "judge", "answerable"}},
    "context_precision": {"group": "judge", "needs": {"reference", "judge", "answerable"}},
    "context_recall": {"group": "judge", "needs": {"reference", "judge", "answerable"}},
    "context_relevance": {"group": "judge", "needs": {"judge", "answerable"}},
    "answer_correctness": {"group": "judge", "needs": {"answer", "reference", "judge", "answerable"}},
    "geval": {"group": "judge", "needs": {"answer", "reference", "judge", "answerable"}},
    "negative_rejection": {"group": "judge", "needs": {"answer", "judge", "unanswerable"}},
    "false_refusal": {"group": "judge", "needs": {"answer", "judge", "answerable"}, "lower_better": True},
}
# 每次都会记录的系统指标
SYSTEM_METRICS = {"latency_ms": True, "retrieval_ms": True, "context_chars": True, "answer_chars": None}

_cancel: dict[str, threading.Event] = {}


class NotFound(LookupError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def metric_list() -> list[dict]:
    out = [{"key": k, "group": v["group"], "needs": sorted(v["needs"]), "lower_better": v.get("lower_better", False)} for k, v in METRICS.items()]
    out += [{"key": k, "group": "system", "needs": [], "lower_better": bool(v)} for k, v in SYSTEM_METRICS.items()]
    return out


# ---------- 测试集 ----------

def _item_out(r) -> dict:
    return {"id": r["id"], "question": r["question"], "reference_answer": r["reference_answer"],
            "evidence": json.loads(r["evidence"]), "answerable": bool(r["answerable"]), "source": r["source"]}


def list_sets() -> list[dict]:
    with db.tx() as conn:
        rows = conn.execute(
            "SELECT s.*, (SELECT COUNT(*) FROM eval_items i WHERE i.set_id = s.id) AS item_count, "
            "(SELECT COUNT(*) FROM eval_runs r WHERE r.set_id = s.id) AS run_count FROM eval_sets s ORDER BY created_at"
        ).fetchall()
    return [dict(r) for r in rows]


def get_set(set_id: str) -> dict:
    with db.tx() as conn:
        s = conn.execute("SELECT * FROM eval_sets WHERE id = ?", (set_id,)).fetchone()
        if not s:
            raise NotFound(set_id)
        items = conn.execute("SELECT * FROM eval_items WHERE set_id = ? ORDER BY position", (set_id,)).fetchall()
    return {**dict(s), "items": [_item_out(i) for i in items]}


def _clean_item(it: dict) -> dict:
    return {
        "question": str(it.get("question") or "").strip(),
        "reference_answer": str(it.get("reference_answer") or "").strip(),
        "evidence": [str(e).strip() for e in it.get("evidence") or [] if str(e).strip()],
        "answerable": bool(it.get("answerable", True)),
        "source": str(it.get("source") or ""),
    }


def _write_items(conn, set_id: str, items: list[dict]):
    conn.execute("DELETE FROM eval_items WHERE set_id = ?", (set_id,))
    for pos, it in enumerate(i for i in map(_clean_item, items) if i["question"]):
        conn.execute(
            "INSERT INTO eval_items (id, set_id, position, question, reference_answer, evidence, answerable, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (uuid.uuid4().hex[:12], set_id, pos, it["question"], it["reference_answer"], json.dumps(it["evidence"], ensure_ascii=False),
             int(it["answerable"]), it["source"]),
        )


def create_set(name: str, items: list[dict] | None = None) -> dict:
    sid = uuid.uuid4().hex[:12]
    with db.tx() as conn:
        conn.execute("INSERT INTO eval_sets (id, name, created_at) VALUES (?, ?, ?)", (sid, name, _now()))
        _write_items(conn, sid, items or [])
    return get_set(sid)


def update_set(set_id: str, name: str | None, items: list[dict] | None) -> dict:
    get_set(set_id)
    with db.tx() as conn:
        if name:
            conn.execute("UPDATE eval_sets SET name = ? WHERE id = ?", (name, set_id))
        if items is not None:
            _write_items(conn, set_id, items)
    return get_set(set_id)


def delete_set(set_id: str):
    get_set(set_id)
    with db.tx() as conn:
        run_ids = [r["id"] for r in conn.execute("SELECT id FROM eval_runs WHERE set_id = ?", (set_id,))]
        for rid in run_ids:
            conn.execute("DELETE FROM eval_results WHERE run_id = ?", (rid,))
        conn.execute("DELETE FROM eval_runs WHERE set_id = ?", (set_id,))
        conn.execute("DELETE FROM eval_items WHERE set_id = ?", (set_id,))
        conn.execute("DELETE FROM eval_sets WHERE id = ?", (set_id,))


def export_set(set_id: str) -> dict:
    s = get_set(set_id)
    return {"name": s["name"], "items": [{k: v for k, v in i.items() if k != "id"} for i in s["items"]]}


def create_sample_set() -> dict:
    data = testset.sample_set(get_lang())
    return create_set(data["name"], data["items"])


def generate_items(set_id: str, provider_id: str | None, n: int, n_unanswerable: int, doc_ids: list[str] | None) -> dict:
    s = get_set(set_id)
    items, errors = testset.generate(providers.get_config(provider_id), n, n_unanswerable, doc_ids)
    out = update_set(set_id, None, [*s["items"], *items])
    return {**out, "generated": len(items), "errors": errors}


# ---------- 评测任务 ----------

def _run_out(r, with_results: bool = False) -> dict:
    d = dict(r)
    d["config"] = json.loads(d["config"])
    d["summary"] = json.loads(d["summary"])
    if with_results:
        with db.tx() as conn:
            rows = conn.execute("SELECT data FROM eval_results WHERE run_id = ? ORDER BY position", (d["id"],)).fetchall()
        d["results"] = [json.loads(x["data"]) for x in rows]
    return d


def list_runs(set_id: str) -> list[dict]:
    with db.tx() as conn:
        rows = conn.execute("SELECT * FROM eval_runs WHERE set_id = ? ORDER BY created_at", (set_id,)).fetchall()
    return [_run_out(r) for r in rows]


def get_run(run_id: str, with_results: bool = True) -> dict:
    with db.tx() as conn:
        r = conn.execute("SELECT * FROM eval_runs WHERE id = ?", (run_id,)).fetchone()
    if not r:
        raise NotFound(run_id)
    return _run_out(r, with_results)


def delete_run(run_id: str):
    get_run(run_id, False)
    cancel_run(run_id)
    with db.tx() as conn:
        conn.execute("DELETE FROM eval_results WHERE run_id = ?", (run_id,))
        conn.execute("DELETE FROM eval_runs WHERE id = ?", (run_id,))


def cancel_run(run_id: str):
    if run_id in _cancel:
        _cancel[run_id].set()


def mark_interrupted():
    """服务重启后，之前没跑完的任务不会继续，标记成 interrupted。"""
    with db.tx() as conn:
        conn.execute("UPDATE eval_runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'", (_now(),))


def _effective(overrides: dict) -> dict:
    """记录这次评测实际生效的参数，方便事后对比“分数差别来自哪个参数”。"""
    eff = {name: settings.section(name, overrides.get(name)).to_dict() for name in ("query", "retrieval", "context", "generation")}
    eff["embedding"] = settings.current_embedder().name
    eff["index"] = settings.section("index").to_dict()
    return eff


def start_run(set_id: str, name: str, metric_keys: list[str], provider_id: str | None, judge_provider_id: str | None,
              overrides: dict | None, match_threshold: float = 0.6, concurrency: int = 4) -> dict:
    s = get_set(set_id)
    if not s["items"]:
        raise ValueError(t("测试集里还没有题目", "The test set has no questions"))
    unknown = set(metric_keys) - set(METRICS)
    if unknown:
        raise ValueError(t(f"未知的指标：{sorted(unknown)}", f"Unknown metrics: {sorted(unknown)}"))
    overrides = {k: v for k, v in (overrides or {}).items() if k in {"query", "retrieval", "context", "generation"} and v}
    needs = set().union(*(METRICS[k]["needs"] for k in metric_keys)) if metric_keys else set()
    answer_cfg = providers.get_config(provider_id) if "answer" in needs else None
    judge_cfg = providers.get_config(judge_provider_id or provider_id) if "judge" in needs else None
    config = {
        "metrics": metric_keys,
        "provider": {"id": answer_cfg.id, "name": answer_cfg.name, "model": answer_cfg.model} if answer_cfg else None,
        "judge": {"id": judge_cfg.id, "name": judge_cfg.name, "model": judge_cfg.model} if judge_cfg else None,
        "overrides": overrides,
        "effective": _effective(overrides),
        "match_threshold": match_threshold,
    }
    rid = uuid.uuid4().hex[:12]
    with db.tx() as conn:
        conn.execute(
            "INSERT INTO eval_runs (id, set_id, name, config, status, total, created_at) VALUES (?, ?, ?, ?, 'running', ?, ?)",
            (rid, set_id, name, json.dumps(config, ensure_ascii=False), len(s["items"]), _now()),
        )
    _cancel[rid] = threading.Event()
    lang = get_lang()
    threading.Thread(target=_run_job, args=(rid, s["items"], set(metric_keys), answer_cfg, judge_cfg, overrides,
                                            match_threshold, max(1, min(concurrency, 8)), lang), daemon=True).start()
    return get_run(rid, False)


def _run_job(rid, items, wanted, answer_cfg, judge_cfg, overrides, threshold, concurrency, lang):
    set_lang(lang)  # 后台线程不会继承请求的语言
    cancel = _cancel[rid]
    embedder = settings.current_embedder()

    def one(pos_item):
        set_lang(lang)
        pos, item = pos_item
        if cancel.is_set():
            return
        data = evaluate_item(item, wanted, answer_cfg, judge_cfg, overrides, threshold, embedder)
        with db.tx() as conn:
            conn.execute("INSERT OR REPLACE INTO eval_results (run_id, item_id, position, data) VALUES (?, ?, ?, ?)",
                         (rid, item["id"], pos, json.dumps(data, ensure_ascii=False)))
            conn.execute("UPDATE eval_runs SET done = done + 1 WHERE id = ?", (rid,))

    status, error = "done", ""
    try:
        with ThreadPoolExecutor(max_workers=concurrency) as ex:
            list(ex.map(one, enumerate(items)))
        if cancel.is_set():
            status = "cancelled"
    except Exception as e:  # 例如没有任何可用的模型配置
        status, error = "failed", str(e)
    summary = summarize(get_run(rid)["results"])
    with db.tx() as conn:
        conn.execute("UPDATE eval_runs SET status = ?, error = ?, summary = ?, finished_at = ? WHERE id = ?",
                     (status, error, json.dumps(summary), _now(), rid))
    _cancel.pop(rid, None)


def _applies(key: str, item: dict) -> bool:
    needs = METRICS[key]["needs"]
    if "answerable" in needs and not item["answerable"]:
        return False
    if "unanswerable" in needs and item["answerable"]:
        return False
    if "evidence" in needs and not item["evidence"]:
        return False
    if "reference" in needs and not item["reference_answer"]:
        return False
    return True


def evaluate_item(item: dict, wanted: set[str], answer_cfg, judge_cfg, overrides: dict, threshold: float, embedder) -> dict:
    """对一道题跑 RAG 流程并计算选中的指标。单个指标出错只记录错误，不影响其他指标。"""
    out = {"item_id": item["id"], "question": item["question"], "reference_answer": item["reference_answer"],
           "evidence": item["evidence"], "answerable": item["answerable"], "answer": None,
           "scores": {}, "details": {}, "errors": {}}
    t0 = time.perf_counter()
    try:
        p = rag.prepare(item["question"], answer_cfg.id if answer_cfg else None, [], overrides) if answer_cfg else _retrieve_only(item["question"], overrides)
    except Exception as e:
        out["errors"]["pipeline"] = str(e)
        return out
    retrieval_ms = p["trace"].get("timings", {}).get("retrieval_ms")
    hits = p["hits"]
    chunk_texts = [h["text"] for h in hits]
    source_texts = [s["text"] for s in p["sources"]]

    applies = {k for k in wanted if _applies(k, item)}
    if applies & {"hit_rate", "recall_at_k", "precision_at_k", "mrr", "map_at_k", "ndcg_at_k"}:
        r_scores, r_details = metrics.retrieval_metrics(chunk_texts, item["evidence"], threshold)
        out["scores"].update({k: v for k, v in r_scores.items() if k in applies})
        covers = r_details["matches"]
    else:
        covers = [[] for _ in hits]
    out["retrieved"] = [{"doc_name": h.get("doc_name"), "index": h["index"], "score": h.get("score"),
                         "text": h["text"][:800], "covers": covers[i]} for i, h in enumerate(hits)]

    answer = ""
    if answer_cfg:
        try:
            t1 = time.perf_counter()
            answer = "".join(create_llm(p["gen_cfg"]).stream(p["system"], p["messages"]))
            out["generation_ms"] = round((time.perf_counter() - t1) * 1000)
        except Exception as e:
            out["errors"]["generation"] = str(e)
            answer = None
    out["answer"] = answer if answer_cfg else None
    out["scores"]["latency_ms"] = round((time.perf_counter() - t0) * 1000)
    if retrieval_ms is not None:
        out["scores"]["retrieval_ms"] = retrieval_ms
    out["scores"]["context_chars"] = sum(len(t) for t in source_texts)
    if answer:
        out["scores"]["answer_chars"] = len(answer)

    def run(key: str, fn):
        try:
            score, detail = fn()
            if score is not None:
                out["scores"][key] = score
            out["details"][key] = detail
        except Exception as e:
            out["errors"][key] = str(e)

    if answer:
        text_keys = applies & {"exact_match", "token_f1", "bleu", "rouge_1", "rouge_2", "rouge_l", "semantic_similarity"}
        if text_keys:
            try:
                out["scores"].update(metrics.text_metrics(answer, item["reference_answer"], text_keys, embedder))
            except Exception as e:
                out["errors"]["text_metrics"] = str(e)
    q, ref = item["question"], item["reference_answer"]
    if judge_cfg:
        if answer and "faithfulness" in applies:
            run("faithfulness", lambda: judge.faithfulness(judge_cfg, q, answer, source_texts))
        if answer and "answer_relevancy" in applies:
            run("answer_relevancy", lambda: judge.answer_relevancy(judge_cfg, embedder, q, answer))
        if "context_precision" in applies:
            run("context_precision", lambda: judge.context_precision(judge_cfg, q, ref, chunk_texts))
        if "context_recall" in applies:
            run("context_recall", lambda: judge.context_recall(judge_cfg, q, ref, chunk_texts))
        if "context_relevance" in applies:
            run("context_relevance", lambda: judge.context_relevance(judge_cfg, q, chunk_texts))
        if answer and "answer_correctness" in applies:
            run("answer_correctness", lambda: judge.answer_correctness(judge_cfg, embedder, q, answer, ref))
        if answer and "geval" in applies:
            run("geval", lambda: judge.geval(judge_cfg, q, answer, ref, source_texts))
        if answer and applies & {"negative_rejection", "false_refusal"}:
            key = "negative_rejection" if not item["answerable"] else "false_refusal"
            run(key, lambda: judge.refusal(judge_cfg, q, answer))
    return out


def _retrieve_only(question: str, overrides: dict) -> dict:
    """只评检索时不需要 LLM：不做问题改写，直接检索 + 组装上下文。"""
    from ..context import assemble
    from . import documents

    t0 = time.perf_counter()
    hits = rag.retrieve(question, overrides.get("retrieval") or None)
    ms = round((time.perf_counter() - t0) * 1000)
    sources, _ = assemble(hits, settings.section("context", overrides.get("context")), documents.get_chunks)
    return {"hits": hits, "sources": sources, "trace": {"timings": {"retrieval_ms": ms}}}


def summarize(results: list[dict]) -> dict:
    keys = {k for r in results for k in r.get("scores", {})}
    summary = {}
    for k in sorted(keys):
        vals = [r["scores"][k] for r in results if r.get("scores", {}).get(k) is not None]
        if vals:
            summary[k] = {"mean": sum(vals) / len(vals), "n": len(vals)}
    summary["_errors"] = sum(1 for r in results if r.get("errors"))
    return summary


# ---------- 成对比较 ----------

def pairwise(run_a: str, run_b: str, judge_provider_id: str | None, concurrency: int = 4) -> dict:
    a, b = get_run(run_a), get_run(run_b)
    cfg = providers.get_config(judge_provider_id)
    b_by_q = {r["question"]: r for r in b["results"]}
    pairs = [(ra, b_by_q[ra["question"]]) for ra in a["results"] if ra["question"] in b_by_q and ra.get("answer") and b_by_q[ra["question"]].get("answer")]
    if not pairs:
        raise ValueError(t("两次评测没有共同的已回答题目（只评检索的评测没有生成回答）", "The two runs have no answered questions in common (retrieval-only runs don't generate answers)"))
    lang = get_lang()

    def one(pair):
        set_lang(lang)
        ra, rb = pair
        try:
            res = judge.pairwise(cfg, ra["question"], ra.get("reference_answer", ""), ra["answer"], rb["answer"])
        except Exception as e:
            res = {"winner": None, "error": str(e)}
        return {"question": ra["question"], "answer_a": ra["answer"], "answer_b": rb["answer"], **res}

    with ThreadPoolExecutor(max_workers=max(1, min(concurrency, 8))) as ex:
        results = list(ex.map(one, pairs))
    count = {w: sum(1 for r in results if r.get("winner") == w) for w in ("A", "B", "tie")}
    return {"run_a": {"id": a["id"], "name": a["name"]}, "run_b": {"id": b["id"], "name": b["name"]},
            "judge": {"name": cfg.name, "model": cfg.model}, "summary": {**count, "errors": sum(1 for r in results if r.get("winner") is None),
                                                                   "consistency": sum(1 for r in results if r.get("consistent")) / len(results)},
            "results": results}
