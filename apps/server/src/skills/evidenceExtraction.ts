import type { ResearchSource } from "../types.js";
import type { ResearchPlan } from "./researchPlanning.js";

export interface EvidenceItem {
  sourceId: string;
  sourceTitle: string;
  claims: string[];
  metrics: string[];
  frameworks: string[];
  limitations: string[];
  aspectTags: string[];
}

export interface EvidenceExtraction {
  itemCount: number;
  coveredAspectTags: string[];
  items: EvidenceItem[];
}

const FRAMEWORKS = ["RAGAS", "TruLens", "ARES", "DeepEval", "LangSmith", "MemGPT", "Letta", "LangGraph", "Zep", "Mem0", "CrewAI"];
const METRICS = [
  "faithfulness",
  "answer relevancy",
  "answer relevance",
  "context precision",
  "context recall",
  "recall",
  "precision",
  "MRR",
  "nDCG",
  "latency",
  "cost",
  "faithfulness",
  "relevance",
  "context",
  "retrieval quality",
  "generation quality"
];
const LIMITATION_TERMS = ["limitation", "pitfall", "risk", "bias", "cost", "manual", "human review", "cost", "pitfall", "risk"];

export function extractEvidenceFromSources(sources: ResearchSource[], plan?: ResearchPlan): EvidenceExtraction {
  const items = sources.map((source) => extractEvidenceItem(source, plan));
  const coveredAspectTags = [...new Set(items.flatMap((item) => item.aspectTags))];

  return {
    itemCount: items.length,
    coveredAspectTags,
    items
  };
}

export function summarizeEvidenceForModel(extraction: EvidenceExtraction): string {
  const topItems = extraction.items.slice(0, 5);
  return [
    `evidence_extraction_skill: extracted evidence hints from ${extraction.itemCount} sources.`,
    `Coverage tags: ${extraction.coveredAspectTags.join(", ") || "Not identified"}`,
    ...topItems.map((item) =>
      [
        `- Source: ${item.sourceTitle}`,
        item.frameworks.length > 0 ? `  Frameworks: ${item.frameworks.join(", ")}` : "",
        item.metrics.length > 0 ? `  Metrics: ${item.metrics.join(", ")}` : "",
        item.claims.length > 0 ? `  Evidence hints: ${item.claims.join("; ")}` : ""
      ]
        .filter(Boolean)
        .join("\n")
    )
  ].join("\n");
}

function extractEvidenceItem(source: ResearchSource, plan?: ResearchPlan): EvidenceItem {
  const text = `${source.title} ${source.summary}`;
  const frameworks = findMatches(text, FRAMEWORKS);
  const metrics = findMatches(text, METRICS);
  const limitations = findMatches(text, LIMITATION_TERMS);
  const aspectTags = inferAspectTags(text, frameworks, metrics, plan);
  const claims = buildClaims(source, frameworks, metrics, limitations, aspectTags);

  return {
    sourceId: source.id,
    sourceTitle: source.title,
    claims,
    metrics,
    frameworks,
    limitations,
    aspectTags
  };
}

function buildClaims(
  source: ResearchSource,
  frameworks: string[],
  metrics: string[],
  limitations: string[],
  aspectTags: string[]
): string[] {
  const claims: string[] = [];

  if (frameworks.length > 0) {
    claims.push(`The source mentions ${frameworks.join(", ")}; inspect it for framework comparison.`);
  }
  if (metrics.length > 0) {
    claims.push(`Metric terms include ${metrics.slice(0, 5).join(", ")}.`);
  }
  if (limitations.length > 0) {
    claims.push("The source discusses limitations such as cost, risk, or human review.");
  }
  if (aspectTags.length > 0) {
    claims.push(`The source may inform these aspects: ${aspectTags.join(", ")}.`);
  }
  if (claims.length === 0) {
    claims.push(`The abstract provides background for "${source.title}"; verify the original text.`);
  }

  return claims;
}

function inferAspectTags(text: string, frameworks: string[], metrics: string[], plan?: ResearchPlan): string[] {
  const normalized = text.toLowerCase();
  const tags: string[] = [];

  if (/dimension|metric|faithfulness|recall|precision|quality/.test(normalized) || metrics.length > 0) {
    tags.push("Key evaluation metrics");
  }
  if (/retrieval|context|context/.test(normalized)) {
    tags.push("Core evaluation dimensions");
  }
  if (frameworks.length > 0 || /framework|tool/.test(normalized)) {
    tags.push("Evaluation framework comparison");
    if (/memory|memgpt|letta|langgraph|zep|mem0|crewai/.test(normalized)) {
      tags.push("Memory framework comparison");
    }
  }
  if (/memory|short-term|long-term|episodic|semantic|procedural|working memory/.test(normalized)) {
    tags.push("Memory models and core concepts");
  }
  if (/dataset|benchmark|rgb|crud|kilt|natural questions/.test(normalized)) {
    tags.push("Evaluation datasets and benchmarks");
  }
  if (/practice|pitfall|production|best/.test(normalized)) {
    tags.push("Best practices and common pitfalls");
  }

  if (plan) {
    return tags.filter((tag) => isPlannedAspect(tag, plan));
  }

  return [...new Set(tags)];
}

function isPlannedAspect(tag: string, plan: ResearchPlan): boolean {
  return [...plan.requiredAspects, ...plan.optionalAspects].some((aspect) => aspect === tag || aspect.includes(tag));
}

function findMatches(text: string, candidates: string[]): string[] {
  const normalized = text.toLowerCase();
  return candidates.filter((candidate) => normalized.includes(candidate.toLowerCase()));
}
