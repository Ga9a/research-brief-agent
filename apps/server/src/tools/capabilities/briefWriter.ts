import { z } from "zod";
import type { DeepSeekToolDefinition } from "../../agent/deepseek.js";
import type { ResearchBrief } from "../../types.js";
import type { ToolExecutionResult } from "../shared/types.js";
import { audienceSchema, lengthSchema, parseToolInput, researchSynthesisSchema } from "../shared/researchSchemas.js";

const briefWriterSchema = z.object({
  synthesis: researchSynthesisSchema,
  audience: audienceSchema.default("self_learning"),
  length: lengthSchema.default("medium")
});

type BriefWriterInput = z.infer<typeof briefWriterSchema>;

export const briefWriterDefinition: DeepSeekToolDefinition = {
  type: "function",
  function: {
    name: "brief_writer",
    description:
      "把 evidence_synthesizer 的结构化结果改写成自然、清晰、面向用户的调研简报。必须在证据整理完成后使用。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        audience: {
          type: "string",
          description:
            "可选。简报面向的读者，只能是 self_learning、team_lead、presentation、interview；默认 self_learning。不要传 synthesis，后端会自动使用 evidence_synthesizer 的结果。",
          enum: ["self_learning", "team_lead", "presentation", "interview"],
          default: "self_learning"
        },
        length: {
          type: "string",
          description: "可选。简报长度，只能是 short、medium、detailed；默认 medium。",
          enum: ["short", "medium", "detailed"],
          default: "medium"
        }
      }
    }
  }
};

export async function runBriefWriter(args: unknown): Promise<ToolExecutionResult> {
  const input = parseToolInput(briefWriterSchema, args, "brief_writer");
  const brief = buildBrief(input);

  return {
    output: JSON.stringify({ brief }, null, 2)
  };
}

function buildBrief(input: BriefWriterInput): ResearchBrief {
  const audienceLabel = getAudienceLabel(input.audience);
  const title = buildBriefTitle(input.synthesis.focus);
  const conclusion = `${audienceLabel}版本的核心结论：${input.synthesis.recommendation}`;
  const findingLimit = input.length === "short" ? 2 : input.synthesis.keyFindings.length;
  const riskLimit = input.length === "detailed" ? input.synthesis.risksOrLimitations.length : 2;
  const keyFindings = input.synthesis.keyFindings.slice(0, findingLimit);
  const risks = input.synthesis.risksOrLimitations.slice(0, riskLimit);
  const frameworkComparisons = selectFrameworkComparisons(input.synthesis.comparisons);
  const comparisonAnalysis = input.synthesis.comparisons.map((item) => `| ${item.dimension} | ${item.notes} |`).join("\n");
  const suggestedQuestions = [
    "我们这次调研最需要支持哪一个决策？",
    "现有资料是否足以支撑结论，哪些地方还需要真实数据？",
    "如果进入落地阶段，第一轮验证应该控制在什么范围内？"
  ];
  const nextSteps = [
    "核对关键资料的原文出处和适用范围。",
    "把关键发现转成可复用的检查清单。",
    "用一个小样本案例验证推荐方案是否可执行。"
  ];
  const content = renderMarkdownBrief({
    title,
    conclusion,
    researchQuestion: input.synthesis.researchQuestion,
    keyFindings,
    frameworkComparisons,
    comparisons: input.synthesis.comparisons,
    evaluationCriteria: input.synthesis.evaluationCriteria || [],
    evidenceRequirements: input.synthesis.evidenceRequirements || [],
    evidenceGaps: input.synthesis.evidenceGaps || [],
    risks,
    suggestedQuestions,
    nextSteps,
    length: input.length
  });

  return {
    title,
    conclusion,
    researchQuestion: input.synthesis.researchQuestion,
    evaluationCriteria: input.synthesis.evaluationCriteria,
    evidenceGaps: input.synthesis.evidenceGaps,
    keyFindings,
    comparisonAnalysis,
    suggestedQuestions,
    nextSteps,
    content
  };
}

function buildBriefTitle(focus: string): string {
  if (isMemoryFocus(focus)) {
    return "agent/LLM 记忆框架选型调研简报";
  }

  const normalized = focus.replace(/\s+/g, " ").trim();
  const shortTopic =
    normalized
      .split(/包括|需要|其中|重点|，|,|。|；|;|：|:|\n/)
      .map((segment) => segment.trim())
      .find(Boolean) || normalized;
  const cleanedTopic = shortTopic
    .replace(/^(请|请你|帮我|需要|围绕|关于|针对)\s*/, "")
    .replace(/^(研究|调研|分析|整理)\s*/, "")
    .replace(/(调研简报|简报|报告)$/u, "")
    .trim();
  const boundedTopic = truncateTitleTopic(cleanedTopic || "调研主题");

  return `${boundedTopic}调研简报`;
}

