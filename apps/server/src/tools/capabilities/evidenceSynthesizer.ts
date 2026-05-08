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
  }, z.string().min(1).max(200).default("基于已收集资料的综合分析")),
  outputFormat: outputFormatSchema.default("decision_brief")
});

type EvidenceSynthesizerInput = z.infer<typeof evidenceSynthesizerSchema>;

export const evidenceSynthesizerDefinition: DeepSeekToolDefinition = {
  type: "function",
  function: {
    name: "evidence_synthesizer",
    description:
      "把 source_collector 收集到的资料整理成核心观点、对比维度、风险限制和初步建议。必须在完成资料收集后使用。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        focus: {
          type: "string",
          description:
            "可选。本次综合分析的关注点，例如“面向组长讨论的 RAG 评估方案”。不传时后端会使用用户原始调研目标。不要传 sources，后端会自动使用 source_collector 的结果。"
        },
        outputFormat: {
          type: "string",
          description: "可选。输出结构类型，只能是 comparison、summary、pros_cons、decision_brief；默认 decision_brief。",
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
      `资料共同指向一个前提：讨论“${input.focus}”时，需要先明确问题边界、使用场景和采用标准，再比较不同方案。`,
      `候选资料覆盖 ${sourceTypes}，可以支撑概念理解、代表方法梳理、方案对比和落地风险判断。`,
      `高相关资料包括：${topSources.map((source) => source.title).join("；")}。`
    ],
    comparisons: [
      {
        dimension: "核心概念",
        notes: "先确认主题中的关键术语、边界和适用场景，避免把不同层次的问题混在一起。"
      },
      {
        dimension: "主要方法",
        notes: "把资料中的代表性方法、框架或实践路径拆开比较，重点看它们解决的问题和依赖条件。"
      },
      {
        dimension: "落地取舍",
        notes: "越贴近真实使用场景，结论越可用，但集成成本、维护成本和验证成本也会更高。"
      }
    ],
    risksOrLimitations: [
      "当前综合结果依赖外部 API 返回的标题和摘要，正式引用前仍需要核对原文，尤其要注意标题相关但正文可能并不完全覆盖用户关心的问题。",
      "如果主题涉及快速变化的技术，需要后续接入更多资料源并记录出处，避免只依赖单一来源。",
      "当前结论适合作为讨论起点，不应直接替代真实项目中的验证、试用和团队约束评估。"
    ],
    recommendation:
      "建议先把主题拆成“概念边界、代表方案、适用场景、成本风险、下一步验证”五个部分，形成小而可执行的讨论框架，再根据缺口继续补资料。"
  };
}

