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
  if (args.taskType === "collect_sources") {
    return {
      topic: buildCollectionTopic(context),
      sourceTypes: getDefaultSourceTypes(),
      maxResults: context.coverageFeedback?.shouldCollectMore ? 6 : 10,
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
    "Coverage feedback from the latest synthesis:",
    `- Coverage: ${Math.round(context.coverageFeedback.coverageScore * 100)}%`,
    `- Missing: ${context.coverageFeedback.missingAspects.join(", ") || "no specific gaps identified"}`,
    `- Additional queries: ${context.coverageFeedback.suggestedQueries.join("; ") || context.researchPlan.searchQueries.join("; ")}`,
    "Target the listed gaps rather than repeating a broad search for the original topic."
  ].join("\n");
}

function getDefaultSourceTypes(): Array<"web" | "papers"> {
  return process.env.SEARCH_API_KEY?.trim() ? ["web", "papers"] : ["papers"];
}

function buildCollectionTopic(context: TaskRunContext): string {
  const query =
    context.coverageFeedback?.suggestedQueries[0] ||
    context.researchPlan.searchQueries.find((item) => /memgpt|mem0|letta|zep|langgraph|crewai|framework/i.test(item)) ||
    context.researchPlan.searchQueries[0] ||
    context.researchPlan.researchGoal;

  return truncateToolString(`${context.researchPlan.researchGoal} ${query}`, 200);
}

function truncateToolString(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function inferAudience(instruction: string): "self_learning" | "team_lead" | "presentation" | "interview" {
  if (/team discussion|team lead|leader|lead|manager|supervisor/.test(instruction)) {
    return "team_lead";
  }
  if (/presentation|slide|demo/.test(instruction)) {
    return "presentation";
  }
  if (/interview/.test(instruction)) {
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
      throw new Error(`No result reference found for this task: ${args.inputRef}`);
    }
    return artifact.value;
  }

  if (requiredKind === "sources") {
    const sourceArtifacts = context.artifactStore.list<ResearchSource[]>("sources", { turnId: context.turnId });
    const sources = dedupeSources(sourceArtifacts.flatMap((artifact) => artifact.value));
    if (sources.length === 0) {
      throw new Error(`This turn is missing a ${requiredKind} result for ${args.taskType}. To reuse an earlier result, supply inputRef explicitly.`);
    }

    return sources;
  }

  const latest = context.artifactStore.latest(requiredKind, { turnId: context.turnId });
  if (!latest) {
    throw new Error(`This turn is missing a ${requiredKind} result for ${args.taskType}. To reuse an earlier result, supply inputRef explicitly.`);
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
    throw new Error("The child tool returned invalid JSON.");
  }

  if (kind === "sources") {
    if (!Array.isArray(parsed.sources)) {
      throw new Error("The collection result is missing sources.");
    }
    return parsed.sources as ResearchSource[];
  }

  if (kind === "synthesis") {
    if (!parsed.synthesis || typeof parsed.synthesis !== "object") {
      throw new Error("The synthesis result is missing synthesis.");
    }
    return parsed.synthesis as ResearchSynthesis;
  }

  if (!parsed.brief || typeof parsed.brief !== "object") {
    throw new Error("The writing result is missing brief.");
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
      summary: `Collected ${sources.length} candidate sources.`,
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
      summary: `Identified ${synthesis.keyFindings.length} key findings and initial recommendations.`,
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
    summary: `Created "${brief.title}".`,
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
