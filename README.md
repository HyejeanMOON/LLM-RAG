# RAG 知识库问答（全栈）

上传文档 → 切片 → 向量化 → 存入向量库 → 提问时检索相关片段 → 把片段和问题一起发给 LLM → 流式返回带引用的回答。
可以在网页上管理文档（上传 / 新建 / 编辑 / 删除）、配置多个 LLM 并随时切换。

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
| 切片 | 按 Markdown 标题分节（Word 标题样式会转成 Markdown 标题）→ 按句子切 → 拼成不超过 N 字、带重叠的块，块前加小节标题 |
| 向量化 | 默认 [fastembed](https://github.com/qdrant/fastembed) 本地运行 `BAAI/bge-small-zh-v1.5`，免费、不需要 Key |
| 向量库 | [Chroma](https://www.trychroma.com/)，本地持久化，余弦相似度；每篇文档的切片带 `doc_id`，支持只在指定文档里检索 |
| LLM | **Claude**（Anthropic 官方 SDK）和 **OpenAI 兼容接口**（OpenAI、DeepSeek、通义千问、Kimi、智谱、本地 Ollama…），网页上添加多个、设默认、测试连接，问答时下拉切换 |
| 问答 | SSE 流式输出；先返回检索到的片段（含相似度），回答里用 [1][2] 标注来源；支持多轮对话、可随时停止 |
| 检索算法 | 向量检索（余弦 / 点积 / 欧氏距离）、BM25 关键词、混合检索（RRF 排名融合或分数加权）、交叉编码器重排序、MMR 多样性、Top K、余弦相似度阈值，可任意组合 |
| 检索调试 | 同一个问题用最多 4 种策略并排对比：每个片段显示余弦、点积、欧氏距离、BM25、混合、重排序、MMR 各项分数，以及它在其他策略里的排名；满意的策略一键设为问答默认 |
| 参数 | 切片长度、重叠、问答默认检索策略、带几轮历史；改完切片参数可一键重建索引 |

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
- 添加一个 Claude Opus 5.5 的模型配置。到“模型与设置”里填 API Key，或者启动前设置环境变量 `ANTHROPIC_API_KEY`。

可以试着问：“出差住在上海每晚最多能报销多少？”“年假没休完能留到什么时候？”“公司的股票代码是多少？”（文档里没有，模型应该回答没找到）。

## 添加其他模型

“模型与设置” → “添加模型” → 选预设，填 API Key 即可。预设的模型名只是示例，可以改成厂商当前提供的任何模型。

| 预设 | 接口类型 | Base URL |
|---|---|---|
| Claude | Anthropic | 留空（官方） |
| OpenAI | OpenAI 兼容 | `https://api.openai.com/v1` |
| DeepSeek | OpenAI 兼容 | `https://api.deepseek.com` |
| 通义千问 | OpenAI 兼容 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Kimi | OpenAI 兼容 | `https://api.moonshot.cn/v1` |
| 智谱 GLM | OpenAI 兼容 | `https://open.bigmodel.cn/api/paas/v4` |
| Ollama | OpenAI 兼容 | `http://localhost:11434/v1`（Docker 里运行时改成 `http://host.docker.internal:11434/v1`） |

“高级参数”是 JSON：Claude 支持 `effort`（`low`/`medium`/`high`）和 `max_tokens`；OpenAI 兼容接口支持 `temperature`。

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

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `RAG_DATA_DIR` | `backend/data` | SQLite、Chroma、模型缓存的目录 |
| `RAG_EMBEDDER` | `fastembed` | 设成 `hash` 用离线的字符哈希向量（不下载模型，质量差，只用于测试） |
| `RAG_EMBED_MODEL` | `BAAI/bge-small-zh-v1.5` | 任何 fastembed 支持的模型，英文文档可用 `BAAI/bge-small-en-v1.5` |
| `ANTHROPIC_API_KEY` | | Claude 配置里没填 key 时使用 |
| `RAG_CORS_ORIGINS` | `http://localhost:5173` | 前后端分开部署时允许的前端地址，逗号分隔 |
| `RAG_MAX_UPLOAD_MB` | `20` | 单个上传文件大小上限 |

> 换 embedding 模型后，在“模型与设置”里点“重建索引”。每种模型用独立的 collection，原文在 SQLite 里，所以随时可以重建。

## 目录结构

```
backend/
  app/
    main.py              FastAPI 入口，启动时建表、导入示例文档，托管前端
    config.py            路径和环境变量
    db.py                SQLite（文档原文、模型配置、设置）
    parsers.py           md / txt / pdf / docx → 纯文本
    chunker.py           切片
    embeddings.py        fastembed / hash 向量化
    store.py             Chroma 向量库：写入、删除、按文档过滤检索
    llm/                 LLM 统一接口：anthropic_provider.py、openai_provider.py
    services/            业务逻辑：documents / providers / settings / rag
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
| GET/PUT/DELETE | `/api/documents/{id}` | 查看 / 修改（自动重新切片）/ 删除 |
| GET | `/api/documents/{id}/chunks` | 查看切片 |
| POST | `/api/documents/reindex` | 用当前参数重建全部索引 |
| POST | `/api/search` | 只检索：query, doc_ids, retrieval（检索参数，不填的用默认策略） |
| POST | `/api/search/compare` | 多策略对比：query, doc_ids, strategies（最多 6 个） |
| POST | `/api/chat` | 问答（SSE）：query, provider_id, doc_ids, history, retrieval；事件依次为 sources、delta…、done 或 error |
| GET/POST/PUT/DELETE | `/api/providers[/{id}]` | 模型配置；`POST /{id}/default` 设默认，`POST /{id}/test` 测试连接 |
| GET/PUT | `/api/settings` | 检索与切片参数 |

启动后访问 http://localhost:8000/docs 可以看到自动生成的接口文档。

## 运行测试

```bash
cd backend && pytest
```

## 后续可以加的

- 多查询改写 / HyDE、small-to-big（命中小切片后返回所在大段落）
- 切片带日期等元数据，按时间过滤
- 多用户登录和每人独立的知识库
- 扫描版 PDF 的 OCR
