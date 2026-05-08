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
        nextAction: `执行 ${input.profile.stepLabel} 子任务。`
      }) || messages;
    const assistantMessage = await createChatCompletion({
      messages,
      tools: input.profile.tools
    });
    messages.push(assistantMessage);

    const toolCalls = assistantMessage.tool_calls || [];
    if (toolCalls.length === 0) {
      throw new Error(`${input.profile.stepLabel}子智能体没有调用必要工具。`);
    }

    for (const toolCall of toolCalls) {
      const toolName = toolCall.function.name;
      if (toolName !== input.profile.toolName) {
        throw new Error(`${input.profile.stepLabel}子智能体只能调用 ${input.profile.toolName}，不能调用 ${toolName}。`);
      }

      const parsedArgs = parseToolArguments(toolCall.function.arguments);
      const callKey = createToolCallKey(toolName, parsedArgs);
      if (executedToolCalls.has(callKey)) {
        throw new Error(`${input.profile.stepLabel}子智能体重复调用了相同工具和参数。`);
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

  throw new Error(`${input.profile.stepLabel}子智能体达到最大工具轮数，仍未产生可用结果。`);
}

function buildChildUserMessage(input: ChildAgentRunInput): string {
  const hasInjectedInput = input.injectedInput !== undefined;
  return [
    `任务说明：${input.instruction}`,
    buildEnvironmentGuidance(input.profile),
    hasInjectedInput ? "后端已经准备好上一步结构化结果，会在执行工具时自动注入；不要在工具参数中复制该结果。" : "",
    `只调用 ${input.profile.toolName}，完成后返回工具结果。`
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
    ? "当前已配置 web 搜索 API key；可以按任务需要选择 web、papers 或二者组合。"
    : "当前未配置 web 搜索 API key；除非用户明确要求 web 来源，否则 source_collector 应使用 sourceTypes: [\"papers\"]。";
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
      throw new Error("整理证据需要先注入 sources。");
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
      throw new Error("生成简报需要先注入 synthesis。");
    }

    return {
      ...baseArgs,
      synthesis: injectedInput
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
