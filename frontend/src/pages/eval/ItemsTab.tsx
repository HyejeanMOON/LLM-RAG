import { useEffect, useState } from "react";
import { api, type EvalItem, type EvalSet, type Provider } from "../../api";
import { t } from "../../i18n";

/** 测试集的题目：问题、参考答案、证据（每行一段原文）、文档里有没有答案。 */
export default function ItemsTab({ set, providers, onSaved }: { set: EvalSet; providers: Provider[]; onSaved: (s: EvalSet) => void }) {
  const [items, setItems] = useState<EvalItem[]>(set.items);
  const [name, setName] = useState(set.name);
  const [msg, setMsg] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [gen, setGen] = useState({ provider_id: "", n: 5, n_unanswerable: 1 });

  useEffect(() => {
    setItems(set.items);
    setName(set.name);
  }, [set]);

  const dirty = name !== set.name || JSON.stringify(items) !== JSON.stringify(set.items);
  const update = (i: number, patch: Partial<EvalItem>) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ type: "ok", text: await fn() });
    } catch (e) {
      setMsg({ type: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      const s = await api.updateEvalSet(set.id, { name, items: items.filter((i) => i.question.trim()) });
      onSaved(s);
      return t(`已保存，共 ${s.items.length} 道题`, `Saved: ${s.items.length} questions`);
    });

  const generate = () =>
    run(async () => {
      if (dirty) await api.updateEvalSet(set.id, { name, items });
      const s = await api.generateEvalItems(set.id, { ...gen, provider_id: gen.provider_id || undefined });
      onSaved(s);
      const errors = s.errors.length ? t(`，${s.errors.length} 次失败：${s.errors[0]}`, `, ${s.errors.length} failed: ${s.errors[0]}`) : "";
      return t(`已生成 ${s.generated} 道题，请检查后再用来评测`, `Generated ${s.generated} questions. Review them before evaluating.`) + errors;
    });

  return (
    <div className="eval-items">
      {msg && <div className={`notice ${msg.type}`}>{msg.text}</div>}
      <div className="row">
        <input className="grow" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("测试集名称", "Test set name")} />
        <button onClick={save} disabled={busy || !dirty || !name.trim()}>
          {t("保存", "Save")}
        </button>
        <button className="secondary" onClick={() => setItems([...items, { question: "", reference_answer: "", evidence: [], answerable: true }])}>
          {t("＋ 添加题目", "＋ Add question")}
        </button>
        {dirty && <span className="muted small">{t("有未保存的修改", "Unsaved changes")}</span>}
      </div>

      <details className="gen-panel">
        <summary>{t("🤖 用 LLM 从文档自动出题", "🤖 Generate questions from documents with an LLM")}</summary>
        <p className="muted small">
          {t(
            "随机抽取切片，让 LLM 针对每个切片出一道题、写参考答案，并原样摘出证据句子；还可以生成几道“文档里没有答案”的题，用来测拒答。合成题目难免有瑕疵，生成后请人工检查一遍。",
            "Random chunks are sampled; for each, the LLM writes a question and reference answer and quotes the evidence verbatim. It can also write questions the documents don't answer, to test refusals. Synthetic questions are imperfect, so review them afterwards.",
          )}
        </p>
        <div className="row">
          <label>
            {t("出题模型", "Model")}
            <select value={gen.provider_id} onChange={(e) => setGen({ ...gen, provider_id: e.target.value })}>
              <option value="">{t("默认模型", "Default model")}</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.model})
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("可回答的题", "Answerable")}
            <input type="number" min={1} max={50} value={gen.n} onChange={(e) => setGen({ ...gen, n: Number(e.target.value) })} />
          </label>
          <label>
            {t("无答案的题", "Unanswerable")}
            <input type="number" min={0} max={20} value={gen.n_unanswerable} onChange={(e) => setGen({ ...gen, n_unanswerable: Number(e.target.value) })} />
          </label>
          <button onClick={generate} disabled={busy}>
            {busy ? t("生成中…", "Generating…") : t("生成并追加", "Generate & append")}
          </button>
        </div>
      </details>

      <p className="muted small">
        {t(
          "证据：从文档里原样复制能回答问题的句子，每行一段，用于计算检索指标。参考答案：用于文本相似度和部分裁判指标。取消勾选“有答案”表示文档里没有答案，期望模型拒答。",
          "Evidence: sentences copied verbatim from the documents that answer the question, one per line; used by retrieval metrics. Reference answer: used by text-similarity and some judge metrics. Uncheck \"Answerable\" when the documents don't contain the answer and the model should decline.",
        )}
      </p>
      {items.length === 0 && <p className="muted">{t("还没有题目。", "No questions yet.")}</p>}
      {items.map((it, i) => (
        <div key={i} className={`eval-item ${it.answerable ? "" : "unanswerable"}`}>
          <div className="row">
            <span className="rank">#{i + 1}</span>
            <input className="grow" value={it.question} placeholder={t("问题", "Question")} onChange={(e) => update(i, { question: e.target.value })} />
            <label className="check">
              <input type="checkbox" checked={it.answerable} onChange={(e) => update(i, { answerable: e.target.checked })} />
              {t("有答案", "Answerable")}
            </label>
            <button className="link danger-text" onClick={() => setItems(items.filter((_, j) => j !== i))}>
              {t("删除", "Delete")}
            </button>
          </div>
          {it.answerable && (
            <div className="eval-item-fields">
              <label>
                {t("参考答案", "Reference answer")}
                <textarea rows={2} value={it.reference_answer} onChange={(e) => update(i, { reference_answer: e.target.value })} />
              </label>
              <label>
                {t("证据（每行一段原文）", "Evidence (one passage per line)")}
                <textarea
                  rows={2}
                  value={it.evidence.join("\n")}
                  onChange={(e) => update(i, { evidence: e.target.value.split("\n") })}
                  onBlur={() => update(i, { evidence: it.evidence.map((x) => x.trim()).filter(Boolean) })}
                />
              </label>
            </div>
          )}
          {it.source && <div className="muted small">{t("来源：", "Source: ")}{it.source}</div>}
        </div>
      ))}
    </div>
  );
}
