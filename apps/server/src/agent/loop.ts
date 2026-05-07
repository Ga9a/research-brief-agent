import { randomUUID } from "node:crypto";
import { createChatCompletion, type DeepSeekMessage } from "./deepseek.js";
import { ArtifactStore } from "./artifactStore.js";
import { ContextBudgetManager, type CompactContext } from "./contextBudget.js";
import { loadSkillToolDefinition, runLoadSkill, validateLoadSkillArgs } from "./loadSkillTool.js";
import { runTaskTool } from "./taskRunner.js";
import {
  taskStepLabels,
  taskToolDefinition,
  validateTaskArgs,
  type ChildTaskType,
  type TaskToolArgs
} from "./taskTool.js";
import type {
  AgentStreamEvent,
  ChatResponse,
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
  modelMessages: DeepSeekMessage[];
  uiMessages: UiMessage[];
  researchEvents: ResearchToolEvent[];
  artifactStore: ArtifactStore;
  contextBudget: ContextBudgetManager;
  researchMemory: SessionResearchMemory;
}

interface AgentRunHooks {
  onEvent?: (event: AgentStreamEvent) => void;
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
    "你是 Research Brief Agent 的父智能体，一个安全的中文调研助手。",
    "你的任务是拆分调研流程、通过 task 工具派发独立子任务，并在子任务完成后输出自然的中文调研简报。",
    "你可以调用 task 工具执行调研子任务，也可以调用 load_skill 按需加载 SKILL.md 的完整工作流说明。",
    "不要把所有技能正文一次性写入上下文；先根据下方技能名称和简介判断是否需要，再通过 load_skill 加载。",
    "",
    "可用技能（只展示简介，完整内容需要 load_skill）：",
    getDefaultSkillLoader().getDescriptions(),
    "",
    "核心约束：",
    "- 不要直接臆造资料，资料收集必须通过 task 子任务完成。",
    "- 需要自主判断资料是否足够：可以先收集资料，再整理证据；如果整理后发现资料不足，可以追加资料收集并重新整理；如果简报不够贴合用户目标，可以重新生成一次。",
    "- 每轮调研必须先明确研究问题、决策场景、评估标准和证据/实验要求。缺少这些内容时，最终简报必须指出缺口，而不是只给泛泛建议。",
    "- 整理证据后如果 coverage feedback 表示覆盖不足，下一步必须优先补充收集资料并重新整理证据；除非已经达到收集上限，否则不要直接写简报。",
    "- 不要复制 sources、synthesis 或其他大段 JSON；调用 task 时通常只需要 taskType，instruction 可省略或保持简短。",
    "- 为避免循环，collect_sources 最多 3 次，synthesize_evidence 最多 4 次，write_brief 最多 2 次；达到限制后必须基于已有结果输出最终回答。",
    "- 旧轮次消息只用于理解会话历史，不是当前主题的证据。不要在最终回答中诊断“上下文污染”“旧主题污染”或系统状态；如果发现旧主题内容不相关，直接忽略并基于当前轮次结果回答。",
    "- 最终回答不要暴露 task、函数名、参数、内部工具日志或上下文管理诊断，结构应包含简要结论、关键发现、对比分析、局限性、建议提问和下一步学习建议。"
  ].join("\n");
}

