import { createChatCompletion, type DeepSeekMessage } from "./deepseek.js";
import type { ContextBudgetManager } from "./contextBudget.js";
import { createToolCallKey, parseToolArguments } from "./toolArguments.js";
import type { ChildAgentProfile } from "./childRegistry.js";
import { executeRegisteredTool } from "../tools/index.js";

const MAX_CHILD_TOOL_ROUNDS = 2;

export interface ChildAgentRunInput {
  profile: ChildAgentProfile;
  instruction: string;
  injectedInput?: unknown;
  defaultToolArgs?: Record<string, unknown>;
  contextBudget?: ContextBudgetManager;
}

export interface ChildAgentRunResult {
  toolName: string;
  output: string;
}

export async function runChildAgent(input: ChildAgentRunInput): Promise<ChildAgentRunResult> {
  let messages: DeepSeekMessage[] = [
    {
      role: "system",
      content: input.profile.systemPrompt
    },
    {
      role: "user",
      content: buildChildUserMessage(input)
    }
  ];
  const executedToolCalls = new Set<string>();

  for (let round = 1; round <= MAX_CHILD_TOOL_ROUNDS; round += 1) {
    messages =
      input.contextBudget?.compactBeforeModelCall(messages, {
        currentGoal: input.instruction,
        uiMessages: [],
        researchEvents: [],
        nextAction: `Execute the ${input.profile.stepLabel} subtask.`
      }) || messages;
    const assistantMessage = await createChatCompletion({
      messages,
      tools: input.profile.tools
    });
    messages.push(assistantMessage);

    const toolCalls = assistantMessage.tool_calls || [];
    if (toolCalls.length === 0) {
      throw new Error(`${input.profile.stepLabel} child agent did not call its required tool.`);
    }

    for (const toolCall of toolCalls) {
      const toolName = toolCall.function.name;
      if (toolName !== input.profile.toolName) {
        throw new Error(`${input.profile.stepLabel} child agent can call only ${input.profile.toolName}, not ${toolName}.`);
      }

      const parsedArgs = parseToolArguments(toolCall.function.arguments);
      const callKey = createToolCallKey(toolName, parsedArgs);
      if (executedToolCalls.has(callKey)) {
        throw new Error(`${input.profile.stepLabel} child agent repeated identical tool arguments.`);
      }

      executedToolCalls.add(callKey);
      const executionArgs = buildChildExecutionArgs(input.profile, parsedArgs, input.injectedInput, input);
      const result = await executeRegisteredTool(toolName, executionArgs);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: input.contextBudget?.prepareToolResultForContext(toolName, result.output) || result.output
      });

      return {
        toolName,
        output: result.output
      };
    }
  }

  throw new Error(`${input.profile.stepLabel} child agent reached the tool-round limit without a usable result.`);
}

function buildChildUserMessage(input: ChildAgentRunInput): string {
  const hasInjectedInput = input.injectedInput !== undefined;
  return [
    `Task instruction: ${input.instruction}`,
    buildEnvironmentGuidance(input.profile),
    hasInjectedInput ? "The server injects the previous structured result when executing the tool. Do not copy it into the arguments." : "",
    `Call only ${input.profile.toolName} and return its result.`
  ]
    .filter(Boolean)
    .join("\n");
}

function buildEnvironmentGuidance(profile: ChildAgentProfile): string {
  if (profile.taskType !== "collect_sources") {
    return "";
  }

  const hasSearchApiKey = Boolean(process.env.SEARCH_API_KEY?.trim());
  return hasSearchApiKey
    ? "A web search API key is configured. Select web, papers, or both as needed."
    : "No web search API key is configured. Use sourceTypes: [\"papers\"] unless the user explicitly requests web sources.";
}

function buildChildExecutionArgs(
  profile: ChildAgentProfile,
  args: unknown,
  injectedInput: unknown,
  input: ChildAgentRunInput
): Record<string, unknown> {
  const baseArgs = {
    ...(input.defaultToolArgs || {}),
    ...toObjectArgs(args)
  };

  if (profile.taskType === "synthesize_evidence") {
    if (!injectedInput) {
      throw new Error("Synthesis requires injected sources.");
    }

    const focus = truncateToolString(getNonEmptyString(baseArgs.focus) || input.instruction, 200);
    const outputFormat = getNonEmptyString(baseArgs.outputFormat) || "decision_brief";
    return {
      ...baseArgs,
      focus,
      outputFormat,
      sources: injectedInput
    };
  }

  if (profile.taskType === "write_brief") {
    if (!injectedInput) {
      throw new Error("Brief writing requires injected synthesis.");
    }

    return {
      ...baseArgs,
      synthesis: injectedInput
    };
  }

  if (profile.taskType === "collect_sources") {
    return {
      ...baseArgs,
      topic: mergeCollectionTopic(baseArgs.topic, input.defaultToolArgs?.topic)
    };
  }

  return baseArgs;
}

function toObjectArgs(args: unknown): Record<string, unknown> {
  return args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function truncateToolString(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function mergeCollectionTopic(requestedTopic: unknown, defaultTopic: unknown): string {
  const requested = getNonEmptyString(requestedTopic);
  const fallback = getNonEmptyString(defaultTopic);
  if (!requested) {
    return truncateToolString(fallback || "Research topic", 200);
  }

  if (!fallback || requested.toLowerCase().includes(fallback.toLowerCase())) {
    return truncateToolString(requested, 200);
  }

  return truncateToolString(`${requested} ${fallback}`, 200);
}
