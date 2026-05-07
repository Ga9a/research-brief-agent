import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
  executeRegisteredTool: vi.fn()
}));

vi.mock("../agent/deepseek.js", () => ({
  createChatCompletion: mocks.createChatCompletion
}));

vi.mock("../tools/index.js", () => ({
  executeRegisteredTool: mocks.executeRegisteredTool,
  toolDefinitions: []
}));

const { createToolCallKey, runAgentTurn } = await import("../agent/loop.js");
const { validateTaskArgs } = await import("../agent/taskTool.js");

const sourceOutput = {
  topic: "RAG 评估方法",
  sources: [
    {
      id: "papers:sample",
      title: "RAG Evaluation Methods",
      url: "https://arxiv.org/abs/2401.00001",
      sourceType: "papers",
      publisher: "arXiv",
      publishedAt: "2024",
      summary: "RAG evaluation methods compare retrieval quality and answer faithfulness.",
      relevanceScore: 1,
      credibilityScore: 0.9
    }
  ]
};

const extraSourceOutput = {
  topic: "RAG 评估方法生产实践",
  sources: [
    {
      id: "web:practice",
      title: "RAG Evaluation in Production",
      url: "https://docs.example.com/rag-evaluation-production",
      sourceType: "web",
      publisher: "Example Docs",
      publishedAt: null,
      summary: "Production RAG evaluation focuses on user-facing answer quality and monitoring.",
      relevanceScore: 0.8,
      credibilityScore: 0.8
    }
  ]
};

const memorySourceOutput = {
  topic: "AI 记忆框架",
  sources: [
    {
      id: "papers:memory",
      title: "Memory Frameworks for LLM Agents",
      url: "https://arxiv.org/abs/2402.00001",
      sourceType: "papers",
      publisher: "arXiv",
      publishedAt: "2024",
      summary: "Agent memory frameworks compare episodic memory, semantic memory, vector stores, and retrieval policies.",
      relevanceScore: 1,
      credibilityScore: 0.9
    }
  ]
};

const synthesisOutput = {
  synthesis: {
    focus: "面向组长讨论的 RAG 评估方案",
    outputFormat: "decision_brief",
    keyFindings: [
      "RAG 评估需要同时覆盖检索质量、生成质量和端到端质量。",
      "关键指标包括 faithfulness、answer relevancy、context precision 和 context recall。",
      "RAGAS、TruLens、ARES、DeepEval 和 LangSmith 适合不同评估场景。",
      "RGB、CRUD、KILT、Natural Questions 等数据集可用于 benchmark，生产实践还需要关注人工复核、成本和常见陷阱。"
    ],
    comparisons: [
      { dimension: "指标", notes: "检索指标和生成指标需要分开看。" },
      { dimension: "框架", notes: "RAGAS、TruLens、ARES、DeepEval、LangSmith 各有适用场景。" }
    ],
    risksOrLimitations: ["资料覆盖仍需后续扩展，生产实践中需要关注人工复核、成本和常见陷阱。"],
    recommendation: "先建立小样本评估框架，再逐步扩展。"
  }
};

const memorySynthesisOutput = {
  synthesis: {
    focus: "帮我研究 AI 记忆框架",
    outputFormat: "decision_brief",
    keyFindings: ["AI 记忆框架需要区分短期上下文、长期记忆和检索策略。"],
    comparisons: [{ dimension: "记忆类型", notes: "语义记忆和事件记忆适合不同任务。" }],
    risksOrLimitations: ["长期记忆需要控制污染、过期和隐私问题。"],
    recommendation: "先明确记忆写入、检索和遗忘策略，再选择框架。"
  }
};

const lowCoverageSynthesisOutput = {
  synthesis: {
    focus: "RAG 评估体系",
    outputFormat: "decision_brief",
    keyFindings: ["RAG 评估需要关注 faithfulness 和 context precision。"],
    comparisons: [{ dimension: "指标", notes: "检索指标和生成指标需要分开看。" }],
    risksOrLimitations: ["当前资料仍不完整。"],
    recommendation: "继续补充资料后再写简报。"
  }
};

