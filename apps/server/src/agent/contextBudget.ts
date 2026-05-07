import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DeepSeekMessage } from "./deepseek.js";
import type { CompactState, PersistedOutputReference, ResearchToolEvent, UiMessage } from "../types.js";

const DEFAULT_INLINE_CHAR_LIMIT = 8000;
const DEFAULT_PREVIEW_CHARS = 1200;
const DEFAULT_RECENT_TOOL_RESULTS = 3;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 64000;
const DEFAULT_SUMMARY_TRIGGER_RATIO = 0.75;
const DEFAULT_KEEP_RECENT_MESSAGES = 8;

export interface ContextBudgetOptions {
  outputDir: string;
  inlineCharLimit: number;
  previewChars: number;
  recentToolResults: number;
  contextWindowTokens: number;
  summaryTriggerRatio: number;
  keepRecentMessages: number;
}

export interface CompactContext {
  currentGoal: string;
  uiMessages: UiMessage[];
  researchEvents: ResearchToolEvent[];
  nextAction?: string;
}

export class ContextBudgetManager {
  private readonly options: ContextBudgetOptions;
  private readonly state: CompactState = {
    hasCompacted: false,
    lastSummary: null,
    recentFiles: [],
    persistedOutputs: [],
    estimatedTokens: 0,
    contextWindowTokens: 0,
    summaryTriggerTokens: 0,
    compactedMessageCount: 0
  };

  constructor(private readonly sessionId: string, options: Partial<ContextBudgetOptions> = {}) {
    this.options = {
      ...getDefaultContextBudgetOptions(),
      ...options
    };
    this.state.contextWindowTokens = this.options.contextWindowTokens;
    this.state.summaryTriggerTokens = Math.floor(this.options.contextWindowTokens * this.options.summaryTriggerRatio);
  }

  getState(): CompactState {
    return {
      ...this.state,
      recentFiles: [...this.state.recentFiles],
      persistedOutputs: [...this.state.persistedOutputs]
    };
  }

  prepareToolResultForContext(toolName: string, content: string, reason: PersistedOutputReference["reason"] = "size-threshold"): string {
    if (content.length <= this.options.inlineCharLimit) {
      return content;
    }

    return JSON.stringify(this.persistOutput(toolName, content, reason), null, 2);
  }

  compactBeforeModelCall(messages: DeepSeekMessage[], context: CompactContext): DeepSeekMessage[] {
    let compacted = this.microCompact(messages);
    this.state.estimatedTokens = estimateContextTokens(compacted);

    if (this.shouldSummaryCompact(compacted)) {
      compacted = this.summaryCompact(compacted, context, false);
    }

    this.state.estimatedTokens = estimateContextTokens(compacted);
    return compacted;
  }

  forceSummaryCompact(messages: DeepSeekMessage[], context: CompactContext): DeepSeekMessage[] {
    const microCompacted = this.microCompact(messages);
    const summarized = this.summaryCompact(microCompacted, context, true);
    this.state.estimatedTokens = estimateContextTokens(summarized);
    return summarized;
  }

  private microCompact(messages: DeepSeekMessage[]): DeepSeekMessage[] {
    const toolIndexes = messages
      .map((message, index) => (message.role === "tool" ? index : -1))
      .filter((index) => index >= 0);
    const keepIndexes = new Set(toolIndexes.slice(-this.options.recentToolResults));
    let changed = false;

    const compacted = messages.map((message, index) => {
      if (message.role !== "tool" || keepIndexes.has(index) || !message.content || isCompactedToolResult(message.content)) {
        return message;
      }

      const persisted = this.ensurePersistedToolContent(message.content, "unknown_tool", "micro-compact");
      changed = true;
      return {
        ...message,
        content: JSON.stringify(
          {
            kind: "compacted-tool-result",
            reason: "micro-compact",
            note: "旧工具结果已从活跃上下文移出；完整内容可通过 persisted-output 路径恢复。",
            persistedOutput: persisted
          },
          null,
          2
        )
      };
    });

    if (changed) {
      this.state.hasCompacted = true;
      this.state.compactedMessageCount += 1;
      this.state.lastCompactedAt = new Date().toISOString();
    }

    return compacted;
  }

