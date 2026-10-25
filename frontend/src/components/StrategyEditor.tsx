import type { RetrievalParams } from "../api";
import { t, tr } from "../i18n";

export const METHOD_LABEL = tr<RetrievalParams["method"]>({
  vector: ["向量检索", "Vector"],
  bm25: ["BM25 关键词", "BM25 keyword"],
  hybrid: ["混合检索", "Hybrid"],
});
export const METRIC_LABEL = tr<RetrievalParams["metric"]>({
  cosine: ["余弦相似度", "Cosine"],
  dot: ["点积", "Dot product"],
  l2: ["欧氏距离", "Euclidean (L2)"],
});

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
  if (p.method === "hybrid") parts.push(p.fusion === "rrf" ? "RRF" : `${t("加权", "weighted")} α=${p.hybrid_alpha}`);
  if (p.use_rerank) parts.push(t("重排序", "rerank"));
  if (p.use_mmr) parts.push(`MMR λ=${p.mmr_lambda}`);
  if (p.index === "hnsw") parts.push(`HNSW ${t("候选", "candidates")} ${p.ann_candidates}`);
  return parts.join(" · ");
}

const HELP = tr({
  method: [
    "向量检索按语义相似度；BM25 按关键词匹配，适合专有名词、编号；混合检索把两者融合。",
    "Vector search ranks by semantic similarity; BM25 matches keywords, good for names and IDs; hybrid fuses both.",
  ],
  metric: [
    "余弦只看方向；点积还受向量长度影响；欧氏距离越小越相近。bge 等模型输出的向量已归一化，三者排序通常一致。",
    "Cosine looks only at direction; dot product is also affected by vector length; for Euclidean distance, smaller is closer. Models like bge output normalized vectors, so all three usually rank the same.",
  ],
  fusion: [
    "RRF 按两边的排名融合（1/(k+排名) 相加），不受分数尺度影响；加权是把两边分数归一化到 0~1 后按 α 加权。",
    "RRF fuses by rank (sums 1/(k+rank)), so score scales don't matter; weighted normalizes both scores to 0–1 and mixes them with α.",
  ],
  mmr: [
    "MMR（最大边际相关）：每次挑“和问题相关、又和已选片段不重复”的片段。λ=1 只看相关性，越小越重视多样性。",
    "MMR (Maximal Marginal Relevance): each pick is relevant to the question but different from chunks already picked. λ=1 is pure relevance; lower values favor diversity.",
  ],
  rerank: [
    "用交叉编码器（bge-reranker-base）把问题和每个候选片段一起打分，通常更准，但更慢，首次使用需下载约 1GB 模型。",
    "A cross-encoder (bge-reranker-base) scores the question together with each candidate. Usually more accurate but slower; the first use downloads a ~1GB model.",
  ],
  min_score: [
    "按余弦相似度过滤，低于阈值的片段不返回、不发给模型。",
    "Filter by cosine similarity; chunks below the threshold are not returned or sent to the model.",
  ],
  index: [
    "精确：和每个切片都算一遍相似度，结果最准，数据量大时慢。HNSW：在预先建好的“多层邻居图”上从粗到细地找最近邻，只看一小部分切片，快但可能漏掉真正最近的（召回率 < 100%）。",
    "Exact: compare against every chunk; most accurate, slow on large data. HNSW: walk a prebuilt multi-layer neighbor graph from coarse to fine, looking at only a small part of the chunks; fast, but may miss the true nearest ones (recall < 100%).",
  ],
});

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
        {t("检索算法", "Retrieval method")}
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
          {t("相似度计算", "Similarity metric")}
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
            {t("融合方式", "Fusion")}
            <select value={value.fusion} onChange={(e) => set("fusion", e.target.value as RetrievalParams["fusion"])}>
              <option value="rrf">{t("RRF 排名融合", "RRF (rank fusion)")}</option>
              <option value="weighted">{t("分数加权", "Weighted scores")}</option>
            </select>
          </label>
          {value.fusion === "weighted" ? (
            <label title={t("向量分数的权重，BM25 权重为 1-α", "Weight of the vector score; BM25 gets 1-α")}>
              {t("向量权重 α", "Vector weight α")}
              {num("hybrid_alpha", 0.1, 0, 1)}
            </label>
          ) : (
            <label title={t("RRF 公式里的常数 k，越大排名靠后的结果影响越大", "The constant k in RRF; larger k gives lower-ranked results more influence")}>
              RRF k{num("rrf_k", 10, 1, 1000)}
            </label>
          )}
        </>
      )}
      <label title={HELP.index}>
        {t("索引方式", "Index")}
        <select value={value.index} onChange={(e) => set("index", e.target.value as RetrievalParams["index"])}>
          <option value="exact">{t("精确计算（暴力检索）", "Exact (brute force)")}</option>
          <option value="hnsw">{t("HNSW 近似检索", "HNSW (approximate)")}</option>
        </select>
      </label>
      {value.index === "hnsw" && (
        <label title={t("HNSW 先召回多少个向量候选（BM25 也召回同样数量），之后只在候选里打分", "How many vector candidates HNSW recalls first (BM25 recalls the same number); scoring then runs only on candidates")}>
          {t("ANN 候选数", "ANN candidates")}
          {num("ann_candidates", 10, 1, 1000)}
        </label>
      )}
      <label>Top K{num("top_k", 1, 1, 50)}</label>
      <label title={HELP.min_score}>
        {t("最低余弦相似度", "Min cosine similarity")}
        {num("min_score", 0.05, -1, 1)}
      </label>
      <label className="check" title={HELP.rerank}>
        <input type="checkbox" checked={value.use_rerank} onChange={(e) => set("use_rerank", e.target.checked)} />
        {t("重排序 Rerank", "Rerank")}
      </label>
      <label className="check" title={HELP.mmr}>
        <input type="checkbox" checked={value.use_mmr} onChange={(e) => set("use_mmr", e.target.checked)} />
        {t("MMR 多样性", "MMR diversity")}
      </label>
      {value.use_mmr && <label title={HELP.mmr}>MMR λ{num("mmr_lambda", 0.1, 0, 1)}</label>}
      {needsCandidates && (
        <label title={t("先取多少个候选，再做重排序 / MMR", "How many candidates to fetch before rerank / MMR")}>
          {t("候选数 fetch_k", "Candidates fetch_k")}
          {num("fetch_k", 5, 1, 200)}
        </label>
      )}
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
