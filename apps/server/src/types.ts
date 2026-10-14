export type UiRole = "user" | "assistant";

export type ResearchSourceType = "web" | "papers";

export interface ResearchSource {
  id: string;
  title: string;
  url: string;
  sourceType: ResearchSourceType;
  publisher: string;
  publishedAt: string | null;
  summary: string;
  relevanceScore: number;
  credibilityScore: number;
}

export type ResearchOutputFormat = "comparison" | "summary" | "pros_cons" | "decision_brief";

export interface ResearchComparison {
  dimension: string;
  notes: string;
}

export interface ResearchSynthesis {
  references?: Array<{ title: string; url: string }>;
  focus: string;
  researchQuestion?: string;
  decisionContext?: string;
  evaluationCriteria?: string[];
  evidenceRequirements?: string[];
  evidenceGaps?: string[];
  outputFormat: ResearchOutputFormat;
  keyFindings: string[];
  comparisons: ResearchComparison[];
  risksOrLimitations: string[];
  recommendation: string;
}

export type ResearchAudience = "self_learning" | "team_lead" | "presentation" | "interview";
export type ResearchBriefLength = "short" | "medium" | "detailed";

export interface ResearchBrief {
  title: string;
  conclusion: string;
  researchQuestion?: string;
  evaluationCriteria?: string[];
  evidenceGaps?: string[];
  keyFindings: string[];
  comparisonAnalysis: string;
  suggestedQuestions: string[];
  nextSteps: string[];
  content: string;
}

export interface ReasoningStep {
  index: number;
  label: string;
  status: "completed" | "failed";
  result: string;
  startedAt: string;
  finishedAt: string;
}

export interface ReasoningSummary {
  title: string;
  summary: string;
  steps: ReasoningStep[];
}

export interface UiMessage {
  id: string;
  role: UiRole;
  content: string;
  createdAt: string;
  reasoning?: ReasoningSummary;
}

export type ResearchToolEventStatus = "completed" | "failed";

export interface ResearchToolEvent {
  id: string;
  toolName: string;
  stepLabel: string;
  args: unknown;
  status: ResearchToolEventStatus;
  output?: string;
  error?: string;
  startedAt: string;
  finishedAt: string;
}

export interface PersistedOutputReference {
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

export interface CompactState {
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

export interface ChatResponse {
  sessionId: string;
  sessionTitle?: string;
  messages: UiMessage[];
  researchEvents: ResearchToolEvent[];
  compactState?: CompactState;
}

export interface ChatSessionSummary {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string;
}

export type AgentStreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "research_event"; researchEvent: ResearchToolEvent }
  | { type: "final"; response: ChatResponse }
  | { type: "error"; error: string };
