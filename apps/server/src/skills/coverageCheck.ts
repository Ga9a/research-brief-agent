import type { ResearchSource, ResearchSynthesis } from "../types.js";
import type { EvidenceExtraction } from "./evidenceExtraction.js";
import type { ResearchPlan } from "./researchPlanning.js";

export interface CoverageReport {
  coverageScore: number;
  coveredAspects: string[];
  missingAspects: string[];
  shouldCollectMore: boolean;
  suggestedQueries: string[];
  rationale: string;
}

export function evaluateCoverage(input: {
  plan: ResearchPlan;
  sources: ResearchSource[];
  synthesis?: ResearchSynthesis;
  evidence?: EvidenceExtraction;
}): CoverageReport {
  const evidenceTags = new Set(input.evidence?.coveredAspectTags || []);
  const synthesisText = [
    ...(input.synthesis?.keyFindings || []),
    ...(input.synthesis?.comparisons.map((item) => `${item.dimension} ${item.notes}`) || []),
    ...(input.synthesis?.risksOrLimitations || []),
    input.synthesis?.recommendation || ""
  ]
    .join(" ")
    .toLowerCase();
  const sourceText = input.sources.map((source) => `${source.title} ${source.summary}`).join(" ").toLowerCase();
  const combinedText = `${sourceText} ${synthesisText}`;

  const coveredAspects = input.plan.requiredAspects.filter(
    (aspect) => evidenceTags.has(aspect) || aspectAppearsCovered(aspect, combinedText)
  );
  const missingAspects = input.plan.requiredAspects.filter((aspect) => !coveredAspects.includes(aspect));
  const coverageScore = roundScore(coveredAspects.length / Math.max(1, input.plan.requiredAspects.length));
  const shouldCollectMore = coverageScore < 0.75 && input.sources.length < 12 && missingAspects.length > 0;

  return {
    coverageScore,
    coveredAspects,
    missingAspects,
    shouldCollectMore,
    suggestedQueries: missingAspects.map((aspect) => `${input.plan.researchGoal} ${aspect}`),
    rationale: shouldCollectMore
      ? `Coverage ${Math.round(coverageScore * 100)}%; missing: ${missingAspects.join(", ")}.`
      : `Coverage ${Math.round(coverageScore * 100)}%; the available evidence can support a preliminary brief.`
  };
}

export function renderCoverageForModel(report: CoverageReport): string {
  return [
    "coverage_check_skill Output: ",
    `Coverage: ${Math.round(report.coverageScore * 100)}%`,
    `Covered: ${report.coveredAspects.join(", ") || "None"}`,
    `Gaps: ${report.missingAspects.join(", ") || "None"}`,
    `Collect more sources: ${report.shouldCollectMore ? "yes" : "no"}`,
    report.suggestedQueries.length > 0 ? `Additional queries: ${report.suggestedQueries.join("; ")}` : "",
    `Rationale: ${report.rationale}`
  ]
    .filter(Boolean)
    .join("\n");
}

function aspectAppearsCovered(aspect: string, text: string): boolean {
  const keywords = [...getGenericAspectKeywords(aspect), ...getAspectKeywords(aspect)];
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

function getGenericAspectKeywords(aspect: string): string[] {
  const name = aspect.toLowerCase();
  if (name.includes("memory models") || name.includes("memory framework"))
    return ["memory", "working memory", "short-term", "long-term", "episodic", "semantic", "procedural", "memgpt", "letta", "mem0", "zep", "langgraph"];
  if (name.includes("core concepts")) return ["concept", "definition", "overview", "introduction"];
  if (name.includes("main methods")) return ["method", "approach", "framework", "architecture"];
  if (name.includes("comparison dimensions")) return ["comparison", "dimension", "tradeoff", "compare"];
  if (name.includes("risk") || name.includes("limitation")) return ["risk", "limitation", "pitfall", "challenge", "cost"];
  if (name.includes("practical recommendations")) return ["recommendation", "practice", "best practice", "next step"];
  if (name.includes("research question") || name.includes("decision context")) return ["research question", "decision", "selection", "design", "benchmark"];
  if (name.includes("evaluation metrics") || name.includes("benchmark methods")) return ["metric", "benchmark", "hit rate", "latency", "cost", "personalization"];
  if (name.includes("experiment design") || name.includes("data requirements")) return ["experiment", "dataset", "baseline", "ablation", "poc"];
  return [];
}

function getAspectKeywords(aspect: string): string[] {
  const name = aspect.toLowerCase();
  if (name.includes("dimensions")) return ["dimension", "retrieval", "generation", "end-to-end"];
  if (name.includes("metrics")) return ["metric", "faithfulness", "relevancy", "recall", "precision"];
  if (name.includes("framework")) return ["ragas", "trulens", "ares", "deepeval", "langsmith", "framework"];
  if (name.includes("datasets") || name.includes("benchmark")) return ["dataset", "benchmark", "rgb", "crud", "kilt", "natural questions"];
  if (name.includes("practice") || name.includes("pitfall")) return ["practice", "pitfall", "production", "risk", "best"];
  return name.split(/\s+|,|\/|-/).filter(Boolean);
}

function roundScore(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}