export async function runAgentTurn(
  input: { sessionId?: string; message: string },
  hooks: AgentRunHooks = {}
): Promise<ChatResponse> {
  const sessionId = input.sessionId || randomUUID();
  const state = getSession(sessionId);
  const userContent = input.message.trim();
  if (!userContent) {
    throw new Error("消息不能为空。");
  }

  hooks.onEvent?.({ type: "session", sessionId });

  if (isManualCompactCommand(userContent)) {
    state.uiMessages.push({
      id: randomUUID(),
      role: "user",
      content: userContent,
      createdAt: new Date().toISOString()
    });
    state.modelMessages = state.contextBudget.forceSummaryCompact(state.modelMessages, buildCompactContext(state, getLatestUserGoal(state)));
    appendFinalAssistantMessage(state, "已完成上下文压缩。旧工具输出没有删除，仍可通过摘要中的 persisted-output 路径追踪。", []);
    return buildResponse(sessionId, state, hooks);
  }

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
    content: `当前轮次 ID：${turnId}。默认只使用当前轮次产生的资料、证据和简报；除非用户明确要求复用上一轮结果，否则不要引用旧主题产物。`
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
      const fallback = buildFallbackFinal(turnEvents, `模型调用失败或超时：${formatError(error)}`);
      if (fallback) {
        appendFinalAssistantMessage(state, fallback, turnEvents, researchPlan);
        return buildResponse(sessionId, state, hooks);
      }

      throw error;
    }

    const toolCalls = assistantMessage.tool_calls || [];
    state.modelMessages.push(assistantMessage);

    if (toolCalls.length === 0) {
      appendFinalAssistantMessage(state, normalizeAssistantContent(assistantMessage.content, turnEvents), turnEvents, researchPlan);
      return buildResponse(sessionId, state, hooks);
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
          throw new Error(`父智能体只能调用 task 或 load_skill 工具，不能调用 ${toolName}。`);
        }

        parsedArgs = parseToolArguments(toolCall.function.arguments);
        const taskArgs = validateTaskArgs(parsedArgs);
        const callKey = createToolCallKey(toolName, taskArgs);
        if (executedToolCalls.has(callKey)) {
          researchEvent = createFailedResearchEvent(
            taskArgs.taskType,
            taskArgs,
            `已跳过重复调用：本轮调研已经用相同参数执行过该步骤。`,
            hooks
          );
        } else {
          const preconditionError = validateTaskPolicy(taskArgs, turnEvents);
          if (preconditionError) {
            researchEvent = createFailedResearchEvent(taskArgs.taskType, taskArgs, preconditionError, hooks);
          } else {
            researchEvent = await executeResearchStep(
              taskArgs,
              callKey,
              state.artifactStore,
              state.contextBudget,
              turnId,
              researchPlan,
              getLatestCoverageFeedback(turnEvents),
              executedToolCalls,
              hooks
            );
          }
        }
      } catch (error) {
        researchEvent = createFailedResearchEvent(
          inferTaskType(parsedArgs) || toolName,
          parsedArgs,
          formatToolArgumentError(error),
          hooks
        );
      }

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
          buildSourceCollectionFailureSummary(researchEvent.error || "资料收集失败。"),
          turnEvents,
          researchPlan
        );
        return buildResponse(sessionId, state, hooks);
      }
    }
  }

  appendFinalAssistantMessage(
    state,
    buildFallbackFinal(turnEvents, `已达到最大工具调用轮数 ${maxToolRounds}，为避免循环，已停止继续调用。`) ||
      "这轮调研没有生成可用简报，请缩小主题或补充更明确的关注点。",
    turnEvents,
    researchPlan
  );
  return buildResponse(sessionId, state, hooks);
}

function getSession(sessionId: string): SessionState {
  const existing = sessions.get(sessionId);
  if (existing) {
    return existing;
  }

  const created: SessionState = {
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
    return `“${taskStepLabels[taskType]}”已达到本轮上限 ${TASK_LIMITS[taskType]} 次，请基于已有结果继续判断或输出最终简报。`;
  }

  if (taskType === "synthesize_evidence" && countCompletedTask(turnEvents, "collect_sources") === 0) {
    return "整理证据前必须先完成至少一次资料收集。";
  }

  if (taskType === "write_brief" && countCompletedTask(turnEvents, "synthesize_evidence") === 0) {
    return "生成简报前必须先完成至少一次证据整理。";
  }

  if (taskType === "write_brief") {
    const coverage = getLatestCoverageFeedback(turnEvents);
    const remainingCollections = TASK_LIMITS.collect_sources - countCompletedTask(turnEvents, "collect_sources");
    if (coverage?.shouldCollectMore && remainingCollections > 0) {
      return [
        `当前证据覆盖率只有 ${Math.round(coverage.coverageScore * 100)}%，仍缺：${coverage.missingAspects.join("、") || "若干关键方面"}。`,
        `请先调用 collect_sources 补充资料，建议检索：${coverage.suggestedQueries.join("；") || "围绕缺口补充检索"}。`,
        "补充收集完成后必须再次调用 synthesize_evidence，再判断是否可以生成简报。"
      ].join("");
    }
  }

  return undefined;
}

