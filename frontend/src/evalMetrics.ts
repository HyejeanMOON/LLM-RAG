// 评测指标的名称、公式和原理说明（中英文）。后端 /api/eval/metrics 决定有哪些指标，这里只负责解释。
import { t } from "./i18n";

export type MetricGroup = "retrieval" | "text" | "judge" | "system";

interface MetricDoc {
  name: [string, string];
  formula?: string;
  how: [string, string];
  /** 每道题会多调用几次裁判 LLM */
  judgeCalls?: number;
}

export const GROUP_LABEL: Record<MetricGroup, () => string> = {
  retrieval: () => t("检索指标（不需要 LLM）", "Retrieval metrics (no LLM)"),
  text: () => t("回答 vs 参考答案（文本相似度）", "Answer vs reference (text similarity)"),
  judge: () => t("LLM 裁判（LLM-as-a-Judge）", "LLM as a judge"),
  system: () => t("系统指标（自动记录）", "System metrics (always recorded)"),
};

export const GROUP_HELP: Record<MetricGroup, () => string> = {
  retrieval: () =>
    t(
      "看检索有没有把“证据”找出来。每道题标注一段或几段能回答问题的原文（证据），检索到的切片和证据的字符重合度超过阈值就算“命中”。K 是检索返回的切片数（Top K）。只看检索、不生成回答时完全免费。",
      "Did retrieval find the evidence? Each question is annotated with one or more source passages that answer it (evidence); a retrieved chunk counts as a hit when its character overlap with the evidence is above the threshold. K is the number of retrieved chunks (Top K). Free to run when you only evaluate retrieval.",
    ),
  text: () =>
    t(
      "把模型的回答和人工写的参考答案逐字比较。便宜、确定、可复现，但只看字面，换个说法分数就会很低，所以更适合当参考，不适合单独作为结论。",
      "Compare the model's answer with a human-written reference word by word. Cheap, deterministic and reproducible, but purely lexical: a paraphrase scores low. Use them as signals, not as the final verdict.",
    ),
  judge: () =>
    t(
      "让另一个 LLM 当裁判，按固定的提示词逐条判断。能理解语义，接近人工评价，但要花钱、有一定随机性，裁判本身也会犯错（偏爱长答案、偏爱排在前面的答案、偏爱自己的风格）。建议用比被测模型更强的模型当裁判，并展开细节抽查裁判的理由。",
      "Another LLM grades each output with a fixed prompt. It understands meaning and is close to human judgment, but costs money, has some randomness, and judges make mistakes (favoring longer answers, the first answer shown, or their own style). Prefer a judge stronger than the model under test, and spot-check its reasons in the details.",
    ),
  system: () => t("每次评测都会记录，用来权衡效果和速度 / 成本。", "Recorded on every run, to weigh quality against speed and cost."),
};

