import { z } from "zod";
import type { DeepSeekToolDefinition } from "../../agent/deepseek.js";
import type { ResearchSynthesis } from "../../types.js";
import type { ToolExecutionResult } from "../shared/types.js";
import { outputFormatSchema, parseToolInput, researchSourceSchema } from "../shared/researchSchemas.js";

const evidenceSynthesizerSchema = z.object({
  sources: z.array(researchSourceSchema).min(1),
  focus: z.preprocess((value) => {
    if (typeof value !== "string") {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }, z.string().min(1).max(200).default("Synthesis of collected sources")),
  outputFormat: outputFormatSchema.default("decision_brief")
});

type EvidenceSynthesizerInput = z.infer<typeof evidenceSynthesizerSchema>;

interface MemoryFrameworkProfile {
  name: string;
  aliases: string[];
  position: string;
  bestFor: string;
  verify: string;
}

const MEMORY_FRAMEWORK_PROFILES: MemoryFrameworkProfile[] = [
  {
    name: "Mem0",
    aliases: ["Mem0"],
    position: "Lightweight semantic memory layer / memory API",
    bestFor: "Prototype external memory for user preferences, facts, and conversations",
    verify: "Validate recall, write policies, deletion, tenant isolation, and long-term storage costs"
  },
  {
    name: "Letta/MemGPT",
    aliases: ["Letta", "MemGPT"],
    position: "Virtual context and explicit memory management",
    bestFor: "Complex tasks requiring explicit control of context, long-term state, and tools",
    verify: "Validate context paging, development complexity, latency, and observability"
  },
  {
    name: "Zep",
    aliases: ["Zep"],
    position: "Conversation persistence and graph-based memory",
    bestFor: "Evaluate for cross-session memory, entity relationships, and conversation retrieval",
    verify: "Validate entity extraction, graph maintenance, privacy deletion, and retrieval integration"
  },
  {
    name: "LangGraph Memory",
    aliases: ["LangGraph"],
    position: "Checkpoint and store state management for graph-based agents",
    bestFor: "Applications using LangGraph that need short-term state, long-term storage, and recovery",
    verify: "Validate state boundaries, checkpoint storage, replay, concurrent writes, and migration costs"
  },
  {
    name: "CrewAI Memory",
    aliases: ["CrewAI"],
    position: "Integrated memory for multi-agent workflows",
    bestFor: "Evaluate for reusing execution history and agent preferences in CrewAI workflows",
    verify: "Validate cross-agent contamination, task isolation, deletion, and framework dependencies"
  },
  {
    name: "Custom lightweight memory layer",
    aliases: ["custom memory", "custom"],
    position: "Custom memory built from databases, vector stores, rules, and audit logs",
    bestFor: "Use when existing frameworks do not meet privacy, audit, access, deletion, or cost requirements",
    verify: "Validate maintenance, evaluation, schema evolution, rollback, and governance costs"
  }
];

export const evidenceSynthesizerDefinition: DeepSeekToolDefinition = {
  type: "function",
  function: {
    name: "evidence_synthesizer",
    description:
      "Organize collected sources into findings, comparison dimensions, limitations, and initial recommendations. Use after source collection.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        focus: {
          type: "string",
          description:
            "Optional focus, such as RAG evaluation for a team discussion. The server supplies the user goal and collected sources when omitted."
        },
        outputFormat: {
          type: "string",
          description: "Optional output format: comparison, summary, pros_cons, or decision_brief. Defaults to decision_brief.",
          enum: ["comparison", "summary", "pros_cons", "decision_brief"],
          default: "decision_brief"
        }
      }
    }
  }
};

export async function runEvidenceSynthesizer(args: unknown): Promise<ToolExecutionResult> {
  const input = parseToolInput(evidenceSynthesizerSchema, args, "evidence_synthesizer");
  const synthesis = buildSynthesis(input);
  synthesis.references = input.sources.map(({ title, url }) => ({ title, url }));

  return {
    output: JSON.stringify({ synthesis }, null, 2)
  };
}