function countCompletedTask(turnEvents: ResearchToolEvent[], taskType: ChildTaskType): number {
  return turnEvents.filter((event) => event.toolName === taskType && event.status === "completed").length;
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
      "coverage feedback：",
      `当前覆盖率为 ${Math.round(coverage.coverageScore * 100)}%。`,
      "可以进入 write_brief；如果最终回答使用部分证据，请明确写出局限性。",
      "不要把本段 feedback 原样写给用户。"
    ].join("\n");
  }

  return [
    "coverage feedback：当前证据覆盖不足，这是一条控制下一步行动的内部反馈。",
    `覆盖率：${Math.round(coverage.coverageScore * 100)}%。`,
    `已覆盖：${coverage.coveredAspects.join("、") || "暂无"}`,
    `仍缺：${coverage.missingAspects.join("、") || "未识别到具体缺口"}`,
    `建议补充检索：${coverage.suggestedQueries.join("；") || "围绕缺口补充检索"}`,
    `剩余资料收集次数：${remainingCollections}。`,
    "下一步必须调用 task: collect_sources，instruction 要围绕上述缺口和建议检索式；补充收集后必须再次调用 synthesize_evidence。",
    "除非资料收集次数已用完，不要直接调用 write_brief。",
    "不要把 coverage feedback、工具名、上下文污染诊断或内部控制逻辑写进最终用户回答。"
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
  executedToolCalls: Set<string>,
  hooks: AgentRunHooks
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
    hooks.onEvent?.({ type: "research_event", researchEvent });
    return researchEvent;
  } catch (error) {
    return createFailedResearchEvent(taskArgs.taskType, taskArgs, formatError(error), hooks, startedAt);
  }
}

function createFailedResearchEvent(
  toolName: string,
  args: unknown,
  error: string,
  hooks: AgentRunHooks,
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
  hooks.onEvent?.({ type: "research_event", researchEvent });
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
    "会话研究记忆：",
    completed.length > 0
      ? `已完成主题：${completed.map((item) => `《${item.goal}》(${item.summary})`).join("；")}`
      : "已完成主题：暂无。",
    `当前轮次主题：${currentPlan.researchGoal}`,
    `当前轮次研究问题：${currentPlan.researchQuestion}`,
    "规则：保留用户多轮研究脉络，但当前轮次的资料、证据和简报只能来自当前 turnId 的工具产物；旧主题只能作为历史背景，不能当作当前主题证据。"
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
    summary: `${summary}${completedCount > 0 ? `；完成 ${completedCount} 个步骤` : ""}`
  };

  memory.completedTopics = [
    ...memory.completedTopics.filter((item) => item.goal !== entry.goal),
    entry
  ].slice(-8);
}