function truncateTitleTopic(topic: string): string {
  const maxLength = 28;
  return topic.length > maxLength ? topic.slice(0, maxLength) : topic;
}

function getAudienceLabel(audience: BriefWriterInput["audience"]): string {
  const labels: Record<BriefWriterInput["audience"], string> = {
    self_learning: "个人学习",
    team_lead: "组长讨论",
    presentation: "汇报展示",
    interview: "面试准备"
  };
  return labels[audience];
}

function renderMarkdownBrief(input: {
  title: string;
  conclusion: string;
  researchQuestion?: string;
  keyFindings: string[];
  frameworkComparisons: Array<{ dimension: string; notes: string }>;
  comparisons: Array<{ dimension: string; notes: string }>;
  evaluationCriteria: string[];
  evidenceRequirements: string[];
  evidenceGaps: string[];
  risks: string[];
  suggestedQuestions: string[];
  nextSteps: string[];
  length: BriefWriterInput["length"];
}): string {
  const generalComparisons = input.comparisons.filter((item) => !isMemoryFrameworkName(item.dimension));
  const lines = [
    `# ${input.title}`,
    "",
    "## 简要结论",
    input.conclusion,
    "",
    "## 研究问题",
    input.researchQuestion || "当前问题仍偏开放，建议先明确是选型、设计方案、做 benchmark，还是形成学习路线。",
    "",
    "## 评估标准",
    ...(input.evaluationCriteria.length > 0 ? input.evaluationCriteria.map((criterion) => `- ${criterion}`) : ["- 暂未形成明确评估标准。"]),
    "",
    "## 关键发现",
    ...input.keyFindings.map((finding) => `- ${finding}`),
    "",
    ...renderFrameworkComparisonSection(input.frameworkComparisons),
    ...(input.frameworkComparisons.length > 0 ? [""] : []),
    "## 对比分析",
    "| 维度 | 观察 |",
    "| --- | --- |",
    ...(generalComparisons.length > 0
      ? generalComparisons.map((item) => `| ${item.dimension} | ${item.notes} |`)
      : ["| 选型取舍 | 具体框架差异见上方候选框架对比表。 |"]),
    "",
    "## 局限性",
    ...input.risks.map((risk) => `- ${risk}`),
    "",
    "## 实验 / 数据缺口",
    ...(input.evidenceRequirements.length > 0 ? input.evidenceRequirements.map((item) => `- 证据要求：${item}`) : []),
    ...(input.evidenceGaps.length > 0 ? input.evidenceGaps.map((gap) => `- 当前缺口：${gap}`) : ["- 当前没有明确实验或数据缺口记录。"]),
    "",
    "## 建议提问",
    ...input.suggestedQuestions.map((question) => `- ${question}`),
    "",
    "## 下一步学习建议",
    ...input.nextSteps.map((step) => `- ${step}`)
  ];

  if (input.length === "detailed") {
    lines.push(
      "",
      "## 使用建议",
      "可以先把这份简报作为讨论提纲，再根据真实资料补充引用、案例和数据。重点不是一次性覆盖所有信息，而是让问题、证据和下一步动作保持一致。"
    );
  }

  return lines.join("\n");
}

function selectFrameworkComparisons(comparisons: Array<{ dimension: string; notes: string }>) {
  return comparisons.filter((item) => isMemoryFrameworkName(item.dimension));
}

function renderFrameworkComparisonSection(comparisons: Array<{ dimension: string; notes: string }>): string[] {
  if (comparisons.length === 0) {
    return [];
  }

  return [
    "## 候选框架对比",
    "| 框架/方案 | 适用场景与验证重点 |",
    "| --- | --- |",
    ...comparisons.map((item) => `| ${item.dimension} | ${item.notes} |`)
  ];
}

function isMemoryFrameworkName(value: string): boolean {
  return /^(Mem0|Letta\/MemGPT|Zep|LangGraph Memory|CrewAI Memory|自研轻量记忆层)$/.test(value);
}

function isMemoryFocus(value: string): boolean {
  return /memory|memgpt|mem0|letta|zep|long[-\s]?term|记忆|长期记忆|记忆框架|上下文记忆/i.test(value);
}
