import { useEffect, useState, type ReactNode } from "react";
import {
  api,
  type ContextParams,
  type EmbeddingModelInfo,
  type EmbeddingSettings,
  type EmbeddingTestResult,
  type GenerationSettings,
  type IndexSettings,
  type Provider,
  type QuerySettings,
  type SectionName,
  type Settings,
} from "../api";
import ChunkingEditor from "../components/ChunkingEditor";
import StrategyEditor from "../components/StrategyEditor";
import { getLang, t } from "../i18n";

/** RAG 流程设置：按数据流动的顺序列出每个环节的可调参数，并解释原理。 */
export default function PipelinePage({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [msg, setMsg] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    api.getSettings().then((fresh) => {
      // 重新拉取设置时，保留其他分组里还没保存的修改
      setSaved((oldSaved) => {
        setDraft((oldDraft) => {
          if (!oldDraft || !oldSaved) return fresh;
          const merged = { ...fresh };
          for (const k of Object.keys(fresh) as (keyof Settings)[]) {
            if (JSON.stringify(oldDraft[k]) !== JSON.stringify(oldSaved[k])) (merged as Record<string, unknown>)[k] = oldDraft[k];
          }
          return merged;
        });
        return fresh;
      });
    });
    api.listProviders().then(setProviders);
  }, [version]);

  if (!draft || !saved) return null;

  const set = <K extends SectionName>(name: K, value: Settings[K]) => setDraft({ ...draft, [name]: value });
  const dirty = (name: SectionName) => JSON.stringify(draft[name]) !== JSON.stringify(saved[name]);

  async function save(name: SectionName, reindexHint = false) {
    setMsg(null);
    try {
      let value: unknown = draft![name];
      if (name === "generation") {
        // 后端约定：0 / 负数 / 空字符串 表示清空，回到模型配置里的值
        const g = value as GenerationSettings;
        value = { ...g, max_tokens: g.max_tokens ?? 0, temperature: g.temperature ?? -1, effort: g.effort ?? "" };
      }
      const s = await api.updateSettings({ [name]: value });
      setSaved(s);
      setDraft((d) => ({ ...d!, [name]: s[name] }));
      onChanged();
      setMsg({ type: "ok", text: reindexHint
          ? t("已保存。这个环节变了以后需要重建索引，点页面顶部或下面的“重建索引”。", "Saved. This step changed, so the index must be rebuilt: click \"Rebuild index\" at the top or below.")
          : t("已保存，下一次问答生效。", "Saved. Takes effect on the next question."),
      });
    } catch (e) {
      setMsg({ type: "error", text: (e as Error).message });
    }
  }

  async function reset(name: SectionName) {
    const s = await api.resetSection(name);
    setSaved(s);
    setDraft((d) => ({ ...d!, [name]: s[name] }));
    onChanged();
  }

  async function reindex() {
    setMsg(null);
    try {
      const r = await api.reindex();
      onChanged();
      setMsg({ type: "ok", text: t(`重建完成：${r.documents} 篇文档，${r.chunks} 个切片`, `Rebuilt: ${r.documents} documents, ${r.chunks} chunks`) });
    } catch (e) {
      setMsg({ type: "error", text: (e as Error).message });
    }
  }

  const section = (name: SectionName, reindexHint = false) => ({
    dirty: dirty(name),
    onSave: () => save(name, reindexHint),
    onReset: () => reset(name),
    onReindex: reindexHint ? reindex : undefined,
  });

  return (
    <div className="pipeline">
      <h2>{t("RAG 流程", "RAG pipeline")}</h2>
      <p className="muted">
        {t(
          "一次问答依次经过下面这些环节。每个环节都可以切换算法、调整参数；问答页每条回答下的“流程追踪”能看到每一步的实际结果。",
          "Every question goes through the steps below in order. Each step lets you switch algorithms and tune parameters; \"Pipeline trace\" under each answer on the Chat page shows what each step actually produced.",
        )}
      </p>
      <div className="flow">
        {[
          ["chunking", t("文档切分", "Chunking")],
          ["embedding", t("向量化", "Embedding")],
          ["index", t("向量索引", "Vector index")],
          ["query", t("问题处理", "Query processing")],
          ["retrieval", t("检索", "Retrieval")],
          ["context", t("上下文组装", "Context assembly")],
          ["generation", t("生成回答", "Generation")],
        ].map(([id, label], i) => (
          <a key={id} href={`#step-${id}`} className={dirty(id as SectionName) ? "dirty" : ""}>
            <span>{i + 1}</span>
            {label}
          </a>
        ))}
      </div>
      <p className="muted small">
        {t(
          "前 3 步在导入文档时执行（离线），改了要重建索引；后 4 步在每次提问时执行（在线），保存后立即生效。",
          "The first 3 steps run when documents are imported (offline); changing them requires rebuilding the index. The last 4 run on every question (online) and take effect as soon as you save.",
        )}
      </p>
      {msg && <div className={`notice ${msg.type} sticky`}>{msg.text}</div>}

      <Section id="chunking" n={1} title={t("文档切分", "Chunking")} {...section("chunking", true)} principle={principle("chunking")}>
        <ChunkingEditor value={draft.chunking} onChange={(v) => set("chunking", v)} />
        <p className="muted small">
          {t("这里是全局默认；单篇文档可以在“文档管理 → 切片”里单独设置并预览。", "This is the global default; a single document can override and preview it under Documents → Chunks.")}
        </p>
      </Section>

      <Section id="embedding" n={2} title={t("向量化（Embedding）", "Embedding")} {...section("embedding", true)} principle={principle("embedding")}>
        <EmbeddingEditor value={draft.embedding} onChange={(v) => set("embedding", v)} providers={providers} />
      </Section>

      <Section id="index" n={3} title={t("向量索引（HNSW）", "Vector index (HNSW)")} {...section("index", true)} principle={principle("index")}>
        <IndexEditor value={draft.index} onChange={(v) => set("index", v)} />
      </Section>

      <Section id="query" n={4} title={t("问题处理", "Query processing")} {...section("query")} principle={principle("query")}>
        <QueryEditor value={draft.query} onChange={(v) => set("query", v)} />
      </Section>

      <Section id="retrieval" n={5} title={t("检索", "Retrieval")} {...section("retrieval")} principle={principle("retrieval")}>
        <StrategyEditor value={draft.retrieval} onChange={(v) => set("retrieval", v)} />
        <p className="muted small">
          {t("想对比不同检索策略的效果，用“检索调试”页并排比较，满意后点“设为问答默认”。", "To compare retrieval strategies, put them side by side on the Search lab page, then click \"Use in Chat\".")}
        </p>
      </Section>

      <Section id="context" n={6} title={t("上下文组装", "Context assembly")} {...section("context")} principle={principle("context")}>
        <ContextEditor value={draft.context} onChange={(v) => set("context", v)} />
      </Section>

      <Section id="generation" n={7} title={t("生成回答", "Generation")} {...section("generation")} principle={principle("generation")}>
        <GenerationEditor value={draft.generation} onChange={(v) => set("generation", v)} />
      </Section>
    </div>
  );
}

