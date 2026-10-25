import { useState } from "react";
import { api, type LocalDiscovery, type LocalModel } from "../api";
import { t } from "../i18n";

// 扫描本机的 Ollama / LM Studio / llama.cpp，点一下已安装的模型就把地址和模型名填进表单
export default function LocalModelPicker({
  baseUrl,
  onPick,
}: {
  baseUrl: string;
  onPick: (v: { server: string; base_url: string; model: string }) => void;
}) {
  const [result, setResult] = useState<LocalDiscovery | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scan = async (url?: string) => {
    setLoading(true);
    setError(null);
    try {
      setResult(await api.discoverLocal(url));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const describe = (m: LocalModel) =>
    [m.parameter_size, m.quantization, m.size_gb ? `${m.size_gb} GB` : null].filter(Boolean).join(" · ");

  const hasGemma = result?.servers.some((s) => s.models.some((m) => m.id.startsWith("gemma4")));

  return (
    <div className="local-picker">
      <div className="row">
        <button type="button" className="secondary" onClick={() => scan()} disabled={loading}>
          {loading ? t("检测中…", "Detecting…") : t("🔍 检测本地模型", "🔍 Detect local models")}
        </button>
        {baseUrl && (
          <button type="button" className="secondary" onClick={() => scan(baseUrl)} disabled={loading}>
            {t("只检测当前 Base URL", "Check this Base URL only")}
          </button>
        )}
        <span className="muted small">{t("会尝试 Ollama :11434、LM Studio :1234、llama.cpp :8080", "Tries Ollama :11434, LM Studio :1234, llama.cpp :8080")}</span>
      </div>
      {error && <div className="small error">{error}</div>}
      {result && result.servers.length === 0 && (
        <div className="small muted">
          {t(`没有找到本地模型服务（试过：${result.tried.join("、")}）。先安装并启动 `, `No local model server found (tried: ${result.tried.join(", ")}). Install and start `)}
          <a href="https://ollama.com" target="_blank" rel="noreferrer">Ollama</a>
          {t("，再运行 ", ", then run ")}
          <code>ollama pull gemma4:e4b</code>.
          {result.in_docker &&
            t(" 后端在 Docker 里运行，宿主机的服务要用 host.docker.internal 访问。", " The backend runs in Docker, so services on the host are reached via host.docker.internal.")}
        </div>
      )}
      {result?.servers.map((s) => (
        <div key={s.base_url} className="local-server">
          <div className="small">
            <b>{s.server}</b> <span className="muted">{s.base_url}</span>
          </div>
          {s.models.length === 0 && <div className="small muted">{t("服务在运行，但还没有安装模型。", "The server is running but has no models installed.")}</div>}
          <div className="local-chips">
            {s.models.map((m) => (
              <button
                type="button"
                key={m.id}
                className="local-chip"
                title={describe(m)}
                onClick={() => onPick({ server: s.server, base_url: s.base_url, model: m.id })}
              >
                {m.id}
                {describe(m) && <span className="muted"> {describe(m)}</span>}
              </button>
            ))}
          </div>
        </div>
      ))}
      {result && result.servers.length > 0 && !hasGemma && (
        <div className="small muted">
          {t("还没装 Gemma 4？运行 ", "No Gemma 4 yet? Run ")}
          <code>ollama pull gemma4:e4b</code>
          {t("（笔记本够用；有 16GB 以上显存可以试 ", " (fine on a laptop; with 16GB+ VRAM try ")}
          <code>gemma4:26b</code>
          {t("），然后重新检测。", "), then detect again.")}
        </div>
      )}
    </div>
  );
}
