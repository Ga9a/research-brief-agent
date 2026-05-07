import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentTurn } from "../agent/loop.js";
import { evidenceSynthesizerDefinition } from "../tools/capabilities/evidenceSynthesizer.js";
import { executeRegisteredTool } from "../tools/index.js";
import type { ResearchSource } from "../types.js";

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
  executeRegisteredTool: vi.fn()
}));

vi.mock("../agent/deepseek.js", () => ({
  createChatCompletion: mocks.createChatCompletion
}));

vi.mock("../tools/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/index.js")>();
  return {
    ...actual,
    executeRegisteredTool: mocks.executeRegisteredTool
  };
});

const sampleSource: ResearchSource = {
  id: "papers:critical-focus",
  title: "RAG Evaluation Methods",
  url: "https://arxiv.org/abs/2401.00001",
  sourceType: "papers",
  publisher: "arXiv",
  publishedAt: "2024",
  summary: "RAG evaluation compares retrieval quality, answer faithfulness, and answer relevancy.",
  relevanceScore: 1,
  credibilityScore: 0.9
};

const sourceOutput = {
  topic: "RAG 评估方法",
  sources: [sampleSource]
};

const synthesisOutput = {
  synthesis: {
    focus: "帮我研究 RAG 评估方法",
    outputFormat: "decision_brief",
    keyFindings: ["RAG 评估需要覆盖检索质量和答案忠实度。"],
    comparisons: [{ dimension: "评估层次", notes: "拆分检索、生成和端到端质量。" }],
    risksOrLimitations: ["需要人工复核自动化指标。"],
    recommendation: "先建立小样本评估框架。"
  }
};

describe("CRITICAL REGRESSION: evidence_synthesizer focus 不能再成为必填参数", () => {
  beforeEach(() => {
    mocks.createChatCompletion.mockReset();
    mocks.executeRegisteredTool.mockReset();
    mocks.executeRegisteredTool.mockImplementation(async (name: string, args: unknown) => {
      if (name === "source_collector") {
        return { output: JSON.stringify(sourceOutput) };
      }

      if (name === "evidence_synthesizer") {
        const actual = await vi.importActual<typeof import("../tools/index.js")>("../tools/index.js");
        return await actual.executeRegisteredTool(name, args);
      }

      throw new Error(`未知工具：${name}`);
    });
  });

  it("tool schema 不允许把 focus 放进 required", () => {
    expect(evidenceSynthesizerDefinition.function.parameters).toMatchObject({
      required: []
    });
  });

  it("直接通过注册表调用 evidence_synthesizer，缺少 focus 时必须成功", async () => {
    const result = await executeRegisteredTool("evidence_synthesizer", {
      sources: [sampleSource]
    });
    const parsed = JSON.parse(result.output);

    expect(parsed.synthesis.focus).toBe("基于已收集资料的综合分析");
    expect(parsed.synthesis.keyFindings.length).toBeGreaterThan(0);
  });

  it("focus 为空字符串时必须自动兜底，不能报“参数无效：focus”", async () => {
    await expect(
      executeRegisteredTool("evidence_synthesizer", {
        sources: [sampleSource],
        focus: "",
        outputFormat: "decision_brief"
      })
    ).resolves.toMatchObject({
      output: expect.stringContaining("基于已收集资料的综合分析")
    });
  });

  it("完整 agent 子任务路径中，子模型传空参数也必须由后端注入 focus", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(parentTask("task_collect", "collect_sources", "收集 RAG 评估方法资料"))
      .mockResolvedValueOnce(childTool("source_collect", "source_collector", { topic: "RAG 评估方法", sourceTypes: ["papers"] }))
      .mockResolvedValueOnce(parentTask("task_synthesize", "synthesize_evidence", "整理 RAG 评估方法资料"))
      .mockResolvedValueOnce(childTool("synthesize", "evidence_synthesizer", {}))
      .mockResolvedValueOnce({
        role: "assistant",
        content: "已完成 RAG 评估方法的证据整理。",
        tool_calls: []
      });

    const response = await runAgentTurn({ message: "帮我研究 RAG 评估方法" });
    const synthesizeEvent = response.researchEvents.find((event) => event.toolName === "synthesize_evidence");
    const synthesizeCall = mocks.executeRegisteredTool.mock.calls.find(([name]) => name === "evidence_synthesizer");

    expect(synthesizeEvent?.status).toBe("completed");
    expect(synthesizeEvent?.error).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain("evidence_synthesizer 参数无效：focus");
    expect(synthesizeCall?.[1]).toMatchObject({
      sources: [sampleSource],
      focus: "帮我研究 RAG 评估方法",
      outputFormat: "decision_brief"
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
