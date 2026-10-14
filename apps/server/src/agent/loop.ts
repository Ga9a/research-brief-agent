import { randomUUID } from "node:crypto";
import { createChatCompletion, type DeepSeekMessage } from "./deepseek.js";
import { ArtifactStore } from "./artifactStore.js";
import { ContextBudgetManager, type CompactContext } from "./contextBudget.js";
import { createAgentHookRunner, ensureHookCanContinue, type AgentHookRunner, type AgentRunHooks } from "./hooks.js";
import { loadSkillToolDefinition, runLoadSkill, validateLoadSkillArgs } from "./loadSkillTool.js";
import {
  deletePersistedSession,
  listPersistedSessions,
  loadPersistedSession,
  savePersistedSession,
  type PersistedSessionRecord
} from "./sessionPersistence.js";
import { runTaskTool } from "./taskRunner.js";
import {
  taskStepLabels,
  taskToolDefinition,
  validateTaskArgs,
  type ChildTaskType,
  type TaskToolArgs
} from "./taskTool.js";
import type {
  ChatResponse,
  ChatSessionSummary,
  ReasoningSummary,
  ResearchBrief,
  ResearchSynthesis,
  ResearchToolEvent,
  UiMessage
} from "../types.js";
import { getDefaultSkillLoader } from "./skillLoader.js";
import { buildResearchPlan, renderResearchPlanForModel, type ResearchPlan } from "../skills/researchPlanning.js";
import type { CoverageReport } from "../skills/coverageCheck.js";

const DEFAULT_MAX_TOOL_ROUNDS = 12;
const KNOWN_TASK_TYPES: ChildTaskType[] = ["collect_sources", "synthesize_evidence", "write_brief"];
const TASK_LIMITS: Record<ChildTaskType, number> = {
  collect_sources: 3,
  synthesize_evidence: 4,
  write_brief: 2
};

interface SessionState {
  metadata: SessionMetadata;
  modelMessages: DeepSeekMessage[];
  uiMessages: UiMessage[];
  researchEvents: ResearchToolEvent[];
  artifactStore: ArtifactStore;
  contextBudget: ContextBudgetManager;
  researchMemory: SessionResearchMemory;
}

