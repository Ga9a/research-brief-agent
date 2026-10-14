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
      "Write a clear English research brief from evidence_synthesizer results. Use after evidence synthesis.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        audience: {
          type: "string",
          description:
            "Optional audience: self_learning, team_lead, presentation, or interview. Defaults to self_learning. The server injects synthesis.",
          enum: ["self_learning", "team_lead", "presentation", "interview"],
          default: "self_learning"
        },
        length: {
          type: "string",
          description: "Optional length: short, medium, or detailed. Defaults to medium.",
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
  const conclusion = `${audienceLabel} conclusion: ${input.synthesis.recommendation}`;
  const findingLimit = input.length === "short" ? 2 : input.synthesis.keyFindings.length;
  const riskLimit = input.length === "detailed" ? input.synthesis.risksOrLimitations.length : 2;
  const keyFindings = input.synthesis.keyFindings.slice(0, findingLimit);
  const risks = input.synthesis.risksOrLimitations.slice(0, riskLimit);
  const frameworkComparisons = selectFrameworkComparisons(input.synthesis.comparisons);
  const comparisonAnalysis = input.synthesis.comparisons.map((item) => `| ${item.dimension} | ${item.notes} |`).join("\n");
  const suggestedQuestions = [
    "Which decision should this research support?",
    "Does the evidence support the conclusion, and where is real data still needed?",
    "What should the first implementation validation cover?"
  ];
  const nextSteps = [
    "Verify the original sources and their scope.",
    "Turn the key findings into a reusable checklist.",
    "Validate the recommendation with a small representative case."
  ];
  const content = renderMarkdownBrief({
    title,
    conclusion,
    references: input.synthesis.references || [],
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
    return "Agent/LLM memory framework selection brief";
  }

  const normalized = focus.replace(/\s+/g, " ").trim();
  const shortTopic =
    normalized
      .split(/including|with focus on|[,.;:\n]/i)
      .map((segment) => segment.trim())
      .find(Boolean) || normalized;
  const cleanedTopic = shortTopic
    .replace(/^(?:please|help me|about|regarding)\s+/i, "")
    .replace(/^(?:research|analyze|summarize)\s+/i, "")
    .replace(/(?:research brief|brief|report)$/i, "")
    .trim();
  const boundedTopic = truncateTitleTopic(cleanedTopic || "Research topic");

  return `${boundedTopic} Research brief`;
}

function truncateTitleTopic(topic: string): string {
  const maxLength = 80;
  return topic.length > maxLength ? topic.slice(0, maxLength) : topic;
}

function getAudienceLabel(audience: BriefWriterInput["audience"]): string {
  const labels: Record<BriefWriterInput["audience"], string> = {
    self_learning: "Self study",
    team_lead: "Team discussion",
    presentation: "Presentation",
    interview: "Interview preparation"
  };
  return labels[audience];
}

function renderMarkdownBrief(input: {
  title: string;
  conclusion: string;
  references: Array<{ title: string; url: string }>;
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
    "## Conclusion",
    input.conclusion,
    "",
    "## Research question",
    input.researchQuestion || "Clarify whether the goal is framework selection, system design, benchmarking, or a learning plan.",
    "",
    "## Evaluation criteria",
    ...(input.evaluationCriteria.length > 0 ? input.evaluationCriteria.map((criterion) => `- ${criterion}`) : ["- No explicit evaluation criteria have been established."]),
    "",
    "## Key findings",
    ...input.keyFindings.map((finding) => `- ${finding}`),
    "",
    ...renderFrameworkComparisonSection(input.frameworkComparisons),
    ...(input.frameworkComparisons.length > 0 ? [""] : []),
    "## Comparison",
    "| Dimension | Observation |",
    "| --- | --- |",
    ...(generalComparisons.length > 0
      ? generalComparisons.map((item) => `| ${item.dimension} | ${item.notes} |`)
      : ["| Selection trade-offs | See the framework comparison above for individual differences. |"]),
    "",
    "## Limitations",
    ...input.risks.map((risk) => `- ${risk}`),
    "",
    "## Experiment and data gaps",
    ...(input.evidenceRequirements.length > 0 ? input.evidenceRequirements.map((item) => `- Evidence requirements: ${item}`) : []),
    ...(input.evidenceGaps.length > 0 ? input.evidenceGaps.map((gap) => `- Current gap: ${gap}`) : ["- No specific experiment or data gaps have been recorded."]),
    "",
    "## Suggested questions",
    ...input.suggestedQuestions.map((question) => `- ${question}`),
    "",
    "## Next steps",
    ...input.nextSteps.map((step) => `- ${step}`)
  ];

  if (input.length === "detailed") {
    lines.push(
      "",
      "## How to use this brief",
      "Use this brief as a discussion outline, then add verified references, examples, and data. Keep the research question, evidence, and next steps aligned."
    );
  }

  if (input.references.length > 0) {
    lines.push("", "## Sources", ...input.references.map((source, index) => {
      const title = source.title.replace(/[\[\]\\]/g, " ");
      const url = source.url.replace(/\(/g, "%28").replace(/\)/g, "%29");
      return `${index + 1}. [${title}](${url})`;
    }));
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
    "## Framework comparison",
    "| Framework/approach | Use cases and validation priorities |",
    "| --- | --- |",
    ...comparisons.map((item) => `| ${item.dimension} | ${item.notes} |`)
  ];
}

function isMemoryFrameworkName(value: string): boolean {
  return /^(Mem0|Letta\/MemGPT|Zep|LangGraph Memory|CrewAI Memory|Custom lightweight memory layer)$/.test(value);
}

function isMemoryFocus(value: string): boolean {
  return /memory|memgpt|mem0|letta|zep|long[-\s]?term/i.test(value);
}
