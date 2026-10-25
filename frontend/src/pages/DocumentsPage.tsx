import { useEffect, useRef, useState } from "react";
import { api, type Chunk, type DocumentFull, type DocumentMeta } from "../api";

type Mode = { kind: "none" } | { kind: "new" } | { kind: "edit"; id: string };

export default function DocumentsPage({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [docs, setDocs] = useState<DocumentMeta[]>([]);
  const [mode, setMode] = useState<Mode>({ kind: "none" });
  const [doc, setDoc] = useState<DocumentFull | null>(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [view, setView] = useState<"content" | "chunks">("content");
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
    setContent(d.content);
    setChunks(cs);
  }

  function startNew() {
    setMsg(null);
    setMode({ kind: "new" });
    setDoc(null);
    setName("");
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
      const d = mode.kind === "new" ? await api.createDocument(name, content) : await api.updateDocument(doc!.id, { name, content });
      await reload();
      onChanged();
      await open(d.id);
      setMsg({ type: "ok", text: `已保存并重新切片，共 ${d.chunk_count} 个切片` });
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

  const dirty = doc ? name !== doc.name || content !== doc.content : mode.kind === "new" && (name || content);

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
              <div className="muted small">
                {d.file_type} · {d.char_count} 字 · {d.chunk_count} 个切片 · {new Date(d.updated_at).toLocaleString()}
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
              <div className="chunk-list">
                {chunks.map((c) => (
                  <div key={c.index} className="chunk">
                    <div className="muted small">
                      #{c.index} · {c.text.length} 字
                    </div>
                    <div>{c.text}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