  private shouldSummaryCompact(messages: DeepSeekMessage[]): boolean {
    const estimatedTokens = estimateContextTokens(messages);
    const threshold = Math.floor(this.options.contextWindowTokens * this.options.summaryTriggerRatio);
    return estimatedTokens >= threshold || estimatedTokens >= this.options.contextWindowTokens;
  }

  private summaryCompact(messages: DeepSeekMessage[], context: CompactContext, manual: boolean): DeepSeekMessage[] {
    const summary = buildStructuredSummary(context, this.state, manual);
    const baseSystem = messages.find((message) => message.role === "system") || { role: "system" as const, content: "" };
    const tail = selectActiveTail(messages, this.options.keepRecentMessages);
    this.state.hasCompacted = true;
    this.state.lastSummary = summary;
    this.state.compactedMessageCount += 1;
    this.state.lastCompactedAt = new Date().toISOString();

    return [
      baseSystem,
      {
        role: "system",
        content: summary
      },
      ...tail
    ];
  }

  private ensurePersistedToolContent(
    content: string,
    toolName: string,
    reason: PersistedOutputReference["reason"]
  ): PersistedOutputReference {
    const existing = parsePersistedOutput(content);
    if (existing) {
      this.trackPersistedOutput(existing);
      return existing;
    }

    return this.persistOutput(toolName, content, reason);
  }

