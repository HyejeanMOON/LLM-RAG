import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { api, streamChat, type ChatTurn, type DocumentMeta, type Filters, type Provider, type Source, type Trace } from "../api";
import { describe } from "../components/StrategyEditor";
import { t } from "../i18n";

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
          onDelta: (d) => updateLast((m) => ({ ...m, content: m.content + d })),
          onError: (error) => updateLast((m) => ({ ...m, error, pending: false })),
          onDone: (info) => updateLast((m) => ({ ...m, pending: false, generationMs: info.generation_ms })),
        },
        ctrl.signal,
      );
    } catch (e) {
      const aborted = (e as Error).name === "AbortError";
      updateLast((m) => ({ ...m, pending: false, error: aborted ? undefined : String(e), content: m.content + (aborted ? t("\n\n（已停止）", "\n\n(stopped)") : "") }));
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
          {t("模型", "Model")}
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.model})
              </option>
            ))}
          </select>
        </label>
        <button className="secondary" onClick={() => setShowFilters((v) => !v)}>
          {t("元数据过滤", "Metadata filter")}
          {activeFilters ? ` (${activeFilters})` : ""}
        </button>
        <button className="secondary" onClick={() => setMessages([])} disabled={busy || !messages.length}>
          {t("清空对话", "Clear chat")}
        </button>
      </div>
      {showFilters && (
        <div className="filters">
          <div>
            <span className="muted small">{t("文档：", "Documents: ")}</span>
            {docs.map((d) => (
              <label key={d.id} className="chip">
                <input type="checkbox" checked={!!filters.doc_ids?.includes(d.id)} onChange={() => setFilters({ ...filters, doc_ids: toggle(filters.doc_ids, d.id) })} />
                {d.name}
              </label>
            ))}
          </div>
          <div>
            <span className="muted small">{t("标签（含任一）：", "Tags (any of): ")}</span>
            {allTags.length === 0 && <span className="muted small">{t("还没有标签，可以在文档管理里添加", "No tags yet. Add them on the Documents page.")}</span>}
            {allTags.map((tag) => (
              <label key={tag} className="chip">
                <input type="checkbox" checked={!!filters.tags?.includes(tag)} onChange={() => setFilters({ ...filters, tags: toggle(filters.tags, tag) })} />
                {tag}
              </label>
            ))}
          </div>
          <div className="row">
            <span className="muted small">{t("更新日期：", "Updated: ")}</span>
            <input type="date" value={filters.date_from ?? ""} onChange={(e) => setFilters({ ...filters, date_from: e.target.value })} />
            {t("至", "to")}
            <input type="date" value={filters.date_to ?? ""} onChange={(e) => setFilters({ ...filters, date_to: e.target.value })} />
            <button className="link" onClick={() => setFilters({})}>
              {t("清除过滤", "Clear filters")}
            </button>
          </div>
          <p className="muted small">
            {t(
              "过滤在检索之前执行：只在符合条件的文档里找片段。不选表示全部文档。",
              "Filtering runs before retrieval: chunks are only searched in matching documents. Leave empty to search all documents.",
            )}
          </p>
        </div>
      )}

      <div className="messages">
        {!messages.length && (
          <div className="empty">
            <p>{t("向知识库提问，回答会标注引用的片段编号，例如 [1]。", "Ask the knowledge base. Answers cite the chunks they use, e.g. [1].")}</p>
            <p className="muted">
              {t(
                "试试：“出差住在上海每晚最多能报销多少？”，每条回答下面可以展开“流程追踪”看每一步做了什么。",
                "Try: \"How much can I claim per night for a hotel in Shanghai?\" The preloaded sample is in Chinese; upload backend/sample_docs/xinghe_handbook.en.md for the English version. Expand \"Pipeline trace\" under each answer to see what every step did.",
              )}
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === "assistant" && m.providerName && <div className="msg-meta">{m.providerName}</div>}
            <div className="bubble">
              {m.role === "assistant" ? <Markdown>{m.content || (m.pending ? (m.trace ? t("生成中…", "Generating…") : t("检索中…", "Retrieving…")) : "")}</Markdown> : m.content}
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
          placeholder={t("输入问题，Enter 发送，Shift+Enter 换行", "Ask a question. Enter to send, Shift+Enter for a new line")}
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
            {t("停止", "Stop")}
          </button>
        ) : (
          <button onClick={send} disabled={!input.trim() || !providerId}>
            {t("发送", "Send")}
          </button>
        )}
      </div>
    </div>
  );
}

