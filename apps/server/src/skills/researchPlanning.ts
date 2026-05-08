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
  "核心评估维度",
  "关键评估指标",
  "主流评估框架对比",
  "评估数据集和基准测试",
  "最佳实践和常见陷阱"
];

const MEMORY_FRAMEWORK_ASPECTS = [
  "研究问题和决策场景",
  "记忆模型和核心概念",
  "主流记忆框架对比（Mem0、Letta/MemGPT、Zep、LangGraph Memory、CrewAI Memory、自研轻量记忆层）",
  "评估指标和基准方法",
  "实验设计和数据需求",
  "风险、成本和运维限制"
];

export function buildResearchPlan(userGoal: string): ResearchPlan {
  const topic = userGoal.trim() || "用户指定主题";
  const normalizedGoal = normalizeText(topic);

  if (isMemoryFrameworkTopic(normalizedGoal)) {
    return {
      researchGoal: topic,
      researchQuestion: "应该如何选择或设计 agent/LLM 记忆框架，才能在效果、成本、延迟和安全性之间取得可验证的平衡？",
      decisionContext: "用于选型 memory 框架、设计记忆模块，或规划 memory benchmark / POC。",
      requiredAspects: MEMORY_FRAMEWORK_ASPECTS,
      optionalAspects: ["代表性开源项目", "个性化效果", "长期记忆治理", "隐私和权限控制"],
      searchQueries: [
        "MemGPT LangGraph memory Letta Zep Mem0 memory framework comparison",
        "CrewAI memory agent memory framework comparison",
        "LLM agent memory framework episodic semantic procedural memory",
        "agent memory benchmark memory hit rate personalization evaluation",
        "LLM long term memory expiration retrieval latency token cost"
      ],
      successCriteria: [
        "明确是在选框架、设计 memory，还是做 benchmark",
        "候选框架对比表至少包含 Mem0、Letta/MemGPT、Zep、LangGraph Memory、CrewAI Memory 和自研轻量记忆层",
        "列出可量化评估指标，而不是只给抽象建议",
        "说明需要哪些实验数据和对照组",
        "指出长期记忆的过期、污染、隐私、成本和延迟风险"
      ],
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
      ]
    };
  }

  if (isRagEvaluationTopic(normalizedGoal)) {
    return {
      researchGoal: topic,
      researchQuestion: "如何为 RAG 系统建立可落地、可复核、能支持团队决策的评估体系？",
      decisionContext: "用于选择评估框架、设计评估指标、确定数据集和落地验证流程。",
      requiredAspects: RAG_EVALUATION_ASPECTS,
      optionalAspects: ["企业落地场景", "人工评估与自动评估结合", "评估成本和可维护性"],
      searchQueries: [
        "RAG evaluation metrics faithfulness context precision recall",
        "RAGAS TruLens ARES DeepEval LangSmith comparison",
        "RAG evaluation benchmark datasets RGB CRUD KILT Natural Questions",
        "RAG evaluation best practices pitfalls production"
      ],
      successCriteria: [
        "能区分检索质量、生成质量和端到端质量",
        "能对比至少 3 个主流评估框架",
        "能说明常见数据集或 benchmark 的用途",
        "能指出落地评估中的风险和实践建议"
      ],
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
      ]
    };
  }

  return {
    researchGoal: topic,
    researchQuestion: `围绕“${topic}”，当前最需要支持的是选型、设计方案、做 benchmark，还是形成学习路线？`,
    decisionContext: "当前用户目标不够明确，应先把研究问题收敛成一个可决策的问题，再进入资料整理。",
    requiredAspects: ["研究问题和决策场景", "核心概念", "主要方法", "对比维度", "评估标准", "实验或证据需求", "风险和限制", "实践建议"],
    optionalAspects: ["代表案例", "最新趋势", "后续学习路径"],
    searchQueries: [`${topic} overview`, `${topic} comparison evaluation criteria`, `${topic} benchmark experiment best practices`],
    successCriteria: [
      "能明确本次调研要支持的具体决策",
      "能解释主题的核心概念和边界",
      "能列出主要观点或方法",
      "能给出对比、评估标准和取舍",
      "能说明还缺少哪些实验或数据"
    ],
    evaluationCriteria: ["效果指标", "成本指标", "延迟或效率指标", "可维护性", "风险和适用边界"],
    evidenceRequirements: [
      "需要区分资料证据、推断和建议",
      "需要指出是否有实验、benchmark 或真实案例支撑",
      "如果没有数据，必须明确说明数据缺口和下一步验证方式"
    ]
  };
}

export function renderResearchPlanForModel(plan: ResearchPlan): string {
  return [
    "research_planning_skill 输出：",
    `调研目标：${plan.researchGoal}`,
    `研究问题：${plan.researchQuestion}`,
    `决策场景：${plan.decisionContext}`,
    `必须覆盖：${plan.requiredAspects.join("、")}`,
    `评估标准：${plan.evaluationCriteria.join("、")}`,
    `证据要求：${plan.evidenceRequirements.join("；")}`,
    `可选补充：${plan.optionalAspects.join("、")}`,
    `建议检索式：${plan.searchQueries.join("；")}`,
    `完成标准：${plan.successCriteria.join("；")}`,
    "父智能体应根据覆盖情况决定是否追加资料收集；最终简报必须显式回答研究问题，列出评估标准，并说明实验/数据缺口；不要把以上内容原样写给用户。"
  ].join("\n");
}

function isRagEvaluationTopic(value: string): boolean {
  return /rag|retrieval augmented generation|检索增强|ragas|trulens|deepeval|langsmith/i.test(value);
}

function isMemoryFrameworkTopic(value: string): boolean {
  return /memory|memgpt|mem0|letta|zep|long[-\s]?term|记忆|长期记忆|记忆框架|上下文记忆|agent.*记忆/i.test(value);
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}
