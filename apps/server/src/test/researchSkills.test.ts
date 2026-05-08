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

describe("调研 skills", () => {
  it("research_planning_skill 能把 RAG 评估主题拆成关键方面", () => {
    const plan = buildResearchPlan("帮我研究 RAG 评估体系");

    expect(plan.requiredAspects).toContain("核心评估维度");
    expect(plan.requiredAspects).toContain("主流评估框架对比");
    expect(plan.researchQuestion).toContain("RAG");
    expect(plan.evaluationCriteria).toContain("答案忠实度和幻觉率");
    expect(plan.searchQueries.some((query) => query.includes("RAGAS"))).toBe(true);
  });

  it("research_planning_skill 能把记忆框架主题拆成研究问题、评估标准和实验要求", () => {
    const plan = buildResearchPlan("帮我研究开源记忆力框架");

    expect(plan.researchQuestion).toContain("记忆框架");
    expect(plan.decisionContext).toContain("选型");
    expect(plan.requiredAspects).toContain("评估指标和基准方法");
    expect(plan.requiredAspects).toContain("实验设计和数据需求");
    expect(plan.evaluationCriteria).toEqual(
      expect.arrayContaining(["记忆命中率和召回质量", "检索延迟、写入延迟和端到端 latency", "token 成本、存储成本和索引维护成本"])
    );
    expect(plan.evidenceRequirements.some((item) => item.includes("POC 实验设计"))).toBe(true);
  });

  it("research_planning_skill 不会把 memory benchmark 误判成 RAG 评估", () => {
    const plan = buildResearchPlan("帮我研究 长上下文记忆框架选型和 memory benchmark");

    expect(plan.researchQuestion).toContain("记忆框架");
    expect(plan.researchQuestion).not.toContain("RAG");
    expect(plan.searchQueries.some((query) => query.includes("memory"))).toBe(true);
  });

  it("evidence_extraction_skill 能从来源摘要中抽取指标和框架线索", () => {
    const plan = buildResearchPlan("RAG 评估体系");
    const extraction = extractEvidenceFromSources([ragSource], plan);

    expect(extraction.itemCount).toBe(1);
    expect(extraction.coveredAspectTags).toContain("关键评估指标");
    expect(extraction.items[0].frameworks).toContain("RAGAS");
    expect(extraction.items[0].metrics).toContain("faithfulness");
  });

  it("coverage_check_skill 能识别缺失方面并建议补充检索", () => {
    const plan = buildResearchPlan("RAG 评估体系");
    const evidence = extractEvidenceFromSources([ragSource], plan);
    const synthesis: ResearchSynthesis = {
      focus: "RAG 评估体系",
      outputFormat: "decision_brief",
      keyFindings: ["RAG 评估需要覆盖 faithfulness、answer relevancy 和 context precision。"],
      comparisons: [{ dimension: "指标", notes: "需要区分检索质量和生成质量。" }],
      risksOrLimitations: ["自动化评估仍需要人工复核。"],
      recommendation: "先建立小样本指标集。"
    };

    const report = evaluateCoverage({
      plan,
      sources: [ragSource],
      synthesis,
      evidence
    });

    expect(report.coverageScore).toBeLessThan(1);
    expect(report.missingAspects).toContain("评估数据集和基准测试");
    expect(report.shouldCollectMore).toBe(true);
    expect(report.suggestedQueries.some((query) => query.includes("评估数据集和基准测试"))).toBe(true);
  });

  it("coverage_check_skill 能识别 memory 主题中的记忆模型和候选框架覆盖", () => {
    const plan = buildResearchPlan("帮我研究 长上下文记忆框架选型");
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
        "长上下文记忆选型需要区分 short-term memory、long-term memory、episodic memory、semantic memory 和 procedural memory。",
        "候选框架应比较 Mem0、Letta/MemGPT、Zep、LangGraph Memory、CrewAI Memory 和自研轻量记忆层。"
      ],
      comparisons: [
        { dimension: "Mem0", notes: "轻量语义记忆层，需要验证召回质量和删除能力。" },
        { dimension: "Letta/MemGPT", notes: "虚拟上下文管理，需要验证复杂度和延迟。" }
      ],
      risksOrLimitations: ["需要验证隐私、记忆污染和长期成本。"],
      recommendation: "用 POC 比较候选框架。"
    };

    const report = evaluateCoverage({ plan, sources, synthesis, evidence });

    expect(report.coveredAspects).toContain("记忆模型和核心概念");
    expect(report.coveredAspects.some((aspect) => aspect.includes("主流记忆框架对比"))).toBe(true);
  });

  it("coverage_check_skill 在关键方面覆盖后允许进入写作", () => {
    const plan = buildResearchPlan("RAG 评估体系");
    const sources = [ragSource, benchmarkSource];
    const evidence = extractEvidenceFromSources(sources, plan);
    const synthesis: ResearchSynthesis = {
      focus: "RAG 评估体系",
      outputFormat: "decision_brief",
      keyFindings: [
        "RAG 评估需要覆盖检索质量、生成质量和端到端质量。",
        "RAGAS、TruLens、ARES、DeepEval 和 LangSmith 可用于不同评估场景。",
        "RGB、CRUD、KILT、Natural Questions 可作为 benchmark 数据集。",
        "生产实践中需要关注人工复核、成本和常见陷阱。"
      ],
      comparisons: [
        { dimension: "框架", notes: "RAGAS、TruLens、ARES、DeepEval、LangSmith 各有适用场景。" }
      ],
      risksOrLimitations: ["自动化评估需要人工抽样校准。"],
      recommendation: "用小样本验证评估框架，再扩展到生产。"
    };

    const report = evaluateCoverage({ plan, sources, synthesis, evidence });

    expect(report.coverageScore).toBeGreaterThanOrEqual(0.75);
    expect(report.shouldCollectMore).toBe(false);
  });
});
