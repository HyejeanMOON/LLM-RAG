import type { EvalMetricInfo } from "../../api";
import { GROUP_HELP, GROUP_LABEL, METRIC_DOCS, metricHow, metricName } from "../../evalMetrics";
import { getLang, t } from "../../i18n";
import { GROUP_ORDER } from "./shared";

/** 评测方法的整体介绍 + 每个指标的公式和原理。 */
export default function GuideTab({ infos }: { infos: EvalMetricInfo[] }) {
  return (
    <div className="eval-guide">
      {getLang() === "en" ? <IntroEn /> : <IntroZh />}
      {GROUP_ORDER.map((g) => (
        <section key={g}>
          <h3>{GROUP_LABEL[g]()}</h3>
          <p className="muted">{GROUP_HELP[g]()}</p>
          <table className="guide-table">
            <tbody>
              {infos
                .filter((m) => m.group === g)
                .map((m) => (
                  <tr key={m.key}>
                    <th>
                      {metricName(m.key)}
                      {METRIC_DOCS[m.key]?.formula && <code className="formula">{METRIC_DOCS[m.key].formula}</code>}
                    </th>
                    <td>
                      {metricHow(m.key)}
                      {m.needs.length > 0 && (
                        <div className="muted small">
                          {t("需要：", "Needs: ")}
                          {m.needs.map((n) => NEEDS[n]?.() ?? n).join(t("、", ", "))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

const NEEDS: Record<string, () => string> = {
  evidence: () => t("标注证据", "evidence annotation"),
  reference: () => t("参考答案", "reference answer"),
  answer: () => t("生成回答", "a generated answer"),
  judge: () => t("裁判 LLM", "a judge LLM"),
  answerable: () => t("只算有答案的题", "answerable questions only"),
  unanswerable: () => t("只算无答案的题", "unanswerable questions only"),
};

function IntroZh() {
  return (
    <section>
      <h3>为什么要评测</h3>
      <p>
        RAG 有很多可以调的地方（切分、向量模型、检索算法、提示词……），凭感觉问几个问题很难判断改动是变好还是变坏。评测就是准备一套固定的题目，每次改完都跑一遍、看分数，用数据说话。
      </p>
      <h3>评什么：把问题拆成两段</h3>
      <ul>
        <li>
          <b>检索</b>：该找的资料找到了吗？排得靠前吗？——用检索指标或上下文精确率 / 召回率。
        </li>
        <li>
          <b>生成</b>：拿到资料以后，回答对吗？有没有编造？答没答到点上？——用文本相似度或 LLM 裁判。
        </li>
      </ul>
      <p>
        分开看才能定位问题：上下文召回率低说明检索漏了，该调检索；召回率高但忠实度低，说明模型没好好用资料，该调提示词或换模型。
      </p>
      <h3>怎么用这个页面</h3>
      <ol>
        <li>在“题目”里准备测试集：导入示例、手动写、或者让 LLM 从文档自动出题（记得检查）。</li>
        <li>在“运行评测”里选指标，先用当前设置跑一次，作为基线。</li>
        <li>换一个配置（比如混合检索、Top K 改成 8、打开 HyDE）再跑一次。</li>
        <li>在“结果对比”里并排看各指标，点评测名看逐题细节，勾选两次评测做成对比较。</li>
      </ol>
      <h3>建议的实验</h3>
      <ul>
        <li>只选检索指标（免费）：对比向量 / BM25 / 混合检索，Top K 2 / 4 / 8，看命中率和精确率如何此消彼长。</li>
        <li>把向量化换成“字符哈希”重建索引再评，体会语义模型的作用。</li>
        <li>删掉系统提示词里“只依据片段回答”，看忠实度和拒答正确率的变化。</li>
        <li>同一次评测里对比 BLEU / ROUGE 和 LLM 裁判的分数：字面指标低但裁判打高分的题，往往是换了说法的正确回答。</li>
        <li>用本地小模型和 Claude 分别当回答模型，再做一次成对比较。</li>
      </ul>
      <h3>注意事项</h3>
      <ul>
        <li>题目太少时分数波动很大，10 道题差 0.05 不一定说明什么。</li>
        <li>LLM 裁判有随机性和偏见，重要结论要展开细节抽查。</li>
        <li>不要拿测试集反复调参后又用同一套题宣布“效果提升”，那是过拟合；真实使用时最好留一部分没见过的题。</li>
      </ul>
    </section>
  );
}

function IntroEn() {
  return (
    <section>
      <h3>Why evaluate</h3>
      <p>
        A RAG system has many knobs (chunking, embedding model, retrieval algorithm, prompt…). Asking a few questions by hand rarely tells you whether a change made things better or worse. Evaluation means keeping a fixed set of questions, running it after every change, and letting the numbers decide.
      </p>
      <h3>What to measure: split it in two</h3>
      <ul>
        <li>
          <b>Retrieval</b>: was the right material found, and ranked near the top? Use retrieval metrics or context precision / recall.
        </li>
        <li>
          <b>Generation</b>: given the material, is the answer correct, free of made-up content, on point? Use text similarity or an LLM judge.
        </li>
      </ul>
      <p>
        Looking at them separately locates the problem: low context recall means retrieval missed something, so tune retrieval; high recall but low faithfulness means the model didn't use the material well, so tune the prompt or switch models.
      </p>
      <h3>How to use this page</h3>
      <ol>
        <li>Prepare a test set under "Questions": import the sample, write your own, or let an LLM generate questions from the documents (review them).</li>
        <li>Under "Run", choose metrics and run once with the current settings as a baseline.</li>
        <li>Change one thing (e.g. hybrid retrieval, Top K 8, HyDE on) and run again.</li>
        <li>Under "Results", compare metrics side by side, click a run name for per-question details, and tick two runs for a pairwise comparison.</li>
      </ol>
      <h3>Suggested experiments</h3>
      <ul>
        <li>Retrieval metrics only (free): compare vector / BM25 / hybrid and Top K 2 / 4 / 8 to see the trade-off between hit rate and precision.</li>
        <li>Switch the embedding to the character hash, rebuild the index and evaluate again to see what a semantic model contributes.</li>
        <li>Remove "answer only from the sources" from the system prompt and watch faithfulness and negative rejection.</li>
        <li>In one run, compare BLEU / ROUGE with the judge scores: questions with low lexical scores but high judge scores are usually correct paraphrases.</li>
        <li>Use a small local model and Claude as answer models, then run a pairwise comparison.</li>
      </ul>
      <h3>Caveats</h3>
      <ul>
        <li>With few questions, scores are noisy; a 0.05 difference on 10 questions may mean nothing.</li>
        <li>LLM judges are random and biased; spot-check the details before trusting a conclusion.</li>
        <li>Don't tune on a test set and then report improvements on the same questions; that's overfitting. Keep some unseen questions for real use.</li>
      </ul>
    </section>
  );
}
