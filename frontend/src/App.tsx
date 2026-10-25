import { useCallback, useEffect, useState } from "react";
import { api, type Health } from "./api";
import ChatPage from "./pages/ChatPage";
import DocumentsPage from "./pages/DocumentsPage";
import SearchPage from "./pages/SearchPage";
import SettingsPage from "./pages/SettingsPage";

const TABS = [
  { key: "chat", label: "💬 问答" },
  { key: "docs", label: "📄 文档管理" },
  { key: "search", label: "🔍 检索调试" },
  { key: "settings", label: "⚙️ 模型与设置" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default function App() {
  const [tab, setTab] = useState<TabKey>("chat");
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState(false);
  // 文档或模型配置变化后递增，让各页面重新拉数据
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

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
        <h1>RAG 知识库</h1>
        <nav>
          {TABS.map((t) => (
            <button key={t.key} className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="status">
          {healthError && <span className="error">后端未连接</span>}
          {health && (
            <>
              <div>文档：{health.documents} 篇</div>
              <div>切片：{health.chunks} 个</div>
              <div title={health.embedder}>向量：{health.embedder.replace("fastembed:", "")}</div>
            </>
          )}
        </div>
      </aside>
      <main>
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
        <div hidden={tab !== "settings"}>
          <SettingsPage version={version} onChanged={bump} />
        </div>
      </main>
    </div>
  );
}