interface SessionMetadata {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface SessionResearchMemory {
  completedTopics: Array<{
    goal: string;
    researchQuestion: string;
    completedAt: string;
    summary: string;
  }>;
}

const sessions = new Map<string, SessionState>();

const systemPrompt: DeepSeekMessage = {
  role: "system",
  content: buildSystemPrompt()
};

function buildSystemPrompt(): string {
  return [
    "You are the parent agent for Research Brief Agent, an English-language research assistant.",
    "Break down the research workflow, dispatch independent subtasks through task, and produce a clear English research brief.",
    "Use task for research subtasks and load_skill to load a complete SKILL.md workflow when needed.",
    "Read skill names and descriptions first, then load only the workflows needed through load_skill.",
    "",
    "Available skills (descriptions only; use load_skill for full content):",
    getDefaultSkillLoader().getDescriptions(),
    "",
    "Core constraints:",
    "- Stay focused on the current user topic and planned research question. Do not turn memory framework research into RAG evaluation unless the user requests it. RAG may provide background but must not replace the main question.",
    "- Use collect_sources -> synthesize_evidence -> write_brief. Collect additional sources and synthesize again only when coverage feedback identifies missing evidence.",
    "- Do not repeat an identical taskType and instruction. Advance when results are sufficient, and stop after write_brief completes.",
    "- Keep each instruction to one or two sentences about the research question, evidence gaps, and intended use. Do not copy sources, internal logs, or large JSON objects.",
    "- Collect real sources through a task subtask; do not invent sources.",
    "- Assess evidence sufficiency. Collect and synthesize sources, then fill identified gaps and synthesize again. A brief may be revised once if it does not address the user goal.",
    "- Identify the research question, decision context, evaluation criteria, and evidence requirements for each turn. Explain missing requirements in the final brief.",
    "- When coverage feedback is insufficient, collect missing evidence and synthesize again before writing, unless the collection limit has been reached.",
    "- Do not copy sources, synthesis, or large JSON objects. Usually pass only taskType and an optional short instruction.",
    "- Avoid loops: at most three collections, four syntheses, and two briefs per turn. At the limit, answer using the available evidence.",
    "- Use prior turns as conversation history, not evidence for the current topic. Ignore unrelated history and omit internal context contamination or system diagnoses from the answer.",
    "- Write the final answer in English with a conclusion, key findings, comparison, limitations, suggested questions, and next steps. Omit internal function names, parameters, logs, and context diagnoses."
  ].join("\n");
}

export async function runAgentTurn(
  input: { sessionId?: string; message: string },
  hooks: AgentRunHooks = {}
): Promise<ChatResponse> {
  const hookRunner = createAgentHookRunner(hooks);
  const sessionId = input.sessionId || randomUUID();
  const state = getSession(sessionId);
  const userContent = input.message.trim();
  if (!userContent) {
    throw new Error("The message must not be empty.");
  }

  ensureHookCanContinue(await hookRunner.sessionStarted({ sessionId }));

  if (isManualCompactCommand(userContent)) {
    updateSessionTitleFromUserMessage(state, userContent);
    state.uiMessages.push({
      id: randomUUID(),
      role: "user",
      content: userContent,
      createdAt: new Date().toISOString()
    });
    state.modelMessages = state.contextBudget.forceSummaryCompact(state.modelMessages, buildCompactContext(state, getLatestUserGoal(state)));
    appendFinalAssistantMessage(state, "Context compacted. Earlier tool outputs remain available through persisted-output references in the summary.", []);
    return await finalizeResponse(sessionId, state, hookRunner);
  }

  updateSessionTitleFromUserMessage(state, userContent);
  state.uiMessages.push({
    id: randomUUID(),
    role: "user",
    content: userContent,
    createdAt: new Date().toISOString()
  });
  state.modelMessages.push({ role: "user", content: userContent });
  const researchPlan = buildResearchPlan(userContent);
  const turnId = randomUUID();
  state.modelMessages.push({ role: "system", content: renderSessionMemoryForModel(state.researchMemory, researchPlan) });
  state.modelMessages.push({ role: "system", content: renderResearchPlanForModel(researchPlan) });
  state.modelMessages.push({
    role: "system",
    content: `Current turn ID: ${turnId}. Use only this turn sources, evidence, and briefs unless the user explicitly requests earlier results.`
  });

  const turnEvents: ResearchToolEvent[] = [];
  const executedToolCalls = new Set<string>();
  const maxToolRounds = getMaxToolRounds();

  for (let round = 1; round <= maxToolRounds; round += 1) {
    let assistantMessage: DeepSeekMessage;
    try {
      state.modelMessages = state.contextBudget.compactBeforeModelCall(
        state.modelMessages,
        buildCompactContext(state, userContent, turnEvents)
      );
      assistantMessage = await createChatCompletion({
        messages: state.modelMessages,
        tools: [taskToolDefinition, loadSkillToolDefinition]
      });
    } catch (error) {
      const fallback = buildFallbackFinal(turnEvents, `Model call failed or timed out: ${formatError(error)}`);
      if (fallback) {
        appendFinalAssistantMessage(state, fallback, turnEvents, researchPlan);
        return await finalizeResponse(sessionId, state, hookRunner);
      }

      throw error;
    }

    const toolCalls = assistantMessage.tool_calls || [];
    state.modelMessages.push(assistantMessage);

    if (toolCalls.length === 0) {
      appendFinalAssistantMessage(state, normalizeAssistantContent(assistantMessage.content, turnEvents), turnEvents, researchPlan);
      return await finalizeResponse(sessionId, state, hookRunner);
    }

    for (const toolCall of toolCalls) {
      const toolName = toolCall.function.name;
      let parsedArgs: unknown = {};
      let researchEvent: ResearchToolEvent;

      if (toolName === "load_skill") {
        const skillResult = executeLoadSkillCall(toolCall.function.arguments, executedToolCalls);
        state.modelMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: state.contextBudget.prepareToolResultForContext("load_skill", skillResult)
        });
        continue;
      }

      try {
        if (toolName !== "task") {
          throw new Error(`The parent can call only task or load_skill, not ${toolName}.`);
        }

        parsedArgs = parseToolArguments(toolCall.function.arguments);
        const taskArgs = validateTaskArgs(parsedArgs);
        const callKey = createToolCallKey(toolName, taskArgs);
        if (executedToolCalls.has(callKey) && !hasNewDependencyForRepeat(taskArgs.taskType, turnEvents)) {
          state.modelMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: state.contextBudget.prepareToolResultForContext(
              "task",
              JSON.stringify({
                status: "skipped",
                reason: "duplicate_tool_call",
                message: "This step has already run with the same arguments. Use the existing result and advance."
              })
            )
          });
          continue;
        } else {
          const preconditionError = validateTaskPolicy(taskArgs, turnEvents);
          if (preconditionError) {
            researchEvent = createFailedResearchEvent(taskArgs.taskType, taskArgs, preconditionError);
          } else {
            researchEvent = await executeResearchStep(
              taskArgs,
              callKey,
              state.artifactStore,
              state.contextBudget,
              turnId,
              researchPlan,
              getLatestCoverageFeedback(turnEvents),
              executedToolCalls
            );
          }
        }
      } catch (error) {
        researchEvent = createFailedResearchEvent(
          inferTaskType(parsedArgs) || toolName,
          parsedArgs,
          formatToolArgumentError(error),
        );
      }

      ensureHookCanContinue(await hookRunner.researchEventCreated({ researchEvent }));
      turnEvents.push(researchEvent);
      state.researchEvents.push(researchEvent);
      state.modelMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: state.contextBudget.prepareToolResultForContext(
          researchEvent.toolName,
          JSON.stringify({
            status: researchEvent.status,
            output: researchEvent.output,
            error: researchEvent.error
          })
        )
      });

      const coverageFeedbackMessage = buildCoverageFeedbackForModel(researchEvent, turnEvents);
      if (coverageFeedbackMessage) {
        state.modelMessages.push({
          role: "system",
          content: coverageFeedbackMessage
        });
      }

      if (isSourceCollectionBlockingFailure(researchEvent)) {
        appendFinalAssistantMessage(
          state,
          buildSourceCollectionFailureSummary(researchEvent.error || "Source collection failed."),
          turnEvents,
          researchPlan
        );
        return await finalizeResponse(sessionId, state, hookRunner);
      }

      if (researchEvent.toolName === "write_brief" && researchEvent.status === "completed") {
        appendFinalAssistantMessage(
          state,
          getLatestBriefContent(turnEvents) || buildFallbackFinal(turnEvents, "The brief tool completed, but no structured brief was parsed.") || "Research brief generated.",
          turnEvents,
          researchPlan
        );
        return await finalizeResponse(sessionId, state, hookRunner);
      }
    }
  }

  appendFinalAssistantMessage(
    state,
    buildFallbackFinal(turnEvents, `Reached the maximum of ${maxToolRounds} tool rounds; stopped to avoid a loop.`) ||
      "No usable brief was generated. Narrow the topic or specify the focus.",
    turnEvents,
    researchPlan
  );
  return await finalizeResponse(sessionId, state, hookRunner);
}

