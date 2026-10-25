import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { api, streamChat, type ChatTurn, type DocumentMeta, type Hit, type Provider } from "../api";

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Hit[];
  error?: string;
  pending?: boolean;
  providerName?: string;
}

export default function ChatPage({ version }: { version: number }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerId, setProviderId] = useState("");
  const [docs, setDocs] = useState<DocumentMeta[]>([]);
  const [docFilter, setDocFilter] = useState<string[]>([]);
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
      setDocFilter((cur) => cur.filter((id) => ds.some((d) => d.id === id)));
    });
  }, [version]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const updateLast = (fn: (m: Message) => Message) =>
    setMessages((ms) => [...ms.slice(0, -1), fn(ms[ms.length - 1])]);

  async function send() {
    const query = input.trim();
    if (!query || busy) return;
    const history: ChatTurn[] = messages
      .filter((m) => !m.error && m.content)
      .map((m) => ({ role: m.role, content: m.content }));
    const providerName = providers.find((p) => p.id === providerId)?.name;
    setMessages((ms) => [...ms, { role: "user", content: query }, { role: "assistant", content: "", pending: true, providerName }]);
    setInput("");
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamChat(
        { query, provider_id: providerId || undefined, doc_ids: docFilter.length ? docFilter : undefined, history },
        {
          onSources: (sources) => updateLast((m) => ({ ...m, sources })),
          onDelta: (t) => updateLast((m) => ({ ...m, content: m.content + t })),
          onError: (error) => updateLast((m) => ({ ...m, error, pending: false })),
          onDone: () => updateLast((m) => ({ ...m, pending: false })),
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
        <label>
          检索范围
          <select
            value={docFilter.length === 1 ? docFilter[0] : ""}
            onChange={(e) => setDocFilter(e.target.value ? [e.target.value] : [])}
          >
            <option value="">全部文档</option>
            {docs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <button className="secondary" onClick={() => setMessages([])} disabled={busy || !messages.length}>
          清空对话
        </button>
      </div>

      <div className="messages">
        {!messages.length && (
          <div className="empty">
            <p>向知识库提问，回答会标注引用的片段编号，例如 [1]。</p>
            <p className="muted">试试：“出差住在上海每晚最多能报销多少？”</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === "assistant" && m.providerName && <div className="msg-meta">{m.providerName}</div>}
            <div className="bubble">
              {m.role === "assistant" ? <Markdown>{m.content || (m.pending ? "思考中…" : "")}</Markdown> : m.content}
              {m.error && <div className="error">⚠️ {m.error}</div>}
            </div>
            {m.sources && (
              <details className="sources">
                <summary>参考片段（{m.sources.length}）</summary>
                {m.sources.length === 0 && <div className="muted">没有检索到相关片段</div>}
                {m.sources.map((s, j) => (
                  <div key={j} className="source">
                    <div className="source-head">
                      [{j + 1}] {s.doc_name} #{s.index} <span className="score">相似度 {s.score.toFixed(3)}</span>
                    </div>
                    <div className="source-text">{s.text}</div>
                  </div>
                ))}
              </details>
            )}
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