export const METRIC_DOCS: Record<string, MetricDoc> = {
  hit_rate: {
    name: ["命中率 Hit Rate@K", "Hit Rate@K"],
    formula: "1 if any chunk in top K covers any evidence else 0",
    how: [
      "前 K 个切片里只要有一个包含证据就算 1 分。最宽松的检索指标，回答“答案有没有被找回来”。",
      "1 if at least one of the top K chunks contains evidence. The most lenient retrieval metric: was the answer retrieved at all?",
    ],
  },
  recall_at_k: {
    name: ["召回率 Recall@K", "Recall@K"],
    formula: "|evidence covered by top K| / |evidence|",
    how: [
      "证据有几段被找回来了。需要多段证据才能答全的问题（比如“年终奖 = 基数 × 系数”）这个指标比命中率更能说明问题。",
      "How many of the evidence passages were retrieved. For questions that need several passages (e.g. \"bonus = base × factor\"), this tells more than Hit Rate.",
    ],
  },
  precision_at_k: {
    name: ["精确率 Precision@K", "Precision@K"],
    formula: "|relevant chunks in top K| / K",
    how: [
      "检索到的切片里有多少是有用的。K 越大召回越高、精确率越低，无关切片多了会干扰模型、浪费上下文。",
      "How many retrieved chunks are useful. Larger K raises recall but lowers precision; irrelevant chunks distract the model and waste context.",
    ],
  },
  mrr: {
    name: ["平均倒数排名 MRR", "Mean Reciprocal Rank (MRR)"],
    formula: "1 / rank of the first relevant chunk",
    how: [
      "第一个相关切片排第几：排第 1 得 1 分，第 2 得 0.5，第 3 得 0.33……只关心第一个命中的位置，适合“只要一条答案”的场景。",
      "Where the first relevant chunk is: rank 1 scores 1, rank 2 scores 0.5, rank 3 scores 0.33… Only the first hit matters, which suits single-answer lookups.",
    ],
  },
  map_at_k: {
    name: ["平均精确率 MAP@K", "Mean Average Precision (MAP@K)"],
    formula: "Σ P@i · rel(i) / min(|evidence|, K)",
    how: [
      "每命中一段新证据，就记下那个位置的精确率，最后取平均。既看找没找到，也看找到的排得靠不靠前。重复覆盖同一段证据的切片不再加分。",
      "At each position that covers new evidence, take the precision so far, then average. Rewards both finding the evidence and ranking it early. Chunks that re-cover the same evidence don't count again.",
    ],
  },
  ndcg_at_k: {
    name: ["归一化折损累计增益 NDCG@K", "NDCG@K"],
    formula: "Σ rel(i)/log2(i+1) ÷ ideal DCG",
    how: [
      "排名越靠后的命中“折损”越多（除以 log2(位置+1)），再除以理想排序的得分归一化到 0~1。搜索引擎最常用的排序指标。",
      "Hits further down are discounted (divided by log2(rank+1)), then normalized by the score of the ideal ranking to 0–1. The standard ranking metric in search engines.",
    ],
  },
  exact_match: {
    name: ["精确匹配 Exact Match", "Exact Match"],
    formula: "normalize(answer) == normalize(reference)",
    how: [
      "去掉空格标点后完全一样才得 1 分。适合答案很短的抽取式问答（数字、人名）；LLM 生成的完整句子几乎总是 0 分，可以借此体会为什么不能只用字面指标。",
      "1 only if identical after removing spaces and punctuation. Fine for short extractive answers (numbers, names); full LLM sentences almost always score 0, which shows why lexical metrics alone aren't enough.",
    ],
  },
  token_f1: {
    name: ["词级 F1 Token F1", "Token F1"],
    formula: "2·P·R/(P+R) over bag of tokens",
    how: [
      "把回答和参考答案都当成一袋词（中文按字），重合的词占回答的比例是精确率，占参考答案的比例是召回率，取调和平均。SQuAD 评测用的就是它。",
      "Treat both as bags of tokens (Chinese by character). Overlap / answer length is precision, overlap / reference length is recall; F1 is their harmonic mean. Used by SQuAD.",
    ],
  },
  bleu: {
    name: ["BLEU-4", "BLEU-4"],
    formula: "BP · exp(Σ log p_n / 4), n = 1..4",
    how: [
      "机器翻译的经典指标：1~4 元组在参考答案里出现的比例（精确率）取几何平均，回答比参考短时再乘简短惩罚 BP。偏重“说的话有没有出处”，对改写很敏感。",
      "The classic machine-translation metric: geometric mean of 1- to 4-gram precision against the reference, times a brevity penalty when the answer is shorter. Rewards wording that appears in the reference; very sensitive to paraphrasing.",
    ],
  },
  rouge_1: {
    name: ["ROUGE-1", "ROUGE-1"],
    formula: "F1 of unigram overlap",
    how: ["单字 / 单词重合的 F1。ROUGE 源自摘要评测，更看重召回：参考答案里的内容有没有被说到。", "F1 of unigram overlap. ROUGE comes from summarization and leans toward recall: is the reference content covered?"],
  },
  rouge_2: {
    name: ["ROUGE-2", "ROUGE-2"],
    formula: "F1 of bigram overlap",
    how: ["相邻两个字 / 词重合的 F1，比 ROUGE-1 更在意词序和搭配。", "F1 of bigram overlap; cares more about word order and phrasing than ROUGE-1."],
  },
  rouge_l: {
    name: ["ROUGE-L", "ROUGE-L"],
    formula: "F1 based on longest common subsequence",
    how: [
      "按最长公共子序列（不要求连续，但顺序一致）算 F1，能容忍中间插入别的词。",
      "F1 based on the longest common subsequence (in order, not necessarily contiguous), so it tolerates inserted words.",
    ],
  },
  semantic_similarity: {
    name: ["语义相似度", "Semantic similarity"],
    formula: "cos(embed(answer), embed(reference))",
    how: [
      "用当前的向量模型把回答和参考答案都变成向量，算余弦相似度。不在乎措辞，只看意思像不像；但分数整体偏高、区分度一般，而且取决于向量模型的质量（字符哈希就不懂语义）。",
      "Embed answer and reference with the current embedding model and take the cosine. Ignores wording and looks at meaning, but scores tend to be high with modest spread, and it depends on the embedding model (the character hash has no notion of meaning).",
    ],
  },
  faithfulness: {
    name: ["忠实度 Faithfulness", "Faithfulness"],
    formula: "supported statements / all statements",
    judgeCalls: 2,
    how: [
      "衡量“幻觉”。裁判先把回答拆成一条条事实陈述，再逐条判断能不能从提供给模型的参考资料里推出来。不需要参考答案。文档里没答案的题也会算：模型编了内容就会被抓出来。",
      "Measures hallucination. The judge splits the answer into factual statements, then checks each against the context given to the model. Needs no reference answer. Also runs on unanswerable questions, where any made-up content gets caught.",
    ],
  },
  answer_relevancy: {
    name: ["答案相关性 Answer Relevancy", "Answer relevancy"],
    formula: "mean cos(q, q'_i) × (1 − noncommittal)",
    judgeCalls: 1,
    how: [
      "RAGAS 的做法：让裁判根据回答反推 3 个问题，再用向量算它们和原问题的相似度。答非所问、只说一半，反推出的问题就和原问题不像；回答含糊其辞（“不确定”）直接记 0。",
      "The RAGAS approach: the judge writes 3 questions the answer would answer, and their embedding similarity to the original question is averaged. Off-topic or partial answers produce dissimilar questions; evasive answers score 0.",
    ],
  },
  context_precision: {
    name: ["上下文精确率 Context Precision", "Context precision"],
    formula: "Σ P@k · v_k / Σ v_k",
    judgeCalls: 1,
    how: [
      "裁判对照参考答案，逐个判断检索到的切片有没有用，再按排名加权：有用的切片排得越靠前分越高。和 Precision@K 的区别是由 LLM 判断“有用”，不需要标注证据。",
      "The judge checks, against the reference answer, whether each retrieved chunk was useful, weighted by rank so useful chunks near the top score higher. Unlike Precision@K, usefulness is judged by an LLM, so no evidence annotation is needed.",
    ],
  },
  context_recall: {
    name: ["上下文召回率 Context Recall", "Context recall"],
    formula: "reference statements found in context / all",
    judgeCalls: 1,
    how: [
      "把参考答案拆成几条陈述，看每条能不能在检索到的切片里找到依据。低分说明检索漏掉了回答需要的信息，问题出在检索而不是生成。",
      "Split the reference answer into statements and check whether each is supported by the retrieved chunks. A low score means retrieval missed information the answer needs: the problem is retrieval, not generation.",
    ],
  },
  context_relevance: {
    name: ["上下文相关性 Context Relevance", "Context relevance"],
    formula: "relevant chunks / retrieved chunks",
    judgeCalls: 1,
    how: [
      "只看问题和检索到的切片（不需要参考答案）：有多少切片和问题相关。可以在没有标注的真实问题上用。",
      "Looks only at the question and the retrieved chunks (no reference needed): what share of chunks is relevant. Usable on real, unannotated questions.",
    ],
  },
  answer_correctness: {
    name: ["答案正确性 Answer Correctness", "Answer correctness"],
    formula: "0.75 · F1(TP, FP, FN) + 0.25 · semantic sim",
    judgeCalls: 1,
    how: [
      "RAGAS 的做法：裁判把陈述分成三类——回答里对的（TP）、回答里多出来或错的（FP）、参考答案里有但回答漏了的（FN），算事实层面的 F1，再和语义相似度按 3:1 加权。",
      "The RAGAS approach: the judge sorts statements into correct ones in the answer (TP), extra or wrong ones (FP) and ones the answer missed (FN), computes a factual F1, and blends it 3:1 with semantic similarity.",
    ],
  },
  geval: {
    name: ["G-Eval 综合打分", "G-Eval score"],
    formula: "(score − 1) / 4, score ∈ 1..5",
    judgeCalls: 1,
    how: [
      "G-Eval 的做法：在提示词里写清评分标准，让裁判先列出评估步骤（思维链），再打 1~5 分。和人工评分的一致性较好，展开细节能看到裁判的推理过程。",
      "The G-Eval approach: the prompt spells out the rubric, the judge lists its evaluation steps (chain of thought), then gives 1–5. Agrees well with human ratings; the details show the judge's reasoning.",
    ],
  },
  negative_rejection: {
    name: ["拒答正确率 Negative Rejection", "Negative rejection"],
    formula: "refused / unanswerable questions",
    judgeCalls: 1,
    how: [
      "只对“文档里没有答案”的题计算：模型有没有老实说“没找到”，而不是凭常识或瞎编作答。RAG 系统可信度的关键指标。",
      "Only for questions the documents can't answer: did the model honestly say it couldn't find it, instead of answering from general knowledge or making things up? Key to a trustworthy RAG system.",
    ],
  },
  false_refusal: {
    name: ["误拒率 False Refusal（越低越好）", "False refusal (lower is better)"],
    formula: "refused / answerable questions",
    judgeCalls: 1,
    how: [
      "和拒答正确率配对看：文档里明明有答案，模型却说“没找到”的比例。提示词把“找不到就说找不到”写得太严、或者检索没找回来，都会让它升高。",
      "The counterpart of negative rejection: how often the model says \"not found\" although the documents do answer. Rises when the prompt is too strict about refusing or when retrieval misses.",
    ],
  },
  latency_ms: { name: ["总耗时（毫秒）", "Total latency (ms)"], how: ["一道题从检索到生成完回答的时间。", "Time per question from retrieval to the finished answer."] },
  retrieval_ms: { name: ["检索耗时（毫秒）", "Retrieval latency (ms)"], how: ["只算检索那一步。", "Retrieval step only."] },
  context_chars: {
    name: ["上下文字数", "Context characters"],
    how: ["发给模型的参考资料总字数，基本决定了输入 token 和费用。", "Total characters of sources sent to the model; roughly decides input tokens and cost."],
  },
  answer_chars: { name: ["回答字数", "Answer characters"], how: ["回答的长度。裁判常常偏爱长答案，可以对照着看。", "Answer length. Judges often favor longer answers, so compare against this."] },
};

export const metricName = (key: string) => {
  const d = METRIC_DOCS[key];
  return d ? t(d.name[0], d.name[1]) : key;
};
export const metricHow = (key: string) => {
  const d = METRIC_DOCS[key];
  return d ? t(d.how[0], d.how[1]) : "";
};
