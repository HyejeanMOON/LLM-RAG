// 后端接口的类型和调用封装
import { getLang, t } from "./i18n";

export type ChunkStrategy = "structure" | "fixed" | "paragraph" | "recursive" | "semantic";
export interface ChunkingParams {
  strategy: ChunkStrategy;
  chunk_size: number;
  chunk_overlap: number;
  add_title: boolean;
  semantic_percentile: number;
}
export interface DocumentMeta {
  id: string;
  name: string;
  file_type: string;
  chunk_count: number;
  char_count: number;
  chunking_custom: boolean; // 是否单独设置了切分策略
  chunking_strategy?: ChunkStrategy;
  tags: string[];
  created_at: string;
  updated_at: string;
}
export interface DocumentFull extends DocumentMeta {
  content: string;
  chunking: ChunkingParams; // 实际生效的切分策略
}
export interface ChunkPreview {
  chunks: string[];
  stats: { count: number; avg_len: number; min_len: number; max_len: number };
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
  index: "exact" | "hnsw";
  ann_candidates: number;
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
  multi_query_rrf?: number;
  matched_queries?: number;
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
  searched: number | null; // 实际参与打分的切片数（HNSW 模式下是候选数）
}
/** 最终放进提示词的一段参考资料（可能由多个相邻切片合并而成） */
export interface Source extends Hit {
  indexes: number[];
  hit_indexes: number[];
}
export interface Trace {
  question: string;
  provider: string;
  condensed_query?: string;
  multi_queries?: string[];
  hyde_text?: string;
  filter?: Record<string, unknown> & { matched_documents: number };
  retrieval: {
    params: RetrievalParams;
    per_query: { query: string; hits: number; corpus?: number; searched?: number; index?: string }[];
    hits: number;
  };
  context: ContextParams & { hits: number; blocks: number; dropped: number; chars: number };
  prompt: { system: string; messages: ChatTurn[]; llm_params: Record<string, unknown> };
  timings: Record<string, number>;
}
export interface Filters {
  doc_ids?: string[];
  tags?: string[];
  date_from?: string;
  date_to?: string;
}
export interface EmbeddingSettings {
  backend: "fastembed" | "openai" | "hash";
  model: string;
  provider_id: string | null;
}
export interface IndexSettings {
  space: "cosine" | "l2" | "ip";
  max_neighbors: number;
  ef_construction: number;
  ef_search: number;
}
export interface QuerySettings {
  history_turns: number;
  condense_history: boolean;
  multi_query: boolean;
  multi_query_n: number;
  hyde: boolean;
}
export interface ContextParams {
  max_chars: number;
  neighbor_window: number;
  order: "score" | "document" | "edges";
}
export interface GenerationSettings {
  system_prompt: string;
  user_template: string;
  source_template: string;
  max_tokens: number | null;
  temperature: number | null;
  effort: string | null;
}
export interface EmbeddingModelInfo {
  model: string;
  dim: number;
  size: string;
  lang: string;
  note: string;
}
export interface EmbeddingTestResult {
  embedder: string;
  dim: number;
  elapsed_ms: number;
  norms: number[];
  similarity: number[][];
  preview: number[][];
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
export interface LocalModel {
  id: string;
  size_gb?: number | null;
  parameter_size?: string | null;
  quantization?: string | null;
  family?: string | null;
}
export interface LocalServer {
  server: string;
  base_url: string;
  models: LocalModel[];
}
export interface LocalDiscovery {
  in_docker: boolean;
  servers: LocalServer[];
  tried: string[];
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
  chunking: ChunkingParams;
  embedding: EmbeddingSettings;
  index: IndexSettings;
  query: QuerySettings;
  retrieval: RetrievalParams;
  context: ContextParams;
  generation: GenerationSettings;
  default_provider_id: string | null;
}
export type SectionName = Exclude<keyof Settings, "default_provider_id">;
export interface Health {
  status: string;
  message?: string;
  embedder?: string;
  documents: number;
  chunks?: number;
  needs_reindex?: boolean;
}
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    // Accept-Language 让后端用同一种语言返回错误信息
    headers:
      init?.body instanceof FormData
        ? { "Accept-Language": getLang(), ...init.headers }
        : { "Content-Type": "application/json", "Accept-Language": getLang(), ...init?.headers },
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
  createDocument: (name: string, content: string, tags: string[] = []) =>
    request<DocumentFull>("/api/documents", json("POST", { name, content, tags })),
  updateDocument: (
    id: string,
    data: { name?: string; content?: string; chunking?: ChunkingParams; use_default_chunking?: boolean; tags?: string[] },
  ) =>
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
  previewChunks: (chunking: ChunkingParams, src: { content?: string; doc_id?: string }) =>
    request<ChunkPreview>("/api/documents/preview-chunks", json("POST", { chunking, ...src })),
  reindex: () => request<{ documents: number; chunks: number }>("/api/documents/reindex", json("POST")),

