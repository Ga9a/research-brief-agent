import {
  BookOpen,
  Brain,
  CheckCircle2,
  ChevronDown,
  Circle,
  ExternalLink,
  FileText,
  Gauge,
  Loader2,
  Send
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const REQUEST_TIMEOUT_MS = 240000;
type UiRole = "user" | "assistant";

interface ReasoningStep {
  index: number;
  label: string;
  status: "completed" | "failed";
  result: string;
  startedAt: string;
  finishedAt: string;
}

interface ReasoningSummary {
  title: string;
  summary: string;
  steps: ReasoningStep[];
}

interface UiMessage {
  id: string;
  role: UiRole;
  content: string;
  createdAt: string;
  reasoning?: ReasoningSummary;
}

interface ResearchToolEvent {
  id: string;
  toolName: string;
  stepLabel: string;
  args: unknown;
  status: "completed" | "failed";
  output?: string;
  error?: string;
  startedAt: string;
  finishedAt: string;
}

interface ResearchSourcePreview {
  title: string;
  url: string;
  publisher: string;
  sourceType: "web" | "papers";
}

interface PersistedOutputReference {
  kind: "persisted-output";
  id: string;
  toolName: string;
  path: string;
  relativePath: string;
  bytes: number;
  preview: string;
  reason: "size-threshold" | "micro-compact";
  createdAt: string;
}

interface CompactState {
  hasCompacted: boolean;
  lastSummary: string | null;
  recentFiles: string[];
  persistedOutputs: PersistedOutputReference[];
  estimatedTokens: number;
  contextWindowTokens: number;
  summaryTriggerTokens: number;
  compactedMessageCount: number;
  lastCompactedAt?: string;
}

interface ChatResponse {
  sessionId: string;
  messages: UiMessage[];
  researchEvents: ResearchToolEvent[];
  compactState?: CompactState;
}

type AgentStreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "research_event"; researchEvent: ResearchToolEvent }
  | { type: "final"; response: ChatResponse }
  | { type: "error"; error: string };

