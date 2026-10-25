import { useCallback, useEffect, useState } from "react";
import { api, type Health } from "./api";
import { getLang, setLang, t, type Lang } from "./i18n";
import ChatPage from "./pages/ChatPage";
import DocumentsPage from "./pages/DocumentsPage";
import PipelinePage from "./pages/PipelinePage";
import SearchPage from "./pages/SearchPage";
import SettingsPage from "./pages/SettingsPage";

const TABS = [
  { key: "chat", label: () => t("💬 问答", "💬 Chat") },
  { key: "docs", label: () => t("📄 文档管理", "📄 Documents") },
  { key: "search", label: () => t("🔍 检索调试", "🔍 Search lab") },
  { key: "pipeline", label: () => t("🧪 RAG 流程", "🧪 RAG pipeline") },
  { key: "settings", label: () => t("🤖 LLM 模型", "🤖 LLM models") },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default function App() {
  const [tab, setTab] = useState<TabKey>("chat");
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState(false);
  // 文档或模型配置变化后递增，让各页面重新拉数据
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const [reindexing, setReindexing] = useState(false);
  const [lang, setLangState] = useState<Lang>(getLang());

  function switchLang(l: Lang) {
    setLang(l);
    setLangState(l); // App 重新渲染，子组件里的 t() 都会取到新语言
    document.title = t("RAG 知识库", "RAG Knowledge Base");
  }

  useEffect(() => {
    document.title = t("RAG 知识库", "RAG Knowledge Base");
  }, []);

  async function reindex() {
    setReindexing(true);
    try {
      await api.reindex();
    } finally {
      setReindexing(false);
      bump();
    }
  }

  useEffect(() => {
    api.health().then(
      (h) => {
        setHealth(h);
        setHealthError(false);
      },
      () => setHealthError(true),
    );
  }, [version]);

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>{t("RAG 知识库", "RAG Knowledge Base")}</h1>
        <nav>
          {TABS.map((item) => (
            <button key={item.key} className={tab === item.key ? "active" : ""} onClick={() => setTab(item.key)}>
              {item.label()}
            </button>
          ))}
        </nav>
        <div className="status">
          {healthError && <span className="error">{t("后端未连接", "Backend not reachable")}</span>}
          {health?.status === "error" && <span className="error">{health.message}</span>}
          {health?.status === "ok" && (
            <>
              <div>{t(`文档：${health.documents} 篇`, `Documents: ${health.documents}`)}</div>
              <div>{t(`切片：${health.chunks} 个`, `Chunks: ${health.chunks}`)}</div>
              <div title={health.embedder}>
                {t("向量：", "Embedding: ")}
                {health.embedder?.replace("fastembed:", "")}
              </div>
            </>
          )}
        </div>
        <div className="lang-switch" role="group" aria-label="Language">
          <button className={lang === "zh" ? "active" : ""} onClick={() => switchLang("zh")}>
            中文
          </button>
          <button className={lang === "en" ? "active" : ""} onClick={() => switchLang("en")}>
            English
          </button>
        </div>
      </aside>
      <main>
        {health?.needs_reindex && (
          <div className="notice warn banner">
            {t(
              "当前向量模型 / 索引参数下的切片和文档对不上（换过模型或参数），检索结果可能不完整。",
              "The index doesn't match the documents under the current embedding model / index settings (they were changed). Search results may be incomplete.",
            )}
            <button onClick={reindex} disabled={reindexing}>
              {reindexing ? t("重建中…", "Rebuilding…") : t("重建索引", "Rebuild index")}
            </button>
          </div>
        )}
        {/* 页面都保持挂载，切换标签时问答记录不会丢 */}
        <div hidden={tab !== "chat"}>
          <ChatPage version={version} />
        </div>
        <div hidden={tab !== "docs"}>
          <DocumentsPage version={version} onChanged={bump} />
        </div>
        <div hidden={tab !== "search"}>
          <SearchPage version={version} onChanged={bump} />
        </div>
        <div hidden={tab !== "pipeline"}>
          <PipelinePage version={version} onChanged={bump} />
        </div>
        <div hidden={tab !== "settings"}>
          <SettingsPage version={version} onChanged={bump} />
        </div>
      </main>
    </div>
  );
}
