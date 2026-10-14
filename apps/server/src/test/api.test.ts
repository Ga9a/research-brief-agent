import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { runAgentTurn } from "../agent/loop.js";
vi.mock("../agent/loop.js", () => ({
  listChatSessions: vi.fn(() => []), getChatSessionResponse: vi.fn(() => undefined),
  deleteChatSession: vi.fn(() => false), runAgentTurn: vi.fn()
}));
let server: Server;
let url: string;
beforeAll(async () => {
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  url = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
beforeEach(() => vi.mocked(runAgentTurn).mockReset());
async function post(path: string, body: unknown) {
  return fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
describe("HTTP API", () => {
  it("returns health and a missing-session response", async () => {
    expect(await (await fetch(url + "/api/health")).json()).toEqual({ ok: true });
    expect((await fetch(url + "/api/sessions/missing")).status).toBe(404);
  });
  it.each(["/api/chat", "/api/chat/stream"])("validates before starting %s", async (path) => {
    const response = await post(path, { message: "   " });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(runAgentTurn).not.toHaveBeenCalled();
  });
  it("rejects malformed JSON consistently", async () => {
    const response = await fetch(url + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON request body" });
  });
  it("uses a server error for execution failures", async () => {
    vi.mocked(runAgentTurn).mockRejectedValueOnce(new Error("Provider unavailable"));
    expect((await post("/api/chat", { message: "Research memory" })).status).toBe(500);
  });
  it("ends a failed stream with a readable error event", async () => {
    vi.mocked(runAgentTurn).mockRejectedValueOnce(new Error("Provider unavailable"));
    const response = await post("/api/chat/stream", { message: "Research memory" });
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(JSON.parse((await response.text()).trim())).toEqual({ type: "error", error: "Provider unavailable" });
  });
});
