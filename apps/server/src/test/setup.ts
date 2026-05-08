import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "research-brief-agent-vitest-"));

process.env.SESSION_STORE_PATH = path.join(dataDir, "sessions.json");
process.env.CONTEXT_OUTPUT_DIR = path.join(dataDir, "tool-outputs");

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});
