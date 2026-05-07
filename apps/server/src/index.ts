import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runAgentTurn } from "./agent/loop.js";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

dotenv.config({
  path: [
    resolve(serverRoot, ".env.local"),
    resolve(serverRoot, ".env"),
    resolve(process.cwd(), ".env.local"),
    resolve(process.cwd(), ".env")
  ]
});

const app = express();
const port = Number(process.env.PORT || "3001");

const chatRequestSchema = z.object({
  message: z.string().min(1),
  sessionId: z.string().optional()
});

app.use(cors({ origin: process.env.WEB_ORIGIN || "http://localhost:5173" }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/chat", async (req, res) => {
  try {
    const body = chatRequestSchema.parse(req.body);
    const response = await runAgentTurn(body);
    res.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知服务器错误";
    res.status(400).json({ error: message });
  }
});

app.post("/api/chat/stream", async (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const send = (event: unknown) => {
    res.write(`${JSON.stringify(event)}\n`);
  };

  try {
    const body = chatRequestSchema.parse(req.body);
    await runAgentTurn(body, {
      onEvent: send
    });
  } catch (error) {
    send({
      type: "error",
      error: error instanceof Error ? error.message : "未知服务器错误"
    });
  } finally {
    res.end();
  }
});

app.listen(port, () => {
  console.log(`服务已启动：http://localhost:${port}`);
});
