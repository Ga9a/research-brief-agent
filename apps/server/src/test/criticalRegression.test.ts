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
  topic: "RAG evaluation methods",
  sources: [sampleSource]
};

const synthesisOutput = {
  synthesis: {
    focus: "Research RAG evaluation methods",
    outputFormat: "decision_brief",
    keyFindings: ["RAG evaluation covers retrieval quality and answer faithfulness."],
    comparisons: [{ dimension: "Evaluation levels", notes: "Separate retrieval, generation, and end-to-end quality." }],
    risksOrLimitations: ["Automated metrics need human review."],
    recommendation: "Build a small evaluation workflow first."
  }
};

describe("criticalRegression", () => {
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

      throw new Error(`Unknown tool: ${name}`);
    });
  });

  it("keeps focus optional in the schema", () => {
    expect(evidenceSynthesizerDefinition.function.parameters).toMatchObject({
      required: []
    });
  });

  it("allows registry synthesis without focus", async () => {
    const result = await executeRegisteredTool("evidence_synthesizer", {
      sources: [sampleSource]
    });
    const parsed = JSON.parse(result.output);

    expect(parsed.synthesis.focus).toBe("Synthesis of collected sources");
    expect(parsed.synthesis.keyFindings.length).toBeGreaterThan(0);
  });

  it("defaults an empty focus", async () => {
    await expect(
      executeRegisteredTool("evidence_synthesizer", {
        sources: [sampleSource],
        focus: "",
        outputFormat: "decision_brief"
      })
    ).resolves.toMatchObject({
      output: expect.stringContaining("Synthesis of collected sources")
    });
  });

  it("injects focus through the child workflow", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(parentTask("task_collect", "collect_sources", "Collect RAG evaluation sources"))
      .mockResolvedValueOnce(childTool("source_collect", "source_collector", { topic: "RAG evaluation methods", sourceTypes: ["papers"] }))
      .mockResolvedValueOnce(parentTask("task_synthesize", "synthesize_evidence", "Synthesize RAG evaluation sources"))
      .mockResolvedValueOnce(childTool("synthesize", "evidence_synthesizer", {}))
      .mockResolvedValueOnce({
        role: "assistant",
        content: "Completed RAG evaluation evidence synthesis.",
        tool_calls: []
      });

    const response = await runAgentTurn({ message: "Research RAG evaluation methods" });
    const synthesizeEvent = response.researchEvents.find((event) => event.toolName === "synthesize_evidence");
    const synthesizeCall = mocks.executeRegisteredTool.mock.calls.find(([name]) => name === "evidence_synthesizer");

    expect(synthesizeEvent?.status).toBe("completed");
    expect(synthesizeEvent?.error).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain("evidence_synthesizer Invalid arguments: focus");
    expect(synthesizeCall?.[1]).toMatchObject({
      sources: [sampleSource],
      focus: "Research RAG evaluation methods",
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