const briefOutput = {
  brief: {
    title: "面向组长讨论的 RAG 评估方案调研简报",
    conclusion: "建议先建立小样本评估框架。",
    keyFindings: ["RAG 评估需要同时覆盖检索质量和答案忠实度。"],
    comparisonAnalysis: "| 指标 | 检索指标和生成指标需要分开看。 |",
    suggestedQuestions: ["我们需要优先支持哪个决策？"],
    nextSteps: ["补充真实资料来源。"],
    content:
      "# 面向组长讨论的 RAG 评估方案调研简报\n\n## 关键发现\n- RAG 评估需要同时覆盖检索质量和答案忠实度。"
  }
};

describe("调研 Agent 流程", () => {
  beforeEach(() => {
    mocks.createChatCompletion.mockReset();
    mocks.executeRegisteredTool.mockReset();
    mocks.executeRegisteredTool.mockImplementation(async (name: string) => {
      if (name === "source_collector") {
        return { output: JSON.stringify(sourceOutput) };
      }
      if (name === "evidence_synthesizer") {
        return { output: JSON.stringify(synthesisOutput) };
      }
      if (name === "brief_writer") {
        return { output: JSON.stringify(briefOutput) };
      }
      throw new Error(`未知工具：${name}`);
    });
  });

  it("相同工具参数顺序不同也会生成相同去重 key", () => {
    expect(createToolCallKey("source_collector", { topic: "RAG", sourceTypes: ["web", "papers"] })).toBe(
      createToolCallKey("source_collector", { sourceTypes: ["web", "papers"], topic: "RAG" })
    );
  });

  it("task instruction 为空时会自动补默认值", () => {
    expect(validateTaskArgs({ taskType: "synthesize_evidence", instruction: "" })).toMatchObject({
      taskType: "synthesize_evidence",
      instruction: "根据用户问题和已有调研上下文完成该子任务。"
    });
  });

  it("父智能体可以先按需加载 SKILL.md，加载过程不作为前端调研步骤展示", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "skill_1",
            type: "function",
            function: {
              name: "load_skill",
              arguments: JSON.stringify({ name: "research_planning_skill" })
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        role: "assistant",
        content: "我会先明确调研目标，再决定是否需要收集资料。",
        tool_calls: []
      });

    const response = await runAgentTurn({ message: "帮我规划一个 RAG 评估方法调研" });
    const secondCallMessages = mocks.createChatCompletion.mock.calls[1]?.[0].messages;
    const loadedSkillMessage = secondCallMessages.find(
      (message: { role: string; content: string | null }) =>
        message.role === "tool" && message.content?.includes('<skill name="research_planning_skill">')
    );

    expect(response.researchEvents).toHaveLength(0);
    expect(response.messages.at(-1)?.content).toContain("明确调研目标");
    expect(loadedSkillMessage).toBeDefined();
  });

  it("证据整理子工具缺少 focus 时会由后端注入用户调研目标", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(parentTask("task_collect_1", "collect_sources", "收集 RAG 评估方法资料"))
      .mockResolvedValueOnce(childTool("collect_1", "source_collector", { topic: "RAG 评估方法", sourceTypes: ["papers"] }))
      .mockResolvedValueOnce(parentTask("task_synthesize_1", "synthesize_evidence", "整理 RAG 评估方法资料"))
      .mockResolvedValueOnce(childTool("synthesize_1", "evidence_synthesizer", {}))
      .mockResolvedValueOnce({
        role: "assistant",
        content: "已整理 RAG 评估方法的关键证据。",
        tool_calls: []
      });

    const response = await runAgentTurn({ message: "帮我研究 RAG 评估方法" });
    const synthesizeCall = mocks.executeRegisteredTool.mock.calls.find(([name]) => name === "evidence_synthesizer");

    expect(response.researchEvents.find((event) => event.toolName === "synthesize_evidence")?.status).toBe("completed");
    expect(synthesizeCall?.[1]).toMatchObject({
      sources: sourceOutput.sources,
      focus: "帮我研究 RAG 评估方法",
      outputFormat: "decision_brief"
    });
  });

  it("整理证据覆盖不足时会把 coverage feedback 注入下一轮并阻止直接生成简报", async () => {
    mocks.executeRegisteredTool.mockImplementation(async (name: string) => {
      if (name === "source_collector") {
        return { output: JSON.stringify(sourceOutput) };
      }
      if (name === "evidence_synthesizer") {
        return { output: JSON.stringify(lowCoverageSynthesisOutput) };
      }
      if (name === "brief_writer") {
        return { output: JSON.stringify(briefOutput) };
      }
      throw new Error(`未知工具：${name}`);
    });

    mocks.createChatCompletion
      .mockResolvedValueOnce(parentTask("task_collect_1", "collect_sources", "收集 RAG 评估体系资料"))
      .mockResolvedValueOnce(childTool("collect_1", "source_collector", { topic: "RAG 评估体系", sourceTypes: ["papers"] }))
      .mockResolvedValueOnce(parentTask("task_synthesize_1", "synthesize_evidence", "整理 RAG 评估体系资料"))
      .mockResolvedValueOnce(childTool("synthesize_1", "evidence_synthesizer", {}))
      .mockResolvedValueOnce(parentTask("task_brief_1", "write_brief", "生成中文调研简报"))
      .mockResolvedValueOnce({
        role: "assistant",
        content: "当前覆盖不足，已先暂停生成正式简报。",
        tool_calls: []
      });

    const response = await runAgentTurn({ message: "帮我研究 RAG 评估体系" });
    const fifthCallMessages = mocks.createChatCompletion.mock.calls[4]?.[0].messages;
    const feedbackMessage = fifthCallMessages.find(
      (message: { role: string; content: string | null }) =>
        message.role === "system" && message.content?.includes("coverage feedback：当前证据覆盖不足")
    );

    expect(feedbackMessage?.content).toContain("下一步必须调用 task: collect_sources");
    expect(response.researchEvents.at(-1)).toMatchObject({
      toolName: "write_brief",
      status: "failed"
    });
    expect(response.researchEvents.at(-1)?.error).toContain("当前证据覆盖率只有");
    expect(mocks.executeRegisteredTool.mock.calls.some(([name]) => name === "brief_writer")).toBe(false);
  });

  it("同一个 session 的新主题不会默认复用上一轮旧产物", async () => {
    mocks.executeRegisteredTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "source_collector") {
        return {
          output: JSON.stringify(String(args.topic || "").includes("记忆") ? memorySourceOutput : sourceOutput)
        };
      }
      if (name === "evidence_synthesizer") {
        const sources = Array.isArray(args.sources) ? args.sources : [];
        const hasMemorySource = sources.some((source) =>
          String((source as { title?: string }).title || "").includes("Memory Frameworks")
        );
        return { output: JSON.stringify(hasMemorySource ? memorySynthesisOutput : synthesisOutput) };
      }
      if (name === "brief_writer") {
        return { output: JSON.stringify(briefOutput) };
      }
      throw new Error(`未知工具：${name}`);
    });

    mocks.createChatCompletion
      .mockResolvedValueOnce(parentTask("task_collect_1", "collect_sources", "收集 RAG 评估方法资料"))
      .mockResolvedValueOnce(childTool("collect_1", "source_collector", { topic: "RAG 评估方法", sourceTypes: ["papers"] }))
      .mockResolvedValueOnce(parentTask("task_synthesize_1", "synthesize_evidence", "整理 RAG 评估方法资料"))
      .mockResolvedValueOnce(childTool("synthesize_1", "evidence_synthesizer", {}))
      .mockResolvedValueOnce({
        role: "assistant",
        content: "RAG 评估方法调研已完成。",
        tool_calls: []
      })
      .mockResolvedValueOnce(parentTask("task_collect_2", "collect_sources", "收集 AI 记忆框架资料"))
      .mockResolvedValueOnce(childTool("collect_2", "source_collector", { topic: "AI 记忆框架", sourceTypes: ["papers"] }))
      .mockResolvedValueOnce(parentTask("task_synthesize_2", "synthesize_evidence", "整理 AI 记忆框架资料"))
      .mockResolvedValueOnce(childTool("synthesize_2", "evidence_synthesizer", {}))
      .mockResolvedValueOnce({
        role: "assistant",
        content: "AI 记忆框架调研已完成。",
        tool_calls: []
      });

    const first = await runAgentTurn({ message: "帮我研究 RAG 评估方法" });
    await runAgentTurn({ sessionId: first.sessionId, message: "帮我研究 AI 记忆框架" });

    const synthesizeCalls = mocks.executeRegisteredTool.mock.calls.filter(([name]) => name === "evidence_synthesizer");
    const secondSynthesizeArgs = synthesizeCalls.at(-1)?.[1] as { sources?: unknown[]; focus?: string };

    expect(secondSynthesizeArgs.sources).toEqual(memorySourceOutput.sources);
    expect(JSON.stringify(secondSynthesizeArgs.sources)).not.toContain("RAG Evaluation Methods");
    expect(secondSynthesizeArgs.focus).toBe("帮我研究 AI 记忆框架");
  });

  it("能完成资料收集到简报生成的完整流程", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "task_collect_1",
            type: "function",
            function: {
              name: "task",
              arguments: JSON.stringify({
                taskType: "collect_sources",
                instruction: "围绕 RAG 评估方法收集 web 和 papers 来源"
              })
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "collect_1",
            type: "function",
            function: {
              name: "source_collector",
              arguments: JSON.stringify({
                topic: "RAG 评估方法",
                sourceTypes: ["web", "papers"],
                maxResults: 6,
                recency: "balanced"
              })
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "task_synthesize_1",
            type: "function",
            function: {
              name: "task",
              arguments: JSON.stringify({
                taskType: "synthesize_evidence",
                instruction: "把已收集资料整理成面向组长讨论的 RAG 评估方案"
              })
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "synthesize_1",
            type: "function",
            function: {
              name: "evidence_synthesizer",
              arguments: JSON.stringify({
                focus: "面向组长讨论的 RAG 评估方案",
                outputFormat: "decision_brief"
              })
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "task_brief_1",
            type: "function",
            function: {
              name: "task",
              arguments: JSON.stringify({
                taskType: "write_brief",
                instruction: "生成适合和组长讨论的中等长度中文调研简报"
              })
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "brief_1",
            type: "function",
            function: {
              name: "brief_writer",
              arguments: JSON.stringify({
                audience: "team_lead",
                length: "medium"
              })
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        role: "assistant",
        content: briefOutput.brief.content,
        tool_calls: []
      });

    const response = await runAgentTurn({ message: "帮我研究 RAG 评估方法" });
    const finalContent = response.messages.at(-1)?.content || "";

    expect(response.researchEvents.map((event) => event.toolName)).toEqual([
      "collect_sources",
      "synthesize_evidence",
      "write_brief"
    ]);
    expect(finalContent).toContain("RAG 评估方案调研简报");
    expect(finalContent).toContain("## 关键发现");
    for (const legacyTerm of ["nm" + "ap", "port" + " scan", "host" + " discovery"]) {
      expect(finalContent.toLowerCase()).not.toContain(legacyTerm);
    }

    const synthesizeCall = mocks.executeRegisteredTool.mock.calls.find(([name]) => name === "evidence_synthesizer");
    const briefCall = mocks.executeRegisteredTool.mock.calls.find(([name]) => name === "brief_writer");
    expect(synthesizeCall?.[1]).toMatchObject({
      sources: sourceOutput.sources,
      focus: "面向组长讨论的 RAG 评估方案",
      outputFormat: "decision_brief"
    });
    expect(briefCall?.[1]).toMatchObject({
      synthesis: synthesisOutput.synthesis,
      audience: "team_lead",
      length: "medium"
    });
    expect(response.researchEvents.find((event) => event.toolName === "synthesize_evidence")?.args).toEqual({
      taskType: "synthesize_evidence",
      instruction: "把已收集资料整理成面向组长讨论的 RAG 评估方案"
    });
    expect(response.researchEvents.find((event) => event.toolName === "write_brief")?.args).toEqual({
      taskType: "write_brief",
      instruction: "生成适合和组长讨论的中等长度中文调研简报"
    });
  });

  it("不会把明显的内部函数名作为最终主消息返回", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "task_collect_1",
            type: "function",
            function: {
              name: "task",
              arguments: JSON.stringify({
                taskType: "collect_sources",
                instruction: "收集 RAG 评估方法资料"
              })
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "collect_1",
            type: "function",
            function: {
              name: "source_collector",
              arguments: JSON.stringify({
                topic: "RAG 评估方法",
                sourceTypes: ["papers"]
              })
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        role: "assistant",
        content: "task 已经完成。",
        tool_calls: []
      });

    const response = await runAgentTurn({ message: "帮我研究 RAG 评估方法" });

    expect(response.messages.at(-1)?.content).not.toContain("source_collector");
    expect(response.messages.at(-1)?.content).not.toContain("task");
  });

  it("最终回答不会把上下文污染诊断暴露给用户", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(parentTask("task_collect_1", "collect_sources", "收集 RAG 评估方法资料"))
      .mockResolvedValueOnce(childTool("collect_1", "source_collector", { topic: "RAG 评估方法", sourceTypes: ["papers"] }))
      .mockResolvedValueOnce(parentTask("task_synthesize_1", "synthesize_evidence", "整理 RAG 评估方法资料"))
      .mockResolvedValueOnce(childTool("synthesize_1", "evidence_synthesizer", {}))
      .mockResolvedValueOnce(parentTask("task_brief_1", "write_brief", "生成中文调研简报"))
      .mockResolvedValueOnce(childTool("brief_1", "brief_writer", { audience: "self_learning", length: "medium" }))
      .mockResolvedValueOnce({
        role: "assistant",
        content: "可以看到简报的内容被之前的 RAG 评估上下文污染了。",
        tool_calls: []
      });

    const response = await runAgentTurn({ message: "帮我研究 RAG 评估方法" });

    expect(response.messages.at(-1)?.content).toContain("RAG 评估方案调研简报");
    expect(response.messages.at(-1)?.content).not.toContain("上下文污染");
    expect(response.messages.at(-1)?.content).not.toContain("污染");
  });

  it("资料收集出现配置或限流错误后停止继续调用工具", async () => {
    mocks.executeRegisteredTool.mockRejectedValueOnce(new Error("Missing SEARCH_API_KEY for web search"));
    mocks.createChatCompletion
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "task_collect_1",
            type: "function",
            function: {
              name: "task",
              arguments: JSON.stringify({
                taskType: "collect_sources",
                instruction: "收集 RAG 评估方法 web 资料"
              })
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "collect_1",
            type: "function",
            function: {
              name: "source_collector",
              arguments: JSON.stringify({
                topic: "RAG 评估方法",
                sourceTypes: ["web"]
              })
            }
          }
        ]
      });

    const response = await runAgentTurn({ message: "帮我研究 RAG 评估方法" });

    expect(mocks.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(response.researchEvents).toHaveLength(1);
    expect(response.messages.at(-1)?.content).toContain("调研暂时无法继续");
    expect(response.messages.at(-1)?.content).toContain("SEARCH_API_KEY");
  });

  it("允许整理后追加资料并在下一次整理时合并多批来源", async () => {
    let collectCount = 0;
    mocks.executeRegisteredTool.mockImplementation(async (name: string) => {
      if (name === "source_collector") {
        collectCount += 1;
        return { output: JSON.stringify(collectCount === 1 ? sourceOutput : extraSourceOutput) };
      }
      if (name === "evidence_synthesizer") {
        return { output: JSON.stringify(synthesisOutput) };
      }
      if (name === "brief_writer") {
        return { output: JSON.stringify(briefOutput) };
      }
      throw new Error(`未知工具：${name}`);
    });

    mocks.createChatCompletion
      .mockResolvedValueOnce(parentTask("task_collect_1", "collect_sources", "先收集 RAG 评估方法资料"))
      .mockResolvedValueOnce(childTool("collect_1", "source_collector", { topic: "RAG 评估方法", sourceTypes: ["papers"] }))
      .mockResolvedValueOnce(parentTask("task_synthesize_1", "synthesize_evidence", "先整理已有资料"))
      .mockResolvedValueOnce(
        childTool("synthesize_1", "evidence_synthesizer", {
          focus: "面向组长讨论的 RAG 评估方案",
          outputFormat: "decision_brief"
        })
      )
      .mockResolvedValueOnce(parentTask("task_collect_2", "collect_sources", "补充收集 RAG 评估的生产实践资料"))
      .mockResolvedValueOnce(
        childTool("collect_2", "source_collector", {
          topic: "RAG 评估生产实践",
          sourceTypes: ["web"],
          maxResults: 3
        })
      )
      .mockResolvedValueOnce(parentTask("task_synthesize_2", "synthesize_evidence", "结合两批资料重新整理"))
      .mockResolvedValueOnce(
        childTool("synthesize_2", "evidence_synthesizer", {
          focus: "面向组长讨论的 RAG 评估方案",
          outputFormat: "decision_brief"
        })
      )
      .mockResolvedValueOnce(parentTask("task_brief_1", "write_brief", "生成最终中文简报"))
      .mockResolvedValueOnce(childTool("brief_1", "brief_writer", { audience: "team_lead", length: "medium" }))
      .mockResolvedValueOnce({
        role: "assistant",
        content: briefOutput.brief.content,
        tool_calls: []
      });

    const response = await runAgentTurn({ message: "帮我研究 RAG 评估方法，如果资料不够可以补充收集" });
    const synthesizeCalls = mocks.executeRegisteredTool.mock.calls.filter(([name]) => name === "evidence_synthesizer");

    expect(response.researchEvents.map((event) => event.toolName)).toEqual([
      "collect_sources",
      "synthesize_evidence",
      "collect_sources",
      "synthesize_evidence",
      "write_brief"
    ]);
    expect(synthesizeCalls.at(-1)?.[1]).toMatchObject({
      sources: [...sourceOutput.sources, ...extraSourceOutput.sources],
      focus: "面向组长讨论的 RAG 评估方案",
      outputFormat: "decision_brief"
    });
  });

  it("能修复 brief_writer 参数末尾多出属性片段的 JSON", async () => {
    const malformedBriefArgs = `${JSON.stringify({ synthesis: synthesisOutput.synthesis })},"audience":"team_lead","length":"medium"`;
    mocks.createChatCompletion
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "task_collect_1",
            type: "function",
            function: {
              name: "task",
              arguments: JSON.stringify({
                taskType: "collect_sources",
                instruction: "收集 RAG 评估方法资料"
              })
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "collect_1",
            type: "function",
            function: {
              name: "source_collector",
              arguments: JSON.stringify({
                topic: "RAG 评估方法",
                sourceTypes: ["papers"]
              })
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "task_synthesize_1",
            type: "function",
            function: {
              name: "task",
              arguments: JSON.stringify({
                taskType: "synthesize_evidence",
                instruction: "整理 RAG 评估方法资料"
              })
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "synthesize_1",
            type: "function",
            function: {
              name: "evidence_synthesizer",
              arguments: JSON.stringify({
                focus: "面向组长讨论的 RAG 评估方案",
                outputFormat: "decision_brief"
              })
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "task_brief_1",
            type: "function",
            function: {
              name: "task",
              arguments: JSON.stringify({
                taskType: "write_brief",
                instruction: "生成适合和组长讨论的中等长度中文调研简报"
              })
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "brief_1",
            type: "function",
            function: {
              name: "brief_writer",
              arguments: malformedBriefArgs
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        role: "assistant",
        content: briefOutput.brief.content,
        tool_calls: []
      });

    const response = await runAgentTurn({ message: "帮我研究 RAG 评估方法" });
    const briefCall = mocks.executeRegisteredTool.mock.calls.find(([name]) => name === "brief_writer");

    expect(response.researchEvents.at(-1)).toMatchObject({ toolName: "write_brief", status: "completed" });
    expect(briefCall?.[1]).toMatchObject({
      synthesis: synthesisOutput.synthesis,
      audience: "team_lead",
      length: "medium"
    });
  });
});

function parentTask(id: string, taskType: string, instruction: string) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id,
        type: "function",
        function: {
          name: "task",
          arguments: JSON.stringify({ taskType, instruction })
        }
      }
    ]
  };
}

function childTool(id: string, name: string, args: unknown) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id,
        type: "function",
        function: {
          name,
          arguments: JSON.stringify(args)
        }
      }
    ]
  };
}
