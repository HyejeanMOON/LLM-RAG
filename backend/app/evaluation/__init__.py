"""RAG 评测：测试集、检索指标、文本指标、LLM 裁判指标。

- metrics.py  不需要 LLM 的指标：检索（Hit Rate / Recall / Precision / MRR / MAP / NDCG）
              和文本相似度（精确匹配 / Token F1 / BLEU / ROUGE / 语义相似度）
- judge.py    LLM-as-a-Judge 指标（RAGAS / G-Eval 风格）：忠实度、答案相关性、
              上下文精确率 / 召回率 / 相关性、答案正确性、G-Eval 打分、拒答、成对比较
- testset.py  用 LLM 从文档自动生成测试题，以及内置示例测试集
"""
