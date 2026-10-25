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
      setMsg({ type: "ok", text: reindexHint ? "已保存。这个环节变了以后需要重建索引，点页面顶部或下面的“重建索引”。" : "已保存，下一次问答生效。" });
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
      setMsg({ type: "ok", text: `重建完成：${r.documents} 篇文档，${r.chunks} 个切片` });
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
      <h2>RAG 流程</h2>
      <p className="muted">
        一次问答依次经过下面这些环节。每个环节都可以切换算法、调整参数；问答页每条回答下的“流程追踪”能看到每一步的实际结果。
      </p>
      <div className="flow">
        {[
          ["chunking", "文档切分"],
          ["embedding", "向量化"],
          ["index", "向量索引"],
          ["query", "问题处理"],
          ["retrieval", "检索"],
          ["context", "上下文组装"],
          ["generation", "生成回答"],
        ].map(([id, label], i) => (
          <a key={id} href={`#step-${id}`} className={dirty(id as SectionName) ? "dirty" : ""}>
            <span>{i + 1}</span>
            {label}
          </a>
        ))}
      </div>
      <p className="muted small">前 3 步在导入文档时执行（离线），改了要重建索引；后 4 步在每次提问时执行（在线），保存后立即生效。</p>
      {msg && <div className={`notice ${msg.type} sticky`}>{msg.text}</div>}

      <Section id="chunking" n={1} title="文档切分" {...section("chunking", true)} principle={PRINCIPLE.chunking}>
        <ChunkingEditor value={draft.chunking} onChange={(v) => set("chunking", v)} />
        <p className="muted small">这里是全局默认；单篇文档可以在“文档管理 → 切片”里单独设置并预览。</p>
      </Section>

      <Section id="embedding" n={2} title="向量化（Embedding）" {...section("embedding", true)} principle={PRINCIPLE.embedding}>
        <EmbeddingEditor value={draft.embedding} onChange={(v) => set("embedding", v)} providers={providers} />
      </Section>

      <Section id="index" n={3} title="向量索引（HNSW）" {...section("index", true)} principle={PRINCIPLE.index}>
        <IndexEditor value={draft.index} onChange={(v) => set("index", v)} />
      </Section>

      <Section id="query" n={4} title="问题处理" {...section("query")} principle={PRINCIPLE.query}>
        <QueryEditor value={draft.query} onChange={(v) => set("query", v)} />
      </Section>

      <Section id="retrieval" n={5} title="检索" {...section("retrieval")} principle={PRINCIPLE.retrieval}>
        <StrategyEditor value={draft.retrieval} onChange={(v) => set("retrieval", v)} />
        <p className="muted small">想对比不同检索策略的效果，用“检索调试”页并排比较，满意后点“设为问答默认”。</p>
      </Section>

      <Section id="context" n={6} title="上下文组装" {...section("context")} principle={PRINCIPLE.context}>
        <ContextEditor value={draft.context} onChange={(v) => set("context", v)} />
      </Section>

      <Section id="generation" n={7} title="生成回答" {...section("generation")} principle={PRINCIPLE.generation}>
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
        {props.onReindex && <span className="badge muted-badge">改后需重建索引</span>}
      </h3>
      <details className="principle">
        <summary>原理说明</summary>
        {props.principle}
      </details>
      {props.children}
      <div className="row">
        <button onClick={props.onSave} disabled={!props.dirty}>
          保存
        </button>
        <button className="secondary" onClick={props.onReset}>
          恢复默认
        </button>
        {props.onReindex && (
          <button className="secondary" onClick={props.onReindex}>
            重建索引
          </button>
        )}
        {props.dirty && <span className="muted small">有未保存的修改</span>}
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
        placeholder={allowEmpty ? "留空=用模型配置" : undefined}
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

const OPENAI_EMBED_SUGGESTIONS = [
  "text-embedding-3-small（OpenAI）",
  "text-embedding-3-large（OpenAI）",
  "text-embedding-v3（通义千问）",
  "embedding-3（智谱）",
  "bge-m3（Ollama，先 ollama pull bge-m3）",
  "nomic-embed-text（Ollama）",
];

