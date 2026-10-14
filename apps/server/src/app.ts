import cors from "cors";
import express from "express";
import type { ErrorRequestHandler } from "express";
import { z } from "zod";
import { deleteChatSession, getChatSessionResponse, listChatSessions, runAgentTurn } from "./agent/loop.js";

const chatRequestSchema = z.object({
  message: z.string().trim().min(1).max(20000),
  sessionId: z.string().min(1).max(200).optional()
});

export function createApp() {
  const app = express();
  app.use(cors({ origin: process.env.WEB_ORIGIN || "http://localhost:5173" }));
  app.use(express.json({ limit: "1mb" }));
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/sessions", (_req, res) => res.json({ sessions: listChatSessions() }));
  app.get("/api/sessions/:sessionId", (req, res) => {
    const response = getChatSessionResponse(req.params.sessionId);
    if (!response) return res.status(404).json({ error: "Session not found" });
    return res.json(response);
  });
  app.delete("/api/sessions/:sessionId", (req, res) => {
    res.json({ ok: true, deleted: deleteChatSession(req.params.sessionId) });
  });
  app.post("/api/chat", async (req, res) => {
    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Provide a non-empty message of at most 20,000 characters and an optional sessionId." });
    try {
      return res.json(await runAgentTurn(parsed.data));
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : "Unknown server error" });
    }
  });
  app.post("/api/chat/stream", async (req, res) => {
    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Provide a non-empty message of at most 20,000 characters and an optional sessionId." });
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    try {
      await runAgentTurn(parsed.data, {
        onEvent: (event) => { if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`); }
      });
    } catch (error) {
      if (!res.destroyed) res.write(`${JSON.stringify({ type: "error", error: error instanceof Error ? error.message : "Unknown server error" })}\n`);
    } finally {
      res.end();
    }
  });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error.type === "entity.too.large" ? 413 : error.type === "entity.parse.failed" ? 400 : 500;
    res.status(status).json({ error: status === 413 ? "Request body is too large" : status === 400 ? "Invalid JSON request body" : "Unknown server error" });
  };
  app.use(errors);
  return app;
}