function buildSynthesis(input: EvidenceSynthesizerInput): ResearchSynthesis {
  const topSources = [...input.sources].sort((left, right) => right.relevanceScore - left.relevanceScore).slice(0, 3);
  const sourceTypes = [...new Set(input.sources.map((source) => source.sourceType))].join("、");
  if (isMemoryTopic(input.focus)) {
    return buildMemoryFrameworkSynthesis(input, topSources, sourceTypes);
  }

  if (isRagEvaluationTopic(input)) {
    return buildRagEvaluationSynthesis(input, topSources, sourceTypes);
  }

  return buildGeneralSynthesis(input, topSources, sourceTypes);
  /*
  return {
    focus: input.focus,
    researchQuestion: "如何为 RAG 系统建立可落地、可复核、能支持团队决策的评估体系？",
    decisionContext: "用于选择评估框架、设计评估指标、确定数据集和落地验证流程。",
    evaluationCriteria: [
      "答案忠实度和幻觉率",
      "上下文相关性、context precision 和 context recall",
      "检索召回、排序质量和覆盖率",
      "端到端任务成功率",
      "人工复核一致性、评估成本和延迟"
    ],
    evidenceRequirements: [
      "至少覆盖指标定义、框架对比和 benchmark 数据集",
      "说明自动化评估与人工评估的适用边界",
      "给出小样本验证流程，而不是只给概念建议"
    ],
    evidenceGaps: inferEvidenceGaps(input),
    outputFormat: input.outputFormat,
    keyFindings: [
      `资料共同指向一个前提：讨论“${input.focus}”时，需要先明确评估目标，再选择指标和样本。`,
      `候选资料覆盖 ${sourceTypes}，可以同时支撑概念理解、方案对比和落地判断。`,
      `高相关资料包括：${topSources.map((source) => source.title).join("；")}。`
    ],
    comparisons: [
      {
        dimension: "评估目标",
        notes: "先区分质量评估、效率评估、成本评估和业务适配度，否则指标容易混在一起。"
      },
      {
        dimension: "证据来源",
        notes: "公开资料适合补充实践案例，论文适合补充方法论和评估框架。"
      },
      {
        dimension: "落地成本",
        notes: "越贴近真实业务样本，结论越可用，但数据整理、人工标注和复核成本也会更高。"
      }
    ],
    risksOrLimitations: [
      "当前综合结果依赖外部 API 返回的标题和摘要，仍需要在正式引用前核对原文。",
      "如果主题涉及快速变化的技术，需要后续接入更多资料源并记录出处。",
      "评估结论容易受样本规模、任务类型和判断标准影响，需要在实际项目中复核。"
    ],
    recommendation:
      "建议先形成一个小而可执行的评估框架：明确目标、挑选代表性样本、设计少量关键指标，再用人工复核校准自动化评估结果。"
  };
  */
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
  const frameworks = findKnownTerms(evidenceText, ["MemGPT", "Letta", "LangGraph", "Zep", "Mem0", "CrewAI"]);
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
  const frameworkText = frameworks.length > 0 ? frameworks.join("、") : "当前资料摘要未充分覆盖候选框架对比，需要后续核对官方文档或 benchmark";
  const memoryTypeText = memoryTypes.length > 0 ? memoryTypes.join("、") : "短期/工作记忆、长期语义记忆、事件记忆、程序性记忆";
  const metricText =
    metrics.length > 0
      ? metrics.join("、")
      : "命中率、召回质量、检索/写入延迟、token 成本、存储成本、隐私和记忆污染风险";

  return {
    focus: input.focus,
    researchQuestion: "应该如何选择或设计 agent/LLM 记忆框架，才能在效果、成本、延迟和安全性之间取得可验证的平衡？",
    decisionContext: "用于选型 memory 框架、设计记忆模块，或规划 memory benchmark / POC。",
    evaluationCriteria: [
      "记忆命中率和召回质量",
      "记忆过期、遗忘和冲突解决策略",
      "检索延迟、写入延迟和端到端 latency",
      "token 成本、存储成本和索引维护成本",
      "个性化效果和用户满意度提升",
      "隐私、权限、可删除性和记忆污染率"
    ],
    evidenceRequirements: [
      "需要至少一个候选框架/方法对比表",
      "需要提出可执行的 POC 实验设计和指标采集方式",
      "需要区分短期上下文、长期语义记忆、事件记忆和程序性记忆"
    ],
    evidenceGaps: inferEvidenceGaps(input),
    outputFormat: input.outputFormat,
    keyFindings: [
      `长上下文记忆选型不能等同于 RAG 评估；应先区分记忆层次：${memoryTypeText}，再决定哪些能力由上下文窗口、向量检索、知识图谱或显式状态管理承担。`,
      `候选框架线索包括：${frameworkText}。这些框架需要按“写入机制、检索机制、遗忘/更新策略、权限隔离、可观测性、部署成本”拆开比较。`,
      `可量化评估应围绕：${metricText}。没有这些指标时，结论只能作为初筛，不能直接作为选型依据。`,
      `候选资料覆盖 ${sourceTypes}，代表资料包括：${topSources.map((source) => source.title).join("；")}。`
    ],
    comparisons: [
      {
        dimension: "记忆层次",
        notes: "短期上下文适合当前任务连续性；语义记忆适合事实和偏好；事件记忆适合历史交互；程序性记忆适合稳定流程和工具使用习惯。"
      },
      {
        dimension: "框架选型",
        notes: `${frameworkText}。对比时不要只看是否支持 memory，而要看写入、检索、更新、删除、隔离和审计是否可控。`
      },
      {
        dimension: "评估指标",
        notes: `${metricText}。建议把效果指标和工程指标分开采集，避免只凭演示效果判断长期可用性。`
      },
      {
        dimension: "风险治理",
        notes: "重点检查记忆污染、过期信息、隐私权限、跨用户泄漏、不可删除和长期成本膨胀。"
      }
    ],
    risksOrLimitations: [
      "当前资料多来自外部 API 的标题和摘要，正式选型前需要打开原文核对具体实现、许可、维护状态和 benchmark 口径。",
      "记忆框架的公开 benchmark 往往不能直接代表业务效果，需要用真实任务样本做 POC。",
      "长期记忆会引入隐私、权限、过期和污染问题；如果没有删除、审计和隔离机制，效果提升可能被治理风险抵消。"
    ],
    recommendation:
      "建议先做一轮小范围 POC：选 2 到 3 个候选框架，固定同一批多轮任务样本，分别记录记忆命中率、召回质量、延迟、写入成本、删除能力和污染率，再基于指标做取舍。"
  };
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
  const metricText = metrics.length > 0 ? metrics.join("、") : "当前资料摘要未明确列出具体指标，需要后续核对原文补充";
  const frameworkText = frameworks.length > 0 ? frameworks.join("、") : "当前资料摘要未充分覆盖主流框架对比";
  const datasetText = datasets.length > 0 ? datasets.join("、") : "当前资料摘要未充分覆盖数据集或 benchmark";

  return {
    focus: input.focus,
    researchQuestion: "如何为 RAG 系统建立可落地、可复核、能支持团队决策的评估体系？",
    decisionContext: "用于选择评估框架、设计评估指标、确定数据集和落地验证流程。",
    evaluationCriteria: [
      "答案忠实度和幻觉率",
      "上下文相关性、context precision 和 context recall",
      "检索召回、排序质量和覆盖率",
      "端到端任务成功率",
      "人工复核一致性、评估成本和延迟"
    ],
    evidenceRequirements: [
      "至少覆盖指标定义、框架对比和 benchmark 数据集",
      "说明自动化评估与人工评估的适用边界",
      "给出小样本验证流程，而不是只给概念建议"
    ],
    evidenceGaps: inferEvidenceGaps(input),
    outputFormat: input.outputFormat,
    keyFindings: [
      `RAG 评估应拆成三个层次：检索质量、生成质量和端到端任务效果，避免把所有指标混成一个总分。`,
      `资料中已经出现的关键指标线索包括：${metricText}。这些指标分别对应答案忠实度、答案相关性和上下文检索质量。`,
      `资料中已经出现的评估框架线索包括：${frameworkText}。框架选择应结合是否需要自动化评估、链路追踪、人工复核和生产监控。`,
      `候选资料覆盖 ${sourceTypes}，代表资料包括：${topSources.map((source) => source.title).join("；")}。`
    ],
    comparisons: [
      {
        dimension: "评估层次",
        notes: "检索质量看召回内容是否相关且完整；生成质量看答案是否忠实、相关、无幻觉；端到端质量看用户任务是否真正完成。"
      },
      {
        dimension: "关键指标",
        notes: `${metricText}。建议先选 3 到 5 个核心指标做小样本验证，再扩大到自动化评估。`
      },
      {
        dimension: "框架选择",
        notes: `${frameworkText}。RAGAS 更适合快速建立指标基线；TruLens 和 LangSmith 更偏链路观测；ARES、DeepEval 可用于更系统的评测流程。`
      },
      {
        dimension: "数据集和基准",
        notes: `${datasetText}。如果目标是企业内部落地，公开 benchmark 只能提供参考，还需要构造贴近业务的代表性样本。`
      },
      {
        dimension: "落地流程",
        notes: "先明确业务问题和失败类型，再抽样构建评测集；用人工复核校准自动化指标，最后纳入持续监控。"
      }
    ],
    risksOrLimitations: [
      "当前资料主要来自外部 API 返回的标题和摘要，正式引用前需要打开原文核对指标定义、实验设置和适用范围。",
      "RAG 评估高度依赖业务场景；公开数据集或通用框架不能直接替代内部样本和人工判断标准。",
      "自动化指标可能误判答案质量，尤其是长答案、多跳推理和领域知识问题，需要保留人工抽检。"
    ],
    recommendation:
      "建议先建立一个小而可执行的 RAG 评估框架和验证闭环：选定代表性问题集，分别评估检索质量、生成忠实度和端到端可用性，再用人工复核校准 RAGAS/DeepEval 等自动化结果。"
  };
}

