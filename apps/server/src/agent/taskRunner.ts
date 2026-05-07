import type { ArtifactStore, ResearchArtifactKind } from "./artifactStore.js";
import type { ContextBudgetManager } from "./contextBudget.js";
import { childAgentProfiles } from "./childRegistry.js";
import { runChildAgent } from "./childLoop.js";
import type { TaskToolArgs } from "./taskTool.js";
import type { ResearchBrief, ResearchSource, ResearchSynthesis } from "../types.js";
import type { ToolExecutionResult } from "../tools/shared/types.js";
import { evaluateCoverage, type CoverageReport } from "../skills/coverageCheck.js";
import { extractEvidenceFromSources, type EvidenceExtraction, type EvidenceItem } from "../skills/evidenceExtraction.js";
import type { ResearchPlan } from "../skills/researchPlanning.js";

export interface TaskRunContext {
  artifactStore: ArtifactStore;
  researchPlan: ResearchPlan;
  contextBudget: ContextBudgetManager;
  turnId: string;
  coverageFeedback?: CoverageReport;
}

interface TaskResultPayload {
  taskType: TaskToolArgs["taskType"];
  artifactRef: string;
  summary: string;
  sourceCount?: number;
  topSources?: Array<Pick<ResearchSource, "title" | "url" | "publisher" | "sourceType">>;
  keyFindings?: string[];
  researchQuestion?: string;
  evaluationCriteria?: string[];
  evidenceGaps?: string[];
  recommendation?: string;
  brief?: Pick<ResearchBrief, "title" | "conclusion" | "content">;
  evidenceExtraction?: CompactEvidenceExtraction;
  coverage?: CoverageReport;
}

interface CompactEvidenceExtraction {
  itemCount: number;
  coveredAspectTags: string[];
  items: Array<Pick<EvidenceItem, "sourceId" | "sourceTitle" | "claims" | "metrics" | "frameworks" | "aspectTags">>;
}

export async function runTaskTool(args: TaskToolArgs, context: TaskRunContext): Promise<ToolExecutionResult> {
  const profile = childAgentProfiles[args.taskType];
  const injectedInput = resolveInjectedInput(args, profile.requiredInputKind, context);
  const childResult = await runChildAgent({
    profile,
    instruction: buildChildInstruction(args, context),
    injectedInput,
    defaultToolArgs: buildDefaultToolArgs(args, context),
    contextBudget: context.contextBudget
  });
  const artifactValue = extractArtifactValue(profile.outputKind, childResult.output);
  const artifact = context.artifactStore.save(profile.outputKind, artifactValue, {
    turnId: context.turnId,
    researchGoal: context.researchPlan.researchGoal
  });
  const payload = buildTaskResultPayload(args, artifact.ref, profile.outputKind, artifactValue, context);

  return {
    output: JSON.stringify(payload, null, 2)
  };
}

function buildDefaultToolArgs(args: TaskToolArgs, context: TaskRunContext): Record<string, unknown> | undefined {
  if (args.taskType === "collect_sources" && context.coverageFeedback?.shouldCollectMore) {
    return {
      topic: context.coverageFeedback.suggestedQueries[0] || context.researchPlan.researchGoal,
      sourceTypes: getDefaultSourceTypes(),
      maxResults: 6,
      recency: "balanced"
    };
  }

  if (args.taskType === "synthesize_evidence") {
    return {
      focus: context.researchPlan.researchGoal || args.instruction,
      outputFormat: "decision_brief"
    };
  }

  if (args.taskType === "write_brief") {
    return {
      audience: inferAudience(args.instruction),
      length: "medium"
    };
  }

  return undefined;
}

function buildChildInstruction(args: TaskToolArgs, context: TaskRunContext): string {
  if (args.taskType !== "collect_sources" || !context.coverageFeedback?.shouldCollectMore) {
    return args.instruction;
  }

  return [
    args.instruction,
    "",
    "上一轮证据整理后的覆盖率反馈：",
    `- 覆盖率：${Math.round(context.coverageFeedback.coverageScore * 100)}%`,
    `- 仍缺：${context.coverageFeedback.missingAspects.join("、") || "未识别到具体缺口"}`,
    `- 建议补充检索：${context.coverageFeedback.suggestedQueries.join("；") || context.researchPlan.searchQueries.join("；")}`,
    "本次资料收集必须优先围绕上述缺口补资料，不要重复泛泛搜索原始主题。"
  ].join("\n");
}

function getDefaultSourceTypes(): Array<"web" | "papers"> {
  return process.env.SEARCH_API_KEY?.trim() ? ["web", "papers"] : ["papers"];
}

function inferAudience(instruction: string): "self_learning" | "team_lead" | "presentation" | "interview" {
  if (/组长|leader|lead|经理|主管/.test(instruction)) {
    return "team_lead";
  }
  if (/汇报|展示|presentation|slide|演示/.test(instruction)) {
    return "presentation";
  }
  if (/面试|interview/.test(instruction)) {
    return "interview";
  }

  return "self_learning";
}