  listTags: () => request<string[]>("/api/documents/tags"),

  search: (query: string, retrieval: Partial<RetrievalParams>, filters: Filters = {}) =>
    request<Hit[]>("/api/search", json("POST", { query, retrieval, ...filters })),
  compare: (query: string, strategies: (Partial<RetrievalParams> & { label: string })[], filters: Filters = {}) =>
    request<CompareResult[]>("/api/search/compare", json("POST", { query, strategies, ...filters })),

  listProviders: () => request<Provider[]>("/api/providers"),
  createProvider: (p: ProviderInput) => request<Provider>("/api/providers", json("POST", p)),
  updateProvider: (id: string, p: Partial<ProviderInput>) => request<Provider>(`/api/providers/${id}`, json("PUT", p)),
  deleteProvider: (id: string) => request<void>(`/api/providers/${id}`, json("DELETE")),
  setDefaultProvider: (id: string) => request<Provider[]>(`/api/providers/${id}/default`, json("POST")),
  discoverLocal: (base_url?: string) =>
    request<LocalDiscovery>(`/api/providers/local/discover${base_url ? `?base_url=${encodeURIComponent(base_url)}` : ""}`),
  testProvider: (id: string) => request<{ ok: boolean; message: string }>(`/api/providers/${id}/test`, json("POST")),

  getSettings: () => request<Settings>("/api/settings"),
  updateSettings: (s: { [K in SectionName]?: Partial<Settings[K]> }) => request<Settings>("/api/settings", json("PUT", s)),
  resetSection: (name: SectionName) => request<Settings>(`/api/settings/${name}/reset`, json("POST")),
  embeddingModels: () => request<EmbeddingModelInfo[]>("/api/embedding/models"),
  embeddingTest: (texts: string[], override?: Partial<EmbeddingSettings>) => {
    const qs = new URLSearchParams(Object.entries(override ?? {}).filter(([, v]) => v) as [string, string][]).toString();
    return request<EmbeddingTestResult>(`/api/embedding/test${qs ? `?${qs}` : ""}`, json("POST", { texts }));
  },
};

export interface ChatHandlers {
  onTrace: (trace: Trace) => void;
  onSources: (sources: Source[]) => void;
  onDelta: (text: string) => void;
  onError: (message: string) => void;
  onDone: (info: { generation_ms?: number }) => void;
}

/** 流式问答：解析后端的 SSE（sources → delta… → done/error）。 */
export async function streamChat(
  body: { query: string; provider_id?: string; history: ChatTurn[]; retrieval?: Partial<RetrievalParams> } & Filters,
  handlers: ChatHandlers,
  signal?: AbortSignal,
) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept-Language": getLang() },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    handlers.onError(t(`请求失败：${res.status}`, `Request failed: ${res.status}`));
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
      if (event === "trace") handlers.onTrace(payload);
      else if (event === "sources") handlers.onSources(payload);
      else if (event === "delta") handlers.onDelta(payload.text);
      else if (event === "error") {
        finished = true;
        handlers.onError(payload.message);
      } else if (event === "done") {
        finished = true;
        handlers.onDone(payload);
      }
    }
  }
  if (!finished) handlers.onError(t("连接意外中断", "Connection closed unexpectedly"));
}