function Section(props: {
  id: string;
  n: number;
  title: string;
  principle: ReactNode;
  dirty: boolean;
  onSave: () => void;
  onReset: () => void;
  onReindex?: () => void;
  children: ReactNode;
}) {
  return (
    <section id={`step-${props.id}`} className="step">
      <h3>
        <span className="step-n">{props.n}</span>
        {props.title}
        {props.onReindex && <span className="badge muted-badge">{t("改后需重建索引", "Needs reindex after change")}</span>}
      </h3>
      <details className="principle">
        <summary>{t("原理说明", "How it works")}</summary>
        {props.principle}
      </details>
      {props.children}
      <div className="row">
        <button onClick={props.onSave} disabled={!props.dirty}>
          {t("保存", "Save")}
        </button>
        <button className="secondary" onClick={props.onReset}>
          {t("恢复默认", "Reset to default")}
        </button>
        {props.onReindex && (
          <button className="secondary" onClick={props.onReindex}>
            {t("重建索引", "Rebuild index")}
          </button>
        )}
        {props.dirty && <span className="muted small">{t("有未保存的修改", "Unsaved changes")}</span>}
      </div>
    </section>
  );
}

function Num({ label, value, onChange, step = 1, min, max, title, allowEmpty }: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  step?: number;
  min?: number;
  max?: number;
  title?: string;
  allowEmpty?: boolean;
}) {
  return (
    <label title={title}>
      {label}
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        value={value ?? ""}
        placeholder={allowEmpty ? t("留空=用模型配置", "empty = model config") : undefined}
        onChange={(e) => onChange(e.target.value === "" && allowEmpty ? null : Number(e.target.value))}
      />
    </label>
  );
}