function SourceList({ sources }: { sources: Source[] }) {
  return (
    <details className="sources">
      <summary>{t(`参考片段（${sources.length}）`, `Sources (${sources.length})`)}</summary>
      {sources.length === 0 && <div className="muted">{t("没有检索到相关片段", "No relevant chunks found")}</div>}
      {sources.map((s, j) => (
        <div key={j} className="source">
          <div className="source-head">
            [{j + 1}] {s.doc_name} · {t("切片", "chunk")}{" "}
            {s.indexes.length > 1
              ? `${s.indexes[0]}–${s.indexes[s.indexes.length - 1]}${t(`（命中 ${s.hit_indexes.join("、")}）`, ` (hits ${s.hit_indexes.join(", ")})`)}`
              : s.index}
            <span className="score">
              {t("得分", "score")} {s.score.toFixed(3)} · {t("余弦", "cosine")} {s.scores.cosine.toFixed(3)} · BM25 {s.scores.bm25.toFixed(2)}
              {s.scores.matched_queries ? t(` · 命中 ${s.scores.matched_queries} 个查询`, ` · matched ${s.scores.matched_queries} queries`) : ""}
            </span>
          </div>
          <div className="source-text">{s.text}</div>
        </div>
      ))}
    </details>
  );
}

const ORDER_LABEL = {
  score: () => t("按相关度", "by relevance"),
  document: () => t("按原文顺序", "in document order"),
  edges: () => t("两头放最相关", "most relevant at both ends"),
};

function TracePanel({ trace, generationMs }: { trace: Trace; generationMs?: number }) {
  const r = trace.retrieval;
  const c = trace.context;
  return (
    <details className="trace">
      <summary>{t("🔍 流程追踪", "🔍 Pipeline trace")}</summary>
      <ol>
        <li>
          <b>{t("问题处理", "Query processing")}</b>
          <div>
            {t("原问题：", "Original question: ")}
            {trace.question}
          </div>
          {trace.condensed_query && (
            <div>
              {t("结合历史改写：", "Condensed with history: ")}
              {trace.condensed_query}
            </div>
          )}
          {trace.multi_queries && (
            <div>
              {t("多查询：", "Multi-query: ")}
              <ul>
                {trace.multi_queries.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          )}
          {trace.hyde_text && (
            <div>
              {t("HyDE 假想文档（用它的向量检索）：", "HyDE hypothetical document (its vector is used for search): ")}
              <div className="quote">{trace.hyde_text}</div>
            </div>
          )}
          {!trace.condensed_query && !trace.multi_queries && !trace.hyde_text && <div className="muted">{t("未开启改写 / 多查询 / HyDE，直接用原问题检索", "No condense / multi-query / HyDE; searched with the original question")}</div>}
        </li>
        <li>
          <b>{t("元数据过滤", "Metadata filter")}</b>
          <div>
            {trace.filter
              ? (() => {
                  const cond = JSON.stringify(Object.fromEntries(Object.entries(trace.filter).filter(([k]) => k !== "matched_documents")));
                  return t(`条件 ${cond}，符合 ${trace.filter.matched_documents} 篇文档`, `Filter ${cond}, ${trace.filter.matched_documents} documents match`);
                })()
              : t("未过滤，检索全部文档", "No filter, searched all documents")}
          </div>
        </li>
        <li>
          <b>{t("检索", "Retrieval")}</b>: {describe(r.params)} · Top {r.params.top_k}
          {r.per_query.map((q, i) => (
            <div key={i} className="muted small">
              {r.per_query.length > 1 && t(`查询 ${i + 1}「${q.query}」：`, `Query ${i + 1} "${q.query}": `)}
              {t(`共 ${q.corpus} 个切片，实际打分 ${q.searched} 个，返回 ${q.hits} 个`, `${q.corpus} chunks, ${q.searched} scored, ${q.hits} returned`)}
            </div>
          ))}
          {r.per_query.length > 1 && (
            <div className="muted small">{t(`多个查询的结果用 RRF 融合后取前 ${r.params.top_k} 个`, `Results of all queries fused with RRF, top ${r.params.top_k} kept`)}</div>
          )}
        </li>
        <li>
          <b>{t("上下文组装", "Context assembly")}</b>:{" "}
          {t(`${c.hits} 个命中 → ${c.blocks} 段参考资料，共 ${c.chars} 字`, `${c.hits} hits → ${c.blocks} source blocks, ${c.chars} characters`)}
          {c.dropped > 0 && t(`，因超过 ${c.max_chars} 字上限丢弃 ${c.dropped} 段`, `, ${c.dropped} blocks dropped (over the ${c.max_chars}-character budget)`)}
          <div className="muted small">
            {t("相邻扩展", "Neighbors")} ±{c.neighbor_window} · {ORDER_LABEL[c.order]()}
          </div>
        </li>
        <li>
          <b>{t("生成", "Generation")}</b>: {trace.provider} · {t("参数", "params")} {JSON.stringify(trace.prompt.llm_params)}
          <details>
            <summary>{t("查看发送给模型的完整提示词", "Show the full prompt sent to the model")}</summary>
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
        {t("耗时：问题处理", "Time: query")} {trace.timings.query_ms} ms · {t("检索", "retrieval")} {trace.timings.retrieval_ms} ms
        {generationMs !== undefined && ` · ${t("生成", "generation")} ${generationMs} ms`}
      </div>
    </details>
  );
}
