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
      ? `当前覆盖 ${Math.round(coverageScore * 100)}%，仍缺少：${missingAspects.join("、")}。`
      : `当前覆盖 ${Math.round(coverageScore * 100)}%，可以基于已有证据生成或完善简报。`
  };
}

export function renderCoverageForModel(report: CoverageReport): string {
  return [
    "coverage_check_skill 输出：",
    `覆盖率：${Math.round(report.coverageScore * 100)}%`,
    `已覆盖：${report.coveredAspects.join("、") || "暂无"}`,
    `缺口：${report.missingAspects.join("、") || "暂无"}`,
    `是否建议追加资料：${report.shouldCollectMore ? "是" : "否"}`,
    report.suggestedQueries.length > 0 ? `建议补充检索：${report.suggestedQueries.join("；")}` : "",
    `判断依据：${report.rationale}`
  ]
    .filter(Boolean)
    .join("\n");
}

function aspectAppearsCovered(aspect: string, text: string): boolean {
  const keywords = [...getGenericAspectKeywords(aspect), ...getAspectKeywords(aspect)];
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

function getGenericAspectKeywords(aspect: string): string[] {
  if (aspect.includes("记忆模型") || aspect.includes("记忆框架")) {
    return [
      "memory",
      "working memory",
      "short-term",
      "long-term",
      "episodic",
      "semantic",
      "procedural",
      "memgpt",
      "letta",
      "mem0",
      "zep",
      "langgraph",
      "记忆",
      "短期",
      "长期",
      "语义",
      "事件",
      "程序性",
      "框架"
    ];
  }
  if (aspect.includes("核心概念")) {
    return ["核心概念", "concept", "definition", "overview", "introduction", "概念", "定义", "边界"];
  }
  if (aspect.includes("主要方法")) {
    return ["主要方法", "method", "approach", "framework", "architecture", "框架", "方法", "方案"];
  }
  if (aspect.includes("对比维度")) {
    return ["对比维度", "comparison", "dimension", "tradeoff", "compare", "对比", "维度", "取舍"];
  }
  if (aspect.includes("风险") || aspect.includes("限制")) {
    return ["risk", "limitation", "pitfall", "challenge", "风险", "限制", "局限", "挑战", "成本"];
  }
  if (aspect.includes("实践建议")) {
    return ["recommendation", "practice", "best practice", "next step", "建议", "实践", "落地", "下一步"];
  }
  if (aspect.includes("研究问题") || aspect.includes("决策场景")) {
    return ["research question", "decision", "selection", "design", "benchmark", "研究问题", "决策", "选型", "设计"];
  }
  if (aspect.includes("评估指标") || aspect.includes("基准方法")) {
    return ["metric", "benchmark", "hit rate", "latency", "cost", "personalization", "评估", "指标", "基准", "命中率", "延迟", "成本", "个性化"];
  }
  if (aspect.includes("实验设计") || aspect.includes("数据需求")) {
    return ["experiment", "dataset", "baseline", "ablation", "poc", "实验", "数据", "对照组", "基线"];
  }
  return [];
}

function getAspectKeywords(aspect: string): string[] {
  if (aspect.includes("维度")) {
    return ["dimension", "retrieval", "generation", "end-to-end", "检索", "生成", "端到端"];
  }
  if (aspect.includes("指标")) {
    return ["metric", "faithfulness", "relevancy", "recall", "precision", "指标", "忠实度", "相关性"];
  }
  if (aspect.includes("框架")) {
    return ["ragas", "trulens", "ares", "deepeval", "langsmith", "framework", "框架"];
  }
  if (aspect.includes("数据集") || aspect.includes("基准")) {
    return ["dataset", "benchmark", "rgb", "crud", "kilt", "natural questions", "数据集", "基准"];
  }
  if (aspect.includes("实践") || aspect.includes("陷阱")) {
    return ["practice", "pitfall", "production", "risk", "best", "实践", "陷阱", "风险"];
  }

  return aspect.split(/\s+|、|，|,|\/|-/).filter(Boolean);
}

function roundScore(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}