function isRagEvaluationTopic(input: EvidenceSynthesizerInput): boolean {
  if (isMemoryTopic(input.focus)) {
    return false;
  }

  return /rag|retrieval augmented generation|检索增强|ragas|trulens|deepeval|langsmith/i.test(input.focus);
}

function inferResearchQuestion(focus: string): string {
  if (isMemoryTopic(focus)) {
    return "应该如何选择或设计 agent/LLM 记忆框架，才能在效果、成本、延迟和安全性之间取得可验证的平衡？";
  }

  return `围绕“${focus}”，当前最需要支持的是选型、方案设计、benchmark，还是学习决策？`;
}

function inferDecisionContext(focus: string): string {
  if (isMemoryTopic(focus)) {
    return "用于选型 memory 框架、设计记忆模块，或规划 memory benchmark / POC。";
  }

  return "用于把资料整理成可讨论、可验证、能支持下一步行动的调研判断。";
}

function inferEvaluationCriteria(focus: string): string[] {
  if (isMemoryTopic(focus)) {
    return [
      "记忆命中率和召回质量",
      "记忆过期、遗忘和冲突解决策略",
      "检索延迟、写入延迟和端到端 latency",
      "token 成本、存储成本和索引维护成本",
      "个性化效果和用户满意度提升",
      "隐私、权限、可删除性和记忆污染率"
    ];
  }

  return ["效果指标", "成本指标", "延迟或效率指标", "可维护性", "风险和适用边界"];
}

