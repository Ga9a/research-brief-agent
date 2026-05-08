import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ResearchArtifact } from "./artifactStore.js";
import type { DeepSeekMessage } from "./deepseek.js";
import type { CompactState, ResearchToolEvent, UiMessage } from "../types.js";

export interface PersistedResearchMemory {
  completedTopics: Array<{
    goal: string;
    researchQuestion: string;
    completedAt: string;
    summary: string;
  }>;
}

export interface PersistedSessionRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  modelMessages: DeepSeekMessage[];
  uiMessages: UiMessage[];
  researchEvents: ResearchToolEvent[];
  compactState?: CompactState;
  researchMemory: PersistedResearchMemory;
  artifacts: ResearchArtifact[];
}

export interface PersistedSessionSummary {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string;
}

interface SessionDatabase {
  version: 1;
  sessions: PersistedSessionRecord[];
}

export function listPersistedSessions(): PersistedSessionSummary[] {
  return readDatabase().sessions.map(toSummary).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function loadPersistedSession(sessionId: string): PersistedSessionRecord | undefined {
  return readDatabase().sessions.find((session) => session.id === sessionId);
}

export function savePersistedSession(session: PersistedSessionRecord): void {
  const database = readDatabase();
  database.sessions = [session, ...database.sessions.filter((item) => item.id !== session.id)];
  writeDatabase(database);
}

export function deletePersistedSession(sessionId: string): boolean {
  const database = readDatabase();
  const nextSessions = database.sessions.filter((session) => session.id !== sessionId);
  if (nextSessions.length === database.sessions.length) {
    return false;
  }

  database.sessions = nextSessions;
  writeDatabase(database);
  return true;
}

function toSummary(session: PersistedSessionRecord): PersistedSessionSummary {
  const lastMessage = [...session.uiMessages].reverse().find((message) => message.content.trim());
  return {
    sessionId: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.uiMessages.length,
    lastMessagePreview: lastMessage ? truncate(lastMessage.content.replace(/\s+/g, " ").trim(), 90) : ""
  };
}

function readDatabase(): SessionDatabase {
  const filePath = getSessionStorePath();
  if (!existsSync(filePath)) {
    return { version: 1, sessions: [] };
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<SessionDatabase>;
    return {
      version: 1,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions.filter(isPersistedSessionRecord) : []
    };
  } catch {
    return { version: 1, sessions: [] };
  }
}

function writeDatabase(database: SessionDatabase): void {
  const filePath = getSessionStorePath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(database, null, 2)}\n`, "utf8");
}

function getSessionStorePath(): string {
  return process.env.SESSION_STORE_PATH?.trim() || path.resolve(process.cwd(), ".agent-data", "sessions.json");
}

function isPersistedSessionRecord(value: unknown): value is PersistedSessionRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<PersistedSessionRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    Array.isArray(record.modelMessages) &&
    Array.isArray(record.uiMessages) &&
    Array.isArray(record.researchEvents)
  );
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
