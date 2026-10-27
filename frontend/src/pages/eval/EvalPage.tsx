import { useCallback, useEffect, useRef, useState } from "react";
import { api, type EvalMetricInfo, type EvalRun, type EvalSet, type EvalSetMeta, type Provider } from "../../api";
import { t } from "../../i18n";
import GuideTab from "./GuideTab";
import ItemsTab from "./ItemsTab";
import ResultsTab from "./ResultsTab";
import RunTab from "./RunTab";

type Tab = "items" | "run" | "results" | "guide";

/** 评测页：测试集 → 运行评测 → 结果对比，外加指标说明。 */
export default function EvalPage({ version }: { version: number }) {
  const [sets, setSets] = useState<EvalSetMeta[]>([]);
  const [setId, setSetId] = useState("");
  const [current, setCurrent] = useState<EvalSet | null>(null);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [infos, setInfos] = useState<EvalMetricInfo[]>([]);
  const [tab, setTab] = useState<Tab>("items");
  const [msg, setMsg] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadSets = useCallback(async (select?: string) => {
    const ss = await api.evalSets();
    setSets(ss);
    setSetId((cur) => select ?? (ss.some((s) => s.id === cur) ? cur : ss[0]?.id ?? ""));
  }, []);

  useEffect(() => {
    loadSets();
    api.listProviders().then(setProviders);
    api.evalMetrics().then(setInfos);
  }, [version, loadSets]);

  const loadRuns = useCallback(() => {
    if (setId) api.evalRuns(setId).then(setRuns);
  }, [setId]);

  useEffect(() => {
    setCurrent(null);
    setRuns([]);
    if (!setId) return;
    api.evalSet(setId).then(setCurrent);
    loadRuns();
  }, [setId, loadRuns]);

  // 有评测在跑时每 1.5 秒刷新一次进度
  const running = runs.some((r) => r.status === "running");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(loadRuns, 1500);
    return () => clearInterval(timer);
  }, [running, loadRuns]);

  async function act(fn: () => Promise<string | void>) {
    setMsg(null);
    try {
      const text = await fn();
      if (text) setMsg({ type: "ok", text });
    } catch (e) {
      setMsg({ type: "error", text: (e as Error).message });
    }
  }

  const createEmpty = () =>
    act(async () => {
      const name = prompt(t("测试集名称", "Test set name"), t("我的测试集", "My test set"));
      if (!name) return;
      const s = await api.createEvalSet(name);
      await loadSets(s.id);
      setTab("items");
    });

  const createSample = () =>
    act(async () => {
      const s = await api.createSampleEvalSet();
      await loadSets(s.id);
      setTab("items");
      return t(`已导入示例测试集（${s.items.length} 道题，对应示例员工手册）`, `Imported the sample test set (${s.items.length} questions, for the sample handbook)`);
    });

  const importFile = (file: File) =>
    act(async () => {
      const data = JSON.parse(await file.text());
      const items = Array.isArray(data) ? data : data.items;
      if (!Array.isArray(items)) throw new Error(t("JSON 里没有 items 数组", "The JSON has no items array"));
      const s = await api.createEvalSet(data.name || file.name.replace(/\.json$/, ""), items);
      await loadSets(s.id);
      return t(`已导入 ${s.items.length} 道题`, `Imported ${s.items.length} questions`);
    });

  const exportSet = () =>
    act(async () => {
      const data = await api.exportEvalSet(setId);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${data.name}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

  const removeSet = () =>
    current &&
    confirm(t(`删除测试集「${current.name}」和它的所有评测记录？`, `Delete test set "${current.name}" and all its runs?`)) &&
    act(async () => {
      await api.deleteEvalSet(setId);
      await loadSets();
    });

  return (
    <div className="eval">
      <h2>{t("评测", "Evaluation")}</h2>
      <p className="muted">
        {t(
          "用一套固定的题目给 RAG 打分：检索有没有找到资料、回答对不对、有没有编造。改一个参数跑一次，并排比较就知道改动是好是坏。",
          "Score the RAG system on a fixed set of questions: did retrieval find the material, is the answer right, is anything made up? Change one parameter, run again, and compare side by side.",
        )}
      </p>
      {msg && <div className={`notice ${msg.type}`}>{msg.text}</div>}
      <div className="row">
        <select value={setId} onChange={(e) => setSetId(e.target.value)}>
          {sets.length === 0 && <option value="">{t("还没有测试集", "No test sets yet")}</option>}
          {sets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}（{t(`${s.item_count} 题，${s.run_count} 次评测`, `${s.item_count} questions, ${s.run_count} runs`)}）
            </option>
          ))}
        </select>
        <button className="secondary" onClick={createSample}>
          {t("导入示例测试集", "Import sample set")}
        </button>
        <button className="secondary" onClick={createEmpty}>
          {t("新建空测试集", "New empty set")}
        </button>
        <button className="secondary" onClick={() => fileRef.current?.click()}>
          {t("导入 JSON", "Import JSON")}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importFile(f);
            e.target.value = "";
          }}
        />
        {current && (
          <>
            <button className="secondary" onClick={exportSet}>
              {t("导出 JSON", "Export JSON")}
            </button>
            <button className="danger" onClick={removeSet}>
              {t("删除", "Delete")}
            </button>
          </>
        )}
      </div>

      <div className="tabs">
        {(
          [
            ["items", t(`① 题目${current ? `（${current.items.length}）` : ""}`, `① Questions${current ? ` (${current.items.length})` : ""}`)],
            ["run", t("② 运行评测", "② Run")],
            ["results", t(`③ 结果对比${runs.length ? `（${runs.length}）` : ""}`, `③ Results${runs.length ? ` (${runs.length})` : ""}`)],
            ["guide", t("📖 指标说明", "📖 Metric guide")],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "guide" ? (
        <GuideTab infos={infos} />
      ) : !current ? (
        <p className="muted">
          {t("先导入示例测试集，或者新建 / 导入一个测试集。", "Import the sample set, or create / import a test set first.")}
        </p>
      ) : tab === "items" ? (
        <ItemsTab set={current} providers={providers} onSaved={(s) => { setCurrent(s); loadSets(s.id); }} />
      ) : tab === "run" ? (
        <RunTab set={current} providers={providers} infos={infos} runCount={runs.length} onStarted={() => { loadRuns(); loadSets(setId); setTab("results"); }} />
      ) : (
        <ResultsTab runs={runs} infos={infos} providers={providers} onChanged={loadRuns} />
      )}
    </div>
  );
}
