import json
import time

import pytest

from app.evaluation import judge, metrics


# ---------- 不需要 LLM 的指标 ----------

def test_retrieval_metrics_by_hand():
    chunks = ["无关内容", "年假可以顺延至次年 3 月 31 日", "年假可以顺延至次年 3 月 31 日（重复）", "每年有 5 天全薪病假"]
    evidence = ["当年未休完的年假可以顺延至次年 3 月 31 日", "每年有 5 天全薪病假"]
    s, d = metrics.retrieval_metrics(chunks, evidence)
    assert d["matches"] == [[], [0], [0], [1]]
    assert s["hit_rate"] == 1 and s["recall_at_k"] == 1
    assert s["precision_at_k"] == 3 / 4
    assert s["mrr"] == 1 / 2
    # 新命中的位置是 2 和 4：AP = (1/2 + 2/4) / 2
    assert s["map_at_k"] == pytest.approx(0.5)
    assert 0 < s["ndcg_at_k"] < 1


def test_retrieval_metrics_no_hit():
    s, _ = metrics.retrieval_metrics(["a", "b"], ["完全不相关的证据"])
    assert s == {"hit_rate": 0, "recall_at_k": 0, "precision_at_k": 0, "mrr": 0, "map_at_k": 0, "ndcg_at_k": 0}


def test_text_metrics():
    assert metrics.exact_match("650元。", "650 元") == 1
    assert metrics.bleu("the cat sat on the mat", "the cat sat on the mat") == pytest.approx(1)
    assert metrics.bleu("完全不同", "毫无关系") == 0
    assert metrics.rouge_l("a b c d", "a c d") == pytest.approx(2 * 0.75 * 1 / 1.75)
    assert metrics.token_f1("每晚 650 元", "每晚不超过 650 元") > 0.7
    assert metrics.rouge_n("年假顺延", "年假可以顺延", 2) > 0


def test_parse_json_variants():
    assert judge.parse_json('好的：\n```json\n{"a": 1}\n```') == {"a": 1}
    assert judge.parse_json('result {"verdicts": [1]} done') == {"verdicts": [1]}
    with pytest.raises(judge.JudgeError):
        judge.parse_json("no json here")


# ---------- 假的回答模型和裁判 ----------

class FakeLLM:
    """按系统提示词判断是哪种任务，返回固定的 JSON。"""

    def __init__(self, cfg):
        pass

    def stream(self, system, messages):
        user = messages[-1]["content"]
        if "Break the ANSWER" in system:
            out = {"statements": ["上海每晚不超过 650 元", "可以报销机票头等舱"]}
        elif "supported by the CONTEXT" in system:
            out = {"verdicts": [{"statement": "a", "verdict": 1, "reason": "ok"}, {"statement": "b", "verdict": 0, "reason": "no"}]}
        elif "write 3 different questions" in system:
            out = {"questions": ["出差住上海每晚能报多少？", "上海住宿标准？", "一线城市住宿上限？"], "noncommittal": 0}
        elif "useful for arriving" in system:
            out = {"verdicts": [{"index": 1, "useful": 0}, {"index": 2, "useful": 1}]}
        elif "attributed to the retrieved" in system:
            out = {"statements": [{"statement": "x", "attributed": 1}, {"statement": "y", "attributed": 1}]}
        elif "relevant to answering" in system:
            out = {"verdicts": [{"index": 1, "relevant": 1}]}
        elif "TP:" in system:
            out = {"TP": ["650"], "FP": [], "FN": ["一线城市"]}
        elif "grading an answer" in system:
            out = {"steps": ["..."], "score": 4}
        elif "declines to answer" in system:
            out = {"refused": 1 if "没有找到" in user else 0, "reason": ""}
        elif "which answer is better" in system:
            # 永远选第一个：交换顺序后结论不一致，应该判平局
            out = {"winner": "A", "reason": "first"}
        elif "write one question" in system:
            passage = user.split("PASSAGE:\n", 1)[1]
            out = {"question": "这段讲了什么？", "answer": "见原文", "evidence": [passage[:30]]}
        elif "does NOT answer" in system:
            out = {"questions": ["公司有健身房吗？"]}
        elif "<source" in user or "没有检索到" in user or "no relevant" in user:
            # 生成回答：股票代码这类问题回答“没有找到”
            yield "资料中没有找到相关信息。" if "股票" in user or "午餐" in user else "上海属于一线城市，每晚不超过 650 元 [1]。"
            return
        else:
            out = {}
        yield json.dumps(out, ensure_ascii=False)


@pytest.fixture
def fake_llm(monkeypatch):
    monkeypatch.setattr("app.evaluation.judge.create_llm", FakeLLM)
    monkeypatch.setattr("app.services.evaluation.create_llm", FakeLLM)


