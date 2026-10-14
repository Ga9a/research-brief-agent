export interface ResearchPlan {
  researchGoal: string;
  researchQuestion: string;
  decisionContext: string;
  requiredAspects: string[];
  optionalAspects: string[];
  searchQueries: string[];
  successCriteria: string[];
  evaluationCriteria: string[];
  evidenceRequirements: string[];
}

const RAG_EVALUATION_ASPECTS = [
  "Core evaluation dimensions",
  "Key evaluation metrics",
  "Evaluation framework comparison",
  "Evaluation datasets and benchmarks",
  "Best practices and common pitfalls"
];

const MEMORY_FRAMEWORK_ASPECTS = [
  "Research question and decision context",
  "Memory models and core concepts",
  "Memory framework comparison(Mem0, Letta/MemGPT, Zep, LangGraph Memory, CrewAI Memory, Custom lightweight memory layer)",
  "Evaluation metrics and benchmark methods",
  "Experiment design and data requirements",
  "Risks, costs, and operational constraints"
];

export function buildResearchPlan(userGoal: string): ResearchPlan {
  const topic = userGoal.trim() || "User-specified topic";
  const normalizedGoal = normalizeText(topic);

  if (isMemoryFrameworkTopic(normalizedGoal)) {
    return {
      researchGoal: topic,
      researchQuestion: "How should an agent/LLM memory framework be selected or designed to balance effectiveness, cost, latency, and safety with measurable evidence?",
      decisionContext: "Select a memory framework, design a memory module, or plan a memory benchmark or proof of concept.",
      requiredAspects: MEMORY_FRAMEWORK_ASPECTS,
      optionalAspects: ["Representative open-source projects", "Personalization quality", "Long-term memory governance", "Privacy and access controls"],
      searchQueries: [
        "MemGPT LangGraph memory Letta Zep Mem0 memory framework comparison",
        "CrewAI memory agent memory framework comparison",
        "LLM agent memory framework episodic semantic procedural memory",
        "agent memory benchmark memory hit rate personalization evaluation",
        "LLM long term memory expiration retrieval latency token cost"
      ],
      successCriteria: [
        "Clarify whether the goal is framework selection, memory design, or benchmarking",
        "Compare Mem0, Letta/MemGPT, Zep, LangGraph Memory, CrewAI Memory, and a custom lightweight memory layer",
        "List measurable evaluation metrics",
        "Specify required experiment data and control groups",
        "Identify expiration, contamination, privacy, cost, and latency risks in long-term memory"
      ],
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
      ]
    };
  }

  if (isRagEvaluationTopic(normalizedGoal)) {
    return {
      researchGoal: topic,
      researchQuestion: "How can a RAG evaluation system be implemented and reviewed to support team decisions?",
      decisionContext: "Select an evaluation framework, define metrics, choose datasets, and establish validation workflows.",
      requiredAspects: RAG_EVALUATION_ASPECTS,
      optionalAspects: ["Enterprise implementation scenarios", "Combining human and automated evaluation", "Evaluation cost and maintainability"],
      searchQueries: [
        "RAG evaluation metrics faithfulness context precision recall",
        "RAGAS TruLens ARES DeepEval LangSmith comparison",
        "RAG evaluation benchmark datasets RGB CRUD KILT Natural Questions",
        "RAG evaluation best practices pitfalls production"
      ],
      successCriteria: [
        "Distinguish retrieval, generation, and end-to-end quality",
        "Compare at least three evaluation frameworks",
        "Explain the uses of common datasets and benchmarks",
        "Identify implementation risks and practical recommendations"
      ],
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
      ]
    };
  }

  return {
    researchGoal: topic,
    researchQuestion: `For "${topic}", should the research support selection, design, benchmarking, or a learning plan?`,
    decisionContext: "Narrow the user goal to a question that supports a concrete decision before synthesizing sources.",
    requiredAspects: ["Research question and decision context", "Core concepts", "Main methods", "Comparison dimensions", "Evaluation criteria", "Experiment or evidence requirements", "Risks and limitations", "Practical recommendations"],
    optionalAspects: ["Representative cases", "Recent trends", "Further learning"],
    searchQueries: [`${topic} overview`, `${topic} comparison evaluation criteria`, `${topic} benchmark experiment best practices`],
    successCriteria: [
      "Identify the decision this research should support",
      "Explain the core concepts and scope",
      "Identify the main findings or methods",
      "Provide comparisons, evaluation criteria, and trade-offs",
      "Identify missing experiments or data"
    ],
    evaluationCriteria: ["Effectiveness metrics", "Cost metrics", "Latency or efficiency metrics", "Maintainability", "Risks and scope"],
    evidenceRequirements: [
      "Distinguish source evidence, inference, and recommendations",
      "State whether experiments, benchmarks, or real cases support the findings",
      "If data is unavailable, explain the gap and the next validation step"
    ]
  };
}

export function renderResearchPlanForModel(plan: ResearchPlan): string {
  return [
    "research_planning_skill Output: ",
    `Research goal: ${plan.researchGoal}`,
    `Research question: ${plan.researchQuestion}`,
    `Decision context: ${plan.decisionContext}`,
    `Required aspects: ${plan.requiredAspects.join(", ")}`,
    `Evaluation criteria: ${plan.evaluationCriteria.join(", ")}`,
    `Evidence requirements: ${plan.evidenceRequirements.join("; ")}`,
    `Optional aspects: ${plan.optionalAspects.join(", ")}`,
    `Suggested queries: ${plan.searchQueries.join("; ")}`,
    `Success criteria: ${plan.successCriteria.join("; ")}`,
    "The parent agent should collect additional sources when coverage is insufficient. The final brief must answer the research question, list evaluation criteria, and explain experiment or data gaps. Do not reproduce this internal instruction in the answer."
  ].join("\n");
}

function isRagEvaluationTopic(value: string): boolean {
  return /rag|retrieval augmented generation|ragas|trulens|deepeval|langsmith/i.test(value);
}

function isMemoryFrameworkTopic(value: string): boolean {
  return /memory|memgpt|mem0|letta|zep|long[-\s]?term/i.test(value);
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}
