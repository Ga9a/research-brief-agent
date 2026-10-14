import { describe, expect, it } from "vitest";
import { evaluateCoverage } from "../skills/coverageCheck.js";
import { extractEvidenceFromSources } from "../skills/evidenceExtraction.js";
import { buildResearchPlan } from "../skills/researchPlanning.js";
import type { ResearchSource, ResearchSynthesis } from "../types.js";

const ragSource: ResearchSource = {
  id: "papers:ragas",
  title: "RAGAS metrics for RAG evaluation",
  url: "https://arxiv.org/abs/2401.00001",
  sourceType: "papers",
  publisher: "arXiv",
  publishedAt: "2024",
  summary:
    "RAGAS evaluates faithfulness, answer relevancy, context precision, context recall and retrieval quality for RAG systems.",
  relevanceScore: 1,
  credibilityScore: 0.9
};

const benchmarkSource: ResearchSource = {
  id: "web:benchmarks",
  title: "RAG benchmark datasets RGB CRUD KILT Natural Questions",
  url: "https://docs.example.com/rag-benchmarks",
  sourceType: "web",
  publisher: "Example Docs",
  publishedAt: null,
  summary: "Benchmark datasets for RAG evaluation include RGB, CRUD, KILT and Natural Questions.",
  relevanceScore: 0.8,
  credibilityScore: 0.8
};

describe("researchSkills", () => {
  it("plans RAG evaluation aspects", () => {
    const plan = buildResearchPlan("Research RAG evaluation system");

    expect(plan.requiredAspects).toContain("Core evaluation dimensions");
    expect(plan.requiredAspects).toContain("Evaluation framework comparison");
    expect(plan.researchQuestion).toContain("RAG");
    expect(plan.evaluationCriteria).toContain("Answer faithfulness and hallucination rate");
    expect(plan.searchQueries.some((query) => query.includes("RAGAS"))).toBe(true);
  });

  it("plans memory framework evaluation", () => {
    const plan = buildResearchPlan("Research open-source memory frameworks");

    expect(plan.researchQuestion).toContain("memory framework");
    expect(plan.decisionContext).toContain("Select");
    expect(plan.requiredAspects).toContain("Evaluation metrics and benchmark methods");
    expect(plan.requiredAspects).toContain("Experiment design and data requirements");
    expect(plan.evaluationCriteria).toEqual(
      expect.arrayContaining(["Memory hit rate and retrieval quality", "Retrieval, write, and end-to-end latency", "Token, storage, and index maintenance costs"])
    );
    expect(plan.evidenceRequirements.some((item) => item.includes("proof-of-concept experiment"))).toBe(true);
  });

  it("distinguishes memory and RAG benchmarks", () => {
    const plan = buildResearchPlan("Research long-context memory framework selection and memory benchmark");

    expect(plan.researchQuestion).toContain("memory framework");
    expect(plan.researchQuestion).not.toContain("RAG");
    expect(plan.searchQueries.some((query) => query.includes("memory"))).toBe(true);
  });

  it("extracts evidence terms", () => {
    const plan = buildResearchPlan("RAG evaluation system");
    const extraction = extractEvidenceFromSources([ragSource], plan);

    expect(extraction.itemCount).toBe(1);
    expect(extraction.coveredAspectTags).toContain("Key evaluation metrics");
    expect(extraction.items[0].frameworks).toContain("RAGAS");
    expect(extraction.items[0].metrics).toContain("faithfulness");
  });

  it("identifies missing coverage", () => {
    const plan = buildResearchPlan("RAG evaluation system");
    const evidence = extractEvidenceFromSources([ragSource], plan);
    const synthesis: ResearchSynthesis = {
      focus: "RAG evaluation system",
      outputFormat: "decision_brief",
      keyFindings: ["RAG evaluation covers faithfulness, answer relevancy, and context precision."],
      comparisons: [{ dimension: "Metrics", notes: "Separate retrieval and generation quality." }],
      risksOrLimitations: ["Automated evaluation requires human review."],
      recommendation: "Start with a small metric set."
    };

    const report = evaluateCoverage({
      plan,
      sources: [ragSource],
      synthesis,
      evidence
    });

    expect(report.coverageScore).toBeLessThan(1);
    expect(report.missingAspects).toContain("Evaluation datasets and benchmarks");
    expect(report.shouldCollectMore).toBe(true);
    expect(report.suggestedQueries.some((query) => query.includes("Evaluation datasets and benchmarks"))).toBe(true);
  });

  it("recognizes memory coverage", () => {
    const plan = buildResearchPlan("Research long-context memory framework selection");
    const sources: ResearchSource[] = [
      {
        id: "papers:memory",
        title: "Memory Frameworks for LLM Agents",
        url: "https://arxiv.org/abs/2402.00001",
        sourceType: "papers",
        publisher: "arXiv",
        publishedAt: "2024",
        summary:
          "LLM agent memory frameworks compare short-term memory, long-term memory, episodic memory, semantic memory, procedural memory, Mem0, Letta, Zep and LangGraph.",
        relevanceScore: 1,
        credibilityScore: 0.9
      }
    ];
    const evidence = extractEvidenceFromSources(sources, plan);
    const synthesis: ResearchSynthesis = {
      focus: plan.researchGoal,
      researchQuestion: plan.researchQuestion,
      outputFormat: "decision_brief",
      keyFindings: [
        "Long-context memory selection distinguishes short-term, long-term, episodic, semantic, and procedural memory.",
        "Compare Mem0, Letta/MemGPT, Zep, LangGraph Memory, CrewAI Memory, and a custom memory layer."
      ],
      comparisons: [
        { dimension: "Mem0", notes: "A lightweight semantic memory layer requiring recall and deletion validation." },
        { dimension: "Letta/MemGPT", notes: "Virtual context management requiring complexity and latency validation." }
      ],
      risksOrLimitations: ["Validate privacy, memory contamination, and long-term costs."],
      recommendation: "Compare candidate frameworks in a proof of concept."
    };

    const report = evaluateCoverage({ plan, sources, synthesis, evidence });

    expect(report.coveredAspects).toContain("Memory models and core concepts");
    expect(report.coveredAspects.some((aspect) => aspect.includes("Memory framework comparison"))).toBe(true);
  });

  it("allows writing with sufficient coverage", () => {
    const plan = buildResearchPlan("RAG evaluation system");
    const sources = [ragSource, benchmarkSource];
    const evidence = extractEvidenceFromSources(sources, plan);
    const synthesis: ResearchSynthesis = {
      focus: "RAG evaluation system",
      outputFormat: "decision_brief",
      keyFindings: [
        "RAG evaluation covers retrieval, generation, and end-to-end quality.",
        "RAGAS, TruLens, ARES, DeepEval, and LangSmith address different evaluation needs.",
        "RGB, CRUD, KILT, and Natural Questions can serve as benchmark datasets.",
        "Production practice needs human review of costs and pitfalls."
      ],
      comparisons: [
        { dimension: "Frameworks", notes: "RAGAS, TruLens, ARES, DeepEval, and LangSmith have different use cases." }
      ],
      risksOrLimitations: ["Calibrate automated evaluation using human samples."],
      recommendation: "Validate the evaluation workflow on a small sample before production."
    };

    const report = evaluateCoverage({ plan, sources, synthesis, evidence });

    expect(report.coverageScore).toBeGreaterThanOrEqual(0.75);
    expect(report.shouldCollectMore).toBe(false);
  });
});
