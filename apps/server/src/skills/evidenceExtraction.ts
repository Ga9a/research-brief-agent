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
  "忠实度",
  "相关性",
  "上下文",
  "检索质量",
  "生成质量"
];
const LIMITATION_TERMS = ["limitation", "pitfall", "risk", "bias", "cost", "manual", "人工", "成本", "陷阱", "风险"];

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
    `evidence_extraction_skill 输出：已从 ${extraction.itemCount} 条资料中抽取证据线索。`,
    `覆盖标签：${extraction.coveredAspectTags.join("、") || "暂未识别"}`,
    ...topItems.map((item) =>
      [
        `- 来源：${item.sourceTitle}`,
        item.frameworks.length > 0 ? `  框架：${item.frameworks.join("、")}` : "",
        item.metrics.length > 0 ? `  指标：${item.metrics.join("、")}` : "",
        item.claims.length > 0 ? `  线索：${item.claims.join("；")}` : ""
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
    claims.push(`资料提到 ${frameworks.join("、")}，可用于框架对比。`);
  }
  if (metrics.length > 0) {
    claims.push(`资料包含 ${metrics.slice(0, 5).join("、")} 等评估指标线索。`);
  }
  if (limitations.length > 0) {
    claims.push("资料涉及成本、风险或人工复核等限制因素。");
  }
  if (aspectTags.length > 0) {
    claims.push(`资料可支撑“${aspectTags.join("、")}”相关部分。`);
  }
  if (claims.length === 0) {
    claims.push(`资料摘要可作为“${source.title}”的背景线索，但需要进一步核对原文。`);
  }

  return claims;
}

function inferAspectTags(text: string, frameworks: string[], metrics: string[], plan?: ResearchPlan): string[] {
  const normalized = text.toLowerCase();
  const tags: string[] = [];

  if (/dimension|metric|指标|faithfulness|recall|precision|quality|质量/.test(normalized) || metrics.length > 0) {
    tags.push("关键评估指标");
  }
  if (/retrieval|context|检索|上下文/.test(normalized)) {
    tags.push("核心评估维度");
  }
  if (frameworks.length > 0 || /framework|tool|平台|框架/.test(normalized)) {
    tags.push("主流评估框架对比");
    if (/memory|memgpt|letta|langgraph|zep|mem0|crewai|记忆/.test(normalized)) {
      tags.push("主流记忆框架对比");
    }
  }
  if (/memory|short-term|long-term|episodic|semantic|procedural|working memory|记忆|长期|短期|语义|事件|程序性/.test(normalized)) {
    tags.push("记忆模型和核心概念");
  }
  if (/dataset|benchmark|rgb|crud|kilt|natural questions|数据集|基准/.test(normalized)) {
    tags.push("评估数据集和基准测试");
  }
  if (/practice|pitfall|production|best|落地|实践|陷阱|风险/.test(normalized)) {
    tags.push("最佳实践和常见陷阱");
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
