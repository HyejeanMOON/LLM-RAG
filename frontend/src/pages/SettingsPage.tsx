import { useEffect, useState } from "react";
import { api, type Provider, type ProviderInput } from "../api";
import LocalModelPicker from "../components/LocalModelPicker";

// 常见厂商的预设，选中后自动填好接口地址和模型名（模型名可以再改）
const PRESETS: { label: string; value: ProviderInput }[] = [
  { label: "Claude (Anthropic)", value: { name: "Claude Opus 5.5", type: "anthropic", base_url: "", model: "claude-opus-5-5", extra: { effort: "medium" } } },
  { label: "OpenAI", value: { name: "OpenAI", type: "openai", base_url: "https://api.openai.com/v1", model: "gpt-5", extra: {} } },
  { label: "DeepSeek", value: { name: "DeepSeek", type: "openai", base_url: "https://api.deepseek.com", model: "deepseek-chat", extra: {} } },
  { label: "通义千问", value: { name: "通义千问", type: "openai", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", extra: {} } },
  { label: "Kimi (Moonshot)", value: { name: "Kimi", type: "openai", base_url: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", extra: {} } },
  { label: "智谱 GLM", value: { name: "智谱 GLM", type: "openai", base_url: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash", extra: {} } },
  // 本地模型：都走 OpenAI 兼容接口，不需要 API Key。Docker 里运行时把 localhost 换成 host.docker.internal
  { label: "本地 · Gemma 4（Ollama）", value: { name: "Gemma 4（本地）", type: "openai", base_url: "http://localhost:11434/v1", model: "gemma4:e4b", extra: { temperature: 0.3 } } },
  { label: "本地 · Ollama 其他模型", value: { name: "Ollama", type: "openai", base_url: "http://localhost:11434/v1", model: "qwen3:8b", extra: {} } },
  { label: "本地 · LM Studio", value: { name: "LM Studio", type: "openai", base_url: "http://localhost:1234/v1", model: "", extra: {} } },
  { label: "本地 · llama.cpp server", value: { name: "llama.cpp", type: "openai", base_url: "http://localhost:8080/v1", model: "", extra: {} } },
];
const LOCAL_PRESET = PRESETS.findIndex((p) => p.label.startsWith("本地 · Gemma 4"));

const EMPTY: ProviderInput = { ...PRESETS[0].value };

export default function SettingsPage({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<ProviderInput>(EMPTY);
  const [presetIndex, setPresetIndex] = useState(0);
  const [apiKey, setApiKey] = useState("");
  const [extraText, setExtraText] = useState("{}");
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; message: string } | "loading">>({});
  const [msg, setMsg] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    api.listProviders().then(setProviders);
  }, [version]);

  const report = async (fn: () => Promise<string | void>) => {
    setMsg(null);
    try {
      const text = await fn();
      if (text) setMsg({ type: "ok", text });
    } catch (e) {
      setMsg({ type: "error", text: (e as Error).message });
    }
  };

  function startEdit(p?: Provider, presetIndex?: number) {
    setMsg(null);
    setApiKey("");
    if (p) {
      setEditing(p.id);
      setForm({ name: p.name, type: p.type, base_url: p.base_url, model: p.model, extra: p.extra });
      setExtraText(JSON.stringify(p.extra, null, 2));
    } else {
      const preset = presetIndex !== undefined ? PRESETS[presetIndex].value : EMPTY;
      setEditing("new");
      setPresetIndex(presetIndex ?? 0);
      setForm({ ...preset });
      setExtraText(JSON.stringify(preset.extra, null, 2));
    }
  }

  const saveProvider = () =>
    report(async () => {
      let extra: Record<string, unknown>;
      try {
        extra = JSON.parse(extraText || "{}");
      } catch {
        throw new Error("高级参数不是合法的 JSON");
      }
      // 编辑时 key 输入框留空表示不修改
      const body = { ...form, extra, api_key: apiKey ? apiKey : editing === "new" ? "" : null };
      if (editing === "new") await api.createProvider(body);
      else await api.updateProvider(editing!, body);
      setEditing(null);
      onChanged();
      return "已保存";
    });

  const test = async (id: string) => {
    setTestResult((r) => ({ ...r, [id]: "loading" }));
    try {
      const res = await api.testProvider(id);
      setTestResult((r) => ({ ...r, [id]: res }));
    } catch (e) {
      setTestResult((r) => ({ ...r, [id]: { ok: false, message: (e as Error).message } }));
    }
  };

  return (
    <div className="settings">
      {msg && <div className={`notice ${msg.type}`}>{msg.text}</div>}

      <h2>LLM 模型</h2>
      <p className="muted small">
        可以配置多个模型，在问答页随时切换。Claude 走 Anthropic 官方接口；其余厂商走 OpenAI 兼容接口。API Key 只保存在后端数据库里，前端只显示打码后的值。
      </p>
      <div className="provider-grid">
        {providers.map((p) => {
          const t = testResult[p.id];
          return (
            <div key={p.id} className={`card ${p.is_default ? "default" : ""}`}>
              <div className="card-title">
                {p.name} {p.is_default && <span className="badge">默认</span>}
              </div>
              <div className="small">
                {p.type === "anthropic" ? "Anthropic" : "OpenAI 兼容"} · {p.model}
              </div>
              {p.base_url && <div className="small muted">{p.base_url}</div>}
              <div className="small muted">
                API Key：{p.has_api_key ? p.api_key : p.type === "anthropic" ? "未填写（读取环境变量 ANTHROPIC_API_KEY）" : "未填写"}
              </div>
              <div className="row">
                {!p.is_default && (
                  <button className="secondary" onClick={() => report(async () => { await api.setDefaultProvider(p.id); onChanged(); })}>
                    设为默认
                  </button>
                )}
                <button className="secondary" onClick={() => test(p.id)} disabled={t === "loading"}>
                  {t === "loading" ? "测试中…" : "测试连接"}
                </button>
                <button className="secondary" onClick={() => startEdit(p)}>
                  编辑
                </button>
                <button
                  className="danger"
                  onClick={() => confirm(`删除「${p.name}」？`) && report(async () => { await api.deleteProvider(p.id); onChanged(); })}
                >
                  删除
                </button>
              </div>
              {t && t !== "loading" && <div className={`small ${t.ok ? "ok" : "error"}`}>{t.ok ? "✅ " : "❌ "}{t.message}</div>}
            </div>
          );
        })}
        <button className="card add" onClick={() => startEdit()}>
          ＋ 添加模型
        </button>
        <button className="card add" onClick={() => startEdit(undefined, LOCAL_PRESET)}>
          ＋ 添加本地模型
          <span className="small muted">Ollama / LM Studio / llama.cpp，例如 Gemma 4</span>
        </button>
      </div>

      {editing && (
        <div className="form">
          <h3>{editing === "new" ? "添加模型" : "编辑模型"}</h3>
          {editing === "new" && (
            <label>
              预设
              <select
                value={presetIndex}
                onChange={(e) => {
                  setPresetIndex(Number(e.target.value));
                  const p = PRESETS[Number(e.target.value)].value;
                  setForm({ ...p });
                  setExtraText(JSON.stringify(p.extra, null, 2));
                }}
              >
                {PRESETS.map((p, i) => (
                  <option key={p.label} value={i}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            显示名称
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            接口类型
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as ProviderInput["type"] })}>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI 兼容</option>
            </select>
          </label>
          <label>
            模型名
            <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
          </label>
          <label>
            Base URL
            <input
              value={form.base_url}
              placeholder={form.type === "anthropic" ? "留空使用官方地址" : "例如 https://api.deepseek.com"}
              onChange={(e) => setForm({ ...form, base_url: e.target.value })}
            />
          </label>
          {form.type === "openai" && (
            <LocalModelPicker
              baseUrl={form.base_url}
              onPick={({ server, base_url, model }) =>
                setForm((f) => ({
                  ...f,
                  base_url,
                  model,
                  // 名称还是预设的默认名时，换成“服务 · 模型”
                  name: editing === "new" && PRESETS.some((p) => p.value.name === f.name) ? `${model}（${server}）` : f.name,
                }))
              }
            />
          )}
          <label>
            API Key
            <input
              type="password"
              value={apiKey}
              placeholder={editing === "new" ? (form.base_url.match(/localhost|127\.0\.0\.1|host\.docker\.internal/) ? "本地模型不需要，留空即可" : "") : "留空表示不修改"}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            高级参数（JSON）
            <textarea rows={3} value={extraText} onChange={(e) => setExtraText(e.target.value)} />
            <span className="muted small">
              Claude：effort（low / medium / high）、max_tokens；OpenAI 兼容：temperature
            </span>
          </label>
          <div className="row">
            <button onClick={saveProvider} disabled={!form.name || !form.model}>
              保存
            </button>
            <button className="secondary" onClick={() => setEditing(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      <p className="muted small">切分、向量化、检索、提示词等参数在“RAG 流程”页面设置。</p>
    </div>
  );
}
