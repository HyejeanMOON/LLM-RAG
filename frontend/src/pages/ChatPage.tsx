import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { api, streamChat, type ChatTurn, type DocumentMeta, type Filters, type Provider, type Source, type Trace } from "../api";
import { describe } from "../components/StrategyEditor";

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  trace?: Trace;
  generationMs?: number;
  error?: string;
  pending?: boolean;
  providerName?: string;
}

export default function ChatPage({ version }: { version: number }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerId, setProviderId] = useState("");
  const [docs, setDocs] = useState<DocumentMeta[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [filters, setFilters] = useState<Filters>({});
  const [showFilters, setShowFilters] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.listProviders().then((ps) => {
      setProviders(ps);
      setProviderId((cur) => (ps.some((p) => p.id === cur) ? cur : (ps.find((p) => p.is_default) ?? ps[0])?.id ?? ""));
    });
    api.listDocuments().then((ds) => {
      setDocs(ds);
      setFilters((f) => ({ ...f, doc_ids: f.doc_ids?.filter((id) => ds.some((d) => d.id === id)) }));
    });
    api.listTags().then(setAllTags);
  }, [version]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const updateLast = (fn: (m: Message) => Message) => setMessages((ms) => [...ms.slice(0, -1), fn(ms[ms.length - 1])]);
  const activeFilters = [filters.doc_ids?.length, filters.tags?.length, filters.date_from, filters.date_to].filter(Boolean).length;

  async function send() {
    const query = input.trim();
    if (!query || busy) return;
    const history: ChatTurn[] = messages.filter((m) => !m.error && m.content).map((m) => ({ role: m.role, content: m.content }));
    const providerName = providers.find((p) => p.id === providerId)?.name;
    setMessages((ms) => [...ms, { role: "user", content: query }, { role: "assistant", content: "", pending: true, providerName }]);
    setInput("");
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const clean: Filters = {
      doc_ids: filters.doc_ids?.length ? filters.doc_ids : undefined,
      tags: filters.tags?.length ? filters.tags : undefined,
      date_from: filters.date_from || undefined,
      date_to: filters.date_to || undefined,
    };
    try {
      await streamChat(
        { query, provider_id: providerId || undefined, history, ...clean },
        {
          onTrace: (trace) => updateLast((m) => ({ ...m, trace })),
          onSources: (sources) => updateLast((m) => ({ ...m, sources })),
          onDelta: (t) => updateLast((m) => ({ ...m, content: m.content + t })),
          onError: (error) => updateLast((m) => ({ ...m, error, pending: false })),
          onDone: (info) => updateLast((m) => ({ ...m, pending: false, generationMs: info.generation_ms })),
        },
        ctrl.signal,
      );
    } catch (e) {
      const aborted = (e as Error).name === "AbortError";
      updateLast((m) => ({ ...m, pending: false, error: aborted ? undefined : String(e), content: m.content + (aborted ? "\n\n（已停止）" : "") }));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  const toggle = (list: string[] | undefined, v: string) => (list?.includes(v) ? list.filter((x) => x !== v) : [...(list ?? []), v]);

  return (
    <div className="chat">
      <div className="toolbar">
        <label>
          模型
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{p.model}）
              </option>
            ))}
          </select>
        </label>
        <button className="secondary" onClick={() => setShowFilters((v) => !v)}>
          元数据过滤{activeFilters ? `（${activeFilters}）` : ""}
        </button>
        <button className="secondary" onClick={() => setMessages([])} disabled={busy || !messages.length}>
          清空对话
        </button>
      </div>
      {showFilters && (
        <div className="filters">
          <div>
            <span className="muted small">文档：</span>
            {docs.map((d) => (
              <label key={d.id} className="chip">
                <input type="checkbox" checked={!!filters.doc_ids?.includes(d.id)} onChange={() => setFilters({ ...filters, doc_ids: toggle(filters.doc_ids, d.id) })} />
                {d.name}
              </label>
            ))}
          </div>
          <div>
            <span className="muted small">标签（含任一）：</span>
            {allTags.length === 0 && <span className="muted small">还没有标签，可以在文档管理里添加</span>}
            {allTags.map((t) => (
              <label key={t} className="chip">
                <input type="checkbox" checked={!!filters.tags?.includes(t)} onChange={() => setFilters({ ...filters, tags: toggle(filters.tags, t) })} />
                {t}
              </label>
            ))}
          </div>
          <div className="row">
            <span className="muted small">更新日期：</span>
            <input type="date" value={filters.date_from ?? ""} onChange={(e) => setFilters({ ...filters, date_from: e.target.value })} />
            至
            <input type="date" value={filters.date_to ?? ""} onChange={(e) => setFilters({ ...filters, date_to: e.target.value })} />
            <button className="link" onClick={() => setFilters({})}>
              清除过滤
            </button>
          </div>
          <p className="muted small">过滤在检索之前执行：只在符合条件的文档里找片段。不选表示全部文档。</p>
        </div>
      )}

      <div className="messages">
        {!messages.length && (
          <div className="empty">
            <p>向知识库提问，回答会标注引用的片段编号，例如 [1]。</p>
            <p className="muted">试试：“出差住在上海每晚最多能报销多少？”，每条回答下面可以展开“流程追踪”看每一步做了什么。</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === "assistant" && m.providerName && <div className="msg-meta">{m.providerName}</div>}
            <div className="bubble">
              {m.role === "assistant" ? <Markdown>{m.content || (m.pending ? (m.trace ? "生成中…" : "检索中…") : "")}</Markdown> : m.content}
              {m.error && <div className="error">⚠️ {m.error}</div>}
            </div>
            {m.sources && <SourceList sources={m.sources} />}
            {m.trace && <TracePanel trace={m.trace} generationMs={m.generationMs} />}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="composer">
        <textarea
          value={input}
          placeholder="输入问题，Enter 发送，Shift+Enter 换行"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        {busy ? (
          <button className="danger" onClick={() => abortRef.current?.abort()}>
            停止
          </button>
        ) : (
          <button onClick={send} disabled={!input.trim() || !providerId}>
            发送
          </button>
        )}
      </div>
    </div>
  );
}

