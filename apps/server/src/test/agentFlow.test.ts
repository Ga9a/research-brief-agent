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
  topic: "RAG evaluation methods",
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
  topic: "RAG evaluation production practices",
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
  topic: "AI memory frameworks",
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
    focus: "RAG evaluation for team discussion",
    outputFormat: "decision_brief",
    keyFindings: [
      "RAG evaluation covers retrieval, generation, and end-to-end quality.",
      "Key metrics include faithfulness, answer relevancy, context precision, and context recall.",
      "RAGAS, TruLens, ARES, DeepEval, and LangSmith address different evaluation needs.",
      "RGB, CRUD, KILT, and Natural Questions support benchmarks. Production practice needs human review of costs and pitfalls."
    ],
    comparisons: [
      { dimension: "Metrics", notes: "Separate retrieval and generation metrics." },
      { dimension: "Frameworks", notes: "RAGAS, TruLens, ARES, DeepEval, and LangSmith have different use cases." }
    ],
    risksOrLimitations: ["Expand evidence coverage and review production risks, costs, and pitfalls."],
    recommendation: "Build a small evaluation workflow, then expand."
  }
};

const memorySynthesisOutput = {
  synthesis: {
    focus: "Research AI memory frameworks",
    outputFormat: "decision_brief",
    keyFindings: ["AI memory frameworks distinguish short-term context, long-term memory, and retrieval policies."],
    comparisons: [{ dimension: "Memory types", notes: "Semantic and episodic memory serve different tasks." }],
    risksOrLimitations: ["Long-term memory requires contamination, expiration, and privacy controls."],
    recommendation: "Define memory write, retrieval, and forgetting policies before selection."
  }
};

const lowCoverageSynthesisOutput = {
  synthesis: {
    focus: "RAG evaluation system",
    outputFormat: "decision_brief",
    keyFindings: ["RAG evaluation considers faithfulness and context precision."],
    comparisons: [{ dimension: "Metrics", notes: "Separate retrieval and generation metrics." }],
    risksOrLimitations: ["The evidence is still incomplete."],
    recommendation: "Collect more evidence before writing."
  }
};

const briefOutput = {
  brief: {
    title: "RAG evaluation for team discussion Research brief",
    conclusion: "Build a small evaluation workflow first.",
    keyFindings: ["RAG evaluation covers retrieval quality and answer faithfulness."],
    comparisonAnalysis: "| Metrics | Separate retrieval and generation metrics. |",
    suggestedQuestions: ["Which decision should we support first?"],
    nextSteps: ["Collect additional real sources."],
    content:
      "# RAG evaluation for team discussion Research brief\n\n## Key findings\n- RAG evaluation covers retrieval quality and answer faithfulness."
  }
};

