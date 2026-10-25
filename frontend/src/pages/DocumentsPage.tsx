import { useEffect, useRef, useState } from "react";
import { api, type Chunk, type ChunkingParams, type ChunkPreview, type DocumentFull, type DocumentMeta } from "../api";
import ChunkingEditor, { DEFAULT_CHUNKING, STRATEGY_LABEL, describeChunking } from "../components/ChunkingEditor";
import { t } from "../i18n";

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
      setMsg({ type: "ok", text: t(`已保存并重新切片，共 ${d.chunk_count} 个切片`, `Saved and re-chunked: ${d.chunk_count} chunks`) });
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
      setMsg({ type: "ok", text: t(`已按「${describeChunking(d.chunking)}」重新切片，共 ${d.chunk_count} 个切片`, `Re-chunked with "${describeChunking(d.chunking)}": ${d.chunk_count} chunks`) });
    });

  const remove = () => {
    if (!doc || !confirm(t(`确定删除「${doc.name}」？对应的向量也会一起删除。`, `Delete "${doc.name}"? Its vectors will be deleted too.`))) return;
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
      const errors = res.filter((r) => r.error).map((r) => `${r.filename}: ${r.error}`);
      setMsg({ type: errors.length ? "error" : "ok", text: [t(`成功导入 ${ok} 个文件`, `Imported ${ok} file(s)`), ...errors].join("\n") });
      const first = res.find((r) => r.document)?.document;
      if (first) await open(first.id);
    });

  const tagList = tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
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
            {t("上传文件", "Upload files")}
          </button>
          <button className="secondary" onClick={startNew} disabled={busy}>
            {t("新建文档", "New document")}
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
        <p className="muted small">{t("支持 .md .txt .pdf .docx，可拖拽到这里", "Supports .md .txt .pdf .docx. You can drag files here.")}</p>
        {docs.length === 0 && <p className="muted">{t("还没有文档", "No documents yet")}</p>}
        <ul>
          {docs.map((d) => (
            <li key={d.id} className={mode.kind === "edit" && mode.id === d.id ? "active" : ""} onClick={() => {
                setMsg(null);
                open(d.id);
              }}>
              <div className="doc-name">{d.name}</div>
              {d.tags.length > 0 && (
                <div className="score-tags">
                  {d.tags.map((tag) => (
                    <span key={tag} className="tag">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <div className="muted small">
                {d.file_type} · {t(`${d.char_count} 字 · ${d.chunk_count} 个切片`, `${d.char_count} chars · ${d.chunk_count} chunks`)}
                {d.chunking_strategy && ` · ${STRATEGY_LABEL[d.chunking_strategy]}${d.chunking_custom ? t("（单独设置）", " (custom)") : ""}`}
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
          <p className="muted">{t("选择左侧的文档查看和编辑，或者上传 / 新建文档。", "Pick a document on the left to view and edit it, or upload / create one.")}</p>
        ) : (
          <>
            <div className="row">
              <input className="grow" value={name} placeholder={t("文档名称", "Document name")} onChange={(e) => setName(e.target.value)} />
              <input
                value={tags}
                placeholder={t("标签，逗号分隔（用于检索过滤）", "Tags, comma separated (for filtering)")}
                title={t("给文档打标签后，问答和检索调试时可以只在某些标签的文档里检索", "With tags, Chat and Search lab can search only documents with certain tags")}
                onChange={(e) => setTags(e.target.value)}
                style={{ width: 220 }}
              />
              <button onClick={save} disabled={busy || !name.trim() || !content.trim() || !dirty}>
                {busy ? t("处理中…", "Working…") : mode.kind === "new" ? t("创建并入库", "Create & index") : t("保存并重新切片", "Save & re-chunk")}
              </button>
              {doc && (
                <button className="danger" onClick={remove} disabled={busy}>
                  {t("删除", "Delete")}
                </button>
              )}
            </div>
            {doc && (
              <div className="tabs">
                <button className={view === "content" ? "active" : ""} onClick={() => setView("content")}>
                  {t("内容", "Content")}
                </button>
                <button className={view === "chunks" ? "active" : ""} onClick={() => setView("chunks")}>
                  {t(`切片（${chunks.length}）`, `Chunks (${chunks.length})`)}
                </button>
              </div>
            )}
            {view === "content" || !doc ? (
              <textarea
                className="editor"
                value={content}
                placeholder={t("粘贴或输入文档内容，支持 Markdown 标题（# 标题），切片会按标题分节", "Paste or type the document. Markdown headings (# Title) are supported, and chunks follow the sections.")}
                onChange={(e) => setContent(e.target.value)}
              />
            ) : (
              <div className="chunk-view">
                <div className="chunking-panel">
                  <div className="row">
                    <strong>{t("切分策略", "Chunking")}</strong>
                    <span className="muted small">
                      {t("当前：", "Current: ")}
                      {describeChunking(doc.chunking)} ({doc.chunking_custom ? t("这篇文档单独设置", "custom for this document") : t("使用全局默认", "global default")})
                    </span>
                  </div>
                  <ChunkingEditor value={chunking} onChange={setChunking} />
                  <div className="row">
                    <button className="secondary" onClick={runPreview} disabled={busy}>
                      {t("预览效果", "Preview")}
                    </button>
                    <button onClick={() => applyChunking(false)} disabled={busy}>
                      {t("应用到这篇文档", "Apply to this document")}
                    </button>
                    {doc.chunking_custom && (
                      <button className="secondary" onClick={() => applyChunking(true)} disabled={busy}>
                        {t("恢复使用全局默认", "Use global default")}
                      </button>
                    )}
                  </div>
                </div>
                <div className={`chunk-columns ${preview ? "two" : ""}`}>
                  <div className="chunk-list">
                    <div className="col-label">
                      {t(`当前切片（${chunks.length}）`, `Current chunks (${chunks.length})`)}
                    </div>
                    {chunks.map((c) => (
                      <div key={c.index} className="chunk">
                        <div className="muted small">
                          #{c.index} · {c.text.length} {t("字", "chars")}
                        </div>
                        <div>{c.text}</div>
                      </div>
                    ))}
                  </div>
                  {preview && (
                    <div className="chunk-list">
                      <div className="col-label">
                        {t("预览：", "Preview: ")}
                        {describeChunking(preview.params)}{" "}
                        {t(
                          `（${preview.stats.count} 个，平均 ${preview.stats.avg_len} 字，最短 ${preview.stats.min_len}，最长 ${preview.stats.max_len}）`,
                          `(${preview.stats.count} chunks, avg ${preview.stats.avg_len} chars, min ${preview.stats.min_len}, max ${preview.stats.max_len})`,
                        )}
                      </div>
                      {preview.chunks.map((c, i) => (
                        <div key={i} className="chunk preview">
                          <div className="muted small">
                            #{i} · {c.length} {t("字", "chars")}
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
