import type { ChunkingParams, ChunkStrategy } from "../api";

export const STRATEGY_LABEL: Record<ChunkStrategy, string> = {
  structure: "标题 + 句子",
  fixed: "固定长度",
  paragraph: "按段落",
  recursive: "递归切分",
  semantic: "语义切分",
};

const STRATEGY_HELP: Record<ChunkStrategy, string> = {
  structure: "先按 Markdown 标题分节，节内按句子切开，再把句子拼成不超过切片长度的块，相邻块有重叠。适合大多数文档。",
  fixed: "不看内容，每隔固定字数切一刀，相邻块重叠。最简单，但可能把一句话切断。",
  paragraph: "按空行分段，短段落合并成一块，太长的段落再按句子切。适合段落分明的文章。",
  recursive: "依次尝试用 段落 → 换行 → 句号 → 逗号 → 空格 → 单字 切分，直到每块都不超过长度，尽量在大的边界处断开。",
  semantic: "把相邻句子向量化，在语义变化最大的地方断开，同一个话题尽量放在一块。需要计算向量，比较慢。",
};

export const DEFAULT_CHUNKING: ChunkingParams = {
  strategy: "structure",
  chunk_size: 300,
  chunk_overlap: 50,
  add_title: true,
  semantic_percentile: 80,
};

export function describeChunking(p: ChunkingParams): string {
  return `${STRATEGY_LABEL[p.strategy]} · ${p.chunk_size} 字${p.strategy !== "semantic" ? ` · 重叠 ${p.chunk_overlap}` : ""}`;
}

export default function ChunkingEditor({ value, onChange }: { value: ChunkingParams; onChange: (p: ChunkingParams) => void }) {
  const set = <K extends keyof ChunkingParams>(k: K, v: ChunkingParams[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="strategy-editor">
      <label>
        切分算法
        <select value={value.strategy} onChange={(e) => set("strategy", e.target.value as ChunkStrategy)}>
          {Object.entries(STRATEGY_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label title="每个切片最多多少字符">
        切片长度（字符）
        <input type="number" min={20} max={4000} value={value.chunk_size} onChange={(e) => set("chunk_size", Number(e.target.value))} />
      </label>
      <label title="相邻切片重叠多少字符，避免关键信息正好被切断">
        重叠（字符）
        <input type="number" min={0} value={value.chunk_overlap} onChange={(e) => set("chunk_overlap", Number(e.target.value))} />
      </label>
      {value.strategy === "semantic" && (
        <label title="相邻句子的语义距离超过这个百分位就断开。数值越小，切得越碎">
          断点百分位
          <input
            type="number"
            min={1}
            max={99}
            value={value.semantic_percentile}
            onChange={(e) => set("semantic_percentile", Number(e.target.value))}
          />
        </label>
      )}
      {value.strategy !== "fixed" && (
        <label className="check" title="每个切片前面加上它所在的小节标题，例如【四、报销规定】">
          <input type="checkbox" checked={value.add_title} onChange={(e) => set("add_title", e.target.checked)} />
          切片前加小节标题
        </label>
      )}
      <p className="help muted small">{STRATEGY_HELP[value.strategy]}</p>
    </div>
  );
}
