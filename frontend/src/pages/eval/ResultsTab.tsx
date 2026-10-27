import { Fragment, useEffect, useState } from "react";
import { api, type EvalMetricInfo, type EvalResult, type EvalRun, type PairwiseResult, type Provider } from "../../api";
import { describe } from "../../components/StrategyEditor";
import { GROUP_LABEL, metricHow, metricName } from "../../evalMetrics";
import { t } from "../../i18n";
import { GROUP_ORDER, fmt, isRatio, lowerBetter } from "./shared";

const STATUS = {
  running: () => t("运行中", "running"),
  done: () => t("完成", "done"),
  failed: () => t("失败", "failed"),
  cancelled: () => t("已取消", "cancelled"),
  interrupted: () => t("已中断", "interrupted"),
};

/** 多次评测并排对比；点开一次评测看逐题结果；选两次做成对比较。 */
export default function ResultsTab({ runs, infos, providers, onChanged }: {
  runs: EvalRun[];
  infos: EvalMetricInfo[];
  providers: Provider[];
  onChanged: () => void;
}) {
  const [detailId, setDetailId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  if (!runs.length) return <p className="muted">{t("还没有评测记录，先到“运行评测”开始一次。", "No runs yet. Start one under \"Run\".")}</p>;

  // 出现过的指标，按分组排列
  const keys = new Set(runs.flatMap((r) => Object.keys(r.summary).filter((k) => !k.startsWith("_"))));
  const columns = GROUP_ORDER.flatMap((g) => infos.filter((m) => m.group === g && keys.has(m.key)).map((m) => m));
  const best = (key: string) => {
    const vals = runs.map((r) => r.summary[key]?.mean).filter((v): v is number => v !== undefined);
    if (vals.length < 2) return undefined;
    return lowerBetter(key, infos) ? Math.min(...vals) : Math.max(...vals);
  };
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s.slice(-1), id]));

  return (
    <div className="eval-results">
      <div className="table-wrap">
        <table className="eval-table">
          <thead>
            <tr>
              <th rowSpan={2} />
              <th rowSpan={2}>{t("评测", "Run")}</th>
              <th rowSpan={2}>{t("配置", "Config")}</th>
              {GROUP_ORDER.map((g) => {
                const n = columns.filter((c) => c.group === g).length;
                return n ? (
                  <th key={g} colSpan={n} className={`group-${g}`}>
                    {GROUP_LABEL[g]().split("（")[0].split(" (")[0]}
                  </th>
                ) : null;
              })}
            </tr>
            <tr>
              {columns.map((c) => (
                <th key={c.key} title={metricHow(c.key)} className={`group-${c.group}`}>
                  {metricName(c.key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className={detailId === r.id ? "active" : ""}>
                <td>
                  <input type="checkbox" checked={selected.includes(r.id)} onChange={() => toggle(r.id)} title={t("选两次评测做成对比较", "Pick two runs for pairwise comparison")} />
                </td>
                <td className="run-name">
                  <button className="link" onClick={() => setDetailId(detailId === r.id ? null : r.id)}>
                    {r.name}
                  </button>
                  <div className="muted small">
                    {r.status === "running" ? (
                      <>
                        <progress max={r.total} value={r.done} /> {r.done}/{r.total}{" "}
                        <button className="link" onClick={() => api.cancelEvalRun(r.id).then(onChanged)}>
                          {t("取消", "Cancel")}
                        </button>
                      </>
                    ) : (
                      <>
                        {STATUS[r.status]()}
                        {r.summary._errors ? ` · ${t(`${r.summary._errors} 题有错误`, `${r.summary._errors} with errors`)}` : ""}{" "}
                        <button
                          className="link danger-text"
                          onClick={() => confirm(t(`删除评测「${r.name}」？`, `Delete run "${r.name}"?`)) && api.deleteEvalRun(r.id).then(onChanged)}
                        >
                          {t("删除", "Delete")}
                        </button>
                      </>
                    )}
                  </div>
                  {r.error && <div className="error small">{r.error}</div>}
                </td>
                <td className="small config-cell">
                  <ConfigSummary run={r} />
                </td>
                {columns.map((c) => {
                  const s = r.summary[c.key];
                  const isBest = s && s.mean === best(c.key);
                  return (
                    <td key={c.key} className={`num ${isBest ? "best" : ""}`} title={s ? t(`${s.n} 道题的平均`, `mean of ${s.n} questions`) : ""}>
                      {fmt(c.key, s?.mean)}
                      {s && isRatio(c.key) && <div className="bar" style={{ width: `${Math.max(0, Math.min(1, s.mean)) * 100}%` }} />}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        {t(
          "加粗的是同一列里最好的值（误拒率、耗时、字数越低越好）。把鼠标停在指标名上看说明；完整原理见“指标说明”。",
          "Bold marks the best value in each column (lower is better for false refusal, latency and length). Hover a metric name for an explanation; see \"Metric guide\" for details.",
        )}
      </p>

      {selected.length === 2 && <PairwisePanel runA={selected[0]} runB={selected[1]} runs={runs} providers={providers} />}
      {detailId && <RunDetail id={detailId} infos={infos} key={detailId + (runs.find((r) => r.id === detailId)?.done ?? 0)} />}
    </div>
  );
}

function ConfigSummary({ run }: { run: EvalRun }) {
  const e = run.config.effective;
  const q = e.query;
  const extras = [q.condense_history && t("改写", "condense"), q.multi_query && t("多查询", "multi-query"), q.hyde && "HyDE"].filter(Boolean);
  const changed = Object.keys(run.config.overrides);
  return (
    <>
      <div>{describe(e.retrieval)} · Top {e.retrieval.top_k}</div>
      <div className="muted">
        {e.embedding.replace("fastembed:", "")}
        {extras.length > 0 && ` · ${extras.join(" + ")}`}
        {e.context.neighbor_window > 0 && ` · ±${e.context.neighbor_window}`}
      </div>
      {run.config.provider && <div className="muted">{t("回答：", "Answer: ")}{run.config.provider.name}</div>}
      {run.config.judge && <div className="muted">{t("裁判：", "Judge: ")}{run.config.judge.name}</div>}
      {changed.length > 0 && <div className="muted">{t("覆盖：", "Overrides: ")}{changed.join(", ")}</div>}
    </>
  );
}

function RunDetail({ id, infos }: { id: string; infos: EvalMetricInfo[] }) {
  const [run, setRun] = useState<EvalRun | null>(null);
  const [filter, setFilter] = useState<"all" | "errors" | "low">("all");
  useEffect(() => {
    api.evalRun(id).then(setRun);
  }, [id]);
  if (!run?.results) return null;
  const order = infos.map((m) => m.key);
  const low = (r: EvalResult) => Object.entries(r.scores).some(([k, v]) => isRatio(k) && (lowerBetter(k, infos) ? v >= 0.5 : v < 0.5));
  const shown = run.results.filter((r) => (filter === "errors" ? Object.keys(r.errors).length : filter === "low" ? low(r) : true));
  return (
    <div className="run-detail">
      <div className="row">
        <h3>{run.name}</h3>
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">{t(`全部（${run.results.length}）`, `All (${run.results.length})`)}</option>
          <option value="low">{t("有低分指标（< 0.5）", "Has a low score (< 0.5)")}</option>
          <option value="errors">{t("有错误", "Has errors")}</option>
        </select>
      </div>
      {shown.map((r, i) => (
        <div key={r.item_id + i} className={`eval-result ${r.answerable ? "" : "unanswerable"}`}>
          <div className="eval-q">
            <b>{r.question}</b>
            {!r.answerable && <span className="badge muted-badge">{t("文档里没有答案", "Not in documents")}</span>}
          </div>
          <div className="score-tags">
            {Object.entries(r.scores)
              .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
              .map(([k, v]) => (
                <span key={k} className={`tag ${isRatio(k) ? ((lowerBetter(k, infos) ? v < 0.5 : v >= 0.5) ? "good" : "bad") : "plain"}`} title={metricHow(k)}>
                  {metricName(k)} {fmt(k, v)}
                </span>
              ))}
          </div>
          {Object.keys(r.errors).length > 0 && (
            <div className="error small">
              {Object.entries(r.errors).map(([k, v]) => (
                <div key={k}>
                  {k}: {v}
                </div>
              ))}
            </div>
          )}
          {r.answer !== null && (
            <div className="eval-answer">
              <div className="muted small">{t("模型回答", "Answer")}</div>
              {r.answer}
            </div>
          )}
          {r.reference_answer && (
            <div className="eval-answer reference">
              <div className="muted small">{t("参考答案", "Reference")}</div>
              {r.reference_answer}
            </div>
          )}
          {r.retrieved && (
            <details>
              <summary className="small">
                {t("检索到的切片", "Retrieved chunks")} ({r.retrieved.length})
                {r.evidence.length > 0 && t(`，证据 ${r.evidence.length} 段`, `, ${r.evidence.length} evidence passages`)}
              </summary>
              {r.evidence.map((e, j) => (
                <div key={j} className="evidence small">
                  {t("证据", "Evidence")} {j + 1}: {e}
                </div>
              ))}
              {r.retrieved.map((c, j) => (
                <div key={j} className={`chunk ${c.covers.length ? "covers" : ""}`}>
                  <div className="muted small">
                    #{j + 1} {c.doc_name} · {t("切片", "chunk")} {c.index}
                    {c.covers.length > 0 && ` · ✅ ${t("覆盖证据", "covers evidence")} ${c.covers.map((x) => x + 1).join(", ")}`}
                  </div>
                  {c.text}
                </div>
              ))}
            </details>
          )}
          {Object.keys(r.details).length > 0 && (
            <details>
              <summary className="small">{t("裁判细节", "Judge details")}</summary>
              {Object.entries(r.details).map(([k, d]) => (
                <Fragment key={k}>
                  <div className="detail-title">{metricName(k)}</div>
                  <JudgeDetail detail={d} />
                </Fragment>
              ))}
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

/** 把裁判返回的结构化细节显示成列表：verdict / useful / attributed 等 0/1 字段显示成 ✅❌ */
function JudgeDetail({ detail }: { detail: Record<string, unknown> }) {
  const flagKeys = ["verdict", "useful", "relevant", "attributed"];
  return (
    <div className="judge-detail small">
      {Object.entries(detail).map(([k, v]) => {
        if (Array.isArray(v)) {
          return (
            <div key={k}>
              <span className="muted">{k}:</span>
              <ul>
                {v.map((x, i) => {
                  if (typeof x !== "object" || x === null) return <li key={i}>{String(x)}</li>;
                  const o = x as Record<string, unknown>;
                  const flag = flagKeys.find((f) => f in o);
                  const text = o.statement ?? o.question ?? (o.index !== undefined ? `#${o.index}` : "");
                  return (
                    <li key={i}>
                      {flag && (o[flag] ? "✅ " : "❌ ")}
                      {String(text)}
                      {typeof o.similarity === "number" && ` (${o.similarity.toFixed(3)})`}
                      {o.reason ? <span className="muted"> — {String(o.reason)}</span> : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        }
        return (
          <div key={k}>
            <span className="muted">{k}:</span> {typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(3)) : String(v)}
          </div>
        );
      })}
    </div>
  );
}

function PairwisePanel({ runA, runB, runs, providers }: { runA: string; runB: string; runs: EvalRun[]; providers: Provider[] }) {
  const [judgeId, setJudgeId] = useState("");
  const [result, setResult] = useState<PairwiseResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const name = (id: string) => runs.find((r) => r.id === id)?.name ?? id;

  async function go() {
    setBusy(true);
    setError("");
    try {
      setResult(await api.pairwise(runA, runB, judgeId || undefined));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pairwise">
      <h3>
        {t("成对比较", "Pairwise comparison")}: A = {name(runA)} · B = {name(runB)}
      </h3>
      <p className="muted small">
        {t(
          "绝对打分会受裁判尺度影响，直接问“哪个更好”往往更稳定（Chatbot Arena、MT-Bench 都这样做）。每道题交换 A/B 顺序各问一次，两次结论不一致就算平局，以抵消裁判偏爱第一个答案的“位置偏差”。",
          "Absolute scores depend on the judge's scale; asking \"which is better\" is often more stable (as Chatbot Arena and MT-Bench do). Each question is judged twice with A/B swapped; if the verdicts disagree it's a tie, cancelling the judge's bias toward the first answer (position bias).",
        )}
      </p>
      {runs.some((r) => (r.id === runA || r.id === runB) && !r.config.provider) && (
        <div className="notice warn">{t("其中一次评测只评了检索、没有生成回答，无法做成对比较。", "One of these runs evaluated retrieval only and has no answers to compare.")}</div>
      )}
      <div className="row">
        <select value={judgeId} onChange={(e) => setJudgeId(e.target.value)}>
          <option value="">{t("裁判：默认模型", "Judge: default model")}</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {t("裁判：", "Judge: ")}
              {p.name} ({p.model})
            </option>
          ))}
        </select>
        <button onClick={go} disabled={busy}>
          {busy ? t("比较中…", "Comparing…") : t("开始比较", "Compare")}
        </button>
      </div>
      {error && <div className="notice error">{error}</div>}
      {result && (
        <>
          <div className="pairwise-summary">
            <span className="tag good">A {t("胜", "wins")} {result.summary.A}</span>
            <span className="tag bad">B {t("胜", "wins")} {result.summary.B}</span>
            <span className="tag plain">{t("平局", "ties")} {result.summary.tie}</span>
            <span className="muted small">
              {t("两次判断一致的比例", "Consistency across swaps")}: {(result.summary.consistency * 100).toFixed(0)}%
              {result.summary.errors > 0 && ` · ${t("出错", "errors")} ${result.summary.errors}`}
            </span>
          </div>
          {result.results.map((r, i) => (
            <details key={i} className="pairwise-item">
              <summary>
                {r.winner === "A" ? "🅰️" : r.winner === "B" ? "🅱️" : r.winner === "tie" ? "🤝" : "⚠️"} {r.question}
              </summary>
              <div className="two-col">
                <div className="eval-answer">
                  <div className="muted small">A</div>
                  {r.answer_a}
                </div>
                <div className="eval-answer">
                  <div className="muted small">B</div>
                  {r.answer_b}
                </div>
              </div>
              {r.rounds?.map((x, j) => (
                <div key={j} className="small">
                  <span className="muted">
                    {t("顺序", "Order")} {x.order} → {x.winner}:
                  </span>{" "}
                  {x.reason}
                </div>
              ))}
              {r.error && <div className="error small">{r.error}</div>}
            </details>
          ))}
        </>
      )}
    </div>
  );
}
