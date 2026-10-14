# Research Brief Agent

A TypeScript research assistant that collects real web or paper sources, organizes evidence, and produces English Markdown briefs. The React interface shows conversations, source cards, progress, and saved sessions. The Express server coordinates a parent agent and restricted child tools through DeepSeek function calling.

## Quick start

Requires Node.js 20.19+ or 22.12+. Install from the repository root:

```sh
npm ci
cp apps/server/.env.example apps/server/.env
```

On PowerShell, use `Copy-Item apps/server/.env.example apps/server/.env`. Set `DEEPSEEK_API_KEY` in the copied file, then run:

```sh
npm run dev
```

Open http://localhost:5173. The API runs at http://127.0.0.1:3001; `GET /api/health` checks its availability without a model call. Separate processes are available through `npm run dev:server` and `npm run dev:web`.

Example: **Research long-context memory framework selection for a team discussion.**

## Source providers and configuration

| Setting | Purpose |
| --- | --- |
| `DEEPSEEK_API_KEY` | Required for model-driven research |
| `DEEPSEEK_MODEL` | Model name; defaults to `deepseek-chat` |
| `DEEPSEEK_TIMEOUT_MS` | Per-model request timeout; default 20,000 ms |
| `PAPER_PROVIDER` | `arxiv` by default; no API key required, or `semantic_scholar` |
| `SEMANTIC_SCHOLAR_API_KEY` | Optional key for Semantic Scholar |
| `SEARCH_PROVIDER` | `tavily`, `serpapi`, or `bing` |
| `SEARCH_API_KEY` | Required when requesting web sources |
| `SOURCE_API_TIMEOUT_MS` | Per-source request timeout; default 20,000 ms |
| `HOST` / `PORT` | API bind address and port; defaults to `127.0.0.1:3001` |
| `WEB_ORIGIN` | Allowed frontend origin; default `http://localhost:5173` |

Paper-only collection is the default when a web search key is absent. Explicit requests for web sources without a key return a clear error. Source errors do not produce simulated references. Availability of individual provider APIs depends on the provider account and endpoint configuration.

## Workflow

1. Plan the research question, decision context, criteria, and evidence requirements.
2. `task` dispatches `collect_sources`, whose child uses `source_collector`.
3. `synthesize_evidence` organizes source terms and produces a structured screening guide.
4. Coverage feedback can trigger targeted additional collection.
5. `write_brief` renders the findings, comparisons, limitations, next steps, and collected source links.

Skills are loaded on demand through `load_skill`. Children receive only their required capability. Existing sources and synthesis are injected by the server, reducing duplicated tool arguments. Tool limits and argument deduplication bound repeated calls.

The synthesis and coverage logic are heuristic and use titles and abstracts. General screening guidance is labeled as guidance. A keyword match does not establish factual support or benchmark performance; verify full sources before using the brief for a decision.

## API

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/health` | Health status |
| GET | `/api/sessions` | Saved session summaries |
| GET | `/api/sessions/:sessionId` | Session or 404 |
| DELETE | `/api/sessions/:sessionId` | Delete a saved session |
| POST | `/api/chat` | Complete JSON research response |
| POST | `/api/chat/stream` | NDJSON session, progress, final, or error events |

Chat requests accept `{ "message": "Research RAG evaluation", "sessionId": "optional-existing-id" }`. Messages are trimmed and limited to 20,000 characters. Invalid requests return JSON with HTTP 400 before streaming starts; oversized bodies return 413. Execution errors return 500 on the JSON endpoint, or an error event after streaming begins.

## Persistence and context management

Sessions are stored under `apps/server/.agent-data/` by default. `SESSION_STORE_PATH` overrides the session store. Oversized tool outputs are persisted with a preview and reference. `CONTEXT_OUTPUT_DIR` overrides their directory.

- `TOOL_OUTPUT_INLINE_CHAR_LIMIT`: default 8,000 characters.
- `TOOL_OUTPUT_PREVIEW_CHARS`: default 1,200 characters.
- `MICRO_COMPACT_RECENT_TOOL_RESULTS`: default 3 recent results.
- `CONTEXT_WINDOW_TOKENS`: default 64,000 estimated tokens.
- `CONTEXT_SUMMARY_TRIGGER_RATIO`: default 0.75.
- `SUMMARY_COMPACT_KEEP_RECENT_MESSAGES`: default 8 messages.

Send `/compact` to create a continuity summary manually. Persisted outputs remain recoverable after compaction. Keep keys and generated session data out of Git.

## Verification and production build

```sh
npm test
npm run build
```

Tests use mocked providers and a temporary session store; API tests exercise actual local HTTP responses. They do not require paid model calls. Build scripts use Vite's runner config loader to avoid bundling configuration before execution.

After building, start the API with `npm --workspace @research-brief-agent/server start`. The frontend build is under `apps/web/dist`; host it separately and proxy `/api` to the server. Set `WEB_ORIGIN` for that frontend. Vite preview is available for local build inspection.

## Project structure

- `apps/server/src/agent/`: parent/child loops, tools, hooks, persistence, and context budgets.
- `apps/server/src/tools/`: source providers, synthesis, writing, schemas, and registry.
- `apps/server/src/skills/` and `apps/server/skills/`: planning, extraction, and coverage workflows.
- `apps/server/src/app.ts`: testable Express application.
- `apps/server/src/test/`: workflow and API regressions.
- `apps/web/src/`: React conversation interface and styles.

The API is a local prototype with no user authentication or tenant separation. Add those controls before sharing the service. Tools collect configured public HTTP sources and do not execute system commands. The repository currently has no explicit license grant.