export function App() {
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [researchEvents, setResearchEvents] = useState<ResearchToolEvent[]>([]);
  const [currentTurnEvents, setCurrentTurnEvents] = useState<ResearchToolEvent[]>([]);
  const [input, setInput] = useState("帮我研究 长上下文记忆框架选型");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thinkingStartedAt, setThinkingStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [compactState, setCompactState] = useState<CompactState | undefined>();
  const currentTurnEventOffsetRef = useRef(0);

  const latestResearchEvents = useMemo(() => researchEvents.slice().reverse(), [researchEvents]);
  const researchSources = useMemo(() => extractResearchSources(researchEvents), [researchEvents]);

  useEffect(() => {
    if (!thinkingStartedAt) {
      setElapsedSeconds(0);
      return undefined;
    }

    const updateElapsed = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - thinkingStartedAt) / 1000)));
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [thinkingStartedAt]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = input.trim();
    if (!message || isLoading) {
      return;
    }

    const localUserMessage: UiMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      content: message,
      createdAt: new Date().toISOString()
    };

    setInput("");
    setError(null);
    setIsLoading(true);
    setThinkingStartedAt(Date.now());
    currentTurnEventOffsetRef.current = researchEvents.length;
    setCurrentTurnEvents([]);
    setMessages((current) => [...current, localUserMessage]);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch("/api/chat/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ message, sessionId }),
        signal: controller.signal
      });

      if (!response.ok || !response.body) {
        throw new Error(`请求失败，状态码：${response.status}`);
      }

      await readStream(response.body, handleStreamEvent);
    } catch (requestError) {
      if (requestError instanceof Error && requestError.name === "AbortError") {
        setError("请求超时，请检查后端服务或 DeepSeek API 响应时间。");
      } else {
        setError(requestError instanceof Error ? requestError.message : "请求失败");
      }
    } finally {
      window.clearTimeout(timeout);
      setIsLoading(false);
      setThinkingStartedAt(null);
    }
  }

  function handleStreamEvent(event: AgentStreamEvent) {
    if (event.type === "session") {
      setSessionId(event.sessionId);
      return;
    }

    if (event.type === "research_event") {
      setResearchEvents((current) => [...current, event.researchEvent]);
      setCurrentTurnEvents((current) => [...current, event.researchEvent]);
      return;
    }

    if (event.type === "final") {
      setSessionId(event.response.sessionId);
      setMessages(event.response.messages);
      setResearchEvents(event.response.researchEvents);
      setCurrentTurnEvents(event.response.researchEvents.slice(currentTurnEventOffsetRef.current));
      setCompactState(event.response.compactState);
      return;
    }

    if (event.type === "error") {
      throw new Error(event.error);
    }
  }

  return (
    <main className="app-shell">
      <section className="conversation-panel" aria-label="调研助手对话">
        <header className="topbar">
          <div>
            <h1>Research Brief Agent</h1>
            <p>把研究主题整理成可讨论的中文调研简报</p>
          </div>
          <div className="status-pill">{sessionId ? "会话进行中" : "新会话"}</div>
        </header>

        <div className="message-list">
          {messages.length === 0 ? (
            <div className="empty-state">
              <FileText size={28} />
              <span>输入一个研究主题，助手会收集资料、整理观点并生成简报。</span>
            </div>
          ) : (
            messages.map((message) => (
              <article key={message.id} className={`message ${message.role}`}>
                <div className="message-meta">
                  <time>{formatTime(message.createdAt)}</time>
                  <span>{message.role === "user" ? "你" : "助手"}</span>
                </div>
                <MessageContent message={message} />
              </article>
            ))
          )}

          {isLoading ? (
            <article className="thinking-message" aria-live="polite">
              <Loader2 className="spin" size={16} />
              <span>正在思考...（{elapsedSeconds}秒）</span>
            </article>
          ) : null}

          {isLoading && currentTurnEvents.length > 0 ? <InlineProgress events={currentTurnEvents.slice(-3)} /> : null}
        </div>

        {error ? <div className="error-banner">{error}</div> : null}

        <form className="composer" onSubmit={handleSubmit}>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="例如：帮我研究 RAG 评估方法，整理成我能和组长讨论的版本。"
            disabled={isLoading}
          />
          <button type="submit" disabled={isLoading || !input.trim()} aria-label="发送消息">
            {isLoading ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
          </button>
        </form>
      </section>

      <aside className="process-panel" aria-label="调研进度">
        <div className="process-panel-header">
          <Brain size={20} />
          <h2>调研进度</h2>
        </div>

        <ResearchProgress events={currentTurnEvents} isLoading={isLoading} hasSessionHistory={researchEvents.length > 0} />

        <div className="process-panel-subheader">
          <Gauge size={18} />
          <h2>上下文窗口</h2>
        </div>

        <ContextWindowStats compactState={compactState} />

        <div className="process-panel-subheader">
          <BookOpen size={18} />
          <h2>调研资料</h2>
        </div>

        <ResearchSources sources={researchSources} events={researchEvents} isLoading={isLoading} />

        <div className="process-panel-subheader">
          <FileText size={18} />
          <h2>最近步骤</h2>
        </div>

        <div className="process-events">
          {latestResearchEvents.length === 0 ? (
            <p className="muted">还没有开始调研。</p>
          ) : (
            latestResearchEvents.map((event) => (
              <article className="process-event" key={event.id}>
                <div className="process-row">
                  <strong>{event.stepLabel}</strong>
                  <span className={`process-status ${event.status}`}>{event.status === "completed" ? "已完成" : "未完成"}</span>
                </div>
                <div className="event-time">
                  {formatTime(event.startedAt)} - {formatTime(event.finishedAt)}
                </div>
                <p>{summarizeEventForUi(event)}</p>
              </article>
            ))
          )}
        </div>
      </aside>
    </main>
  );
}

function ContextWindowStats({ compactState }: { compactState: CompactState | undefined }) {
  const windowTokens = compactState?.contextWindowTokens || 64000;
  const triggerTokens = compactState?.summaryTriggerTokens || Math.floor(windowTokens * 0.75);
  const estimatedTokens = compactState?.estimatedTokens || 0;
  const windowRatio = Math.min(1, estimatedTokens / windowTokens);
  const triggerRatio = Math.min(1, estimatedTokens / triggerTokens);
  const persistedCount = compactState?.persistedOutputs.length || 0;

  return (
    <section className="context-section" aria-label="上下文窗口统计">
      <div className="context-budget">
        <div className="context-budget-row">
          <span>使用量</span>
          <strong>
            {formatNumber(estimatedTokens)} / {formatNumber(windowTokens)}
          </strong>
        </div>
        <div className="context-bar" aria-label="上下文窗口占用">
          <span style={{ width: `${Math.round(windowRatio * 100)}%` }} />
        </div>
        <div className="context-pill-row">
          <span>{Math.round(windowRatio * 100)}%</span>
          <span>触发 {Math.round(triggerRatio * 100)}%</span>
          <span>压缩 {compactState?.compactedMessageCount || 0}</span>
          <span>输出 {persistedCount}</span>
        </div>
      </div>
    </section>
  );
}