  private persistOutput(toolName: string, content: string, reason: PersistedOutputReference["reason"]): PersistedOutputReference {
    const outputDir = path.join(this.options.outputDir, sanitizePathPart(this.sessionId));
    mkdirSync(outputDir, { recursive: true });

    const id = randomUUID();
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
    const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-${sanitizePathPart(toolName)}-${hash}.txt`;
    const filePath = path.join(outputDir, filename);
    writeFileSync(filePath, content, "utf8");

    const reference: PersistedOutputReference = {
      kind: "persisted-output",
      id,
      toolName,
      path: filePath,
      relativePath: path.relative(process.cwd(), filePath),
      bytes: Buffer.byteLength(content, "utf8"),
      preview: truncate(content, this.options.previewChars),
      reason,
      createdAt: new Date().toISOString()
    };
    this.trackPersistedOutput(reference);
    return reference;
  }

  private trackPersistedOutput(reference: PersistedOutputReference): void {
    if (!this.state.persistedOutputs.some((item) => item.path === reference.path)) {
      this.state.persistedOutputs.push(reference);
    }

    this.state.recentFiles = [reference.relativePath, ...this.state.recentFiles.filter((file) => file !== reference.relativePath)].slice(0, 20);
  }
}

export function estimateContextTokens(messages: DeepSeekMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

export function getDefaultContextBudgetOptions(): ContextBudgetOptions {
  return {
    outputDir: process.env.CONTEXT_OUTPUT_DIR?.trim() || path.resolve(process.cwd(), ".agent-data", "tool-outputs"),
    inlineCharLimit: readPositiveInt("TOOL_OUTPUT_INLINE_CHAR_LIMIT", DEFAULT_INLINE_CHAR_LIMIT),
    previewChars: readPositiveInt("TOOL_OUTPUT_PREVIEW_CHARS", DEFAULT_PREVIEW_CHARS),
    recentToolResults: readPositiveInt("MICRO_COMPACT_RECENT_TOOL_RESULTS", DEFAULT_RECENT_TOOL_RESULTS),
    contextWindowTokens: readPositiveInt("CONTEXT_WINDOW_TOKENS", DEFAULT_CONTEXT_WINDOW_TOKENS),
    summaryTriggerRatio: readRatio("CONTEXT_SUMMARY_TRIGGER_RATIO", DEFAULT_SUMMARY_TRIGGER_RATIO),
    keepRecentMessages: readPositiveInt("SUMMARY_COMPACT_KEEP_RECENT_MESSAGES", DEFAULT_KEEP_RECENT_MESSAGES)
  };
}

function buildStructuredSummary(context: CompactContext, state: CompactState, manual: boolean): string {
  const completedSteps = context.researchEvents.slice(-12).map((event, index) => {
    const status = event.status === "completed" ? "已完成" : "失败";
    const result = event.status === "completed" ? summarizeToolEventOutput(event.output) : event.error || "未知错误";
    return `${index + 1}. ${event.stepLabel}：${status}。${result}`;
  });

  const recentFiles = state.recentFiles.length > 0 ? state.recentFiles.map((file) => `- ${file}`) : ["- 暂无持久化文件。"];

  return [
    "# 上下文连续性摘要",
    "",
    "## 当前目标",
    context.currentGoal || "继续完成当前调研任务。",
    "",
    "## 已完成步骤",
    ...(completedSteps.length > 0 ? completedSteps : ["暂无已完成工具步骤。"]),
    "",
    "## 涉及文件",
    ...recentFiles,
    "",
    "## 关键决策与约束",
    "- 工具输出超过阈值时必须使用 persisted-output 路径和 preview，不直接注入完整大文本。",
    "- 旧工具结果被 micro compact 后仍可通过 persisted-output 文件恢复，不视为删除。",
    "- 调研回答必须基于真实资料来源，不能伪造来源或把内部工具日志暴露给用户。",
    "- 资料不足时优先补充收集；资料充分后再整理证据并生成中文简报。",
    "",
    "## 下一步行动",
    context.nextAction || inferNextAction(context.researchEvents),
    "",
    "## 压缩状态",
    `- 触发方式：${manual ? "手动 /compact" : "自动上下文预算管理"}`,
    `- 已持久化输出：${state.persistedOutputs.length} 个`,
    `- 估算上下文：${state.estimatedTokens} tokens`
  ].join("\n");
}

function selectActiveTail(messages: DeepSeekMessage[], keepRecentMessages: number): DeepSeekMessage[] {
  const latestUserIndex = findLastIndex(messages, (message) => message.role === "user");
  const startIndex = latestUserIndex >= 0 ? latestUserIndex : Math.max(1, messages.length - keepRecentMessages);
  const tail = messages.slice(startIndex);

  while (tail.length > 0 && tail[0].role === "tool") {
    tail.shift();
  }

  return tail;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) {
      return index;
    }
  }

  return -1;
}

function parsePersistedOutput(content: string): PersistedOutputReference | undefined {
  try {
    const parsed = JSON.parse(content) as PersistedOutputReference;
    return parsed?.kind === "persisted-output" && typeof parsed.path === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isCompactedToolResult(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { kind?: string };
    return parsed?.kind === "compacted-tool-result";
  } catch {
    return false;
  }
}

function summarizeToolEventOutput(output: string | undefined): string {
  if (!output) {
    return "没有可用输出。";
  }

  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    if (typeof parsed.summary === "string") {
      return parsed.summary;
    }
    if (typeof parsed.sourceCount === "number") {
      return `收集到 ${parsed.sourceCount} 条资料。`;
    }
    if (Array.isArray(parsed.keyFindings)) {
      return `形成 ${parsed.keyFindings.length} 条关键发现。`;
    }
  } catch {
    // Fall back to text preview below.
  }

  return truncate(output.replace(/\s+/g, " "), 180);
}

function inferNextAction(events: ResearchToolEvent[]): string {
  const completed = events.filter((event) => event.status === "completed");
  const latest = completed.at(-1);
  if (!latest) {
    return "下一步应先收集资料。";
  }

  if (latest.toolName === "collect_sources") {
    return "下一步应整理证据，判断资料覆盖是否足够。";
  }

  if (latest.toolName === "synthesize_evidence") {
    return "下一步应根据覆盖情况决定补充资料或生成简报。";
  }

  return "下一步应输出最终用户可读结果，避免继续无意义调用工具。";
}

function readPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] || String(fallback));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function readRatio(name: string, fallback: number): number {
  const value = Number(process.env[name] || String(fallback));
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "session";
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}
