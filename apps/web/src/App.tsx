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
  MessageSquare,
  Plus,
  Send,
  Trash2
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
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
  sessionTitle?: string;
  messages: UiMessage[];
  researchEvents: ResearchToolEvent[];
  compactState?: CompactState;
}

interface SessionSummary {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string;
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
  const [input, setInput] = useState("Research long-context memory framework selection");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thinkingStartedAt, setThinkingStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [compactState, setCompactState] = useState<CompactState | undefined>();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const currentTurnEventOffsetRef = useRef(0);

  const latestResearchEvents = useMemo(() => researchEvents.slice().reverse(), [researchEvents]);
  const researchSources = useMemo(() => extractResearchSources(researchEvents), [researchEvents]);

  useEffect(() => {
    void refreshSessions();
  }, []);

  async function refreshSessions() {
    try {
      const response = await fetch("/api/sessions");
      if (!response.ok) throw new Error("Failed to refresh sessions");
      const payload = (await response.json()) as { sessions?: SessionSummary[] };
      setSessions(payload.sessions || []);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to refresh sessions");
    }
  }

  async function loadSession(nextSessionId: string) {
    if (isLoading || loadingSessionId) {
      return;
    }

    setLoadingSessionId(nextSessionId);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(nextSessionId)}`);
      if (!response.ok) {
        throw new Error("The session does not exist or has been deleted.");
      }

      const payload = (await response.json()) as ChatResponse;
      setSessionId(payload.sessionId);
      setMessages(payload.messages);
      setResearchEvents(payload.researchEvents);
      setCurrentTurnEvents([]);
      currentTurnEventOffsetRef.current = payload.researchEvents.length;
      setCompactState(payload.compactState);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to load the session");
      await refreshSessions();
    } finally {
      setLoadingSessionId(null);
    }
  }

  async function deleteSession(targetSessionId: string, event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (isLoading) {
      return;
    }

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(targetSessionId)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Failed to delete the session");
      setSessions((current) => current.filter((session) => session.sessionId !== targetSessionId));
      if (sessionId === targetSessionId) startNewSession();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to delete the session");
    }
  }

  function startNewSession() {
    setSessionId(undefined);
    setMessages([]);
    setResearchEvents([]);
    setCurrentTurnEvents([]);
    setCompactState(undefined);
    setError(null);
    currentTurnEventOffsetRef.current = 0;
  }

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

      if (!response.ok) {
        const details = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(details.error || `Request failed with status ${response.status}`);
      }
      if (!response.body) throw new Error("The server did not return a response stream");

      await readStream(response.body, handleStreamEvent);
    } catch (requestError) {
      if (requestError instanceof Error && requestError.name === "AbortError") {
        setError("The request timed out. Check the server and DeepSeek API availability.");
      } else {
        setError(requestError instanceof Error ? requestError.message : "Request failed");
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
      void refreshSessions();
      return;
    }

    if (event.type === "error") {
      throw new Error(event.error);
    }
  }

  return (
    <main className="app-shell">
      <SessionSidebar
        sessions={sessions}
        activeSessionId={sessionId}
        loadingSessionId={loadingSessionId}
        isLoading={isLoading}
        onNewSession={startNewSession}
        onLoadSession={loadSession}
        onDeleteSession={deleteSession}
      />

      <section className="conversation-panel" aria-label="Research assistant conversation">
        <header className="topbar">
          <div>
            <h1>Research Brief Agent</h1>
            <p>Turn a research topic into an English brief for discussion</p>
          </div>
          <div className="status-pill">{sessionId ? "Active session" : "New session"}</div>
        </header>

        <div className="message-list">
          {messages.length === 0 ? (
            <div className="empty-state">
              <FileText size={28} />
              <span>Enter a topic to collect sources, synthesize evidence, and create a brief.</span>
            </div>
          ) : (
            messages.map((message) => (
              <article key={message.id} className={`message ${message.role}`}>
                <div className="message-meta">
                  <time>{formatTime(message.createdAt)}</time>
                  <span>{message.role === "user" ? "You" : "Assistant"}</span>
                </div>
                <MessageContent message={message} />
              </article>
            ))
          )}

          {isLoading ? (
            <article className="thinking-message" aria-live="polite">
              <Loader2 className="spin" size={16} />
              <span>Thinking... ({elapsedSeconds}s)</span>
            </article>
          ) : null}

          {isLoading && currentTurnEvents.length > 0 ? <InlineProgress events={currentTurnEvents.slice(-3)} /> : null}
        </div>

        {error ? <div className="error-banner">{error}</div> : null}

        <form className="composer" onSubmit={handleSubmit}>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="For example: Research RAG evaluation methods for a discussion with my team lead."
            disabled={isLoading}
          />
          <button type="submit" disabled={isLoading || !input.trim()} aria-label="Send message">
            {isLoading ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
          </button>
        </form>
      </section>

      <aside className="process-panel" aria-label="Research progress">
        <div className="process-panel-header">
          <Brain size={20} />
          <h2>Research progress</h2>
        </div>

        <ResearchProgress events={currentTurnEvents} isLoading={isLoading} hasSessionHistory={researchEvents.length > 0} />

        <div className="process-panel-subheader">
          <Gauge size={18} />
          <h2>Context window</h2>
        </div>

        <ContextWindowStats compactState={compactState} />

        <div className="process-panel-subheader">
          <BookOpen size={18} />
          <h2>Research sources</h2>
        </div>

        <ResearchSources sources={researchSources} events={researchEvents} isLoading={isLoading} />

        <div className="process-panel-subheader">
          <FileText size={18} />
          <h2>Recent steps</h2>
        </div>

        <div className="process-events">
          {latestResearchEvents.length === 0 ? (
            <p className="muted">Research has not started yet.</p>
          ) : (
            latestResearchEvents.map((event) => (
              <article className="process-event" key={event.id}>
                <div className="process-row">
                  <strong>{event.stepLabel}</strong>
                  <span className={`process-status ${event.status}`}>{event.status === "completed" ? "Completed" : "Incomplete"}</span>
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

function SessionSidebar({
  sessions,
  activeSessionId,
  loadingSessionId,
  isLoading,
  onNewSession,
  onLoadSession,
  onDeleteSession
}: {
  sessions: SessionSummary[];
  activeSessionId: string | undefined;
  loadingSessionId: string | null;
  isLoading: boolean;
  onNewSession: () => void;
  onLoadSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <aside className="session-sidebar" aria-label="Session history">
      <div className="session-sidebar-header">
        <h2>Sessions</h2>
        <button type="button" onClick={onNewSession} disabled={isLoading} aria-label="Create session">
          <Plus size={16} />
        </button>
      </div>

      <div className="session-list">
        {sessions.length === 0 ? (
          <p className="muted session-empty">No sessions yet</p>
        ) : (
          sessions.map((session) => (
            <div className={`session-item ${session.sessionId === activeSessionId ? "active" : ""}`} key={session.sessionId}>
              <button
                type="button"
                className="session-open"
                onClick={() => onLoadSession(session.sessionId)}
                disabled={isLoading || loadingSessionId === session.sessionId}
              >
                <MessageSquare size={15} />
                <span>
                  <strong>{session.title}</strong>
                  <small>{formatSessionTime(session.updatedAt)}</small>
                </span>
              </button>
              <button
                type="button"
                className="session-delete"
                onClick={(event) => onDeleteSession(session.sessionId, event)}
                disabled={isLoading}
                aria-label="Delete session"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))
        )}
      </div>
    </aside>
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
    <section className="context-section" aria-label="Context window statistics">
      <div className="context-budget">
        <div className="context-budget-row">
          <span>Usage</span>
          <strong>
            {formatNumber(estimatedTokens)} / {formatNumber(windowTokens)}
          </strong>
        </div>
        <div className="context-bar" aria-label="Context window usage">
          <span style={{ width: `${Math.round(windowRatio * 100)}%` }} />
        </div>
        <div className="context-pill-row">
          <span>{Math.round(windowRatio * 100)}%</span>
          <span>Threshold {Math.round(triggerRatio * 100)}%</span>
          <span>Compacted {compactState?.compactedMessageCount || 0}</span>
          <span>Outputs {persistedCount}</span>
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
    <div className="inline-progress" aria-label="Current research steps">
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
    <section className="progress-section" aria-label="Research workflow">
      <div className="plan-summary-row">
        <span>Current tasks</span>
        <span className={`plan-state ${planState}`}>{planStateLabel(planState)}</span>
      </div>
      <p className="turn-plan-note">
        {isLoading
          ? "Updating the current turn."
          : events.length > 0
            ? "Showing the steps from the latest turn."
            : hasSessionHistory
              ? "Send another question to see the steps for the next turn."
              : "Send a question to generate a task list."}
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
    <section className="source-section" aria-label="Research sources">
      {sources.length === 0 ? (
        <p className="muted">
          {failedCollection
            ? `Source collection failed: ${failedCollection.error || "No error details were returned."}`
            : isLoading
              ? "Waiting for collected sources."
              : "No sources to display yet."}
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
                <span>{source.sourceType === "papers" ? "Paper" : "Web"}</span>
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
        label: isLoading ? "Plan this turn" : "Waiting for a new question",
        detail: isLoading ? "Deciding whether to collect sources, synthesize evidence, or write a brief." : "Send a question to see the current steps.",
        status: isLoading ? "in-progress" : "pending"
      }
    ];
  }

  const items: TaskPlanItem[] = events.map((event, index) => ({
    id: event.id,
    label: `Step ${index + 1}: ${event.stepLabel}`,
    detail: summarizeEventForUi(event),
    status: event.status === "completed" ? "completed" : "failed"
  }));

  const lastEvent = events.at(-1);
  if (isLoading && lastEvent?.status !== "failed") {
    items.push({
      id: "next-decision",
      label: "Determine the next step",
      detail: "Checking whether the evidence is sufficient or further synthesis is needed.",
      status: "in-progress"
    });
  }

  if (!isLoading && lastEvent?.status === "completed") {
    items.push({
      id: "plan-completed",
      label: "Tasks completed",
      detail: "This turn is complete. The final answer is available in the conversation.",
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
    return "Completed";
  }

  if (state === "failed") {
    return "Failed";
  }

  if (state === "running") {
    return "In progress";
  }

  return "Not started";
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
        <small>{reasoning.steps.length} steps</small>
      </summary>
      <div className="reasoning-content">
        <ul>
          {reasoning.steps.map((step) => (
            <li key={step.index}>
              <div>
                Step {step.index}: {step.label}
              </div>
              <div>Result: {step.result}</div>
            </li>
          ))}
        </ul>
        <p>Summary: {reasoning.summary}</p>
      </div>
    </details>
  );
}

function summarizeEventForUi(event: ResearchToolEvent) {
  if (event.status === "failed") {
    return event.error || "The step did not complete.";
  }

  const parsed = safeParseJson(event.output);
  if (typeof parsed?.sourceCount === "number") {
    return `Collected ${parsed.sourceCount} candidate sources.`;
  }

  if (Array.isArray(parsed?.keyFindings)) {
    if (parsed?.coverage && typeof parsed.coverage.coverageScore === "number") {
      const missing = Array.isArray(parsed.coverage.missingAspects) ? parsed.coverage.missingAspects : [];
      return `Identified ${parsed.keyFindings.length} key findings, coverage ${Math.round(parsed.coverage.coverageScore * 100)}%${
        missing.length > 0 ? `, missing: ${missing.join(", ")}` : "."
      }`;
    }

    return `Identified ${parsed.keyFindings.length} key findings.`;
  }

  if (parsed?.sources) {
    return `Collected ${parsed.sources.length} candidate sources.`;
  }

  if (parsed?.synthesis) {
    return `Identified ${parsed.synthesis.keyFindings?.length ?? 0} key findings.`;
  }

  if (parsed?.brief) {
    return `Created "${parsed.brief.title ?? "Research brief"}".`;
  }

  return "Step completed.";
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
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function formatSessionTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0
  }).format(value);
}