function resolveInjectedInput(
  args: TaskToolArgs,
  requiredKind: ResearchArtifactKind | undefined,
  context: TaskRunContext
): unknown {
  if (!requiredKind) {
    return undefined;
  }

  if (args.inputRef) {
    const artifact = context.artifactStore.get(args.inputRef, requiredKind);
    if (!artifact) {
      throw new Error(`找不到可用于该子任务的结果引用：${args.inputRef}`);
    }
    return artifact.value;
  }

  if (requiredKind === "sources") {
    const sourceArtifacts = context.artifactStore.list<ResearchSource[]>("sources", { turnId: context.turnId });
    const sources = dedupeSources(sourceArtifacts.flatMap((artifact) => artifact.value));
    if (sources.length === 0) {
      throw new Error(`当前轮次缺少 ${requiredKind} 结果，无法执行 ${args.taskType}。如需复用上一轮结果，请显式传入 inputRef。`);
    }

    return sources;
  }

  const latest = context.artifactStore.latest(requiredKind, { turnId: context.turnId });
  if (!latest) {
    throw new Error(`当前轮次缺少 ${requiredKind} 结果，无法执行 ${args.taskType}。如需复用上一轮结果，请显式传入 inputRef。`);
  }

  return latest.value;
}

function dedupeSources(sources: ResearchSource[]): ResearchSource[] {
  const byUrl = new Map<string, ResearchSource>();

  for (const source of sources) {
    const key = normalizeSourceUrl(source.url);
    const existing = byUrl.get(key);
    if (!existing || combinedScore(source) > combinedScore(existing)) {
      byUrl.set(key, source);
    }
  }

  return [...byUrl.values()].sort((left, right) => combinedScore(right) - combinedScore(left));
}

function normalizeSourceUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.trim().toLowerCase();
  }
}

function combinedScore(source: ResearchSource): number {
  return source.relevanceScore * 0.6 + source.credibilityScore * 0.4;
}

function extractArtifactValue(kind: ResearchArtifactKind, output: string): unknown {
  const parsed = parseJson<Record<string, unknown>>(output);
  if (!parsed) {
    throw new Error("子智能体工具返回了无效 JSON。");
  }

  if (kind === "sources") {
    if (!Array.isArray(parsed.sources)) {
      throw new Error("资料收集结果缺少 sources。");
    }
    return parsed.sources as ResearchSource[];
  }

  if (kind === "synthesis") {
    if (!parsed.synthesis || typeof parsed.synthesis !== "object") {
      throw new Error("证据整理结果缺少 synthesis。");
    }
    return parsed.synthesis as ResearchSynthesis;
  }

  if (!parsed.brief || typeof parsed.brief !== "object") {
    throw new Error("简报生成结果缺少 brief。");
  }
  return parsed.brief as ResearchBrief;
}

function buildTaskResultPayload(
  args: TaskToolArgs,
  artifactRef: string,
  kind: ResearchArtifactKind,
  value: unknown,
  context: TaskRunContext
): TaskResultPayload {
  if (kind === "sources") {
    const sources = value as ResearchSource[];
    const evidenceExtraction = extractEvidenceFromSources(sources, context.researchPlan);
    return {
      taskType: args.taskType,
      artifactRef,
      summary: `收集到 ${sources.length} 条候选资料。`,
      sourceCount: sources.length,
      topSources: sources.slice(0, 3).map((source) => ({
        title: source.title,
        url: source.url,
        publisher: source.publisher,
        sourceType: source.sourceType
      })),
      evidenceExtraction: compactEvidenceExtraction(evidenceExtraction)
    };
  }

  if (kind === "synthesis") {
    const synthesis = value as ResearchSynthesis;
    const allSources = dedupeSources(
      context.artifactStore.list<ResearchSource[]>("sources", { turnId: context.turnId }).flatMap((artifact) => artifact.value)
    );
    const evidenceExtraction = extractEvidenceFromSources(allSources, context.researchPlan);
    const coverage = evaluateCoverage({
      plan: context.researchPlan,
      sources: allSources,
      synthesis,
      evidence: evidenceExtraction
    });

    return {
      taskType: args.taskType,
      artifactRef,
      summary: `形成 ${synthesis.keyFindings.length} 条关键发现，并给出初步建议。`,
      researchQuestion: synthesis.researchQuestion,
      evaluationCriteria: synthesis.evaluationCriteria,
      evidenceGaps: synthesis.evidenceGaps,
      keyFindings: synthesis.keyFindings,
      recommendation: synthesis.recommendation,
      coverage
    };
  }

  const brief = value as ResearchBrief;
  return {
    taskType: args.taskType,
    artifactRef,
    summary: `生成《${brief.title}》。`,
    brief: {
      title: brief.title,
      conclusion: brief.conclusion,
      content: brief.content
    }
  };
}

function compactEvidenceExtraction(extraction: EvidenceExtraction): CompactEvidenceExtraction {
  return {
    itemCount: extraction.itemCount,
    coveredAspectTags: extraction.coveredAspectTags,
    items: extraction.items.slice(0, 5).map((item) => ({
      sourceId: item.sourceId,
      sourceTitle: item.sourceTitle,
      claims: item.claims.slice(0, 3),
      metrics: item.metrics.slice(0, 6),
      frameworks: item.frameworks.slice(0, 6),
      aspectTags: item.aspectTags
    }))
  };
}

function parseJson<T>(output: string): T | undefined {
  try {
    return JSON.parse(output) as T;
  } catch {
    return undefined;
  }
}
