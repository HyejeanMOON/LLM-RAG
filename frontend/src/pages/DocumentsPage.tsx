import { useEffect, useRef, useState } from "react";
import { api, type Chunk, type ChunkingParams, type ChunkPreview, type DocumentFull, type DocumentMeta } from "../api";
import ChunkingEditor, { DEFAULT_CHUNKING, STRATEGY_LABEL, describeChunking } from "../components/ChunkingEditor";

type Mode = { kind: "none" } | { kind: "new" } | { kind: "edit"; id: string };

export default function DocumentsPage({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [docs, setDocs] = useState<DocumentMeta[]>([]);
  const [mode, setMode] = useState<Mode>({ kind: "none" });
  const [doc, setDoc] = useState<DocumentFull | null>(null);
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [content, setContent] = useState("");
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [view, setView] = useState<"content" | "chunks">("content");
  const [chunking, setChunking] = useState<ChunkingParams>(DEFAULT_CHUNKING);
  const [preview, setPreview] = useState<(ChunkPreview & { params: ChunkingParams }) | null>(null);
  const [msg, setMsg] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = () => api.listDocuments().then(setDocs);
  useEffect(() => {
    reload();
  }, [version]);

  async function open(id: string) {
    setMode({ kind: "edit", id });
    const [d, cs] = await Promise.all([api.getDocument(id), api.getChunks(id)]);
    setDoc(d);
    setName(d.name);
    setTags(d.tags.join(", "));
    setContent(d.content);
    setChunks(cs);
    setChunking(d.chunking);
    setPreview(null);
  }

  function startNew() {
    setMsg(null);
    setMode({ kind: "new" });
    setDoc(null);
    setName("");
    setTags("");
    setContent("");
    setChunks([]);
    setView("content");
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ type: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      const d =
        mode.kind === "new" ? await api.createDocument(name, content, tagList) : await api.updateDocument(doc!.id, { name, content, tags: tagList });
      await reload();
      onChanged();
      await open(d.id);
      setMsg({ type: "ok", text: `已保存并重新切片，共 ${d.chunk_count} 个切片` });
    });

  const runPreview = () =>
    run(async () => {
      // 预览用编辑框里的内容（可能还没保存）
      setPreview({ ...(await api.previewChunks(chunking, { content })), params: chunking });
    });

  const applyChunking = (useDefault: boolean) =>
    run(async () => {
      const d = await api.updateDocument(doc!.id, useDefault ? { use_default_chunking: true } : { chunking, name, content });
      await reload();
      onChanged();
      await open(d.id);
      setMsg({ type: "ok", text: `已按「${describeChunking(d.chunking)}」重新切片，共 ${d.chunk_count} 个切片` });
    });

  const remove = () => {
    if (!doc || !confirm(`确定删除「${doc.name}」？对应的向量也会一起删除。`)) return;
    run(async () => {
      await api.deleteDocument(doc.id);
      setMode({ kind: "none" });
      setDoc(null);
      await reload();
      onChanged();
    });
  };

  const upload = (files: File[]) =>
    files.length &&
    run(async () => {
      const res = await api.uploadDocuments(files);
      await reload();
      onChanged();
      const ok = res.filter((r) => r.document).length;
      const errors = res.filter((r) => r.error).map((r) => `${r.filename}：${r.error}`);
      setMsg({ type: errors.length ? "error" : "ok", text: [`成功导入 ${ok} 个文件`, ...errors].join("\n") });
      const first = res.find((r) => r.document)?.document;
      if (first) await open(first.id);
    });

  const tagList = tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
  const dirty = doc
    ? name !== doc.name || content !== doc.content || tagList.join(",") !== doc.tags.join(",")
    : mode.kind === "new" && (name || content);

  return (
    <div className="docs">
      <section
        className={`doc-list ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          upload(Array.from(e.dataTransfer.files));
        }}
      >
        <div className="row">
          <button onClick={() => fileRef.current?.click()} disabled={busy}>
            上传文件
          </button>
          <button className="secondary" onClick={startNew} disabled={busy}>
            新建文档
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            accept=".md,.markdown,.txt,.pdf,.docx"
            onChange={(e) => {
              upload(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
        </div>
        <p className="muted small">支持 .md .txt .pdf .docx，可拖拽到这里</p>
        {docs.length === 0 && <p className="muted">还没有文档</p>}
        <ul>
          {docs.map((d) => (
            <li key={d.id} className={mode.kind === "edit" && mode.id === d.id ? "active" : ""} onClick={() => {
                setMsg(null);
                open(d.id);
              }}>
              <div className="doc-name">{d.name}</div>
              {d.tags.length > 0 && (
                <div className="score-tags">
                  {d.tags.map((t) => (
                    <span key={t} className="tag">
                      {t}
                    </span>
                  ))}
                </div>
              )}
              <div className="muted small">
                {d.file_type} · {d.char_count} 字 · {d.chunk_count} 个切片
                {d.chunking_strategy && ` · ${STRATEGY_LABEL[d.chunking_strategy]}${d.chunking_custom ? "（单独设置）" : ""}`}
                <br />
                {new Date(d.updated_at).toLocaleString()}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="doc-detail">
        {msg && <div className={`notice ${msg.type}`}>{msg.text}</div>}
        {mode.kind === "none" ? (
          <p className="muted">选择左侧的文档查看和编辑，或者上传 / 新建文档。</p>
        ) : (
          <>
            <div className="row">
              <input className="grow" value={name} placeholder="文档名称" onChange={(e) => setName(e.target.value)} />
              <input
                value={tags}
                placeholder="标签，逗号分隔（用于检索过滤）"
                title="给文档打标签后，问答和检索调试时可以只在某些标签的文档里检索"
                onChange={(e) => setTags(e.target.value)}
                style={{ width: 220 }}
              />
              <button onClick={save} disabled={busy || !name.trim() || !content.trim() || !dirty}>
                {busy ? "处理中…" : mode.kind === "new" ? "创建并入库" : "保存并重新切片"}
              </button>
              {doc && (
                <button className="danger" onClick={remove} disabled={busy}>
                  删除
                </button>
              )}
            </div>
            {doc && (
              <div className="tabs">
                <button className={view === "content" ? "active" : ""} onClick={() => setView("content")}>
                  内容
                </button>
                <button className={view === "chunks" ? "active" : ""} onClick={() => setView("chunks")}>
                  切片（{chunks.length}）
                </button>
              </div>
            )}
            {view === "content" || !doc ? (
              <textarea
                className="editor"
                value={content}
                placeholder="粘贴或输入文档内容，支持 Markdown 标题（# 标题），切片会按标题分节"
                onChange={(e) => setContent(e.target.value)}
              />
            ) : (
              <div className="chunk-view">
                <div className="chunking-panel">
                  <div className="row">
                    <strong>切分策略</strong>
                    <span className="muted small">
                      当前：{describeChunking(doc.chunking)}（{doc.chunking_custom ? "这篇文档单独设置" : "使用全局默认"}）
                    </span>
                  </div>
                  <ChunkingEditor value={chunking} onChange={setChunking} />
                  <div className="row">
                    <button className="secondary" onClick={runPreview} disabled={busy}>
                      预览效果
                    </button>
                    <button onClick={() => applyChunking(false)} disabled={busy}>
                      应用到这篇文档
                    </button>
                    {doc.chunking_custom && (
                      <button className="secondary" onClick={() => applyChunking(true)} disabled={busy}>
                        恢复使用全局默认
                      </button>
                    )}
                  </div>
                </div>
                <div className={`chunk-columns ${preview ? "two" : ""}`}>
                  <div className="chunk-list">
                    <div className="col-label">
                      当前切片（{chunks.length}）
                    </div>
                    {chunks.map((c) => (
                      <div key={c.index} className="chunk">
                        <div className="muted small">
                          #{c.index} · {c.text.length} 字
                        </div>
                        <div>{c.text}</div>
                      </div>
                    ))}
                  </div>
                  {preview && (
                    <div className="chunk-list">
                      <div className="col-label">
                        预览：{describeChunking(preview.params)}（{preview.stats.count} 个，平均 {preview.stats.avg_len} 字，最短 {preview.stats.min_len}，最长{" "}
                        {preview.stats.max_len}）
                      </div>
                      {preview.chunks.map((c, i) => (
                        <div key={i} className="chunk preview">
                          <div className="muted small">
                            #{i} · {c.length} 字
                          </div>
                          <div>{c}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
