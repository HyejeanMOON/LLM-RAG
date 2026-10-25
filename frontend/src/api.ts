// 后端接口的类型和调用封装

export interface DocumentMeta {
  id: string;
  name: string;
  file_type: string;
  chunk_count: number;
  char_count: number;
  created_at: string;
  updated_at: string;
}
export interface DocumentFull extends DocumentMeta {
  content: string;
}
export interface Chunk {
  index: number;
  text: string;
}
export type Method = "vector" | "bm25" | "hybrid";
export type Metric = "cosine" | "dot" | "l2";
export interface RetrievalParams {
  method: Method;
  metric: Metric;
  top_k: number;
  min_score: number;
  fetch_k: number;
  fusion: "rrf" | "weighted";
  hybrid_alpha: number;
  rrf_k: number;
  use_mmr: boolean;
  mmr_lambda: number;
  use_rerank: boolean;
}
export interface HitScores {
  cosine: number;
  dot: number;
  l2: number;
  bm25: number;
  vector_rank: number;
  bm25_rank: number;
  hybrid?: number;
  mmr?: number;
  rerank?: number;
}
export interface Hit {
  doc_id: string;
  doc_name: string;
  index: number;
  text: string;
  score: number; // 当前策略最终用来排序的分数
  scores: HitScores;
}
export interface CompareResult {
  label: string;
  params: RetrievalParams;
  hits: Hit[];
  error: string | null;
  elapsed_ms: number;
}
export type ProviderType = "anthropic" | "openai";
export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  base_url: string;
  api_key: string; // 已打码
  has_api_key: boolean;
  model: string;
  extra: Record<string, unknown>;
  is_default: boolean;
}
export interface ProviderInput {
  name: string;
  type: ProviderType;
  base_url: string;
  model: string;
  api_key?: string | null;
  extra: Record<string, unknown>;
}
export interface Settings {
  chunk_size: number;
  chunk_overlap: number;
  retrieval: RetrievalParams;
  history_turns: number;
  default_provider_id: string | null;
}
export interface Health {
  status: string;
  embedder: string;
  documents: number;
  chunks: number;
}
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body instanceof FormData ? init.headers : { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      msg = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
    } catch {
      /* 非 JSON 响应 */
    }
    throw new Error(msg);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  health: () => request<Health>("/api/health"),

  listDocuments: () => request<DocumentMeta[]>("/api/documents"),
  getDocument: (id: string) => request<DocumentFull>(`/api/documents/${id}`),
  createDocument: (name: string, content: string) => request<DocumentFull>("/api/documents", json("POST", { name, content })),
  updateDocument: (id: string, data: { name?: string; content?: string }) =>
    request<DocumentFull>(`/api/documents/${id}`, json("PUT", data)),
  deleteDocument: (id: string) => request<void>(`/api/documents/${id}`, json("DELETE")),
  getChunks: (id: string) => request<Chunk[]>(`/api/documents/${id}/chunks`),
  uploadDocuments: (files: File[]) => {
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    return request<{ filename: string; document?: DocumentMeta; error?: string }[]>("/api/documents/upload", {
      method: "POST",
      body: form,
    });
  },
  reindex: () => request<{ documents: number; chunks: number }>("/api/documents/reindex", json("POST")),

  search: (query: string, retrieval: Partial<RetrievalParams>, doc_ids?: string[]) =>
    request<Hit[]>("/api/search", json("POST", { query, retrieval, doc_ids })),
  compare: (query: string, strategies: (Partial<RetrievalParams> & { label: string })[], doc_ids?: string[]) =>
    request<CompareResult[]>("/api/search/compare", json("POST", { query, strategies, doc_ids })),

  listProviders: () => request<Provider[]>("/api/providers"),
  createProvider: (p: ProviderInput) => request<Provider>("/api/providers", json("POST", p)),
  updateProvider: (id: string, p: Partial<ProviderInput>) => request<Provider>(`/api/providers/${id}`, json("PUT", p)),
  deleteProvider: (id: string) => request<void>(`/api/providers/${id}`, json("DELETE")),
  setDefaultProvider: (id: string) => request<Provider[]>(`/api/providers/${id}/default`, json("POST")),
  testProvider: (id: string) => request<{ ok: boolean; message: string }>(`/api/providers/${id}/test`, json("POST")),

  getSettings: () => request<Settings>("/api/settings"),
  updateSettings: (s: Partial<Omit<Settings, "retrieval">> & { retrieval?: Partial<RetrievalParams> }) => request<Settings>("/api/settings", json("PUT", s)),
};

export interface ChatHandlers {
  onSources: (hits: Hit[]) => void;
  onDelta: (text: string) => void;
  onError: (message: string) => void;
  onDone: () => void;
}

/** 流式问答：解析后端的 SSE（sources → delta… → done/error）。 */
export async function streamChat(
  body: { query: string; provider_id?: string; doc_ids?: string[]; history: ChatTurn[]; retrieval?: Partial<RetrievalParams> },
  handlers: ChatHandlers,
  signal?: AbortSignal,
) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    handlers.onError(`请求失败：${res.status}`);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      const payload = data ? JSON.parse(data) : {};
      if (event === "sources") handlers.onSources(payload);
      else if (event === "delta") handlers.onDelta(payload.text);
      else if (event === "error") {
        finished = true;
        handlers.onError(payload.message);
      } else if (event === "done") {
        finished = true;
        handlers.onDone();
      }
    }
  }
  if (!finished) handlers.onError("连接意外中断");
}