function SourceList({ sources }: { sources: Source[] }) {
  return (
    <details className="sources">
      <summary>参考片段（{sources.length}）</summary>
      {sources.length === 0 && <div className="muted">没有检索到相关片段</div>}
      {sources.map((s, j) => (
        <div key={j} className="source">
          <div className="source-head">
            [{j + 1}] {s.doc_name} · 切片 {s.indexes.length > 1 ? `${s.indexes[0]}–${s.indexes[s.indexes.length - 1]}（命中 ${s.hit_indexes.join("、")}）` : s.index}
            <span className="score">
              得分 {s.score.toFixed(3)} · 余弦 {s.scores.cosine.toFixed(3)} · BM25 {s.scores.bm25.toFixed(2)}
              {s.scores.matched_queries ? ` · 命中 ${s.scores.matched_queries} 个查询` : ""}
            </span>
          </div>
          <div className="source-text">{s.text}</div>
        </div>
      ))}
    </details>
  );
}

const ORDER_LABEL = { score: "按相关度", document: "按原文顺序", edges: "两头放最相关" };

function TracePanel({ trace, generationMs }: { trace: Trace; generationMs?: number }) {
  const r = trace.retrieval;
  const c = trace.context;
  return (
    <details className="trace">
      <summary>🔍 流程追踪</summary>
      <ol>
        <li>
          <b>问题处理</b>
          <div>原问题：{trace.question}</div>
          {trace.condensed_query && <div>结合历史改写：{trace.condensed_query}</div>}
          {trace.multi_queries && (
            <div>
              多查询：
              <ul>
                {trace.multi_queries.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          )}
          {trace.hyde_text && (
            <div>
              HyDE 假想文档（用它的向量检索）：<div className="quote">{trace.hyde_text}</div>
            </div>
          )}
          {!trace.condensed_query && !trace.multi_queries && !trace.hyde_text && <div className="muted">未开启改写 / 多查询 / HyDE，直接用原问题检索</div>}
        </li>
        <li>
          <b>元数据过滤</b>
          <div>{trace.filter ? `条件 ${JSON.stringify(Object.fromEntries(Object.entries(trace.filter).filter(([k]) => k !== "matched_documents")))}，符合 ${trace.filter.matched_documents} 篇文档` : "未过滤，检索全部文档"}</div>
        </li>
        <li>
          <b>检索</b>：{describe(r.params)} · Top {r.params.top_k}
          {r.per_query.map((q, i) => (
            <div key={i} className="muted small">
              {r.per_query.length > 1 && `查询 ${i + 1}「${q.query}」：`}共 {q.corpus} 个切片，实际打分 {q.searched} 个，返回 {q.hits} 个
            </div>
          ))}
          {r.per_query.length > 1 && <div className="muted small">多个查询的结果用 RRF 融合后取前 {r.params.top_k} 个</div>}
        </li>
        <li>
          <b>上下文组装</b>：{c.hits} 个命中 → {c.blocks} 段参考资料，共 {c.chars} 字
          {c.dropped > 0 && `，因超过 ${c.max_chars} 字上限丢弃 ${c.dropped} 段`}
          <div className="muted small">
            相邻扩展 ±{c.neighbor_window} · {ORDER_LABEL[c.order]}
          </div>
        </li>
        <li>
          <b>生成</b>：{trace.provider} · 参数 {JSON.stringify(trace.prompt.llm_params)}
          <details>
            <summary>查看发送给模型的完整提示词</summary>
            <div className="prompt-label">system</div>
            <pre>{trace.prompt.system}</pre>
            {trace.prompt.messages.map((m, i) => (
              <div key={i}>
                <div className="prompt-label">{m.role}</div>
                <pre>{m.content}</pre>
              </div>
            ))}
          </details>
        </li>
      </ol>
      <div className="muted small">
        耗时：问题处理 {trace.timings.query_ms} ms · 检索 {trace.timings.retrieval_ms} ms{generationMs !== undefined && ` · 生成 ${generationMs} ms`}
      </div>
    </details>
  );
}
