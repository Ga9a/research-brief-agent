import { describe, expect, it, vi } from "vitest";
import { createAgentHookRunner, ensureHookCanContinue } from "../agent/hooks.js";
import type { ChatResponse, ResearchToolEvent } from "../types.js";

describe("Agent hook runner", () => {
  it("maps lifecycle hook contexts to stream events for existing clients", async () => {
    const onEvent = vi.fn();
    const onResearchEventCreated = vi.fn();
    const runner = createAgentHookRunner({
      onEvent,
      onResearchEventCreated
    });
    const researchEvent = createResearchEvent();
    const response: ChatResponse = {
      sessionId: "session-1",
      messages: [],
      researchEvents: [researchEvent]
    };

    await runner.sessionStarted({ sessionId: "session-1" });
    await runner.researchEventCreated({ researchEvent });
    await runner.finalResponseCreated({ response });

    expect(onResearchEventCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "research_event_created",
        payload: { researchEvent },
        emittedAt: expect.any(String)
      })
    );
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual(["session", "research_event", "final"]);
  });

  it("returns hook stop decisions before invoking the stream compatibility hook", async () => {
    const onEvent = vi.fn();
    const runner = createAgentHookRunner({
      onEvent,
      onSessionStarted: () => ({ continue: false, reason: "blocked by hook" })
    });

    const decision = await runner.sessionStarted({ sessionId: "session-1" });

    expect(decision).toEqual({ continue: false, reason: "blocked by hook" });
    expect(onEvent).not.toHaveBeenCalled();
    expect(() => ensureHookCanContinue(decision)).toThrow("blocked by hook");
  });
});

function createResearchEvent(): ResearchToolEvent {
  return {
    id: "event-1",
    toolName: "collect_sources",
    stepLabel: "收集资料",
    args: { taskType: "collect_sources" },
    status: "completed",
    output: "{}",
    startedAt: "2026-05-07T00:00:00.000Z",
    finishedAt: "2026-05-07T00:00:01.000Z"
  };
}