function EmbeddingEditor({ value, onChange, providers }: { value: EmbeddingSettings; onChange: (v: EmbeddingSettings) => void; providers: Provider[] }) {
  const [models, setModels] = useState<EmbeddingModelInfo[]>([]);
  const [texts, setTexts] = useState("出差住宿每晚能报销多少钱？\n差旅住宿标准：一线城市每晚不超过 650 元。\n公司班车早上八点发车。");
  const [result, setResult] = useState<EmbeddingTestResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.embeddingModels().then(setModels);
  }, []);
  const known = models.some((m) => m.model === value.model);
  const openaiProviders = providers.filter((p) => p.type === "openai");
  const info = models.find((m) => m.model === value.model);
  const lines = texts.split("\n").map((t) => t.trim()).filter(Boolean);

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
          向量化方式
          <select value={value.backend} onChange={(e) => onChange({ ...value, backend: e.target.value as EmbeddingSettings["backend"] })}>
            <option value="fastembed">本地模型（fastembed）</option>
            <option value="openai">OpenAI 兼容接口</option>
            <option value="hash">字符哈希（离线对照）</option>
          </select>
        </label>
        {value.backend === "fastembed" && (
          <>
            <label>
              模型
              <select value={known ? value.model : "__custom"} onChange={(e) => onChange({ ...value, model: e.target.value === "__custom" ? "" : e.target.value })}>
                {models.map((m) => (
                  <option key={m.model} value={m.model}>
                    {m.model}（{m.lang}，{m.dim} 维，{m.size}）
                  </option>
                ))}
                <option value="__custom">自定义…</option>
              </select>
            </label>
            {!known && (
              <label title="任何 fastembed 支持的模型名">
                模型名
                <input value={value.model} placeholder="例如 BAAI/bge-base-en-v1.5" onChange={(e) => onChange({ ...value, model: e.target.value })} />
              </label>
            )}
          </>
        )}
        {value.backend === "openai" && (
          <>
            <label title="复用这个配置的接口地址和 API Key">
              使用哪个接口
              <select value={value.provider_id ?? ""} onChange={(e) => onChange({ ...value, provider_id: e.target.value || null })}>
                <option value="">请选择（在“LLM 模型”页添加 OpenAI 兼容配置）</option>
                {openaiProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}（{p.base_url || "api.openai.com"}）
                  </option>
                ))}
              </select>
            </label>
            <label>
              向量模型名
              <input value={value.model} list="embed-suggest" onChange={(e) => onChange({ ...value, model: e.target.value })} />
              <datalist id="embed-suggest">
                {OPENAI_EMBED_SUGGESTIONS.map((s) => (
                  <option key={s} value={s.split("（")[0]}>
                    {s}
                  </option>
                ))}
              </datalist>
            </label>
          </>
        )}
      </div>
      {value.backend === "fastembed" && info && <p className="muted small">{info.note}。首次使用会下载模型（{info.size}）。</p>}
      {value.backend === "hash" && <p className="muted small">字符哈希不理解语义，只是把字符片段映射到向量里，用来和真正的语义模型做对照。</p>}

      <div className="lab">
        <strong>向量化实验</strong>
        <span className="muted small">每行一句话，用上面选的模型（不必先保存）算出向量，看看哪些句子在向量空间里更近。</span>
        <textarea rows={3} value={texts} onChange={(e) => setTexts(e.target.value)} />
        <div className="row">
          <button className="secondary" onClick={test} disabled={busy || lines.length < 2}>
            {busy ? "计算中…" : "计算相似度"}
          </button>
          {result && (
            <span className="muted small">
              {result.embedder} · {result.dim} 维 · 耗时 {result.elapsed_ms} ms · 向量长度 {result.norms.map((n) => n.toFixed(2)).join(" / ")}
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
            <summary>看看向量长什么样（每句前 8 维）</summary>
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
      <label title="建图时衡量两个向量远近的方式">
        距离
        <select value={value.space} onChange={(e) => onChange({ ...value, space: e.target.value as IndexSettings["space"] })}>
          <option value="cosine">余弦距离 cosine</option>
          <option value="l2">欧氏距离平方 l2</option>
          <option value="ip">内积 ip</option>
        </select>
      </label>
      <Num label="M（每个节点的邻居数）" value={value.max_neighbors} min={2} max={128} onChange={(v) => onChange({ ...value, max_neighbors: v ?? 16 })} title="越大图越密，召回越高，内存占用和建图时间也越大。常用 8~64" />
      <Num label="ef_construction" value={value.ef_construction} min={10} max={2000} onChange={(v) => onChange({ ...value, ef_construction: v ?? 100 })} title="建图时每个节点搜索邻居的候选队列长度，越大图质量越好、建得越慢" />
      <Num label="ef_search" value={value.ef_search} min={1} max={2000} onChange={(v) => onChange({ ...value, ef_search: v ?? 100 })} title="查询时的候选队列长度，越大召回越高、查询越慢。必须 ≥ 要取回的数量" />
      <p className="help muted small">这些参数只在“检索”里选择“HNSW 近似检索”时生效；“精确计算”不使用索引。</p>
    </div>
  );
}