function buildGeneralSynthesis(
  input: EvidenceSynthesizerInput,
  topSources: EvidenceSynthesizerInput["sources"],
  sourceTypes: string
): ResearchSynthesis {
  return {
    focus: input.focus,
    researchQuestion: inferResearchQuestion(input.focus),
    decisionContext: inferDecisionContext(input.focus),
    evaluationCriteria: inferEvaluationCriteria(input.focus),
    evidenceRequirements: inferEvidenceRequirements(input.focus),
    evidenceGaps: inferEvidenceGaps(input),
    outputFormat: input.outputFormat,
    keyFindings: [
      `Planning guidance for "${input.focus}": clarify scope, use cases, and adoption criteria before comparing approaches.`,
      `Collected source types: ${sourceTypes}. Review them for concepts, methods, comparisons, and implementation risks.`,
      `Highly ranked sources: ${topSources.map((source) => source.title).join("; ")}.`
    ],
    comparisons: [
      {
        dimension: "Core concepts",
        notes: "Define terminology, scope, and use cases before combining findings from different levels."
      },
      {
        dimension: "Main methods",
        notes: "Compare representative methods, frameworks, and workflows by the problems they address and their prerequisites."
      },
      {
        dimension: "Implementation trade-offs",
        notes: "Representative use cases improve relevance but increase integration, maintenance, and validation costs."
      }
    ],
    risksOrLimitations: [
      "This synthesis uses API titles and abstracts. Check the full source before citing it; a relevant title does not establish complete support for the research question.",
      "For rapidly changing technology, expand the source set and record references.",
      "Use the findings as a discussion starting point and validate them against project requirements."
    ],
    recommendation:
      "Organize discussion around concepts, candidate approaches, use cases, cost and risk, and next validation steps. Collect more evidence for identified gaps."
  };
}

function buildSynthesis(input: EvidenceSynthesizerInput): ResearchSynthesis {
  const topSources = [...input.sources].sort((left, right) => right.relevanceScore - left.relevanceScore).slice(0, 3);
  const sourceTypes = [...new Set(input.sources.map((source) => source.sourceType))].join(", ");
  if (isMemoryTopic(input.focus)) {
    return buildMemoryFrameworkSynthesis(input, topSources, sourceTypes);
  }

  if (isRagEvaluationTopic(input)) {
    return buildRagEvaluationSynthesis(input, topSources, sourceTypes);
  }

  return buildGeneralSynthesis(input, topSources, sourceTypes);

}

function buildMemoryFrameworkSynthesis(
  input: EvidenceSynthesizerInput,
  topSources: EvidenceSynthesizerInput["sources"],
  sourceTypes: string
): ResearchSynthesis {
  const evidenceText = buildEvidenceText(input.sources);
  const memoryTypes = findKnownTerms(evidenceText, [
    "working memory",
    "short-term memory",
    "long-term memory",
    "episodic memory",
    "semantic memory",
    "procedural memory"
  ]);
  const mentionedFrameworks = getMentionedMemoryFrameworks(evidenceText);
  const metrics = findKnownTerms(evidenceText, [
    "hit rate",
    "recall",
    "latency",
    "token",
    "cost",
    "privacy",
    "personalization",
    "expiration",
    "conflict"
  ]);
  const frameworkText = renderMemoryFrameworkCoverage(mentionedFrameworks);
  const frameworkRows = buildMemoryFrameworkRows(mentionedFrameworks);
  const memoryTypeText = memoryTypes.length > 0 ? memoryTypes.join(", ") : "short-term/working memory, long-term semantic memory, episodic memory, and procedural memory";
  const metricText =
    metrics.length > 0
      ? metrics.join(", ")
      : "hit rate, recall, retrieval/write latency, token and storage costs, privacy, and contamination risk";

  return {
    focus: input.focus,
    researchQuestion: "How should an agent/LLM memory framework be selected or designed to balance effectiveness, cost, latency, and safety with measurable evidence?",
    decisionContext: "Select a memory framework, design a memory module, or plan a memory benchmark or proof of concept.",
    evaluationCriteria: [
      "Memory hit rate and retrieval quality",
      "Memory expiration, forgetting, and conflict resolution",
      "Retrieval, write, and end-to-end latency",
      "Token, storage, and index maintenance costs",
      "Personalization and user satisfaction gains",
      "Privacy, permissions, deletion, and memory contamination rate"
    ],
    evidenceRequirements: [
      "Include at least one comparison of candidate frameworks or methods",
      "Propose an executable proof-of-concept experiment and metric collection method",
      "Distinguish short-term context, long-term semantic memory, episodic memory, and procedural memory"
    ],
    evidenceGaps: inferEvidenceGaps(input),
    outputFormat: input.outputFormat,
    keyFindings: [
      `Planning guidance: distinguish ${memoryTypeText}, then decide what belongs in context, vector retrieval, a knowledge graph, or explicit state management. Memory selection requires its own evaluation.`,
      `Candidate screening guide: compare Mem0, Letta/MemGPT, Zep, LangGraph Memory, CrewAI Memory, and a custom memory layer. ${frameworkText}`,
      `Evaluation guidance: measure ${metricText}. Without measurements, conclusions remain preliminary.`,
      `Collected ${sourceTypes} sources, including ${topSources.map((source) => source.title).join("; ")}.`
    ],
    comparisons: [
      {
        dimension: "Memory levels",
        notes: "Working context supports task continuity; semantic memory stores facts and preferences; episodic memory records interactions; procedural memory represents workflows."
      },
      ...frameworkRows,
      {
        dimension: "Evaluation metrics",
        notes: `${metricText}. Collect effectiveness and engineering metrics separately when judging long-term suitability.`
      },
      {
        dimension: "Risk governance",
        notes: "Check contamination, stale information, privacy, cross-user leakage, deletion, and long-term cost growth."
      }
    ],
    risksOrLimitations: [
      "Before selection, verify full-source implementation details, licenses, maintenance status, and benchmark definitions.",
      "Public benchmarks require validation on representative application tasks.",
      "Long-term memory needs privacy, access, expiration, contamination, deletion, audit, and isolation controls."
    ],
    recommendation:
      "Run a small proof of concept with two or three candidates on the same multi-turn tasks. Record hit rate, recall, latency, write cost, deletion, and contamination before comparing results."
  };
}

