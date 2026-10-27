import { useEffect, useState } from "react";
import { api, type ContextParams, type EvalMetricInfo, type EvalSet, type Provider, type QuerySettings, type RetrievalParams, type Settings } from "../../api";
import StrategyEditor from "../../components/StrategyEditor";
import { GROUP_HELP, GROUP_LABEL, METRIC_DOCS, metricHow, metricName } from "../../evalMetrics";
import { t } from "../../i18n";
import { ContextEditor, QueryEditor } from "../PipelinePage";

const DEFAULT_METRICS = ["hit_rate", "recall_at_k", "mrr", "ndcg_at_k", "rouge_l", "semantic_similarity", "faithfulness", "answer_correctness", "negative_rejection"];

/** 选指标、选模型、（可选）临时覆盖 RAG 参数，然后开始评测。 */
export default function RunTab({ set, providers, infos, runCount, onStarted }: {
  set: EvalSet;
  providers: Provider[];
  infos: EvalMetricInfo[];
  runCount: number;
  onStarted: () => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [metrics, setMetrics] = useState<string[]>(DEFAULT_METRICS);
  const [name, setName] = useState("");
  const [providerId, setProviderId] = useState("");
  const [judgeId, setJudgeId] = useState("");
  const [custom, setCustom] = useState(false);
  const [retrieval, setRetrieval] = useState<RetrievalParams | null>(null);
  const [query, setQuery] = useState<QuerySettings | null>(null);
  const [context, setContext] = useState<ContextParams | null>(null);
  const [threshold, setThreshold] = useState(0.6);
  const [concurrency, setConcurrency] = useState(4);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getSettings().then((s) => {
      setSettings(s);
      setRetrieval(s.retrieval);
      setQuery(s.query);
      setContext(s.context);
    });
  }, [set.id]);

  const selectable = infos.filter((m) => m.group !== "system");
  const chosen = selectable.filter((m) => metrics.includes(m.key));
  const needs = new Set(chosen.flatMap((m) => m.needs));
  const needsAnswer = needs.has("answer");
  const needsJudge = needs.has("judge");
  const answerable = set.items.filter((i) => i.answerable).length;
  const judgeCalls = chosen.reduce((sum, m) => {
    const per = METRIC_DOCS[m.key]?.judgeCalls ?? 0;
    const n = m.needs.includes("unanswerable") ? set.items.length - answerable : m.needs.includes("answerable") ? answerable : set.items.length;
    return sum + per * n;
  }, 0);
  const toggle = (key: string) => setMetrics((ms) => (ms.includes(key) ? ms.filter((k) => k !== key) : [...ms, key]));

  async function start() {
    setError("");
    setBusy(true);
    try {
      const overrides: Record<string, unknown> = {};
      if (custom && settings) {
        // 只把和当前设置不同的分组传过去，结果里能清楚看到“这次改了什么”
        if (JSON.stringify(retrieval) !== JSON.stringify(settings.retrieval)) overrides.retrieval = retrieval;
        if (JSON.stringify(query) !== JSON.stringify(settings.query)) overrides.query = query;
        if (JSON.stringify(context) !== JSON.stringify(settings.context)) overrides.context = context;
      }
      await api.startEvalRun({
        set_id: set.id,
        name: name.trim() || t(`配置 ${runCount + 1}`, `Config ${runCount + 1}`),
        metrics,
        provider_id: providerId || undefined,
        judge_provider_id: judgeId || undefined,
        overrides,
        match_threshold: threshold,
        concurrency,
      });
      setName("");
      onStarted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="eval-run">
      {error && <div className="notice error">{error}</div>}
      <div className="row">
        <input className="grow" value={name} onChange={(e) => setName(e.target.value)} placeholder={t(`这次评测的名字，例如“混合检索 Top 5”（默认：配置 ${runCount + 1}）`, `Name for this run, e.g. "hybrid top 5" (default: Config ${runCount + 1})`)} />
      </div>

      <h4>{t("1. 选择指标", "1. Choose metrics")}</h4>
      {(["retrieval", "text", "judge"] as const).map((g) => {
        const group = selectable.filter((m) => m.group === g);
        const all = group.every((m) => metrics.includes(m.key));
        return (
          <fieldset key={g} className="metric-group">
            <legend>
              <label className="check">
                <input
                  type="checkbox"
                  checked={all}
                  onChange={() => setMetrics((ms) => (all ? ms.filter((k) => !group.some((m) => m.key === k)) : [...new Set([...ms, ...group.map((m) => m.key)])]))}
                />
                {GROUP_LABEL[g]()}
              </label>
            </legend>
            <p className="muted small">{GROUP_HELP[g]()}</p>
            <div className="metric-checks">
              {group.map((m) => (
                <label key={m.key} className="check" title={metricHow(m.key)}>
                  <input type="checkbox" checked={metrics.includes(m.key)} onChange={() => toggle(m.key)} />
                  {metricName(m.key)}
                </label>
              ))}
            </div>
          </fieldset>
        );
      })}

      <h4>{t("2. 选择模型", "2. Choose models")}</h4>
      <div className="row">
        <label>
          {t("回答模型（被测）", "Answer model (under test)")}
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)} disabled={!needsAnswer}>
            <option value="">{t("默认模型", "Default model")}</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.model})
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("裁判模型", "Judge model")}
          <select value={judgeId} onChange={(e) => setJudgeId(e.target.value)} disabled={!needsJudge}>
            <option value="">{t("和回答模型相同", "Same as answer model")}</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.model})
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted small">
        {!needsAnswer
          ? t("只选了检索指标：不会调用任何 LLM（也不做问题改写），免费、很快。", "Retrieval metrics only: no LLM is called (and no query rewriting), so it's free and fast.")
          : t(
              `每道题生成一次回答（共 ${set.items.length} 次），裁判大约调用 ${judgeCalls} 次。裁判最好用比被测模型更强的模型。`,
              `One answer per question (${set.items.length} calls); the judge is called about ${judgeCalls} times. Prefer a judge stronger than the model under test.`,
            )}
      </p>

      <h4>{t("3. RAG 参数", "3. RAG parameters")}</h4>
      <label className="check">
        <input type="checkbox" checked={!custom} onChange={(e) => setCustom(!e.target.checked)} />
        {t("使用“RAG 流程”页的当前设置", "Use the current settings from the RAG pipeline page")}
      </label>
      {custom && retrieval && query && context && (
        <div className="eval-overrides">
          <p className="muted small">
            {t(
              "只对这次评测生效，不会改动全局设置。切分、向量模型、索引要在“RAG 流程”页修改并重建索引后再评测。",
              "Applies to this run only and doesn't change global settings. Chunking, embedding model and index must be changed on the RAG pipeline page (then rebuild the index) before evaluating.",
            )}
          </p>
          <strong>{t("检索", "Retrieval")}</strong>
          <StrategyEditor compact value={retrieval} onChange={setRetrieval} />
          <strong>{t("问题处理", "Query processing")}</strong>
          <QueryEditor value={query} onChange={setQuery} />
          <strong>{t("上下文组装", "Context assembly")}</strong>
          <ContextEditor value={context} onChange={setContext} />
        </div>
      )}

      <details>
        <summary className="small">{t("高级", "Advanced")}</summary>
        <div className="row">
          <label title={t("切片和证据的字符二元组重合度达到这个比例才算命中", "A chunk counts as covering evidence when their character-bigram overlap reaches this ratio")}>
            {t("证据匹配阈值", "Evidence match threshold")}
            <input type="number" step={0.05} min={0.1} max={1} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
          </label>
          <label title={t("同时评测几道题。本地模型建议设为 1", "Questions evaluated in parallel. Use 1 for local models")}>
            {t("并发数", "Concurrency")}
            <input type="number" min={1} max={8} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} />
          </label>
        </div>
      </details>

      <div className="row">
        <button onClick={start} disabled={busy || !metrics.length || !set.items.length}>
          {busy ? t("启动中…", "Starting…") : t(`▶ 开始评测（${set.items.length} 道题）`, `▶ Run evaluation (${set.items.length} questions)`)}
        </button>
      </div>
    </div>
  );
}