function QueryEditor({ value, onChange }: { value: QuerySettings; onChange: (v: QuerySettings) => void }) {
  return (
    <div className="strategy-editor">
      <Num label="带上最近几轮对话" value={value.history_turns} min={0} max={20} onChange={(v) => onChange({ ...value, history_turns: v ?? 0 })} title="生成回答时把最近几轮问答一起发给模型，0 表示每次都是新对话" />
      <Check label="结合历史改写问题" checked={value.condense_history} onChange={(v) => onChange({ ...value, condense_history: v })} title="检索前让 LLM 把“那北京呢？”这类追问改写成完整问题" />
      <Check label="多查询 Multi-Query" checked={value.multi_query} onChange={(v) => onChange({ ...value, multi_query: v })} title="让 LLM 换几种说法分别检索，再用 RRF 融合" />
      {value.multi_query && <Num label="额外生成几个查询" value={value.multi_query_n} min={1} max={8} onChange={(v) => onChange({ ...value, multi_query_n: v ?? 3 })} />}
      <Check label="HyDE 假想文档" checked={value.hyde} onChange={(v) => onChange({ ...value, hyde: v })} title="先让 LLM 写一段假想答案，用它的向量去检索" />
      <p className="help muted small">改写、多查询、HyDE 每个都会多调用一次 LLM（使用问答时选的模型，低 effort），会增加一点延迟和费用。</p>
    </div>
  );
}

function ContextEditor({ value, onChange }: { value: ContextParams; onChange: (v: ContextParams) => void }) {
  return (
    <div className="strategy-editor">
      <Num label="总字数上限" value={value.max_chars} min={200} step={500} onChange={(v) => onChange({ ...value, max_chars: v ?? 6000 })} title="放进提示词的参考资料最多多少字，超出的低相关片段会被丢掉" />
      <Num label="相邻片段扩展（前后各几个）" value={value.neighbor_window} min={0} max={5} onChange={(v) => onChange({ ...value, neighbor_window: v ?? 0 })} title="small-to-big：命中一个切片后，把它前后几个切片也带上" />
      <label title="参考片段在提示词里的排列顺序">
        片段排序
        <select value={value.order} onChange={(e) => onChange({ ...value, order: e.target.value as ContextParams["order"] })}>
          <option value="score">按相关度（高→低）</option>
          <option value="document">按原文顺序</option>
          <option value="edges">两头放最相关（Lost in the Middle）</option>
        </select>
      </label>
    </div>
  );
}

function GenerationEditor({ value, onChange }: { value: GenerationSettings; onChange: (v: GenerationSettings) => void }) {
  return (
    <div className="gen-editor">
      <label>
        系统提示词（System Prompt）
        <textarea rows={6} value={value.system_prompt} onChange={(e) => onChange({ ...value, system_prompt: e.target.value })} />
      </label>
      <label>
        用户消息模板（必须包含 {"{sources}"} 和 {"{question}"}）
        <textarea rows={3} value={value.user_template} onChange={(e) => onChange({ ...value, user_template: e.target.value })} />
      </label>
      <label>
        每个片段的模板（可用 {"{id} {doc_name} {text} {score}"}）
        <textarea rows={3} value={value.source_template} onChange={(e) => onChange({ ...value, source_template: e.target.value })} />
      </label>
      <div className="strategy-editor">
        <Num label="max_tokens" value={value.max_tokens} min={1} allowEmpty onChange={(v) => onChange({ ...value, max_tokens: v })} title="回答最多生成多少 token，太小会被截断" />
        <Num
          label="temperature（仅 OpenAI 兼容）"
          value={value.temperature}
          step={0.1}
          min={0}
          max={2}
          allowEmpty
          onChange={(v) => onChange({ ...value, temperature: v })}
          title="越高越随机、越有创意；RAG 问答一般用 0~0.3。新版 Claude 不再接受 temperature"
        />
        <label title="Claude 的思考深度：越高越仔细，也越慢、越贵">
          effort（仅 Claude）
          <select value={value.effort ?? ""} onChange={(e) => onChange({ ...value, effort: e.target.value || null })}>
            <option value="">用模型配置</option>
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
