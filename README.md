# RAG 知识库问答（全栈）

上传文档 → 切片 → 向量化 → 存入向量库 → 提问时检索相关片段 → 把片段和问题一起发给 LLM → 流式返回带引用的回答。
可以在网页上管理文档（上传 / 新建 / 编辑 / 删除）、配置多个 LLM 并随时切换。

![问答界面截图](docs/images/chat.png)

```
┌────────── 前端 React + Vite ──────────┐        ┌──────────────── 后端 FastAPI ────────────────┐
│ 问答  文档管理  检索调试  模型与设置   │ ─/api─▶ │ 文档解析 (md/txt/pdf/docx) → 切片 → embedding │
└────────────────────────────────────────┘        │        │                          │          │
                                                  │   SQLite (原文/配置)        Chroma (向量)   │
                                                  │                                    │          │
                                                  │ 问题 → 向量检索 top-k → 拼提示词 → LLM (SSE) │
                                                  │                    Claude / OpenAI 兼容接口   │
                                                  └───────────────────────────────────────────────┘
```

## 功能

| 功能 | 说明 |
|---|---|
| 文档管理 | 上传 .md / .txt / .pdf / .docx（可多选、拖拽），也能直接粘贴新建；在线编辑后自动重新切片入库；删除时向量一起删 |
| 切分算法 | 标题 + 句子、固定长度、按段落、递归切分、语义切分五种，可调长度、重叠、是否加小节标题；设置全局默认，也可以每篇文档单独设置，应用前能并排预览切片效果 |
| 向量化 | 可在网页切换：本地 [fastembed](https://github.com/qdrant/fastembed) 模型（默认 `BAAI/bge-small-zh-v1.5`，还有 jina-zh、multilingual-e5、Qwen3-Embedding 等）、OpenAI 兼容向量接口（OpenAI / 通义 / 智谱 / Ollama bge-m3…）、离线字符哈希；带“向量化实验”看句子间相似度 |
| 向量库 | [Chroma](https://www.trychroma.com/)，本地持久化；HNSW 参数（距离、M、ef_construction、ef_search）可调，检索时可选精确计算或 HNSW 近似检索 |
| 问题处理 | 结合历史改写问题、多查询（Multi-Query + RRF 融合）、HyDE 假想文档，可分别开关 |
| 元数据过滤 | 文档可打标签；问答和检索调试可按文档、标签、更新日期过滤 |
| 上下文组装 | 总字数上限、相邻片段扩展（small-to-big）、片段排序（相关度 / 原文顺序 / 两头放最相关） |
| 生成 | 系统提示词、用户消息模板、片段模板都可编辑；max_tokens、temperature（OpenAI 兼容）、effort（Claude） |
| 流程追踪 | 每条回答下可展开：改写后的问题、多查询、HyDE 文本、过滤结果、检索统计、上下文组装、发送给模型的完整提示词、各步耗时 |
| LLM | **Claude**（Anthropic 官方 SDK）和 **OpenAI 兼容接口**（OpenAI、DeepSeek、通义千问、Kimi、智谱…），以及**本地模型**（Ollama / LM Studio / llama.cpp，例如 Gemma 4，能自动检测本机已装的模型），网页上添加多个、设默认、测试连接，问答时下拉切换 |
| 问答 | SSE 流式输出；先返回检索到的片段（含相似度），回答里用 [1][2] 标注来源；支持多轮对话、可随时停止 |
| 检索算法 | 向量检索（余弦 / 点积 / 欧氏距离）、BM25 关键词、混合检索（RRF 排名融合或分数加权）、交叉编码器重排序、MMR 多样性、Top K、余弦相似度阈值，可任意组合 |
| 检索调试 | 同一个问题用最多 4 种策略并排对比：每个片段显示余弦、点积、欧氏距离、BM25、混合、重排序、MMR 各项分数，以及它在其他策略里的排名；满意的策略一键设为问答默认 |
| RAG 流程页 | 按“切分 → 向量化 → 索引 → 问题处理 → 检索 → 上下文 → 生成”的顺序列出全部参数，每个环节都有原理说明；前三步改了会提示重建索引 |

## 界面截图

| 问答 | 文档管理 |
|---|---|
| ![问答](docs/images/chat.png) | ![文档管理](docs/images/documents.png) |
| **检索调试**（多种检索算法并排对比片段相似度） | **RAG 流程**（切分 / 向量 / 索引 / 查询 / 检索 / 上下文 / 生成，每一步可切换） |
| ![检索调试](docs/images/search.png) | ![RAG 流程](docs/images/pipeline.png) |
| **LLM 模型**（添加、切换 Claude 和 OpenAI 兼容模型） | |
| ![LLM 模型](docs/images/llm-models.png) | |

## 快速开始

### 方式一：Docker（推荐）

```bash
docker compose up --build
# 打开 http://localhost:8000
```

首次启动会下载约 90MB 的 embedding 模型（缓存在 `./data/models`）。国内网络访问 HuggingFace 慢的话：

```bash
HF_ENDPOINT=https://hf-mirror.com docker compose up --build
```

### 方式二：本地开发

需要 Python 3.10+ 和 Node.js 18+。

```bash
# 后端
cd backend
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 8000

# 前端（另开一个终端）
cd frontend
npm install
npm run dev                                           # 打开 http://localhost:5173
```

开发模式下 Vite 会把 `/api` 代理到 8000 端口。执行 `npm run build` 之后，后端会直接托管 `frontend/dist`，只开 8000 端口就行。

首次启动会自动：
- 导入示例文档 `backend/sample_docs/xinghe_handbook.md`（虚构的员工手册，数字都是编的，用来验证 RAG 是否生效）；
- 添加一个 Claude Opus 5.5 的模型配置。到“LLM 模型”里填 API Key，或者启动前设置环境变量 `ANTHROPIC_API_KEY`。

可以试着问：“出差住在上海每晚最多能报销多少？”“年假没休完能留到什么时候？”“公司的股票代码是多少？”（文档里没有，模型应该回答没找到）。

## 添加其他模型

“LLM 模型” → “添加模型” → 选预设，填 API Key 即可。预设的模型名只是示例，可以改成厂商当前提供的任何模型。

| 预设 | 接口类型 | Base URL |
|---|---|---|
| Claude | Anthropic | 留空（官方） |
| OpenAI | OpenAI 兼容 | `https://api.openai.com/v1` |
| DeepSeek | OpenAI 兼容 | `https://api.deepseek.com` |
| 通义千问 | OpenAI 兼容 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Kimi | OpenAI 兼容 | `https://api.moonshot.cn/v1` |
| 智谱 GLM | OpenAI 兼容 | `https://open.bigmodel.cn/api/paas/v4` |
| 本地 · Gemma 4（Ollama） | OpenAI 兼容 | `http://localhost:11434/v1`，模型 `gemma4:e4b` |
| 本地 · Ollama 其他模型 | OpenAI 兼容 | `http://localhost:11434/v1` |
| 本地 · LM Studio | OpenAI 兼容 | `http://localhost:1234/v1` |
| 本地 · llama.cpp server | OpenAI 兼容 | `http://localhost:8080/v1` |

“高级参数”是 JSON：Claude 支持 `effort`（`low`/`medium`/`high`）和 `max_tokens`；OpenAI 兼容接口支持 `temperature`。

## 本地模型（以 Gemma 4 为例）

本地模型不花钱、数据不出电脑，适合拿来和 Claude 对比 RAG 的效果。Ollama、LM Studio、llama.cpp 都提供 OpenAI 兼容接口，所以不需要额外代码，也不需要 API Key。

**1. 安装 Ollama 并下载 Gemma 4**

```bash
# 安装：https://ollama.com/download（Mac / Windows 有安装包，Linux 用下面这行）
curl -fsSL https://ollama.com/install.sh | sh

ollama pull gemma4:e4b     # 笔记本 / 普通台式机够用
# ollama pull gemma4:e2b   # 最小，内存紧张时用
# ollama pull gemma4:26b   # MoE，建议 16GB 以上显存
# ollama pull gemma4:31b   # 最大最强
ollama list                # 看已经装好的模型
```

Ollama 装好后会在后台运行，默认地址 `http://localhost:11434`。

**2. 在网页上添加**

“LLM 模型” → “＋ 添加本地模型” → 点 “🔍 检测本地模型”。后端会扫描 Ollama（11434）、LM Studio（1234）、llama.cpp（8080）这几个默认端口，列出已安装的模型和参数量、量化方式、大小，点一下就会填好 Base URL 和模型名。保存后点“测试连接”，再到问答页的下拉框里切换过去。

端口不是默认值时，把 Base URL 改好，点“只检测当前 Base URL”。

**3. 用 Docker 运行时**

容器里的 `localhost` 指的是容器自己，访问宿主机上的 Ollama 要用 `http://host.docker.internal:11434/v1`。`docker-compose.yml` 已经加了 `extra_hosts: host.docker.internal:host-gateway`（Linux 需要，Mac / Windows 自带），自动检测也会先试这个地址。Linux 上还要让 Ollama 监听所有网卡：`OLLAMA_HOST=0.0.0.0 ollama serve`。

**小提示**

- 第一次提问时 Ollama 要把模型加载进内存，会慢几秒到几十秒，之后就快了。
- 小模型更容易不按要求引用片段或者编造，可以在“RAG 流程 → 生成”里把提示词写得更直接，temperature 调低一点（预设是 0.3）。
- Ollama 默认上下文窗口比较小，片段很多时可能被截断，可以把“上下文”里的字符预算调小，或者启动 Ollama 时调大上下文，例如 `OLLAMA_CONTEXT_LENGTH=16384 ollama serve`。
- 向量化也可以用本地模型：`ollama pull bge-m3`，然后在“RAG 流程 → 向量化”里选 OpenAI 兼容接口。

## 切分算法说明

代码在 `backend/app/chunker.py`。除“固定长度”外，切片都不会跨 Markdown 小节（Word 的标题样式上传时会转成 Markdown 标题）。

| 策略 | 做法 | 适合 |
|---|---|---|
| 标题 + 句子（默认） | 节内按句子切开，拼成不超过切片长度的块，相邻块重叠 | 大多数文档 |
| 固定长度 | 每隔固定字数切一刀，滑动窗口重叠 | 没有结构的纯文本，或做对照实验 |
| 按段落 | 按空行分段，短段落合并，长段落再按句子切 | 段落分明的文章 |
| 递归切分 | 依次用 段落 → 换行 → 句号 → 逗号 → 空格 → 单字 切，尽量在大边界断开 | 结构不规整的文本 |
| 语义切分 | 相邻句子向量化，在语义距离超过第 N 百分位的地方断开 | 话题跳跃多的长文 |

在“文档管理 → 切片”里可以选策略、点“预览效果”和当前切片并排比较，满意后“应用到这篇文档”。单独设置过的文档不受全局默认和“重建索引”影响，可以随时“恢复使用全局默认”。

## 检索算法说明

代码在 `backend/app/retrieval.py`，流程是：打分 → 取候选 → （可选）重排序 → （可选）MMR → 阈值过滤 → 取 Top K。

| 选项 | 作用 |
|---|---|
| 向量检索 + 余弦 / 点积 / 欧氏距离 | 按语义相似度排序。bge 这类模型输出归一化向量，三种度量的排序基本一致，分数尺度不同 |
| BM25 | 关键词匹配（中文按单字 + 双字切词，不依赖词典），适合专有名词、编号、数字 |
| 混合检索 · RRF | 向量和 BM25 各自排名，按 `1/(k+排名)` 相加，不受分数尺度影响 |
| 混合检索 · 加权 | 两边分数归一化到 0~1，`α·向量 + (1-α)·BM25` |
| 重排序 | 用交叉编码器 `BAAI/bge-reranker-base` 给前 fetch_k 个候选重新打分（首次使用会下载约 1GB 模型） |
| MMR | 在前 fetch_k 个候选里挑“相关、且和已选片段不重复”的，λ 越小越重视多样性 |
| 最低余弦相似度 | 无论用哪种算法，余弦相似度低于阈值的片段都丢弃 |

切片数量在几万以内时，检索直接用 numpy 对全部切片精确计算；数据量更大时，可以改成先用 Chroma 的近似检索取候选。

## RAG 流程页（学习用）

“🧪 RAG 流程”页按数据流动的顺序排列 7 个环节，每个环节可以展开“原理说明”：

1. **文档切分**：五种切分算法（见上）
2. **向量化**：切换 embedding 模型；“向量化实验”输入几句话，看维度、耗时和两两相似度
3. **向量索引**：HNSW 参数；配合检索里的“精确 / HNSW”对比召回差异
4. **问题处理**：结合历史改写、多查询、HyDE（每个会多调用一次 LLM）
5. **检索**：同“检索调试”页的全部算法
6. **上下文组装**：相邻片段扩展、排序、字数上限
7. **生成**：提示词模板和生成参数

前 3 步在导入文档时执行，改了以后页面顶部会提示“重建索引”（每种 embedding 模型 + 索引参数组合各用一个 Chroma 集合，切换回去不用重新算）。后 4 步每次提问时执行，保存后立即生效。

建议的实验：
- 把 embedding 换成“字符哈希”，问同一个问题，对比参考片段的变化；
- 问一个追问（“那北京呢？”），对比开 / 关“结合历史改写”的检索结果；
- 去掉系统提示词里“只依据片段回答”，问一个文档里没有的问题，看模型会不会编；
- 在检索调试页把“精确计算”和“HNSW 候选 5”放两列，看召回差异。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `RAG_DATA_DIR` | `backend/data` | SQLite、Chroma、模型缓存的目录 |
| `RAG_EMBEDDER` | `fastembed` | 向量化方式的初始默认值（之后在网页上切换）；`hash` 为离线字符哈希 |
| `RAG_EMBED_MODEL` | `BAAI/bge-small-zh-v1.5` | 初始默认的 fastembed 模型 |
| `ANTHROPIC_API_KEY` | | Claude 配置里没填 key 时使用 |
| `RAG_CORS_ORIGINS` | `http://localhost:5173` | 前后端分开部署时允许的前端地址，逗号分隔 |
| `RAG_MAX_UPLOAD_MB` | `20` | 单个上传文件大小上限 |

> 换 embedding 模型或 HNSW 参数后，点页面顶部提示里的“重建索引”。原文在 SQLite 里，所以随时可以重建。

## 目录结构

```
backend/
  app/
    main.py              FastAPI 入口，启动时建表、导入示例文档，托管前端
    config.py            路径和环境变量
    db.py                SQLite（文档原文、模型配置、设置）
    parsers.py           md / txt / pdf / docx → 纯文本
    chunker.py           五种切分策略
    query.py             问题处理：结合历史改写、多查询、HyDE
    context.py           上下文组装：相邻片段扩展、排序、字数上限
    embeddings.py        fastembed / hash 向量化
    store.py             Chroma 向量库：写入、删除、按文档过滤检索
    llm/                 LLM 统一接口：anthropic_provider.py、openai_provider.py
    services/            业务逻辑：documents / providers / local_models（本地模型检测） / settings / rag
    routers/             HTTP 接口
  tests/                 pytest（用 hash 向量和假 LLM，不需要网络和 key）
  sample_docs/           示例文档
frontend/
  src/api.ts             接口封装 + SSE 解析
  src/pages/             ChatPage / DocumentsPage / SearchPage / SettingsPage
```

## 主要接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/documents` | 文档列表 / 新建（JSON: name, content） |
| POST | `/api/documents/upload` | 上传文件（multipart，字段名 files，可多个） |
| GET/PUT/DELETE | `/api/documents/{id}` | 查看 / 修改（自动重新切片；可传 chunking 单独设置切分策略，或 use_default_chunking 恢复默认）/ 删除 |
| GET | `/api/documents/{id}/chunks` | 查看切片 |
| POST | `/api/documents/preview-chunks` | 试切不入库：content 或 doc_id，chunking（切分参数） |
| POST | `/api/documents/reindex` | 用当前参数重建全部索引 |
| POST | `/api/search` | 只检索：query, retrieval（检索参数，不填的用默认策略），过滤 doc_ids / tags / date_from / date_to |
| POST | `/api/search/compare` | 多策略对比：query, doc_ids, strategies（最多 6 个） |
| POST | `/api/chat` | 问答（SSE）：query, provider_id, history, retrieval, 过滤条件；事件依次为 trace、sources、delta…、done 或 error |
| GET/POST/PUT/DELETE | `/api/providers[/{id}]` | 模型配置；`POST /{id}/default` 设默认，`POST /{id}/test` 测试连接 |
| GET | `/api/providers/local/discover[?base_url=]` | 检测本机的 Ollama / LM Studio / llama.cpp 及已安装的模型 |
| GET/PUT | `/api/settings` | RAG 流程各环节参数（chunking / embedding / index / query / retrieval / context / generation）；`POST /api/settings/{分组}/reset` 恢复默认 |
| GET | `/api/embedding/models` | 常用 embedding 模型列表 |
| POST | `/api/embedding/test` | 向量化实验：texts，可用 query 参数临时指定 backend / model / provider_id |
| GET | `/api/documents/tags` | 所有标签 |

启动后访问 http://localhost:8000/docs 可以看到自动生成的接口文档。

## 运行测试

```bash
cd backend && pytest
```

## 后续可以加的

- 换用 FAISS / Qdrant / Milvus 等其他向量库
- 父子切片（parent-child）、按 token 计数切分
- 多用户登录和每人独立的知识库
- 扫描版 PDF 的 OCR