function getMentionedMemoryFrameworks(evidenceText: string): Set<string> {
  const normalized = evidenceText.toLowerCase();
  return new Set(
    MEMORY_FRAMEWORK_PROFILES.filter((profile) =>
      profile.aliases.some((alias) => normalized.includes(alias.toLowerCase()))
    ).map((profile) => profile.name)
  );
}

function renderMemoryFrameworkCoverage(mentionedFrameworks: Set<string>): string {
  const allFrameworks = MEMORY_FRAMEWORK_PROFILES.map((profile) => profile.name);
  const mentioned = allFrameworks.filter((name) => mentionedFrameworks.has(name));
  const missing = allFrameworks.filter((name) => !mentionedFrameworks.has(name));

  return [
    mentioned.length > 0 ? `Mentioned in collected abstracts: ${mentioned.join(", ")}.` : "Collected abstracts do not identify specific candidate frameworks.",
    missing.length > 0 ? `Verify with official documentation or benchmarks: ${missing.join(", ")}.` : ""
  ]
    .filter(Boolean)
    .join("");
}

function buildMemoryFrameworkRows(mentionedFrameworks: Set<string>): Array<{ dimension: string; notes: string }> {
  return MEMORY_FRAMEWORK_PROFILES.map((profile) => ({
    dimension: profile.name,
    notes: [
      profile.position,
      `Candidate use case: ${profile.bestFor}`,
      `Validate: ${profile.verify}`,
      mentionedFrameworks.has(profile.name) ? "Evidence status: named in collected abstracts; suitability still requires verification." : "Evidence status: absent from collected abstracts; obtain official documentation or benchmarks."
    ].join("; ")
  }));
}

function buildRagEvaluationSynthesis(
  input: EvidenceSynthesizerInput,
  topSources: EvidenceSynthesizerInput["sources"],
  sourceTypes: string
): ResearchSynthesis {
  const evidenceText = buildEvidenceText(input.sources);
  const metrics = findKnownTerms(evidenceText, [
    "faithfulness",
    "answer relevancy",
    "context precision",
    "context recall",
    "retrieval quality",
    "answer correctness",
    "context relevance",
    "hallucination"
  ]);
  const frameworks = findKnownTerms(evidenceText, ["RAGAS", "TruLens", "ARES", "DeepEval", "LangSmith"]);
  const datasets = findKnownTerms(evidenceText, ["RGB", "CRUD", "KILT", "Natural Questions", "HotpotQA", "MS MARCO"]);
  const metricText = metrics.length > 0 ? metrics.join(", ") : "specific metrics are not identified in the abstracts; consult full sources";
  const frameworkText = frameworks.length > 0 ? frameworks.join(", ") : "framework comparison is not sufficiently covered in the abstracts";
  const datasetText = datasets.length > 0 ? datasets.join(", ") : "datasets or benchmarks are not sufficiently covered in the abstracts";

  return {
    focus: input.focus,
    researchQuestion: "How can a RAG evaluation system be implemented and reviewed to support team decisions?",
    decisionContext: "Select an evaluation framework, define metrics, choose datasets, and establish validation workflows.",
    evaluationCriteria: [
      "Answer faithfulness and hallucination rate",
      "Context relevance, precision, and recall",
      "Retrieval recall, ranking quality, and coverage",
      "End-to-end task success rate",
      "Human review agreement, evaluation cost, and latency"
    ],
    evidenceRequirements: [
      "Cover metric definitions, framework comparisons, and benchmark datasets",
      "Explain the scope of automated and human evaluation",
      "Provide a small-sample validation workflow"
    ],
    evidenceGaps: inferEvidenceGaps(input),
    outputFormat: input.outputFormat,
    keyFindings: [
      `Evaluation guidance: assess retrieval quality, generation quality, and end-to-end task outcomes separately.`,
      `Metric terms identified in the sources: ${metricText}. Validate their definitions against full sources.`,
      `Framework terms identified in the sources: ${frameworkText}. Compare automated evaluation, tracing, human review, and monitoring needs.`,
      `Collected ${sourceTypes} sources, including ${topSources.map((source) => source.title).join("; ")}.`
    ],
    comparisons: [
      {
        dimension: "Evaluation levels",
        notes: "Evaluate retrieval relevance and completeness, answer faithfulness and relevance, and end-to-end task completion."
      },
      {
        dimension: "Key metrics",
        notes: `${metricText}. Start with three to five metrics on a small sample, then expand automated evaluation.`
      },
      {
        dimension: "Framework selection",
        notes: `${frameworkText}. Verify current framework capabilities against metric, tracing, and evaluation workflow requirements.`
      },
      {
        dimension: "Datasets and benchmarks",
        notes: `${datasetText}. Supplement public benchmarks with representative internal task samples.`
      },
      {
        dimension: "Implementation workflow",
        notes: "Identify the business problem and failure types, build a sample evaluation set, calibrate automated metrics with human review, and monitor continuously."
      }
    ],
    risksOrLimitations: [
      "Sources are API titles and abstracts. Check full-text metric definitions, experiment settings, and scope before citing.",
      "RAG evaluation depends on the application. Validate public datasets and frameworks against internal examples and human criteria.",
      "Retain human spot checks for automated metrics, especially for long answers, multi-hop reasoning, and domain knowledge."
    ],
    recommendation:
      "Build a small RAG evaluation workflow with representative questions, separate retrieval and generation metrics, and human review of automated results."
  };
}

