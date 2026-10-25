import { useEffect, useState } from "react";
import { api, type CompareResult, type DocumentMeta, type Hit, type RetrievalParams } from "../api";
import StrategyEditor, { DEFAULT_PARAMS, describe } from "../components/StrategyEditor";

interface Column {
  label: string;
  params: RetrievalParams;
  editing: boolean;
}

const PRESETS: RetrievalParams[] = [
  { ...DEFAULT_PARAMS },
  { ...DEFAULT_PARAMS, method: "bm25" },
  { ...DEFAULT_PARAMS, method: "hybrid", use_mmr: true },
];

const MAX_COLUMNS = 4;
const chunkKey = (h: Hit) => `${h.doc_id}#${h.index}`;

/** 检索调试：同一个问题用多种算法检索，并排对比片段和各项分数。不调用 LLM。 */
export default function SearchPage({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [query, setQuery] = useState("");
  const [docs, setDocs] = useState<DocumentMeta[]>([]);
  const [docId, setDocId] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tag, setTag] = useState("");
  const [columns, setColumns] = useState<Column[]>(PRESETS.map((p) => ({ label: "", params: p, editing: false })));
  const [results, setResults] = useState<CompareResult[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listDocuments().then(setDocs);
    api.listTags().then(setTags);
  }, [version]);

  const updateColumn = (i: number, patch: Partial<Column>) =>
    setColumns((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  async function run() {
    if (!query.trim()) return;
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const strategies = columns.map((c) => ({ ...c.params, label: c.label || describe(c.params) }));
      setResults(await api.compare(query, strategies, { doc_ids: docId ? [docId] : undefined, tags: tag ? [tag] : undefined }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault(p: RetrievalParams) {
    await api.updateSettings({ retrieval: p });
    onChanged();
    setNotice(`问答默认检索策略已改为：${describe(p)}`);
  }

  // 每个片段在各策略里的名次，用来显示“其他策略里排第几”
  const rankMaps = results?.map((r) => new Map(r.hits.map((h, i) => [chunkKey(h), i + 1])));

  return (
    <div className="search">
      <div className="row">
        <input
          className="grow"
          value={query}
          placeholder="输入问题，比较不同检索算法会找到哪些片段"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && run()}
        />
        <select value={docId} onChange={(e) => setDocId(e.target.value)}>
          <option value="">全部文档</option>
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        {tags.length > 0 && (
          <select value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">全部标签</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                标签：{t}
              </option>
            ))}
          </select>
        )}
        <button onClick={run} disabled={busy || !query.trim()}>
          {busy ? "检索中…" : "对比检索"}
        </button>
        <button
          className="secondary"
          disabled={columns.length >= MAX_COLUMNS}
          onClick={() => setColumns((cs) => [...cs, { label: "", params: { ...DEFAULT_PARAMS }, editing: true }])}
        >
          ＋ 添加策略
        </button>
      </div>
      {error && <div className="notice error">{error}</div>}
      {notice && <div className="notice ok">{notice}</div>}

      <div className="compare" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(260px, 1fr))` }}>
        {columns.map((c, i) => {
          const r = results?.[i];
          return (
            <div key={i} className="compare-col">
              <div className="compare-head">
                <input
                  className="col-title"
                  value={c.label}
                  placeholder={describe(c.params)}
                  onChange={(e) => updateColumn(i, { label: e.target.value })}
                />
                <div className="row small">
                  <button className="link" onClick={() => updateColumn(i, { editing: !c.editing })}>
                    {c.editing ? "收起参数" : "调整参数"}
                  </button>
                  <button className="link" onClick={() => makeDefault(c.params)}>
                    设为问答默认
                  </button>
                  {columns.length > 1 && (
                    <button
                      className="link danger-text"
                      onClick={() => {
                        setColumns((cs) => cs.filter((_, j) => j !== i));
                        setResults((rs) => rs && rs.filter((_, j) => j !== i));
                      }}
                    >
                      删除
                    </button>
                  )}
                </div>
                {c.editing && <StrategyEditor compact value={c.params} onChange={(params) => updateColumn(i, { params })} />}
                {r && (
                  <div className="muted small">
                    耗时 {r.elapsed_ms} ms · 打分 {r.searched ?? "-"} 个切片 · {r.hits.length} 个结果
                  </div>
                )}
              </div>
              {r?.error && <div className="notice error">{r.error}</div>}
              {r && !r.error && r.hits.length === 0 && <p className="muted">没有结果（可能被阈值过滤掉了）</p>}
              {r?.hits.map((h, j) => (
                <HitCard
                  key={chunkKey(h)}
                  hit={h}
                  rank={j + 1}
                  params={r.params}
                  others={results!
                    .map((o, k) => ({ label: o.label, rank: rankMaps![k].get(chunkKey(h)) }))
                    .filter((_, k) => k !== i)}
                />
              ))}
            </div>
          );
        })}
      </div>
      {!results && (
        <p className="muted small">
          提示：把鼠标停在参数名上能看到说明。每个片段会显示所有算法的分数，以及它在其他策略里的排名，方便看出各算法的差别。
        </p>
      )}
    </div>
  );
}

function HitCard({ hit, rank, params, others }: { hit: Hit; rank: number; params: RetrievalParams; others: { label: string; rank?: number }[] }) {
  const s = hit.scores;
  // 当前策略实际用来排序的那个分数高亮
  const active = params.use_mmr ? "mmr" : params.use_rerank ? "rerank" : params.method === "hybrid" ? "hybrid" : params.method === "bm25" ? "bm25" : params.metric;
  const items: [string, string, number | undefined][] = [
    ["cosine", "余弦", s.cosine],
    ["dot", "点积", s.dot],
    ["l2", "欧氏距离", s.l2],
    ["bm25", "BM25", s.bm25],
    ["hybrid", "混合", s.hybrid],
    ["rerank", "重排序", s.rerank],
    ["mmr", "MMR", s.mmr],
  ];
  return (
    <div className="chunk hit">
      <div className="source-head">
        <span className="rank">#{rank}</span> {hit.doc_name} · 切片 {hit.index}
      </div>
      <div className="score-tags">
        {items
          .filter(([, , v]) => v !== undefined)
          .map(([k, label, v]) => (
            <span key={k} className={`tag ${k === active ? "active" : ""}`}>
              {label} {v!.toFixed(3)}
            </span>
          ))}
      </div>
      <div className="score-tags">
        <span className="tag plain">向量排名 {s.vector_rank}</span>
        <span className="tag plain">BM25 排名 {s.bm25_rank}</span>
      </div>
      <div className="hit-text">{hit.text}</div>
      {others.length > 0 && (
        <div className="muted small">
          其他策略：{others.map((o) => `${o.label} ${o.rank ? `#${o.rank}` : "未入选"}`).join("；")}
        </div>
      )}
    </div>
  );
}
