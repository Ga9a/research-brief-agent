import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextBudgetManager, estimateContextTokens } from "../agent/contextBudget.js";
import type { DeepSeekMessage } from "../agent/deepseek.js";

const outputDir = path.resolve(process.cwd(), ".agent-data-test", "context-budget");

describe("Context budgeting", () => {
  beforeEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
    mkdirSync(outputDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  it("persists oversized tool results", () => {
    const manager = new ContextBudgetManager("session-a", {
      outputDir,
      inlineCharLimit: 20,
      previewChars: 12
    });
    const contextContent = manager.prepareToolResultForContext("source_collector", "x".repeat(80));
    const parsed = JSON.parse(contextContent);

    expect(parsed.kind).toBe("persisted-output");
    expect(parsed.preview.length).toBeLessThanOrEqual(12);
    expect(existsSync(parsed.path)).toBe(true);
    expect(manager.getState().recentFiles).toContain(parsed.relativePath);
  });

  it("retains recent results and recoverable placeholders", () => {
    const manager = new ContextBudgetManager("session-b", {
      outputDir,
      inlineCharLimit: 1000,
      recentToolResults: 2
    });
    const messages: DeepSeekMessage[] = [
      { role: "system", content: "system" },
      { role: "tool", tool_call_id: "1", content: "old result 1" },
      { role: "tool", tool_call_id: "2", content: "old result 2" },
      { role: "tool", tool_call_id: "3", content: "recent result 1" },
      { role: "tool", tool_call_id: "4", content: "recent result 2" }
    ];

    const compacted = manager.compactBeforeModelCall(messages, {
      currentGoal: "Test micro compaction",
      uiMessages: [],
      researchEvents: []
    });
    const firstTool = JSON.parse(compacted[1].content || "{}");
    const secondTool = JSON.parse(compacted[2].content || "{}");

    expect(firstTool.kind).toBe("compacted-tool-result");
    expect(secondTool.kind).toBe("compacted-tool-result");
    expect(existsSync(firstTool.persistedOutput.path)).toBe(true);
    expect(compacted[3].content).toBe("recent result 1");
    expect(compacted[4].content).toBe("recent result 2");
  });

  it("compacts context while preserving recent messages", () => {
    const manager = new ContextBudgetManager("session-c", {
      outputDir,
      contextWindowTokens: 80,
      summaryTriggerRatio: 0.5,
      keepRecentMessages: 4
    });
    const messages: DeepSeekMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "Previous question " + "a".repeat(400) },
      { role: "assistant", content: "Previous answer " + "b".repeat(400) },
      { role: "user", content: "Current question" },
      { role: "system", content: "Current plan" }
    ];

    const compacted = manager.compactBeforeModelCall(messages, {
      currentGoal: "Current question",
      uiMessages: [],
      researchEvents: [
        {
          id: "event-1",
          toolName: "collect_sources",
          stepLabel: "Collect sources",
          args: {},
          status: "completed",
          output: JSON.stringify({ summary: "Collected three candidate sources." }),
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:00:01.000Z"
        }
      ]
    });
    const summaryMessage = compacted.find((message) => message.role === "system" && message.content?.includes("Context continuity summary"));

    expect(summaryMessage?.content).toContain("## Current goal");
    expect(summaryMessage?.content).toContain("## Completed steps");
    expect(summaryMessage?.content).toContain("## Referenced files");
    expect(summaryMessage?.content).toContain("## Key decisions and constraints");
    expect(summaryMessage?.content).toContain("## Next actions");
    expect(compacted.some((message) => message.role === "user" && message.content === "Current question")).toBe(true);
    expect(manager.getState().hasCompacted).toBe(true);
    expect(estimateContextTokens(compacted)).toBeLessThan(estimateContextTokens(messages));
  });
});