function inferEvidenceRequirements(focus: string): string[] {
  if (isMemoryTopic(focus)) {
    return [
      "需要至少一个候选框架/方法对比表",
      "需要提出可执行的 POC 实验设计和指标采集方式",
      "需要区分短期上下文、长期语义记忆、事件记忆和程序性记忆"
    ];
  }

  return [
    "需要区分资料证据、推断和建议",
    "需要指出是否有实验、benchmark 或真实案例支撑",
    "如果没有数据，必须明确说明数据缺口和下一步验证方式"
  ];
}

function inferEvidenceGaps(input: EvidenceSynthesizerInput): string[] {
  const text = buildEvidenceText(input.sources).toLowerCase();
  const gaps: string[] = [];

  if (!/experiment|benchmark|dataset|evaluation|metric|实验|基准|数据集|指标/.test(text)) {
    gaps.push("当前资料更偏概念和方法介绍，缺少实验、benchmark 或量化指标。");
  }
  if (isMemoryTopic(input.focus) && !/hit rate|latency|token|cost|personalization|privacy|过期|延迟|成本|个性化|隐私/.test(text)) {
    gaps.push("当前资料未充分覆盖记忆命中率、过期策略、延迟、token 成本、个性化效果等 memory 评估指标。");
  }
  if (input.sources.length < 3) {
    gaps.push("候选资料数量较少，结论应作为初步判断，后续需要补充更多来源。");
  }

  return gaps.length > 0 ? gaps : ["当前资料仍主要来自标题和摘要，正式决策前需要核对原文和实验设置。"];
}

function isMemoryTopic(value: string): boolean {
  return /memory|memgpt|mem0|letta|zep|long[-\s]?term|记忆|长期记忆|记忆框架|上下文记忆/i.test(value);
}

function buildEvidenceText(sources: EvidenceSynthesizerInput["sources"]): string {
  return sources.map((source) => `${source.title} ${source.summary} ${source.publisher}`).join("\n");
}

function findKnownTerms(text: string, terms: string[]): string[] {
  const normalized = text.toLowerCase();
  return terms.filter((term) => normalized.includes(term.toLowerCase()));
}
