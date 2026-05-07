import type { AgentStreamEvent, ChatResponse, ResearchToolEvent } from "../types.js";

export type AgentHookName = "session_started" | "research_event_created" | "final_response_created";

export interface AgentHookPayloads {
  session_started: {
    sessionId: string;
  };
  research_event_created: {
    researchEvent: ResearchToolEvent;
  };
  final_response_created: {
    response: ChatResponse;
  };
}

export interface AgentHookContext<Name extends AgentHookName = AgentHookName> {
  name: Name;
  payload: AgentHookPayloads[Name];
  emittedAt: string;
}

export interface AgentHookDecision {
  continue: boolean;
  reason?: string;
}

export type AgentHookHandler<Name extends AgentHookName = AgentHookName> = (
  context: AgentHookContext<Name>
) => AgentHookDecision | void | Promise<AgentHookDecision | void>;

export interface AgentRunHooks {
  onEvent?: (event: AgentStreamEvent) => void | Promise<void>;
  onSessionStarted?: AgentHookHandler<"session_started">;
  onResearchEventCreated?: AgentHookHandler<"research_event_created">;
  onFinalResponseCreated?: AgentHookHandler<"final_response_created">;
}

export interface AgentHookRunner {
  sessionStarted(payload: AgentHookPayloads["session_started"]): Promise<AgentHookDecision>;
  researchEventCreated(payload: AgentHookPayloads["research_event_created"]): Promise<AgentHookDecision>;
  finalResponseCreated(payload: AgentHookPayloads["final_response_created"]): Promise<AgentHookDecision>;
}

const CONTINUE: AgentHookDecision = { continue: true };

export function createAgentHookRunner(hooks: AgentRunHooks = {}): AgentHookRunner {
  return {
    sessionStarted: (payload) =>
      runHook(hooks.onSessionStarted, {
        name: "session_started",
        payload,
        streamEvent: { type: "session", sessionId: payload.sessionId },
        hooks
      }),
    researchEventCreated: (payload) =>
      runHook(hooks.onResearchEventCreated, {
        name: "research_event_created",
        payload,
        streamEvent: { type: "research_event", researchEvent: payload.researchEvent },
        hooks
      }),
    finalResponseCreated: (payload) =>
      runHook(hooks.onFinalResponseCreated, {
        name: "final_response_created",
        payload,
        streamEvent: { type: "final", response: payload.response },
        hooks
      })
  };
}

export function ensureHookCanContinue(decision: AgentHookDecision): void {
  if (!decision.continue) {
    throw new Error(decision.reason || "Agent hook stopped the current run.");
  }
}

async function runHook<Name extends AgentHookName>(
  handler: AgentHookHandler<Name> | undefined,
  input: {
    name: Name;
    payload: AgentHookPayloads[Name];
    streamEvent: AgentStreamEvent;
    hooks: AgentRunHooks;
  }
): Promise<AgentHookDecision> {
  const context: AgentHookContext<Name> = {
    name: input.name,
    payload: input.payload,
    emittedAt: new Date().toISOString()
  };
  const decision = normalizeDecision(await handler?.(context));
  if (!decision.continue) {
    return decision;
  }

  await input.hooks.onEvent?.(input.streamEvent);
  return CONTINUE;
}

function normalizeDecision(decision: AgentHookDecision | void): AgentHookDecision {
  return decision ?? CONTINUE;
}
