import { useEffect, useState } from "react";
import { api, type DocumentMeta, type Hit } from "../api";

/** 只做向量检索、不调用 LLM，用来观察切片和相似度，调参数用。 */
export default function SearchPage({ version }: { version: number }) {
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(5);
  const [docs, setDocs] = useState<DocumentMeta[]>([]);
  const [docId, setDocId] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.listDocuments().then(setDocs);
  }, [version]);

  async function search() {
    if (!query.trim()) return;
    setError("");
    try {
      setHits(await api.search(query, topK, docId ? [docId] : undefined));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="search">
      <div className="row">
        <input
          className="grow"
          value={query}
          placeholder="输入问题，查看会检索到哪些切片"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && search()}
        />
        <label>
          Top K
          <input type="number" min={1} max={50} value={topK} onChange={(e) => setTopK(Number(e.target.value))} style={{ width: 64 }} />
        </label>
        <select value={docId} onChange={(e) => setDocId(e.target.value)}>
          <option value="">全部文档</option>
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <button onClick={search}>检索</button>
      </div>
      {error && <div className="notice error">{error}</div>}
      {hits && hits.length === 0 && <p className="muted">没有结果（向量库可能是空的）</p>}
      {hits?.map((h, i) => (
        <div key={i} className="chunk">
          <div className="source-head">
            [{i + 1}] {h.doc_name} #{h.index}
            <span className="score">相似度 {h.score.toFixed(3)}</span>
            <span className="bar" style={{ width: `${Math.max(0, h.score) * 100}px` }} />
          </div>
          <div>{h.text}</div>
        </div>
      ))}
    </div>
  );
}
