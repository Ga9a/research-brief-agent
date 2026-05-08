import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn()
}));

vi.mock("../agent/deepseek.js", () => ({
  createChatCompletion: mocks.createChatCompletion
}));

const { deleteChatSession, getChatSessionResponse, listChatSessions, runAgentTurn } = await import("../agent/loop.js");

describe("chat session persistence", () => {
  beforeEach(() => {
    mocks.createChatCompletion.mockReset();
  });

  it("lists, restores, and deletes completed sessions", async () => {
    const sessionId = `test-session-${Date.now()}`;
    mocks.createChatCompletion.mockResolvedValueOnce({
      role: "assistant",
      content: "Session persistence works.",
      tool_calls: []
    });

    const response = await runAgentTurn({ sessionId, message: "Research session persistence design" });
    const summary = listChatSessions().find((session) => session.sessionId === sessionId);
    const restored = getChatSessionResponse(sessionId);

    expect(response.sessionTitle).toBe("Research session persiste...");
    expect(summary).toMatchObject({
      sessionId,
      title: "Research session persiste...",
      messageCount: 2
    });
    expect(restored?.messages.at(-1)?.content).toBe("Session persistence works.");
    expect(deleteChatSession(sessionId)).toBe(true);
    expect(getChatSessionResponse(sessionId)).toBeUndefined();
  });
});