function Check({ label, checked, onChange, title }: { label: string; checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label className="check" title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

const OPENAI_EMBED_SUGGESTIONS = (): [string, string][] => [
  ["text-embedding-3-small", "OpenAI"],
  ["text-embedding-3-large", "OpenAI"],
  ["text-embedding-v3", t("通义千问", "Qwen")],
  ["embedding-3", t("智谱", "Zhipu")],
  ["bge-m3", t("Ollama，先 ollama pull bge-m3", "Ollama, run ollama pull bge-m3 first")],
  ["nomic-embed-text", "Ollama"],
];

function EmbeddingEditor({ value, onChange, providers }: { value: EmbeddingSettings; onChange: (v: EmbeddingSettings) => void; providers: Provider[] }) {
  const [models, setModels] = useState<EmbeddingModelInfo[]>([]);
  const [texts, setTexts] = useState(
    t(
      "出差住宿每晚能报销多少钱？\n差旅住宿标准：一线城市每晚不超过 650 元。\n公司班车早上八点发车。",
      "How much can I claim per night for a hotel on a business trip?\nTravel lodging policy: up to 650 yuan per night in tier-1 cities.\nThe company shuttle leaves at 8 a.m.",
    ),
  );
  const [result, setResult] = useState<EmbeddingTestResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.embeddingModels().then(setModels);
  }, [getLang()]); // 模型说明由后端按语言返回
  const known = models.some((m) => m.model === value.model);
  const openaiProviders = providers.filter((p) => p.type === "openai");
  const info = models.find((m) => m.model === value.model);
  const lines = texts.split("\n").map((l) => l.trim()).filter(Boolean);

  async function test() {
    setError("");
    setBusy(true);
    try {
      setResult(await api.embeddingTest(lines, { backend: value.backend, model: value.model, provider_id: value.provider_id }));
    } catch (e) {
      setError((e as Error).message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="strategy-editor">
        <label>
          {t("向量化方式", "Embedding backend")}
          <select value={value.backend} onChange={(e) => onChange({ ...value, backend: e.target.value as EmbeddingSettings["backend"] })}>
            <option value="fastembed">{t("本地模型（fastembed）", "Local model (fastembed)")}</option>
            <option value="openai">{t("OpenAI 兼容接口", "OpenAI-compatible API")}</option>
            <option value="hash">{t("字符哈希（离线对照）", "Character hash (offline baseline)")}</option>
          </select>
        </label>
        {value.backend === "fastembed" && (
          <>
            <label>
              {t("模型", "Model")}
              <select value={known ? value.model : "__custom"} onChange={(e) => onChange({ ...value, model: e.target.value === "__custom" ? "" : e.target.value })}>
                {models.map((m) => (
                  <option key={m.model} value={m.model}>
                    {m.model} ({m.lang}, {m.dim} {t("维", "dims")}, {m.size})
                  </option>
                ))}
                <option value="__custom">{t("自定义…", "Custom…")}</option>
              </select>
            </label>
            {!known && (
              <label title={t("任何 fastembed 支持的模型名", "Any model name fastembed supports")}>
                {t("模型名", "Model name")}
                <input value={value.model} placeholder={t("例如 BAAI/bge-base-en-v1.5", "e.g. BAAI/bge-base-en-v1.5")} onChange={(e) => onChange({ ...value, model: e.target.value })} />
              </label>
            )}
          </>
        )}
        {value.backend === "openai" && (
          <>
            <label title={t("复用这个配置的接口地址和 API Key", "Reuses this config's endpoint and API key")}>
              {t("使用哪个接口", "Endpoint")}
              <select value={value.provider_id ?? ""} onChange={(e) => onChange({ ...value, provider_id: e.target.value || null })}>
                <option value="">{t("请选择（在“LLM 模型”页添加 OpenAI 兼容配置）", "Choose one (add an OpenAI-compatible config on the LLM models page)")}</option>
                {openaiProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.base_url || "api.openai.com"})
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("向量模型名", "Embedding model name")}
              <input value={value.model} list="embed-suggest" onChange={(e) => onChange({ ...value, model: e.target.value })} />
              <datalist id="embed-suggest">
                {OPENAI_EMBED_SUGGESTIONS().map(([model, note]) => (
                  <option key={model} value={model}>
                    {note}
                  </option>
                ))}
              </datalist>
            </label>
          </>
        )}
      </div>
      {value.backend === "fastembed" && info && (
        <p className="muted small">
          {info.note}
          {t(`。首次使用会下载模型（${info.size}）。`, `. The model is downloaded on first use (${info.size}).`)}
        </p>
      )}
      {value.backend === "hash" && (
        <p className="muted small">
          {t(
            "字符哈希不理解语义，只是把字符片段映射到向量里，用来和真正的语义模型做对照。",
            "Character hashing doesn't understand meaning; it just maps character n-grams into a vector. Use it as a baseline against real semantic models.",
          )}
        </p>
      )}

      <div className="lab">
        <strong>{t("向量化实验", "Embedding lab")}</strong>
        <span className="muted small">
          {t(
            "每行一句话，用上面选的模型（不必先保存）算出向量，看看哪些句子在向量空间里更近。",
            "One sentence per line. They are embedded with the model chosen above (no need to save first), so you can see which sentences are close in vector space.",
          )}
        </span>
        <textarea rows={3} value={texts} onChange={(e) => setTexts(e.target.value)} />
        <div className="row">
          <button className="secondary" onClick={test} disabled={busy || lines.length < 2}>
            {busy ? t("计算中…", "Computing…") : t("计算相似度", "Compute similarity")}
          </button>
          {result && (
            <span className="muted small">
              {result.embedder} · {result.dim} {t("维", "dims")} · {result.elapsed_ms} ms · {t("向量长度", "norms")}{" "}
              {result.norms.map((n) => n.toFixed(2)).join(" / ")}
            </span>
          )}
        </div>
        {error && <div className="notice error">{error}</div>}
        {result && (
          <table className="sim">
            <thead>
              <tr>
                <th />
                {lines.map((_, i) => (
                  <th key={i}>#{i + 1}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.similarity.map((row, i) => (
                <tr key={i}>
                  <th title={lines[i]}>
                    #{i + 1} {lines[i].slice(0, 16)}
                  </th>
                  {row.map((v, j) => (
                    <td key={j} style={{ background: `rgba(79,70,229,${Math.max(0, v) * 0.6})`, color: v > 0.6 ? "#fff" : undefined }}>
                      {v.toFixed(3)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {result && (
          <details className="small">
            <summary>{t("看看向量长什么样（每句前 8 维）", "What a vector looks like (first 8 dims of each)")}</summary>
            {result.preview.map((v, i) => (
              <div key={i} className="mono">
                #{i + 1} [{v.join(", ")}, …]
              </div>
            ))}
          </details>
        )}
      </div>
    </>
  );
}

function IndexEditor({ value, onChange }: { value: IndexSettings; onChange: (v: IndexSettings) => void }) {
  return (
    <div className="strategy-editor">
      <label title={t("建图时衡量两个向量远近的方式", "How distance between two vectors is measured when building the graph")}>
        {t("距离", "Distance")}
        <select value={value.space} onChange={(e) => onChange({ ...value, space: e.target.value as IndexSettings["space"] })}>
          <option value="cosine">{t("余弦距离 cosine", "Cosine distance")}</option>
          <option value="l2">{t("欧氏距离平方 l2", "Squared Euclidean (l2)")}</option>
          <option value="ip">{t("内积 ip", "Inner product (ip)")}</option>
        </select>
      </label>
      <Num
        label={t("M（每个节点的邻居数）", "M (neighbors per node)")}
        value={value.max_neighbors}
        min={2}
        max={128}
        onChange={(v) => onChange({ ...value, max_neighbors: v ?? 16 })}
        title={t("越大图越密，召回越高，内存占用和建图时间也越大。常用 8~64", "Larger = denser graph and higher recall, but more memory and build time. Typical: 8–64")}
      />
      <Num
        label="ef_construction"
        value={value.ef_construction}
        min={10}
        max={2000}
        onChange={(v) => onChange({ ...value, ef_construction: v ?? 100 })}
        title={t("建图时每个节点搜索邻居的候选队列长度，越大图质量越好、建得越慢", "Candidate list size when searching neighbors during build; larger = better graph, slower build")}
      />
      <Num
        label="ef_search"
        value={value.ef_search}
        min={1}
        max={2000}
        onChange={(v) => onChange({ ...value, ef_search: v ?? 100 })}
        title={t("查询时的候选队列长度，越大召回越高、查询越慢。必须 ≥ 要取回的数量", "Candidate list size at query time; larger = higher recall, slower queries. Must be ≥ the number of results")}
      />
      <p className="help muted small">
        {t(
          "这些参数只在“检索”里选择“HNSW 近似检索”时生效；“精确计算”不使用索引。",
          "These only apply when Retrieval uses \"HNSW (approximate)\"; \"Exact\" doesn't use the index.",
        )}
      </p>
    </div>
  );
}

export function QueryEditor({ value, onChange }: { value: QuerySettings; onChange: (v: QuerySettings) => void }) {
  return (
    <div className="strategy-editor">
      <Num
        label={t("带上最近几轮对话", "Recent turns to include")}
        value={value.history_turns}
        min={0}
        max={20}
        onChange={(v) => onChange({ ...value, history_turns: v ?? 0 })}
        title={t("生成回答时把最近几轮问答一起发给模型，0 表示每次都是新对话", "Send the last few Q&A turns along with the question; 0 = every question is a new conversation")}
      />
      <Check
        label={t("结合历史改写问题", "Condense with history")}
        checked={value.condense_history}
        onChange={(v) => onChange({ ...value, condense_history: v })}
        title={t("检索前让 LLM 把“那北京呢？”这类追问改写成完整问题", "Before retrieval, have the LLM rewrite follow-ups like \"What about Beijing?\" into a standalone question")}
      />
      <Check
        label={t("多查询 Multi-Query", "Multi-query")}
        checked={value.multi_query}
        onChange={(v) => onChange({ ...value, multi_query: v })}
        title={t("让 LLM 换几种说法分别检索，再用 RRF 融合", "Have the LLM rephrase the question several ways, search each, and fuse with RRF")}
      />
      {value.multi_query && (
        <Num label={t("额外生成几个查询", "Extra queries")} value={value.multi_query_n} min={1} max={8} onChange={(v) => onChange({ ...value, multi_query_n: v ?? 3 })} />
      )}
      <Check
        label={t("HyDE 假想文档", "HyDE hypothetical document")}
        checked={value.hyde}
        onChange={(v) => onChange({ ...value, hyde: v })}
        title={t("先让 LLM 写一段假想答案，用它的向量去检索", "Have the LLM write a hypothetical answer first and search with its vector")}
      />
      <p className="help muted small">
        {t(
          "改写、多查询、HyDE 每个都会多调用一次 LLM（使用问答时选的模型，低 effort），会增加一点延迟和费用。",
          "Condense, multi-query and HyDE each add one LLM call (with the model chosen in Chat, at low effort), adding some latency and cost.",
        )}
      </p>
    </div>
  );
}

export function ContextEditor({ value, onChange }: { value: ContextParams; onChange: (v: ContextParams) => void }) {
  return (
    <div className="strategy-editor">
      <Num
        label={t("总字数上限", "Character budget")}
        value={value.max_chars}
        min={200}
        step={500}
        onChange={(v) => onChange({ ...value, max_chars: v ?? 6000 })}
        title={t("放进提示词的参考资料最多多少字，超出的低相关片段会被丢掉", "Maximum characters of sources in the prompt; lower-relevance blocks beyond it are dropped")}
      />
      <Num
        label={t("相邻片段扩展（前后各几个）", "Neighbor expansion (each side)")}
        value={value.neighbor_window}
        min={0}
        max={5}
        onChange={(v) => onChange({ ...value, neighbor_window: v ?? 0 })}
        title={t("small-to-big：命中一个切片后，把它前后几个切片也带上", "Small-to-big: when a chunk is hit, also include the chunks around it")}
      />
      <label title={t("参考片段在提示词里的排列顺序", "Order of source blocks in the prompt")}>
        {t("片段排序", "Order")}
        <select value={value.order} onChange={(e) => onChange({ ...value, order: e.target.value as ContextParams["order"] })}>
          <option value="score">{t("按相关度（高→低）", "By relevance (high → low)")}</option>
          <option value="document">{t("按原文顺序", "Document order")}</option>
          <option value="edges">{t("两头放最相关（Lost in the Middle）", "Most relevant at both ends (Lost in the Middle)")}</option>
        </select>
      </label>
    </div>
  );
}

function GenerationEditor({ value, onChange }: { value: GenerationSettings; onChange: (v: GenerationSettings) => void }) {
  return (
    <div className="gen-editor">
      <label>
        {t("系统提示词（System Prompt）", "System prompt")}
        <textarea rows={6} value={value.system_prompt} onChange={(e) => onChange({ ...value, system_prompt: e.target.value })} />
      </label>
      <label>
        {t("用户消息模板（必须包含 {sources} 和 {question}）", "User message template (must contain {sources} and {question})")}
        <textarea rows={3} value={value.user_template} onChange={(e) => onChange({ ...value, user_template: e.target.value })} />
      </label>
      <label>
        {t("每个片段的模板（可用 {id} {doc_name} {text} {score}）", "Per-source template (can use {id} {doc_name} {text} {score})")}
        <textarea rows={3} value={value.source_template} onChange={(e) => onChange({ ...value, source_template: e.target.value })} />
      </label>
      <div className="strategy-editor">
        <Num label="max_tokens" value={value.max_tokens} min={1} allowEmpty onChange={(v) => onChange({ ...value, max_tokens: v })} title={t("回答最多生成多少 token，太小会被截断", "Maximum tokens to generate; too small truncates the answer")} />
        <Num
          label={t("temperature（仅 OpenAI 兼容）", "temperature (OpenAI-compatible only)")}
          value={value.temperature}
          step={0.1}
          min={0}
          max={2}
          allowEmpty
          onChange={(v) => onChange({ ...value, temperature: v })}
          title={t("越高越随机、越有创意；RAG 问答一般用 0~0.3。新版 Claude 不再接受 temperature", "Higher = more random and creative; RAG usually uses 0–0.3. Newer Claude models no longer accept temperature")}
        />
        <label title={t("Claude 的思考深度：越高越仔细，也越慢、越贵", "How hard Claude thinks: higher is more careful, slower and more expensive")}>
          {t("effort（仅 Claude）", "effort (Claude only)")}
          <select value={value.effort ?? ""} onChange={(e) => onChange({ ...value, effort: e.target.value || null })}>
            <option value="">{t("用模型配置", "Model config")}</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
            <option value="max">max</option>
          </select>
        </label>
      </div>
    </div>
  );
}

const principle = (name: SectionName) => (getLang() === "en" ? PRINCIPLE_EN : PRINCIPLE)[name];

const PRINCIPLE: Record<SectionName, ReactNode> = {
  chunking: (
    <>
      <p>LLM 一次能读的内容有限，向量模型也只擅长表示一小段话的意思，所以先把文档切成小块（chunk），检索时只把最相关的几块交给模型。</p>
      <ul>
        <li>切得太大：一块里混着好几个话题，向量变得“模糊”，检索不准，也浪费上下文。</li>
        <li>切得太小：一句话被拆散，单独一块缺少上下文，模型拿到也答不全。</li>
        <li>重叠（overlap）：相邻两块共享一段文字，防止关键信息正好落在切口上。</li>
      </ul>
      <p>不同切分算法的区别在于“在哪里下刀”：固定长度不看内容；按句子 / 段落 / 递归切分尽量在自然边界断开；语义切分在意思转折处断开。</p>
    </>
  ),
  embedding: (
    <>
      <p>
        Embedding 模型把一段文字变成一个几百到上千维的向量。训练时让意思相近的句子向量靠近、无关的远离，于是“文字的相似度”就变成了“向量的距离”，可以用数学方法快速比较。
      </p>
      <ul>
        <li>维度越高通常表达能力越强，但更占空间、更慢。</li>
        <li>模型要和语言匹配：中文文档用英文模型效果会很差。</li>
        <li>不同模型的向量空间互不相通，换模型后必须用新模型把所有切片重新向量化（重建索引）。</li>
        <li>有些模型（如 E5、BGE）给“问题”和“文档”加不同前缀或指令，用错会明显降低效果。</li>
      </ul>
    </>
  ),
  index: (
    <>
      <p>
        最直接的检索是把问题向量和每个切片向量都算一遍距离（暴力检索，O(N)）。切片到百万级时太慢，于是有了近似最近邻（ANN）索引，用一点准确率换大量速度。
      </p>
      <p>
        HNSW（Hierarchical Navigable Small World）是最常用的 ANN 算法：把向量连成多层“邻居图”，上层稀疏、下层稠密。查询时从最上层的入口出发，每层都贪心地走向更近的邻居，再下到下一层细找，像先坐飞机再换地铁最后步行。
      </p>
      <p>M、ef_construction 决定图建得多好，ef_search 决定查询时找得多仔细。可以在“检索调试”里把“精确计算”和“HNSW”放在两列，看看结果有没有差别。</p>
    </>
  ),
  query: (
    <>
      <p>用户的问题常常不适合直接拿去检索：太口语、依赖上下文、或者用词和文档不一样。这一步在检索前先用 LLM 处理问题。</p>
      <ul>
        <li>
          <b>结合历史改写</b>：多轮对话里“那北京呢？”单独检索什么也找不到，改写成“出差住在北京每晚最多能报销多少？”再检索。
        </li>
        <li>
          <b>多查询</b>：同一个意思换几种说法各检索一次，再用 RRF（按排名倒数相加）融合，弥补措辞差异，提高召回率。
        </li>
        <li>
          <b>HyDE</b>：先让 LLM 写一段“假想答案”，用它的向量去检索。答案和文档的写法更像，向量往往比“问题”离正确文档更近。BM25 仍用原问题。
        </li>
      </ul>
    </>
  ),
  retrieval: (
    <>
      <p>检索就是从所有切片里挑出和问题最相关的 Top K 个。主要有两类信号：</p>
      <ul>
        <li>
          <b>向量（语义）</b>：理解同义、换说法，但对专有名词、编号、数字不敏感。
        </li>
        <li>
          <b>BM25（关键词）</b>：词频 × 逆文档频率，越稀有的词命中越加分，对精确匹配很强，但不懂同义词。
        </li>
      </ul>
      <p>混合检索把两者融合，通常比单独用任何一种都好。之后还可以用交叉编码器重排序（更准但更慢）、用 MMR 去掉内容重复的片段，再用相似度阈值过滤掉明显无关的结果。</p>
    </>
  ),
  context: (
    <>
      <p>检索到的片段要整理成一段“参考资料”放进提示词。怎么放会影响回答质量：</p>
      <ul>
        <li>
          <b>相邻片段扩展（small-to-big）</b>：用小切片检索更准，但给模型看时把前后文也带上，信息更完整。相邻或重叠的范围会合并成一段。
        </li>
        <li>
          <b>排序</b>：研究发现 LLM 对长上下文开头和结尾的信息利用得最好、中间最差（Lost in the Middle），所以可以把最相关的放两头。按原文顺序则读起来更连贯。
        </li>
        <li>
          <b>字数上限</b>：资料越多越贵、越慢，噪音也越多，超出上限的低相关片段直接丢掉。
        </li>
      </ul>
    </>
  ),
  generation: (
    <>
      <p>最后把“系统提示词 + 历史对话 + 参考资料 + 问题”发给 LLM。提示词决定模型怎么使用资料：只依据资料回答、标注来源编号、找不到就说找不到，这些约束能显著减少编造（幻觉）。</p>
      <p>
        可以试着改模板做实验：比如去掉“只依据片段回答”，问一个文档里没有的问题，看看模型会不会开始编；或者把片段模板里的文件名去掉，看引用是否变差。问答页的“流程追踪”会显示最终发给模型的完整提示词。
      </p>
      <p>temperature 控制随机性（RAG 问答一般设低）；Claude 新模型不接受 temperature，改用 effort 控制思考深度。</p>
    </>
  ),
};

const PRINCIPLE_EN: Record<SectionName, ReactNode> = {
  chunking: (
    <>
      <p>An LLM can only read so much at once, and embedding models are best at representing the meaning of a short passage. So documents are first cut into small pieces (chunks), and only the most relevant few are handed to the model.</p>
      <ul>
        <li>Too large: one chunk mixes several topics, its vector gets "blurry", retrieval is less precise, and context is wasted.</li>
        <li>Too small: sentences are scattered, a chunk lacks context on its own, and the model can't answer fully.</li>
        <li>Overlap: neighboring chunks share some text, so key information that falls on a boundary isn't lost.</li>
      </ul>
      <p>The algorithms differ in where they cut: fixed length ignores content; sentence / paragraph / recursive splitting try to break at natural boundaries; semantic splitting breaks where the meaning shifts.</p>
    </>
  ),
  embedding: (
    <>
      <p>
        An embedding model turns a passage into a vector with hundreds to thousands of dimensions. It is trained so that sentences with similar meanings end up close together and unrelated ones far apart, which turns "text similarity" into "vector distance" that can be compared quickly with math.
      </p>
      <ul>
        <li>More dimensions usually means more expressive power, but more storage and slower search.</li>
        <li>The model must match the language: an English-only model works poorly on Chinese documents, and vice versa.</li>
        <li>Vector spaces of different models are incompatible. After switching models, every chunk must be re-embedded (rebuild the index).</li>
        <li>Some models (e.g. E5, BGE) expect different prefixes or instructions for queries and documents; getting them wrong noticeably hurts quality.</li>
      </ul>
    </>
  ),
  index: (
    <>
      <p>
        The most direct search computes the distance between the query vector and every chunk vector (brute force, O(N)). At millions of chunks this is too slow, so approximate nearest neighbor (ANN) indexes trade a little accuracy for a lot of speed.
      </p>
      <p>
        HNSW (Hierarchical Navigable Small World) is the most widely used ANN algorithm. It links vectors into a multi-layer neighbor graph: sparse at the top, dense at the bottom. A query starts at an entry point on the top layer, greedily moves to closer neighbors on each layer, then drops down to search more finely, like taking a plane, then the subway, then walking.
      </p>
      <p>M and ef_construction decide how good the graph is; ef_search decides how carefully queries search it. Put "Exact" and "HNSW" in two columns on the Search lab page to see whether the results differ.</p>
    </>
  ),
  query: (
    <>
      <p>A user's question is often a poor search query: too casual, dependent on context, or worded differently from the documents. This step processes the question with the LLM before retrieval.</p>
      <ul>
        <li>
          <b>Condense with history</b>: in a conversation, "What about Beijing?" finds nothing on its own; it is rewritten to "How much can I claim per night for a hotel in Beijing?" before searching.
        </li>
        <li>
          <b>Multi-query</b>: search the same intent with several phrasings, then fuse with RRF (sum of reciprocal ranks), making up for wording differences and raising recall.
        </li>
        <li>
          <b>HyDE</b>: have the LLM write a hypothetical answer first and search with its vector. An answer is written more like the documents, so its vector is often closer to the right chunks than the question's. BM25 still uses the original question.
        </li>
      </ul>
    </>
  ),
  retrieval: (
    <>
      <p>Retrieval picks the Top K chunks most relevant to the question. There are two main signals:</p>
      <ul>
        <li>
          <b>Vector (semantic)</b>: understands synonyms and paraphrases, but is weak on names, IDs and numbers.
        </li>
        <li>
          <b>BM25 (keyword)</b>: term frequency × inverse document frequency; rarer words score higher. Strong for exact matches but knows no synonyms.
        </li>
      </ul>
      <p>Hybrid search fuses the two and usually beats either alone. After that you can rerank with a cross-encoder (more accurate, slower), drop near-duplicate chunks with MMR, and filter clearly irrelevant results with a similarity threshold.</p>
    </>
  ),
  context: (
    <>
      <p>Retrieved chunks are arranged into a "sources" section of the prompt. How they are arranged affects answer quality:</p>
      <ul>
        <li>
          <b>Neighbor expansion (small-to-big)</b>: small chunks retrieve more precisely, but the model sees the surrounding text too, so information is complete. Adjacent or overlapping ranges are merged into one block.
        </li>
        <li>
          <b>Order</b>: research found LLMs use information at the start and end of a long context best and the middle worst ("Lost in the Middle"), so the most relevant blocks can go at both ends. Document order reads more naturally.
        </li>
        <li>
          <b>Character budget</b>: more sources cost more, run slower and add noise; lower-relevance blocks beyond the budget are dropped.
        </li>
      </ul>
    </>
  ),
  generation: (
    <>
      <p>Finally, "system prompt + conversation history + sources + question" is sent to the LLM. The prompt decides how the model uses the sources: answer only from them, cite source numbers, and say so when nothing is found. These constraints greatly reduce made-up answers (hallucinations).</p>
      <p>
        Try experimenting with the templates: remove "answer only from the sources" and ask something the documents don't cover to see whether the model starts making things up; or remove the file name from the source template and see whether citations get worse. "Pipeline trace" on the Chat page shows the full prompt sent to the model.
      </p>
      <p>temperature controls randomness (keep it low for RAG). Newer Claude models don't accept temperature; use effort to control how hard they think.</p>
    </>
  ),
};