describe("agentFlow", () => {
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
      throw new Error(`Unknown tool: ${name}`);
    });
  });

  it("normalizes tool arguments for deduplication", () => {
    expect(createToolCallKey("source_collector", { topic: "RAG", sourceTypes: ["web", "papers"] })).toBe(
      createToolCallKey("source_collector", { sourceTypes: ["web", "papers"], topic: "RAG" })
    );
  });

  it("defaults an empty instruction", () => {
    expect(validateTaskArgs({ taskType: "synthesize_evidence", instruction: "" })).toMatchObject({
      taskType: "synthesize_evidence",
      instruction: "Complete this subtask using the user question and available research context."
    });
  });

  it("loads skills without adding progress events", async () => {
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
        content: "I will clarify the research goal before deciding whether to collect sources.",
        tool_calls: []
      });

    const response = await runAgentTurn({ message: "Plan research on RAG evaluation methods" });
    const secondCallMessages = mocks.createChatCompletion.mock.calls[1]?.[0].messages;
    const loadedSkillMessage = secondCallMessages.find(
      (message: { role: string; content: string | null }) =>
        message.role === "tool" && message.content?.includes('<skill name="research_planning_skill">')
    );

    expect(response.researchEvents).toHaveLength(0);
    expect(response.messages.at(-1)?.content).toContain("clarify the research goal");
    expect(loadedSkillMessage).toBeDefined();
  });

  it("injects missing synthesis focus", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(parentTask("task_collect_1", "collect_sources", "Collect RAG evaluation sources"))
      .mockResolvedValueOnce(childTool("collect_1", "source_collector", { topic: "RAG evaluation methods", sourceTypes: ["papers"] }))
      .mockResolvedValueOnce(parentTask("task_synthesize_1", "synthesize_evidence", "Synthesize RAG evaluation sources"))
      .mockResolvedValueOnce(childTool("synthesize_1", "evidence_synthesizer", {}))
      .mockResolvedValueOnce({
        role: "assistant",
        content: "Synthesized key RAG evaluation evidence.",
        tool_calls: []
      });

    const response = await runAgentTurn({ message: "Research RAG evaluation methods" });
    const synthesizeCall = mocks.executeRegisteredTool.mock.calls.find(([name]) => name === "evidence_synthesizer");

    expect(response.researchEvents.find((event) => event.toolName === "synthesize_evidence")?.status).toBe("completed");
    expect(synthesizeCall?.[1]).toMatchObject({
      sources: sourceOutput.sources,
      focus: "Research RAG evaluation methods",
      outputFormat: "decision_brief"
    });
  });

  it("blocks writing with insufficient coverage", async () => {
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
      throw new Error(`Unknown tool: ${name}`);
    });

    mocks.createChatCompletion
      .mockResolvedValueOnce(parentTask("task_collect_1", "collect_sources", "Collect RAG evaluation system sources"))
      .mockResolvedValueOnce(childTool("collect_1", "source_collector", { topic: "RAG evaluation system", sourceTypes: ["papers"] }))
      .mockResolvedValueOnce(parentTask("task_synthesize_1", "synthesize_evidence", "Synthesize RAG evaluation system sources"))
      .mockResolvedValueOnce(childTool("synthesize_1", "evidence_synthesizer", {}))
      .mockResolvedValueOnce(parentTask("task_brief_1", "write_brief", "Write an English research brief"))
      .mockResolvedValueOnce({
        role: "assistant",
        content: "Coverage is insufficient, so brief generation is paused.",
        tool_calls: []
      });

    const response = await runAgentTurn({ message: "Research RAG evaluation system" });
    const fifthCallMessages = mocks.createChatCompletion.mock.calls[4]?.[0].messages;
    const feedbackMessage = fifthCallMessages.find(
      (message: { role: string; content: string | null }) =>
        message.role === "system" && message.content?.includes("Coverage feedback: evidence is incomplete")
    );

    expect(feedbackMessage?.content).toContain("Next call task: collect_sources");
    expect(response.researchEvents.at(-1)).toMatchObject({
      toolName: "write_brief",
      status: "failed"
    });
    expect(response.researchEvents.at(-1)?.error).toContain("Evidence coverage is");
    expect(mocks.executeRegisteredTool.mock.calls.some(([name]) => name === "brief_writer")).toBe(false);
  });

  it("isolates artifacts between topics", async () => {
    mocks.executeRegisteredTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "source_collector") {
        return {
          output: JSON.stringify(String(args.topic || "").includes("memory") ? memorySourceOutput : sourceOutput)
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
      throw new Error(`Unknown tool: ${name}`);
    });

    mocks.createChatCompletion
      .mockResolvedValueOnce(parentTask("task_collect_1", "collect_sources", "Collect RAG evaluation sources"))
      .mockResolvedValueOnce(childTool("collect_1", "source_collector", { topic: "RAG evaluation methods", sourceTypes: ["papers"] }))
      .mockResolvedValueOnce(parentTask("task_synthesize_1", "synthesize_evidence", "Synthesize RAG evaluation sources"))
      .mockResolvedValueOnce(childTool("synthesize_1", "evidence_synthesizer", {}))
      .mockResolvedValueOnce({
        role: "assistant",
        content: "RAG evaluation methodsResearch completed.",
        tool_calls: []
      })
      .mockResolvedValueOnce(parentTask("task_collect_2", "collect_sources", "Collect AI memory framework sources"))
      .mockResolvedValueOnce(childTool("collect_2", "source_collector", { topic: "AI memory frameworks", sourceTypes: ["papers"] }))
      .mockResolvedValueOnce(parentTask("task_synthesize_2", "synthesize_evidence", "Synthesize AI memory framework sources"))
      .mockResolvedValueOnce(childTool("synthesize_2", "evidence_synthesizer", {}))
      .mockResolvedValueOnce({
        role: "assistant",
        content: "AI memory frameworksResearch completed.",
        tool_calls: []
      });

    const first = await runAgentTurn({ message: "Research RAG evaluation methods" });
    await runAgentTurn({ sessionId: first.sessionId, message: "Research AI memory frameworks" });

    const synthesizeCalls = mocks.executeRegisteredTool.mock.calls.filter(([name]) => name === "evidence_synthesizer");
    const secondSynthesizeArgs = synthesizeCalls.at(-1)?.[1] as { sources?: unknown[]; focus?: string };
    const sourceCalls = mocks.executeRegisteredTool.mock.calls.filter(([name]) => name === "source_collector");
    const secondSourceArgs = sourceCalls.at(-1)?.[1] as { topic?: string };

    expect(secondSynthesizeArgs.sources).toEqual(memorySourceOutput.sources);
    expect(JSON.stringify(secondSynthesizeArgs.sources)).not.toContain("RAG Evaluation Methods");
    expect(secondSynthesizeArgs.focus).toBe("Research AI memory frameworks");
    expect(secondSourceArgs.topic).toContain("MemGPT");
    expect(secondSourceArgs.topic).toContain("Mem0");
  });

  it("completes the research workflow", async () => {
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
                instruction: "Collect web and paper sources on RAG evaluation methods"
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
                topic: "RAG evaluation methods",
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
                instruction: "Synthesize collected sources for a team discussion on RAG evaluation"
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
                focus: "RAG evaluation for team discussion",
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
                instruction: "Write a medium-length English brief for team discussion"
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

    const response = await runAgentTurn({ message: "Research RAG evaluation methods" });
    const finalContent = response.messages.at(-1)?.content || "";

    expect(response.researchEvents.map((event) => event.toolName)).toEqual([
      "collect_sources",
      "synthesize_evidence",
      "write_brief"
    ]);
    expect(finalContent).toContain("RAG evaluation for team discussion Research brief");
    expect(finalContent).toContain("## Key findings");
    for (const legacyTerm of ["nm" + "ap", "port" + " scan", "host" + " discovery"]) {
      expect(finalContent.toLowerCase()).not.toContain(legacyTerm);
    }

    const synthesizeCall = mocks.executeRegisteredTool.mock.calls.find(([name]) => name === "evidence_synthesizer");
    const briefCall = mocks.executeRegisteredTool.mock.calls.find(([name]) => name === "brief_writer");
    expect(synthesizeCall?.[1]).toMatchObject({
      sources: sourceOutput.sources,
      focus: "RAG evaluation for team discussion",
      outputFormat: "decision_brief"
    });
    expect(briefCall?.[1]).toMatchObject({
      synthesis: synthesisOutput.synthesis,
      audience: "team_lead",
      length: "medium"
    });
    expect(response.researchEvents.find((event) => event.toolName === "synthesize_evidence")?.args).toEqual({
      taskType: "synthesize_evidence",
      instruction: "Synthesize collected sources for a team discussion on RAG evaluation"
    });
    expect(response.researchEvents.find((event) => event.toolName === "write_brief")?.args).toEqual({
      taskType: "write_brief",
      instruction: "Write a medium-length English brief for team discussion"
    });
  });

  it("hides internal function names", async () => {
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
                instruction: "Collect RAG evaluation sources"
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
                topic: "RAG evaluation methods",
                sourceTypes: ["papers"]
              })
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        role: "assistant",
        content: "task completed.",
        tool_calls: []
      });

    const response = await runAgentTurn({ message: "Research RAG evaluation methods" });

    expect(response.messages.at(-1)?.content).not.toContain("source_collector");
    expect(response.messages.at(-1)?.content).not.toContain("task");
  });

  it("hides context diagnostics", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(parentTask("task_collect_1", "collect_sources", "Collect RAG evaluation sources"))
      .mockResolvedValueOnce(childTool("collect_1", "source_collector", { topic: "RAG evaluation methods", sourceTypes: ["papers"] }))
      .mockResolvedValueOnce(parentTask("task_synthesize_1", "synthesize_evidence", "Synthesize RAG evaluation sources"))
      .mockResolvedValueOnce(childTool("synthesize_1", "evidence_synthesizer", {}))
      .mockResolvedValueOnce(parentTask("task_brief_1", "write_brief", "Write an English research brief"))
      .mockResolvedValueOnce(childTool("brief_1", "brief_writer", { audience: "self_learning", length: "medium" }))
      .mockResolvedValueOnce({
        role: "assistant",
        content: "The brief was contaminated by previous RAG evaluation context contamination.",
        tool_calls: []
      });

    const response = await runAgentTurn({ message: "Research RAG evaluation methods" });

    expect(response.messages.at(-1)?.content).toContain("RAG evaluation for team discussion Research brief");
    expect(response.messages.at(-1)?.content).not.toContain("context contamination");
    expect(response.messages.at(-1)?.content).not.toContain("contamination");
  });

  it("stops on collection errors", async () => {
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
                instruction: "Collect web sources on RAG evaluation methods"
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
                topic: "RAG evaluation methods",
                sourceTypes: ["web"]
              })
            }
          }
        ]
      });

    const response = await runAgentTurn({ message: "Research RAG evaluation methods" });

    expect(mocks.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(response.researchEvents).toHaveLength(1);
    expect(response.messages.at(-1)?.content).toContain("Research could not continue");
    expect(response.messages.at(-1)?.content).toContain("SEARCH_API_KEY");
  });

  it("merges additional source batches", async () => {
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
      throw new Error(`Unknown tool: ${name}`);
    });

    mocks.createChatCompletion
      .mockResolvedValueOnce(parentTask("task_collect_1", "collect_sources", "Collect initial RAG evaluation sources"))
      .mockResolvedValueOnce(childTool("collect_1", "source_collector", { topic: "RAG evaluation methods", sourceTypes: ["papers"] }))
      .mockResolvedValueOnce(parentTask("task_synthesize_1", "synthesize_evidence", "Synthesize existing sources first"))
      .mockResolvedValueOnce(
        childTool("synthesize_1", "evidence_synthesizer", {
          focus: "RAG evaluation for team discussion",
          outputFormat: "decision_brief"
        })
      )
      .mockResolvedValueOnce(parentTask("task_collect_2", "collect_sources", "Collect additional RAG production evaluation sources"))
      .mockResolvedValueOnce(
        childTool("collect_2", "source_collector", {
          topic: "RAG evaluation production practices",
          sourceTypes: ["web"],
          maxResults: 3
        })
      )
      .mockResolvedValueOnce(parentTask("task_synthesize_2", "synthesize_evidence", "Synthesize both source batches"))
      .mockResolvedValueOnce(
        childTool("synthesize_2", "evidence_synthesizer", {
          focus: "RAG evaluation for team discussion",
          outputFormat: "decision_brief"
        })
      )
      .mockResolvedValueOnce(parentTask("task_brief_1", "write_brief", "Write the final English brief"))
      .mockResolvedValueOnce(childTool("brief_1", "brief_writer", { audience: "team_lead", length: "medium" }))
      .mockResolvedValueOnce({
        role: "assistant",
        content: briefOutput.brief.content,
        tool_calls: []
      });

    const response = await runAgentTurn({ message: "Research RAG evaluation methods, collect more sources if evidence is insufficient" });
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
      focus: "RAG evaluation for team discussion",
      outputFormat: "decision_brief"
    });
  });

  it("repairs malformed brief arguments", async () => {
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
                instruction: "Collect RAG evaluation sources"
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
                topic: "RAG evaluation methods",
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
                instruction: "Synthesize RAG evaluation sources"
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
                focus: "RAG evaluation for team discussion",
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
                instruction: "Write a medium-length English brief for team discussion"
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

    const response = await runAgentTurn({ message: "Research RAG evaluation methods" });
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