function truncateMemorySummary(value: string): string {
  const compact = value.replace(/[#*_`>|-]/g, "").replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 119)}…` : compact || "本轮未形成可用摘要";
}

function buildReasoningSummary(turnEvents: ResearchToolEvent[]): ReasoningSummary | undefined {
  if (turnEvents.length === 0) {
    return undefined;
  }

  const completed = turnEvents.filter((event) => event.status === "completed").length;
  const failed = turnEvents.length - completed;

  return {
    title: "调研过程",
    summary: `本轮共完成 ${completed} 个步骤${failed > 0 ? `，有 ${failed} 个步骤未成功` : ""}。`,
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
    return event.error || "执行失败，未返回明确错误。";
  }

  if (event.toolName === "collect_sources") {
    const payload = parseJson<{ sourceCount?: number; topSources?: Array<{ title: string }> }>(event.output);
    return payload?.sourceCount
      ? `整理出 ${payload.sourceCount} 条候选资料，代表资料是“${payload.topSources?.[0]?.title || "候选资料"}”。`
      : "资料收集已完成，但没有解析到候选资料。";
  }

  if (event.toolName === "synthesize_evidence") {
    const payload = parseJson<{ keyFindings?: string[]; coverage?: { coverageScore: number; missingAspects: string[] } }>(
      event.output
    );
    if (payload?.coverage) {
      return `形成 ${payload.keyFindings?.length ?? 0} 条关键发现，覆盖率 ${Math.round(
        payload.coverage.coverageScore * 100
      )}%${payload.coverage.missingAspects.length > 0 ? `，仍缺：${payload.coverage.missingAspects.join("、")}` : "。"}`;
    }
    return payload?.keyFindings
      ? `形成 ${payload.keyFindings.length} 条关键发现，并给出初步建议。`
      : "证据整理已完成，但没有解析到结构化结果。";
  }

  if (event.toolName === "write_brief") {
    const brief = extractBrief(event.output);
    return brief ? `生成《${brief.title}》。` : "简报生成已完成。";
  }

  return "步骤已完成。";
}

function normalizeAssistantContent(content: string | null, turnEvents: ResearchToolEvent[]): string {
  const fallback = getLatestBriefContent(turnEvents);
  if (!content?.trim()) {
    return fallback || "调研已完成，但模型没有返回文本。";
  }

  if (/上下文污染|旧主题污染|被之前.*污染|简报.*污染|内容.*污染/i.test(content)) {
    return fallback || buildFallbackFinal(turnEvents, "模型返回了内部上下文诊断，已改写为当前轮次的用户可读结果。") || "调研已完成。";
  }

  if (/task|collect_sources|synthesize_evidence|write_brief|source_collector|evidence_synthesizer|brief_writer|tool_calls|function/i.test(
    content
  )) {
    return fallback || buildFallbackFinal(turnEvents, "模型返回了内部步骤名称，已改写为用户可读摘要。") || "调研已完成。";
  }

  return content;
}

function buildFallbackFinal(turnEvents: ResearchToolEvent[], note: string): string | undefined {
  const brief = getLatestBriefContent(turnEvents);
  if (brief) {
    return `${brief}\n\n## 备注\n- ${note}`;
  }

  if (turnEvents.length === 0) {
    return undefined;
  }

  const sourceCount = sumSourceCounts(turnEvents);
  const recommendation = extractRecommendation(findLatestOutput(turnEvents, "synthesize_evidence"));
  const failed = turnEvents.filter((event) => event.status === "failed");

  return [
    "# 调研简报（部分结果）",
    "",
    "## 当前进展",
    `- 已整理候选资料：${sourceCount} 条。`,
    `- 结构化发现：${extractFindingCount(findLatestOutput(turnEvents, "synthesize_evidence"))} 条。`,
    "",
    "## 可用结论",
    recommendation || "当前证据不足，尚不能形成稳定建议。",
    "",
    "## 限制说明",
    `- ${note}`,
    ...failed.map((event) => `- ${event.stepLabel}失败：${event.error || "未知错误"}`)
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
    suggestions.push("如果需要 web 资料，请在 apps/server/.env 中配置 SEARCH_API_KEY，并重启后端服务。");
  }
  if (/Semantic Scholar rate limit exceeded|429/i.test(error)) {
    suggestions.push("如果论文接口被限流，请配置 SEMANTIC_SCHOLAR_API_KEY，或稍后重试。");
  }
  if (/Unsupported SEARCH_PROVIDER/i.test(error)) {
    suggestions.push("请把 SEARCH_PROVIDER 设置为 tavily、serpapi 或 bing。");
  }
  if (suggestions.length === 0) {
    suggestions.push("请检查外部资料 API 的返回格式、额度和网络连通性后重试。");
  }

  return [
    "# 调研暂时无法继续",
    "",
    "## 原因",
    `- 资料收集阶段失败：${error}`,
    "",
    "## 需要处理",
    ...suggestions.map((item) => `- ${item}`),
    "",
    "我没有继续调用后续整理和写作工具，因为没有可靠的真实资料来源时不能生成调研简报。"
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

function buildResponse(sessionId: string, state: SessionState, hooks?: AgentRunHooks): ChatResponse {
  const response = {
    sessionId,
    messages: state.uiMessages,
    researchEvents: state.researchEvents,
    compactState: state.contextBudget.getState()
  };
  hooks?.onEvent?.({ type: "final", response });
  return response;
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
      .find((message) => message.role === "user" && !isManualCompactCommand(message.content))?.content || "继续当前调研任务"
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
  return isRequiredToolName(toolName) ? taskStepLabels[toolName] : "未知步骤";
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
  return error instanceof Error ? error.message : "未知错误";
}

function formatToolArgumentError(error: unknown): string {
  const message = formatError(error);
  if (/task 参数无效/i.test(message)) {
    return `任务参数不完整或格式不正确：${message.replace(/^task 参数无效：?/, "")}`;
  }

  return `工具参数解析或上下文注入失败：${message}`;
}