function getSession(sessionId: string): SessionState {
  const existing = sessions.get(sessionId);
  if (existing) {
    return existing;
  }

  const persisted = loadPersistedSession(sessionId);
  if (persisted) {
    const restored = hydrateSessionState(persisted);
    sessions.set(sessionId, restored);
    return restored;
  }

  const now = new Date().toISOString();
  const created: SessionState = {
    metadata: {
      id: sessionId,
      title: "New session",
      createdAt: now,
      updatedAt: now
    },
    modelMessages: [systemPrompt],
    uiMessages: [],
    researchEvents: [],
    artifactStore: new ArtifactStore(),
    contextBudget: new ContextBudgetManager(sessionId),
    researchMemory: { completedTopics: [] }
  };
  sessions.set(sessionId, created);
  return created;
}

export function listChatSessions(): ChatSessionSummary[] {
  const summaries = new Map<string, ChatSessionSummary>();
  for (const summary of listPersistedSessions()) {
    summaries.set(summary.sessionId, summary);
  }

  for (const state of sessions.values()) {
    summaries.set(state.metadata.id, summarizeSession(state));
  }

  return [...summaries.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function getChatSessionResponse(sessionId: string): ChatResponse | undefined {
  const persisted = loadPersistedSession(sessionId);
  const live = sessions.get(sessionId);
  const state = live || (persisted ? hydrateSessionState(persisted) : undefined);
  if (!state) {
    return undefined;
  }

  sessions.set(sessionId, state);
  return buildResponse(sessionId, state);
}

export function deleteChatSession(sessionId: string): boolean {
  const hadLiveSession = sessions.delete(sessionId);
  const hadPersistedSession = deletePersistedSession(sessionId);
  return hadLiveSession || hadPersistedSession;
}

function hydrateSessionState(record: PersistedSessionRecord): SessionState {
  const contextBudget = new ContextBudgetManager(record.id);
  contextBudget.hydrateState(record.compactState);

  return {
    metadata: {
      id: record.id,
      title: record.title || "New session",
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    },
    modelMessages: record.modelMessages.length > 0 ? record.modelMessages : [systemPrompt],
    uiMessages: record.uiMessages,
    researchEvents: record.researchEvents,
    artifactStore: new ArtifactStore(record.artifacts || []),
    contextBudget,
    researchMemory: record.researchMemory || { completedTopics: [] }
  };
}

function persistSessionState(state: SessionState): void {
  savePersistedSession({
    id: state.metadata.id,
    title: state.metadata.title,
    createdAt: state.metadata.createdAt,
    updatedAt: state.metadata.updatedAt,
    modelMessages: state.modelMessages,
    uiMessages: state.uiMessages,
    researchEvents: state.researchEvents,
    compactState: state.contextBudget.getState(),
    researchMemory: state.researchMemory,
    artifacts: state.artifactStore.listAll()
  });
}

function summarizeSession(state: SessionState): ChatSessionSummary {
  const lastMessage = [...state.uiMessages].reverse().find((message) => message.content.trim());
  return {
    sessionId: state.metadata.id,
    title: state.metadata.title,
    createdAt: state.metadata.createdAt,
    updatedAt: state.metadata.updatedAt,
    messageCount: state.uiMessages.length,
    lastMessagePreview: lastMessage ? truncateText(lastMessage.content.replace(/\s+/g, " ").trim(), 90) : ""
  };
}

function updateSessionTitleFromUserMessage(state: SessionState, content: string): void {
  if (state.uiMessages.some((message) => message.role === "user")) {
    return;
  }

  state.metadata.title = createSessionTitle(content);
  state.metadata.updatedAt = new Date().toISOString();
}

function createSessionTitle(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return truncateText(normalized, 28) || "New session";
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

export function createToolCallKey(toolName: string, args: unknown): string {
  return `${toolName}:${stableStringify(args)}`;
}

function executeLoadSkillCall(rawArgs: string, executedToolCalls: Set<string>): string {
  try {
    const parsedArgs = parseToolArguments(rawArgs);
    const skillArgs = validateLoadSkillArgs(parsedArgs);
    const callKey = createToolCallKey("load_skill", skillArgs);
    if (executedToolCalls.has(callKey)) {
      return `Error: skill '${skillArgs.name}' has already been loaded in this turn. Use the loaded instructions instead of loading it again.`;
    }

    executedToolCalls.add(callKey);
    return runLoadSkill(skillArgs).output;
  } catch (error) {
    return `Error: ${formatError(error)}`;
  }
}

function parseToolArguments(rawArgs: string): unknown {
  const normalized = normalizeToolArguments(rawArgs);
  if (!normalized) {
    return {};
  }

  try {
    return JSON.parse(normalized);
  } catch (error) {
    const repaired = repairToolArguments(normalized);
    if (repaired) {
      return repaired;
    }

    throw error;
  }
}

function normalizeToolArguments(rawArgs: string): string {
  return rawArgs
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function repairToolArguments(rawArgs: string): unknown | undefined {
  const firstObject = readFirstJsonObject(rawArgs);
  if (!firstObject) {
    return undefined;
  }

  const trailing = rawArgs.slice(firstObject.endIndex).trim();
  const candidates = [
    repairTrailingObjectProperties(firstObject.text, trailing),
    mergeAdjacentJsonObjects(rawArgs),
    firstObject.text
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next deterministic repair candidate.
    }
  }

  return undefined;
}

function repairTrailingObjectProperties(firstObjectText: string, trailing: string): string | undefined {
  if (!trailing.startsWith(",") || !firstObjectText.endsWith("}")) {
    return undefined;
  }

  return `${firstObjectText.slice(0, -1)}${trailing}}`;
}

function mergeAdjacentJsonObjects(rawArgs: string): string | undefined {
  const objects: unknown[] = [];
  let cursor = 0;

  while (cursor < rawArgs.length) {
    const remaining = rawArgs.slice(cursor).trimStart();
    const skipped = rawArgs.length - cursor - remaining.length;
    cursor += skipped;

    if (!remaining) {
      break;
    }

    if (!remaining.startsWith("{")) {
      return undefined;
    }

    const object = readFirstJsonObject(remaining);
    if (!object) {
      return undefined;
    }

    try {
      objects.push(JSON.parse(object.text));
    } catch {
      return undefined;
    }

    cursor += object.endIndex;
  }

  if (objects.length <= 1 || objects.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) {
    return undefined;
  }

  return JSON.stringify(Object.assign({}, ...objects));
}

function readFirstJsonObject(input: string): { text: string; endIndex: number } | undefined {
  const start = input.indexOf("{");
  if (start < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < input.length; index += 1) {
    const char = input[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          text: input.slice(start, index + 1),
          endIndex: index + 1
        };
      }
    }
  }

  return undefined;
}

function validateTaskPolicy(taskArgs: TaskToolArgs, turnEvents: ResearchToolEvent[]): string | undefined {
  const taskType = taskArgs.taskType;
  const completedCount = countCompletedTask(turnEvents, taskType);
  if (completedCount >= TASK_LIMITS[taskType]) {
    return `"${taskStepLabels[taskType]}" reached its limit of ${TASK_LIMITS[taskType]} calls for this turn. Use existing results to proceed or answer.`;
  }

  if (taskType === "synthesize_evidence" && countCompletedTask(turnEvents, "collect_sources") === 0) {
    return "Collect sources before synthesizing evidence.";
  }

  if (taskType === "write_brief" && countCompletedTask(turnEvents, "synthesize_evidence") === 0) {
    return "Synthesize evidence before writing a brief.";
  }

  if (taskType === "write_brief") {
    const coverage = getLatestCoverageFeedback(turnEvents);
    const remainingCollections = TASK_LIMITS.collect_sources - countCompletedTask(turnEvents, "collect_sources");
    if (coverage?.shouldCollectMore && remainingCollections > 0) {
      return [
        `Evidence coverage is ${Math.round(coverage.coverageScore * 100)}%. Missing: ${coverage.missingAspects.join(", ") || "several key aspects"}.`,
        `Call collect_sources first. Suggested queries: ${coverage.suggestedQueries.join("; ") || "search the identified evidence gaps"}.`,
        "After collecting additional sources, call synthesize_evidence again before deciding whether to write a brief."
      ].join("");
    }
  }

  return undefined;
}

function countCompletedTask(turnEvents: ResearchToolEvent[], taskType: ChildTaskType): number {
  return turnEvents.filter((event) => event.toolName === taskType && event.status === "completed").length;
}

function hasNewDependencyForRepeat(taskType: ChildTaskType, turnEvents: ResearchToolEvent[]): boolean {
  if (taskType === "synthesize_evidence") {
    return latestCompletedTaskIndex(turnEvents, "collect_sources") > latestCompletedTaskIndex(turnEvents, "synthesize_evidence");
  }

  if (taskType === "write_brief") {
    return latestCompletedTaskIndex(turnEvents, "synthesize_evidence") > latestCompletedTaskIndex(turnEvents, "write_brief");
  }

  return false;
}

function latestCompletedTaskIndex(turnEvents: ResearchToolEvent[], taskType: ChildTaskType): number {
  for (let index = turnEvents.length - 1; index >= 0; index -= 1) {
    const event = turnEvents[index];
    if (event.toolName === taskType && event.status === "completed") {
      return index;
    }
  }

  return -1;
}

function getLatestCoverageFeedback(turnEvents: ResearchToolEvent[]): CoverageReport | undefined {
  const latestSynthesis = [...turnEvents]
    .reverse()
    .find((event) => event.toolName === "synthesize_evidence" && event.status === "completed");
  if (!latestSynthesis) {
    return undefined;
  }

  return parseJson<{ coverage?: CoverageReport }>(latestSynthesis.output)?.coverage;
}

function buildCoverageFeedbackForModel(event: ResearchToolEvent, turnEvents: ResearchToolEvent[]): string | undefined {
  if (event.toolName !== "synthesize_evidence" || event.status !== "completed") {
    return undefined;
  }

  const coverage = parseJson<{ coverage?: CoverageReport }>(event.output)?.coverage;
  if (!coverage) {
    return undefined;
  }

  const remainingCollections = TASK_LIMITS.collect_sources - countCompletedTask(turnEvents, "collect_sources");
  if (!coverage.shouldCollectMore || remainingCollections <= 0) {
    return [
      "coverage feedback: ",
      `Current coverage: ${Math.round(coverage.coverageScore * 100)}%.`,
      "Proceed to write_brief, explaining limitations when the evidence is incomplete.",
      "Do not reproduce this internal feedback in the answer."
    ].join("\n");
  }

  return [
    "Coverage feedback: evidence is incomplete. Use this internal feedback to choose the next action.",
    `Coverage: ${Math.round(coverage.coverageScore * 100)}%.`,
    `Covered: ${coverage.coveredAspects.join(", ") || "None"}`,
    `Missing: ${coverage.missingAspects.join(", ") || "no specific gaps identified"}`,
    `Additional queries: ${coverage.suggestedQueries.join("; ") || "search the identified evidence gaps"}`,
    `Remaining collections: ${remainingCollections}.`,
    "Next call task: collect_sources with a short instruction targeting the listed gaps and queries. Then call synthesize_evidence again.",
    "Do not call write_brief while evidence gaps remain unless the collection limit is exhausted.",
    "Omit coverage feedback, internal tool names, context diagnoses, and control logic from the final answer."
  ].join("\n");
}

async function executeResearchStep(
  taskArgs: TaskToolArgs,
  callKey: string,
  artifactStore: ArtifactStore,
  contextBudget: ContextBudgetManager,
  turnId: string,
  researchPlan: ResearchPlan,
  coverageFeedback: CoverageReport | undefined,
  executedToolCalls: Set<string>
): Promise<ResearchToolEvent> {
  executedToolCalls.add(callKey);
  const startedAt = new Date().toISOString();

  try {
    const result = await runTaskTool(taskArgs, { artifactStore, researchPlan, contextBudget, turnId, coverageFeedback });
    const researchEvent: ResearchToolEvent = {
      id: randomUUID(),
      toolName: taskArgs.taskType,
      stepLabel: getStepLabel(taskArgs.taskType),
      args: taskArgs,
      status: "completed",
      output: result.output,
      startedAt,
      finishedAt: new Date().toISOString()
    };
    return researchEvent;
  } catch (error) {
    return createFailedResearchEvent(taskArgs.taskType, taskArgs, formatError(error), startedAt);
  }
}

function createFailedResearchEvent(
  toolName: string,
  args: unknown,
  error: string,
  startedAt = new Date().toISOString()
): ResearchToolEvent {
  const researchEvent: ResearchToolEvent = {
    id: randomUUID(),
    toolName,
    stepLabel: getStepLabel(toolName),
    args,
    status: "failed",
    error,
    startedAt,
    finishedAt: new Date().toISOString()
  };
  return researchEvent;
}

function appendFinalAssistantMessage(
  state: SessionState,
  content: string,
  turnEvents: ResearchToolEvent[],
  researchPlan?: ResearchPlan
): void {
  state.uiMessages.push({
    id: randomUUID(),
    role: "assistant",
    content,
    reasoning: buildReasoningSummary(turnEvents),
    createdAt: new Date().toISOString()
  });
  if (researchPlan) {
    updateSessionResearchMemory(state.researchMemory, researchPlan, turnEvents, content);
  }
}

function renderSessionMemoryForModel(memory: SessionResearchMemory, currentPlan: ResearchPlan): string {
  const completed = memory.completedTopics.slice(-5);
  return [
    "Session research memory:",
    completed.length > 0
      ? `Completed topics: ${completed.map((item) => `[${item.goal}](${item.summary})`).join("; ")}`
      : "Completed topics: None.",
    `Current turn topic: ${currentPlan.researchGoal}`,
    `Current turn research question: ${currentPlan.researchQuestion}`,
    "Preserve the research history, but use only artifacts from the current turnId as evidence unless the user explicitly requests earlier results."
  ].join("\n");
}

function updateSessionResearchMemory(
  memory: SessionResearchMemory,
  plan: ResearchPlan,
  turnEvents: ResearchToolEvent[],
  finalContent: string
): void {
  const completedCount = turnEvents.filter((event) => event.status === "completed").length;
  const latestBrief = extractBrief(findLatestOutput(turnEvents, "write_brief"));
  const summary =
    latestBrief?.conclusion ||
    extractRecommendation(findLatestOutput(turnEvents, "synthesize_evidence")) ||
    truncateMemorySummary(finalContent);

  const entry = {
    goal: plan.researchGoal,
    researchQuestion: plan.researchQuestion,
    completedAt: new Date().toISOString(),
    summary: `${summary}${completedCount > 0 ? `; completed ${completedCount} steps` : ""}`
  };

  memory.completedTopics = [
    ...memory.completedTopics.filter((item) => item.goal !== entry.goal),
    entry
  ].slice(-8);
}

function truncateMemorySummary(value: string): string {
  const compact = value.replace(/[#*_`>|-]/g, "").replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 119)}…` : compact || "No usable summary for this turn";
}

function buildReasoningSummary(turnEvents: ResearchToolEvent[]): ReasoningSummary | undefined {
  if (turnEvents.length === 0) {
    return undefined;
  }

  const completed = turnEvents.filter((event) => event.status === "completed").length;
  const failed = turnEvents.length - completed;

  return {
    title: "Research process",
    summary: `Completed ${completed} steps this turn${failed > 0 ? `; ${failed} steps failed` : ""}.`,
    steps: turnEvents.map((event, index) => ({
      index: index + 1,
      label: event.stepLabel,
      status: event.status,
      result: summarizeResearchResult(event),
      startedAt: event.startedAt,
      finishedAt: event.finishedAt
    }))
  };
}

function summarizeResearchResult(event: ResearchToolEvent): string {
  if (event.status === "failed") {
    return event.error || "Execution failed without error details.";
  }

  if (event.toolName === "collect_sources") {
    const payload = parseJson<{ sourceCount?: number; topSources?: Array<{ title: string }> }>(event.output);
    return payload?.sourceCount
      ? `Collected ${payload.sourceCount} candidate sources, including "${payload.topSources?.[0]?.title || "a candidate source"}".`
      : "Source collection completed, but no candidate sources were parsed.";
  }

  if (event.toolName === "synthesize_evidence") {
    const payload = parseJson<{ keyFindings?: string[]; coverage?: { coverageScore: number; missingAspects: string[] } }>(
      event.output
    );
    if (payload?.coverage) {
      return `Identified ${payload.keyFindings?.length ?? 0} key findings, coverage ${Math.round(
        payload.coverage.coverageScore * 100
      )}%${payload.coverage.missingAspects.length > 0 ? `, Missing: ${payload.coverage.missingAspects.join(", ")}` : "."}`;
    }
    return payload?.keyFindings
      ? `Identified ${payload.keyFindings.length} key findings and initial recommendations.`
      : "Synthesis completed, but no structured result was parsed.";
  }

  if (event.toolName === "write_brief") {
    const brief = extractBrief(event.output);
    return brief ? `Created "${brief.title}".` : "Brief generation completed.";
  }

  return "Step completed.";
}

function normalizeAssistantContent(content: string | null, turnEvents: ResearchToolEvent[]): string {
  const fallback = getLatestBriefContent(turnEvents);
  if (!content?.trim()) {
    return fallback || "Research completed without a model text response.";
  }

  if (/context contamination|old topic contamination|contaminated by (?:a )?previous|contaminated brief/i.test(content)) {
    return fallback || buildFallbackFinal(turnEvents, "Internal context diagnostics were replaced with the current turn result.") || "Research completed.";
  }

  if (/task|collect_sources|synthesize_evidence|write_brief|source_collector|evidence_synthesizer|brief_writer|tool_calls|function/i.test(
    content
  )) {
    return fallback || buildFallbackFinal(turnEvents, "Internal step names were replaced with a readable summary.") || "Research completed.";
  }

  return content;
}

function buildFallbackFinal(turnEvents: ResearchToolEvent[], note: string): string | undefined {
  const brief = getLatestBriefContent(turnEvents);
  if (brief) {
    return `${brief}\n\n## Notes\n- ${note}`;
  }

  if (turnEvents.length === 0) {
    return undefined;
  }

  const sourceCount = sumSourceCounts(turnEvents);
  const recommendation = extractRecommendation(findLatestOutput(turnEvents, "synthesize_evidence"));
  const failed = turnEvents.filter((event) => event.status === "failed");

  return [
    "# Research brief (partial results)",
    "",
    "## Current progress",
    `- Candidate sources: ${sourceCount}.`,
    `- Structured findings: ${extractFindingCount(findLatestOutput(turnEvents, "synthesize_evidence"))}.`,
    "",
    "## Available findings",
    recommendation || "The current evidence is insufficient for a reliable recommendation.",
    "",
    "## Limitations",
    `- ${note}`,
    ...failed.map((event) => `- ${event.stepLabel}Failed: ${event.error || "Unknown error"}`)
  ].join("\n");
}

function isSourceCollectionBlockingFailure(event: ResearchToolEvent): boolean {
  if (event.toolName !== "collect_sources" || event.status !== "failed") {
    return false;
  }

  return /Missing SEARCH_API_KEY|Unsupported SEARCH_PROVIDER|External API request failed|Invalid response format/i.test(
    event.error || ""
  );
}

function buildSourceCollectionFailureSummary(error: string): string {
  const suggestions: string[] = [];
  if (/Missing SEARCH_API_KEY/i.test(error)) {
    suggestions.push("For web sources, configure SEARCH_API_KEY in apps/server/.env and restart the server.");
  }
  if (/Semantic Scholar rate limit exceeded|429/i.test(error)) {
    suggestions.push("If the paper API is rate limited, configure SEMANTIC_SCHOLAR_API_KEY or try again later.");
  }
  if (/Unsupported SEARCH_PROVIDER/i.test(error)) {
    suggestions.push("Set SEARCH_PROVIDER to tavily, serpapi, or bing.");
  }
  if (suggestions.length === 0) {
    suggestions.push("Check the source API response format, quota, and network connection, then retry.");
  }

  return [
    "# Research could not continue",
    "",
    "## Reason",
    `- Source collection failed: ${error}`,
    "",
    "## Action needed",
    ...suggestions.map((item) => `- ${item}`),
    "",
    "The workflow stopped because a research brief requires reliable real sources."
  ].join("\n");
}

function getLatestBriefContent(turnEvents: ResearchToolEvent[]): string | undefined {
  const brief = extractBrief(findLatestOutput(turnEvents, "write_brief"));
  return brief?.content;
}

function findLatestOutput(turnEvents: ResearchToolEvent[], toolName: string): string | undefined {
  return [...turnEvents].reverse().find((event) => event.toolName === toolName && event.status === "completed")?.output;
}

function extractSourceCount(output: string | undefined): number {
  const parsed = parseJson<{ sourceCount?: number; sources?: unknown[] }>(output);
  if (typeof parsed?.sourceCount === "number") {
    return parsed.sourceCount;
  }

  return Array.isArray(parsed?.sources) ? parsed.sources.length : 0;
}

function extractFindingCount(output: string | undefined): number {
  const parsed = parseJson<{ keyFindings?: string[]; synthesis?: ResearchSynthesis }>(output);
  if (Array.isArray(parsed?.keyFindings)) {
    return parsed.keyFindings.length;
  }

  return Array.isArray(parsed?.synthesis?.keyFindings) ? parsed.synthesis.keyFindings.length : 0;
}

function extractRecommendation(output: string | undefined): string | undefined {
  const parsed = parseJson<{ recommendation?: string; synthesis?: ResearchSynthesis }>(output);
  return parsed?.recommendation || parsed?.synthesis?.recommendation;
}

function extractBrief(output: string | undefined): ResearchBrief | undefined {
  const parsed = parseJson<{ brief?: ResearchBrief }>(output);
  return parsed?.brief;
}

function parseJson<T>(output: string | undefined): T | undefined {
  if (!output) {
    return undefined;
  }

  try {
    return JSON.parse(output) as T;
  } catch {
    return undefined;
  }
}

async function finalizeResponse(sessionId: string, state: SessionState, hookRunner: AgentHookRunner): Promise<ChatResponse> {
  state.metadata.updatedAt = new Date().toISOString();
  persistSessionState(state);
  const response = buildResponse(sessionId, state);
  ensureHookCanContinue(await hookRunner.finalResponseCreated({ response }));
  return response;
}

function buildResponse(sessionId: string, state: SessionState): ChatResponse {
  return {
    sessionId,
    sessionTitle: state.metadata.title,
    messages: state.uiMessages,
    researchEvents: state.researchEvents,
    compactState: state.contextBudget.getState()
  };
}

function buildCompactContext(
  state: SessionState,
  currentGoal: string,
  activeTurnEvents?: ResearchToolEvent[]
): CompactContext {
  return {
    currentGoal: currentGoal || getLatestUserGoal(state),
    uiMessages: state.uiMessages,
    researchEvents: activeTurnEvents ?? state.researchEvents
  };
}

function isManualCompactCommand(content: string): boolean {
  return content.trim().toLowerCase() === "/compact";
}

function getLatestUserGoal(state: SessionState): string {
  return (
    [...state.uiMessages]
      .reverse()
      .find((message) => message.role === "user" && !isManualCompactCommand(message.content))?.content || "Continue the current research task"
  );
}

function sumSourceCounts(turnEvents: ResearchToolEvent[]): number {
  return turnEvents
    .filter((event) => event.toolName === "collect_sources" && event.status === "completed")
    .reduce((total, event) => total + extractSourceCount(event.output), 0);
}

function isRequiredToolName(toolName: string): toolName is ChildTaskType {
  return (KNOWN_TASK_TYPES as readonly string[]).includes(toolName);
}

function getStepLabel(toolName: string): string {
  return isRequiredToolName(toolName) ? taskStepLabels[toolName] : "Unknown step";
}

function inferTaskType(args: unknown): ChildTaskType | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }

  const taskType = (args as Record<string, unknown>).taskType;
  return typeof taskType === "string" && isRequiredToolName(taskType) ? taskType : undefined;
}

function getMaxToolRounds(): number {
  const configured = Number(process.env.AGENT_MAX_TOOL_ROUNDS || String(DEFAULT_MAX_TOOL_ROUNDS));
  if (!Number.isFinite(configured) || configured < 3) {
    return DEFAULT_MAX_TOOL_ROUNDS;
  }

  return Math.min(Math.floor(configured), 20);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function formatToolArgumentError(error: unknown): string {
  const message = formatError(error);
  if (/task Invalid arguments/i.test(message)) {
    return `Task arguments are incomplete or invalid: ${message.replace(/^task Invalid arguments: ?/, "")}`;
  }

  return `Tool argument parsing or context injection failed: ${message}`;
}