function isRagEvaluationTopic(input: EvidenceSynthesizerInput): boolean {
  if (isMemoryTopic(input.focus)) {
    return false;
  }

  return /rag|retrieval augmented generation|ragas|trulens|deepeval|langsmith/i.test(input.focus);
}

function inferResearchQuestion(focus: string): string {
  if (isMemoryTopic(focus)) {
    return "How should an agent/LLM memory framework be selected or designed to balance effectiveness, cost, latency, and safety with measurable evidence?";
  }

  return `For "${focus}", should the research support selection, system design, benchmarking, or learning?`;
}

function inferDecisionContext(focus: string): string {
  if (isMemoryTopic(focus)) {
    return "Select a memory framework, design a memory module, or plan a memory benchmark or proof of concept.";
  }

  return "Organize sources into findings that can be discussed, verified, and used to plan next steps.";
}

function inferEvaluationCriteria(focus: string): string[] {
  if (isMemoryTopic(focus)) {
    return [
      "Memory hit rate and retrieval quality",
      "Memory expiration, forgetting, and conflict resolution",
      "Retrieval, write, and end-to-end latency",
      "Token, storage, and index maintenance costs",
      "Personalization and user satisfaction gains",
      "Privacy, permissions, deletion, and memory contamination rate"
    ];
  }

  return ["Effectiveness metrics", "Cost metrics", "Latency or efficiency metrics", "Maintainability", "Risks and scope"];
}

function inferEvidenceRequirements(focus: string): string[] {
  if (isMemoryTopic(focus)) {
    return [
      "Include at least one comparison of candidate frameworks or methods",
      "Propose an executable proof-of-concept experiment and metric collection method",
      "Distinguish short-term context, long-term semantic memory, episodic memory, and procedural memory"
    ];
  }

  return [
    "Distinguish source evidence, inference, and recommendations",
    "State whether experiments, benchmarks, or real cases support the findings",
    "If data is unavailable, explain the gap and the next validation step"
  ];
}

function inferEvidenceGaps(input: EvidenceSynthesizerInput): string[] {
  const text = buildEvidenceText(input.sources).toLowerCase();
  const gaps: string[] = [];

  if (!/experiment|benchmark|dataset|evaluation|metric/.test(text)) {
    gaps.push("The sources emphasize concepts and methods without clear experiments, benchmarks, or quantitative metrics.");
  }
  if (isMemoryTopic(input.focus) && !/hit rate|latency|token|cost|personalization|privacy/.test(text)) {
    gaps.push("The sources do not sufficiently cover memory hit rate, expiration, latency, token cost, or personalization metrics.");
  }
  if (input.sources.length < 3) {
    gaps.push("Few candidate sources are available; treat conclusions as preliminary and collect more evidence.");
  }

  return gaps.length > 0 ? gaps : ["Verify full sources and experiment settings before making a decision based on titles and abstracts."];
}

function isMemoryTopic(value: string): boolean {
  return /memory|memgpt|mem0|letta|zep|long[-\s]?term/i.test(value);
}

function buildEvidenceText(sources: EvidenceSynthesizerInput["sources"]): string {
  return sources.map((source) => `${source.title} ${source.summary} ${source.publisher}`).join("\n");
}

function findKnownTerms(text: string, terms: string[]): string[] {
  const normalized = text.toLowerCase();
  return terms.filter((term) => normalized.includes(term.toLowerCase()));
}