async function readStream(body: ReadableStream<Uint8Array>, onEvent: (event: AgentStreamEvent) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      onEvent(JSON.parse(line) as AgentStreamEvent);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    onEvent(JSON.parse(buffer) as AgentStreamEvent);
  }
}

function MessageContent({ message }: { message: UiMessage }) {
  if (message.role === "user") {
    return <p className="plain-message">{message.content}</p>;
  }

  return (
    <>
      <div className="markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
      </div>
      {message.reasoning ? <ReasoningPanel reasoning={message.reasoning} /> : null}
    </>
  );
}

function InlineProgress({ events }: { events: ResearchToolEvent[] }) {
  return (
    <div className="inline-progress" aria-label="当前调研步骤">
      {events.map((event) => (
        <span key={event.id} className={`inline-step ${event.status}`}>
          {event.status === "completed" ? <CheckCircle2 size={14} /> : <Circle size={14} />}
          {event.stepLabel}
        </span>
      ))}
    </div>
  );
}

function ResearchProgress({
  events,
  isLoading,
  hasSessionHistory
}: {
  events: ResearchToolEvent[];
  isLoading: boolean;
  hasSessionHistory: boolean;
}) {
  const planItems = buildTaskPlanItems(events, isLoading);
  const planState = getPlanState(events, isLoading);

  return (
    <section className="progress-section" aria-label="调研流程">
      <div className="plan-summary-row">
        <span>本轮 Todo</span>
        <span className={`plan-state ${planState}`}>{planStateLabel(planState)}</span>
      </div>
      <p className="turn-plan-note">
        {isLoading
          ? "当前轮次正在刷新。"
          : events.length > 0
            ? "这里只显示最近一轮对话的任务步骤。"
            : hasSessionHistory
              ? "新一轮问题发送后会刷新这里，不沿用上一轮步骤。"
              : "发送问题后会生成当前轮次的 todo list。"}
      </p>
      <ol className="research-step-list">
        {planItems.map((item) => {
          const status = item.status;
          return (
            <li key={item.id} className={`research-step ${status}`}>
              <StepIcon status={status} />
              <div>
                <div className="step-content">{item.label}</div>
                <div className="step-status-text">{item.detail}</div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function ResearchSources({
  sources,
  events,
  isLoading
}: {
  sources: ResearchSourcePreview[];
  events: ResearchToolEvent[];
  isLoading: boolean;
}) {
  const failedCollection = [...events].reverse().find((event) => event.toolName === "collect_sources" && event.status === "failed");

  return (
    <section className="source-section" aria-label="调研资料">
      {sources.length === 0 ? (
        <p className="muted">
          {failedCollection
            ? `资料收集失败：${failedCollection.error || "未返回明确错误。"}`
            : isLoading
              ? "正在等待资料收集结果。"
              : "还没有可展示的资料来源。"}
        </p>
      ) : (
        <div className="source-list">
          {sources.slice(0, 8).map((source) => (
            <a className="source-card" key={source.url} href={source.url} target="_blank" rel="noreferrer">
              <div className="source-card-title">
                <span>{source.title}</span>
                <ExternalLink size={13} />
              </div>
              <div className="source-meta">
                <span>{source.publisher}</span>
                <span>{source.sourceType === "papers" ? "论文" : "网页"}</span>
              </div>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

type PlanStepStatus = "completed" | "failed" | "in-progress" | "pending";
type PlanState = "completed" | "failed" | "running" | "pending";

interface TaskPlanItem {
  id: string;
  label: string;
  detail: string;
  status: PlanStepStatus;
}

function buildTaskPlanItems(events: ResearchToolEvent[], isLoading: boolean): TaskPlanItem[] {
  if (events.length === 0) {
    return [
      {
        id: "planning",
        label: isLoading ? "规划本轮 todo" : "等待新一轮输入",
        detail: isLoading ? "正在为当前问题判断需要收集、整理还是生成简报。" : "发送问题后会显示当前轮次的任务步骤。",
        status: isLoading ? "in-progress" : "pending"
      }
    ];
  }

  const items: TaskPlanItem[] = events.map((event, index) => ({
    id: event.id,
    label: `第 ${index + 1} 步：${event.stepLabel}`,
    detail: summarizeEventForUi(event),
    status: event.status === "completed" ? "completed" : "failed"
  }));

  const lastEvent = events.at(-1);
  if (isLoading && lastEvent?.status !== "failed") {
    items.push({
      id: "next-decision",
      label: "判断本轮下一步",
      detail: "正在判断当前轮次资料是否足够，或是否需要继续整理、生成简报。",
      status: "in-progress"
    });
  }

  if (!isLoading && lastEvent?.status === "completed") {
    items.push({
      id: "plan-completed",
      label: "本轮 todo 完成",
      detail: "当前轮次流程已经结束，最终回答已同步到聊天区。",
      status: "completed"
    });
  }

  return items;
}

function getPlanState(events: ResearchToolEvent[], isLoading: boolean): PlanState {
  if (events.some((event) => event.status === "failed")) {
    return "failed";
  }

  if (isLoading) {
    return "running";
  }

  return events.length > 0 ? "completed" : "pending";
}

function planStateLabel(state: PlanState) {
  if (state === "completed") {
    return "已完成";
  }

  if (state === "failed") {
    return "有失败";
  }

  if (state === "running") {
    return "进行中";
  }

  return "未开始";
}

function StepIcon({ status }: { status: PlanStepStatus }) {
  if (status === "completed") {
    return <CheckCircle2 className="step-icon completed" size={17} />;
  }

  if (status === "in-progress") {
    return <Loader2 className="step-icon in-progress spin" size={17} />;
  }

  if (status === "failed") {
    return <Circle className="step-icon failed" size={17} />;
  }

  return <Circle className="step-icon pending" size={17} />;
}

function ReasoningPanel({ reasoning }: { reasoning: ReasoningSummary }) {
  return (
    <details className="reasoning-panel">
      <summary>
        <span>
          <ChevronDown size={14} />
          {reasoning.title}
        </span>
        <small>{reasoning.steps.length} 个步骤</small>
      </summary>
      <div className="reasoning-content">
        <ul>
          {reasoning.steps.map((step) => (
            <li key={step.index}>
              <div>
                第 {step.index} 步：{step.label}
              </div>
              <div>结果：{step.result}</div>
            </li>
          ))}
        </ul>
        <p>总结：{reasoning.summary}</p>
      </div>
    </details>
  );
}

function summarizeEventForUi(event: ResearchToolEvent) {
  if (event.status === "failed") {
    return event.error || "步骤未完成。";
  }

  const parsed = safeParseJson(event.output);
  if (typeof parsed?.sourceCount === "number") {
    return `整理出 ${parsed.sourceCount} 条候选资料。`;
  }

  if (Array.isArray(parsed?.keyFindings)) {
    if (parsed?.coverage && typeof parsed.coverage.coverageScore === "number") {
      const missing = Array.isArray(parsed.coverage.missingAspects) ? parsed.coverage.missingAspects : [];
      return `形成 ${parsed.keyFindings.length} 条关键发现，覆盖率 ${Math.round(parsed.coverage.coverageScore * 100)}%${
        missing.length > 0 ? `，仍缺：${missing.join("、")}` : "。"
      }`;
    }

    return `形成 ${parsed.keyFindings.length} 条关键发现。`;
  }

  if (parsed?.sources) {
    return `整理出 ${parsed.sources.length} 条候选资料。`;
  }

  if (parsed?.synthesis) {
    return `形成 ${parsed.synthesis.keyFindings?.length ?? 0} 条关键发现。`;
  }

  if (parsed?.brief) {
    return `已生成《${parsed.brief.title ?? "调研简报"}》。`;
  }

  return "步骤已完成。";
}

function extractResearchSources(events: ResearchToolEvent[]): ResearchSourcePreview[] {
  const byUrl = new Map<string, ResearchSourcePreview>();

  for (const event of events) {
    if (event.toolName !== "collect_sources" || event.status !== "completed") {
      continue;
    }

    const parsed = safeParseJson(event.output);
    const sources = Array.isArray(parsed?.topSources)
      ? parsed.topSources
      : Array.isArray(parsed?.sources)
        ? parsed.sources
        : [];

    for (const source of sources) {
      if (!isResearchSourcePreview(source)) {
        continue;
      }
      byUrl.set(source.url, source);
    }
  }

  return [...byUrl.values()];
}

function isResearchSourcePreview(value: unknown): value is ResearchSourcePreview {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.title === "string" &&
    typeof candidate.url === "string" &&
    typeof candidate.publisher === "string" &&
    (candidate.sourceType === "web" || candidate.sourceType === "papers")
  );
}

function safeParseJson(value: string | undefined): any {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function formatNumber(value: number) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 0
  }).format(value);
}
