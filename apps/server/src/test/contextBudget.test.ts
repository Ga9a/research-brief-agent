import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextBudgetManager, estimateContextTokens } from "../agent/contextBudget.js";
import type { DeepSeekMessage } from "../agent/deepseek.js";

const outputDir = path.resolve(process.cwd(), ".agent-data-test", "context-budget");

describe("上下文预算管理", () => {
  beforeEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
    mkdirSync(outputDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  it("工具输出超过阈值时写入磁盘，并在上下文中保留 persisted-output preview", () => {
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

  it("micro compact 只保留最近 N 个工具结果，旧结果改为可恢复占位", () => {
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
      currentGoal: "测试 micro compact",
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

  it("接近上下文上限时触发结构化 summary compact，并保留当前轮尾部消息", () => {
    const manager = new ContextBudgetManager("session-c", {
      outputDir,
      contextWindowTokens: 80,
      summaryTriggerRatio: 0.5,
      keepRecentMessages: 4
    });
    const messages: DeepSeekMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "旧问题 " + "a".repeat(400) },
      { role: "assistant", content: "旧回答 " + "b".repeat(400) },
      { role: "user", content: "当前问题" },
      { role: "system", content: "当前计划" }
    ];

    const compacted = manager.compactBeforeModelCall(messages, {
      currentGoal: "当前问题",
      uiMessages: [],
      researchEvents: [
        {
          id: "event-1",
          toolName: "collect_sources",
          stepLabel: "收集资料",
          args: {},
          status: "completed",
          output: JSON.stringify({ summary: "收集到 3 条候选资料。" }),
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:00:01.000Z"
        }
      ]
    });
    const summaryMessage = compacted.find((message) => message.role === "system" && message.content?.includes("上下文连续性摘要"));

    expect(summaryMessage?.content).toContain("## 当前目标");
    expect(summaryMessage?.content).toContain("## 已完成步骤");
    expect(summaryMessage?.content).toContain("## 涉及文件");
    expect(summaryMessage?.content).toContain("## 关键决策与约束");
    expect(summaryMessage?.content).toContain("## 下一步行动");
    expect(compacted.some((message) => message.role === "user" && message.content === "当前问题")).toBe(true);
    expect(manager.getState().hasCompacted).toBe(true);
    expect(estimateContextTokens(compacted)).toBeLessThan(estimateContextTokens(messages));
  });
});