def _wait(client, rid, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        run = client.get(f"/api/eval/runs/{rid}").json()
        if run["status"] != "running":
            return run
        time.sleep(0.1)
    raise AssertionError("run did not finish")


RETRIEVAL = ["hit_rate", "recall_at_k", "precision_at_k", "mrr", "map_at_k", "ndcg_at_k"]


def test_sample_set_and_retrieval_only_run(client):
    s = client.post("/api/eval/sets/sample").json()
    assert len(s["items"]) == 12 and sum(not i["answerable"] for i in s["items"]) == 2
    run = client.post("/api/eval/runs", json={"set_id": s["id"], "name": "检索", "metrics": RETRIEVAL}).json()
    run = _wait(client, run["id"])
    assert run["status"] == "done" and run["config"]["provider"] is None
    assert run["summary"]["hit_rate"]["n"] == 10  # 不可回答的两题不算检索指标
    assert 0 < run["summary"]["hit_rate"]["mean"] <= 1
    r0 = run["results"][0]
    assert r0["answer"] is None and r0["retrieved"] and "covers" in r0["retrieved"][0]
    # 列表接口带着摘要，前端用来做对比表
    assert client.get(f"/api/eval/sets/{s['id']}/runs").json()[0]["summary"]["mrr"]["n"] == 10


def test_full_run_with_judge(client, fake_llm):
    s = client.post("/api/eval/sets/sample").json()
    all_metrics = [m["key"] for m in client.get("/api/eval/metrics").json() if m["group"] != "system"]
    run = client.post("/api/eval/runs", json={
        "set_id": s["id"], "name": "全部", "metrics": all_metrics,
        "overrides": {"retrieval": {"method": "hybrid", "top_k": 2}},
    }).json()
    run = _wait(client, run["id"])
    assert run["status"] == "done", run
    summ = run["summary"]
    assert summ["_errors"] == 0, [r["errors"] for r in run["results"] if r["errors"]]
    assert summ["faithfulness"]["mean"] == pytest.approx(0.5)
    assert summ["context_precision"]["mean"] == pytest.approx(0.5)   # 有用片段排第 2：1/2
    assert summ["context_recall"]["mean"] == 1
    assert summ["geval"]["mean"] == pytest.approx(0.75)
    assert summ["negative_rejection"] == {"mean": 1.0, "n": 2}
    assert summ["false_refusal"]["mean"] == 0
    assert 0 < summ["answer_correctness"]["mean"] < 1
    assert summ["bleu"]["n"] == 10 and "latency_ms" in summ
    assert run["config"]["effective"]["retrieval"]["top_k"] == 2
    first = run["results"][0]
    assert len(first["retrieved"]) == 2
    assert first["details"]["faithfulness"]["verdicts"][1]["verdict"] == 0


def test_pairwise_position_bias_becomes_tie(client, fake_llm):
    s = client.post("/api/eval/sets/sample").json()
    ids = []
    for name in ("A", "B"):
        r = client.post("/api/eval/runs", json={"set_id": s["id"], "name": name, "metrics": ["token_f1"]}).json()
        ids.append(_wait(client, r["id"])["id"])
    res = client.post("/api/eval/pairwise", json={"run_a": ids[0], "run_b": ids[1]}).json()
    assert res["summary"]["tie"] == len(res["results"]) == 12
    assert res["summary"]["consistency"] == 0


def test_set_crud_import_export_generate(client, fake_llm):
    s = client.post("/api/eval/sets", json={"name": "mine", "items": [{"question": "q1", "evidence": ["e"]}]}).json()
    s = client.put(f"/api/eval/sets/{s['id']}", json={"items": [*s["items"], {"question": "q2", "answerable": False}]}).json()
    assert [i["question"] for i in s["items"]] == ["q1", "q2"]
    exported = client.get(f"/api/eval/sets/{s['id']}/export").json()
    copy = client.post("/api/eval/sets", json=exported).json()
    assert copy["items"][1]["answerable"] is False
    g = client.post(f"/api/eval/sets/{s['id']}/generate", json={"n": 3, "n_unanswerable": 1}).json()
    assert g["generated"] == 4 and len(g["items"]) == 6
    assert g["items"][2]["evidence"] and g["items"][-1]["answerable"] is False
    client.delete(f"/api/eval/sets/{s['id']}")
    assert client.get(f"/api/eval/sets/{s['id']}").status_code == 404


def test_run_errors(client):
    s = client.post("/api/eval/sets", json={"name": "empty"}).json()
    assert client.post("/api/eval/runs", json={"set_id": s["id"], "name": "x"}).status_code == 400
    assert client.post("/api/eval/runs", json={"set_id": "nope", "name": "x"}).status_code == 404
