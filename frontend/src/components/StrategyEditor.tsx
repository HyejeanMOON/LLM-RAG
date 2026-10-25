import type { RetrievalParams } from "../api";

export const METHOD_LABEL = { vector: "向量检索", bm25: "BM25 关键词", hybrid: "混合检索" } as const;
export const METRIC_LABEL = { cosine: "余弦相似度", dot: "点积", l2: "欧氏距离" } as const;

export const DEFAULT_PARAMS: RetrievalParams = {
  method: "vector",
  metric: "cosine",
  top_k: 4,
  min_score: 0,
  fetch_k: 20,
  fusion: "rrf",
  hybrid_alpha: 0.5,
  rrf_k: 60,
  use_mmr: false,
  mmr_lambda: 0.5,
  use_rerank: false,
  index: "exact",
  ann_candidates: 50,
};

/** 一句话描述策略，用作对比列的默认标题 */
export function describe(p: RetrievalParams): string {
  const parts: string[] = [METHOD_LABEL[p.method]];
  if (p.method !== "bm25") parts.push(METRIC_LABEL[p.metric]);
  if (p.method === "hybrid") parts.push(p.fusion === "rrf" ? "RRF" : `加权 α=${p.hybrid_alpha}`);
  if (p.use_rerank) parts.push("重排序");
  if (p.use_mmr) parts.push(`MMR λ=${p.mmr_lambda}`);
  if (p.index === "hnsw") parts.push(`HNSW 候选 ${p.ann_candidates}`);
  return parts.join(" · ");
}

const HELP = {
  method: "向量检索按语义相似度；BM25 按关键词匹配，适合专有名词、编号；混合检索把两者融合。",
  metric: "余弦只看方向；点积还受向量长度影响；欧氏距离越小越相近。bge 等模型输出的向量已归一化，三者排序通常一致。",
  fusion: "RRF 按两边的排名融合（1/(k+排名) 相加），不受分数尺度影响；加权是把两边分数归一化到 0~1 后按 α 加权。",
  mmr: "MMR（最大边际相关）：每次挑“和问题相关、又和已选片段不重复”的片段。λ=1 只看相关性，越小越重视多样性。",
  rerank: "用交叉编码器（bge-reranker-base）把问题和每个候选片段一起打分，通常更准，但更慢，首次使用需下载约 1GB 模型。",
  min_score: "按余弦相似度过滤，低于阈值的片段不返回、不发给模型。",
  index:
    "精确：和每个切片都算一遍相似度，结果最准，数据量大时慢。HNSW：在预先建好的“多层邻居图”上从粗到细地找最近邻，只看一小部分切片，快但可能漏掉真正最近的（召回率 < 100%）。",
};

export default function StrategyEditor({
  value,
  onChange,
  compact,
}: {
  value: RetrievalParams;
  onChange: (p: RetrievalParams) => void;
  compact?: boolean;
}) {
  const set = <K extends keyof RetrievalParams>(k: K, v: RetrievalParams[K]) => onChange({ ...value, [k]: v });
  const num = (k: keyof RetrievalParams, step = 1, min?: number, max?: number) => (
    <input
      type="number"
      step={step}
      min={min}
      max={max}
      value={value[k] as number}
      onChange={(e) => set(k, Number(e.target.value) as never)}
    />
  );
  const needsCandidates = value.use_mmr || value.use_rerank;

  return (
    <div className={`strategy-editor ${compact ? "compact" : ""}`}>
      <label title={HELP.method}>
        检索算法
        <select value={value.method} onChange={(e) => set("method", e.target.value as RetrievalParams["method"])}>
          {Object.entries(METHOD_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      {value.method !== "bm25" && (
        <label title={HELP.metric}>
          相似度计算
          <select value={value.metric} onChange={(e) => set("metric", e.target.value as RetrievalParams["metric"])}>
            {Object.entries(METRIC_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      )}
      {value.method === "hybrid" && (
        <>
          <label title={HELP.fusion}>
            融合方式
            <select value={value.fusion} onChange={(e) => set("fusion", e.target.value as RetrievalParams["fusion"])}>
              <option value="rrf">RRF 排名融合</option>
              <option value="weighted">分数加权</option>
            </select>
          </label>
          {value.fusion === "weighted" ? (
            <label title="向量分数的权重，BM25 权重为 1-α">向量权重 α{num("hybrid_alpha", 0.1, 0, 1)}</label>
          ) : (
            <label title="RRF 公式里的常数 k，越大排名靠后的结果影响越大">RRF k{num("rrf_k", 10, 1, 1000)}</label>
          )}
        </>
      )}
      <label title={HELP.index}>
        索引方式
        <select value={value.index} onChange={(e) => set("index", e.target.value as RetrievalParams["index"])}>
          <option value="exact">精确计算（暴力检索）</option>
          <option value="hnsw">HNSW 近似检索</option>
        </select>
      </label>
      {value.index === "hnsw" && (
        <label title="HNSW 先召回多少个向量候选（BM25 也召回同样数量），之后只在候选里打分">ANN 候选数{num("ann_candidates", 10, 1, 1000)}</label>
      )}
      <label>Top K{num("top_k", 1, 1, 50)}</label>
      <label title={HELP.min_score}>最低余弦相似度{num("min_score", 0.05, -1, 1)}</label>
      <label className="check" title={HELP.rerank}>
        <input type="checkbox" checked={value.use_rerank} onChange={(e) => set("use_rerank", e.target.checked)} />
        重排序 Rerank
      </label>
      <label className="check" title={HELP.mmr}>
        <input type="checkbox" checked={value.use_mmr} onChange={(e) => set("use_mmr", e.target.checked)} />
        MMR 多样性
      </label>
      {value.use_mmr && <label title={HELP.mmr}>MMR λ{num("mmr_lambda", 0.1, 0, 1)}</label>}
      {needsCandidates && <label title="先取多少个候选，再做重排序 / MMR">候选数 fetch_k{num("fetch_k", 5, 1, 200)}</label>}
      {!compact && (
        <ul className="help muted small">
          {Object.values(HELP).map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
