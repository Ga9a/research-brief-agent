# Research Brief Agent

这是一个基于 TypeScript 的调研助手实验项目，用来学习实际产品中常见的 LLM tool calling、Agent loop、工具注册表和前后端协作方式。

项目目标是把用户输入的研究主题转化为一份自然、清晰、面向用户的中文调研简报。资料收集工具会通过真实 HTTP API 获取 web 和 papers 来源；默认论文来源使用无需 key 的 arXiv。如果显式请求 web 来源但缺少必要 API key，会明确报错，不返回模拟数据。

## 核心流程

```text
用户问题
  -> 收集资料
  -> 综合证据
  -> 生成简报
```

示例输入：

```text
帮我研究 RAG 评估方法，整理成我能和组长讨论的版本。
```

示例输出会是一份包含简要结论、关键发现、对比分析、局限性、建议提问和下一步学习建议的调研简报。

## 技术栈

- 前端：React、Vite、TypeScript、React Markdown、remark-gfm。
- 后端：Express、TypeScript、Zod。
- 模型接口：DeepSeek Chat Completions function calling。
- 工具组织：父 Agent 通过 `task` 工具派发子 Agent，子 Agent 只拿必要能力工具。
- 测试：Vitest。

## 工具列表

- `task(taskType, instruction, inputRef?)`：父 Agent 使用的任务派发工具，把收集资料、整理证据、生成简报交给独立子 Agent。
- `source_collector(topic, sourceTypes, maxResults, recency)`：子 Agent 使用的资料收集工具；默认 `sourceTypes=["papers"]`，论文来源默认使用无需 key 的 arXiv。
- `evidence_synthesizer(sources, focus, outputFormat)`：把资料整理为关键发现、对比维度、限制和建议。
- `brief_writer(synthesis, audience, length)`：把结构化结果改写成自然语言调研简报。

这些工具只处理文本、结构化数据和 HTTP API 响应，不执行系统命令，也不访问本地敏感文件。

## 前端体验

- 用户消息以正常聊天气泡展示。
- 等待阶段显示“正在思考...（X秒）”。
- 中间步骤弱化展示为“收集资料、整理证据、生成简报”。
- 最终回答合并为一条正式 Markdown 简报，支持标题、表格和列表。

## 后端接口

`POST /api/chat`

请求体：

```json
{
  "message": "帮我研究 RAG 评估方法",
  "sessionId": "可选会话 ID"
}
```

响应体：

```json
{
  "sessionId": "会话 ID",
  "messages": [],
  "researchEvents": []
}
```

`POST /api/chat/stream`

使用 NDJSON 分段返回会话事件、调研步骤事件和最终结果，前端用它逐步更新进度。

## 安全边界

- 当前版本只做文本调研流程演示。
- 不执行系统命令。
- 只允许通过配置好的 HTTP API 收集公开资料。
- 不对真实网络目标执行操作。
- 不包含侵入式能力。
- API key 只通过 `.env` 配置，不写入代码。

## 安装与配置

安装依赖：

```powershell
npm.cmd install
```

复制后端环境变量示例：

```powershell
Copy-Item apps\server\.env.example apps\server\.env
```

编辑 `apps/server/.env`：

```env
DEEPSEEK_API_KEY=your_key_here
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_TIMEOUT_MS=20000
TOOL_OUTPUT_INLINE_CHAR_LIMIT=8000
TOOL_OUTPUT_PREVIEW_CHARS=1200
MICRO_COMPACT_RECENT_TOOL_RESULTS=3
CONTEXT_WINDOW_TOKENS=64000
CONTEXT_SUMMARY_TRIGGER_RATIO=0.75
SUMMARY_COMPACT_KEEP_RECENT_MESSAGES=8
CONTEXT_OUTPUT_DIR=
SOURCE_API_TIMEOUT_MS=20000
PORT=3001
WEB_ORIGIN=http://localhost:5173
SEARCH_PROVIDER=tavily
SEARCH_API_KEY=your_search_key_here
PAPER_PROVIDER=arxiv
SEMANTIC_SCHOLAR_API_KEY=your_semantic_scholar_key_here
```

`SEARCH_PROVIDER` 支持 `tavily`、`serpapi`、`bing`。如果请求包含 `web` 来源，则必须配置 `SEARCH_API_KEY`。`PAPER_PROVIDER` 默认是 `arxiv`，无需 API key；也可以显式设置为 `semantic_scholar`，此时 `SEMANTIC_SCHOLAR_API_KEY` 是可选项，用于提高 Semantic Scholar API 的速率限制。`SOURCE_API_TIMEOUT_MS` 用来限制外部资料 API 的单次请求时长，避免资料接口卡住整个对话。

上下文预算由后端自动管理：超过 `TOOL_OUTPUT_INLINE_CHAR_LIMIT` 的工具输出会写入磁盘，并在模型上下文中保留 `persisted-output` 预览和路径；每轮模型调用前会按 `MICRO_COMPACT_RECENT_TOOL_RESULTS` 保留最近工具结果，旧结果替换为可恢复占位；当估算上下文接近 `CONTEXT_WINDOW_TOKENS * CONTEXT_SUMMARY_TRIGGER_RATIO` 时，会生成结构化连续性摘要。你也可以在对话中发送 `/compact` 手动触发同一套 summary compact 流程。

推荐 Node.js 版本：`20.19.0` 或更高。项目依赖 Vite 7 和 Node 原生 `fetch`，较旧 Node 版本可能无法启动或构建。

## 运行项目

同时启动前后端：

```powershell
npm.cmd run dev
```

在 macOS / Linux 或非 PowerShell 终端中，可以直接使用：

```bash
npm run dev
```

单独启动后端：

```powershell
npm.cmd run dev:server
```

单独启动前端：

```powershell
npm.cmd run dev:web
```

默认地址：

- 前端：<http://localhost:5173>
- 后端：<http://localhost:3001>
- 健康检查：<http://localhost:3001/api/health>

## 测试与构建

运行测试：

```powershell
npm.cmd run test
```

构建前后端：

```powershell
npm.cmd run build
```

## 项目结构

```text
apps/
  server/
    src/
      agent/              DeepSeek 调用和 Agent loop
      tools/              调研能力工具与注册表
      test/               后端测试
      index.ts            Express API 入口
      types.ts            调研领域类型和响应类型
  web/
    src/
      App.tsx             前端对话和调研进度展示
      styles.css          前端样式
```

## 学习重点

- Agent loop 如何维护模型消息、工具调用和最终回答。
- Function calling 工具 schema 如何设计。
- 如何用 Zod 校验工具参数。
- 如何用注册表对象管理多个工具。
- 如何把中间步骤弱化展示，避免让用户看到生硬的工具日志。
- 如何把真实外部 API 响应收敛为稳定的内部类型，方便后续替换或增加资料源。
