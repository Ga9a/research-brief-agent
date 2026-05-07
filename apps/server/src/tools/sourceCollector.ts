import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import type { DeepSeekToolDefinition } from "../agent/deepseek.js";
import type { ResearchSource } from "../types.js";
import type { ToolExecutionResult } from "./shared/types.js";

export const sourceCollectorArgsSchema = z.object({
  topic: z.string().min(2).max(200),
  sourceTypes: z.array(z.enum(["web", "papers"])).min(1).default(["papers"]),
  maxResults: z.number().int().min(1).max(10).default(6),
  recency: z.enum(["recent", "balanced", "classic"]).default("balanced")
});

export type SourceCollectorArgs = z.infer<typeof sourceCollectorArgsSchema>;
type SearchProvider = "tavily" | "serpapi" | "bing";
type PaperProvider = "arxiv" | "semantic_scholar";

interface TavilyResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  snippet?: unknown;
  domain?: unknown;
}

interface SerpApiResult {
  title?: unknown;
  link?: unknown;
  snippet?: unknown;
  source?: unknown;
  displayed_link?: unknown;
}

interface BingResult {
  name?: unknown;
  url?: unknown;
  snippet?: unknown;
  displayUrl?: unknown;
}

interface SemanticScholarPaper {
  paperId?: unknown;
  title?: unknown;
  abstract?: unknown;
  year?: unknown;
  venue?: unknown;
  url?: unknown;
}

interface ArxivEntry {
  id?: unknown;
  title?: unknown;
  summary?: unknown;
  published?: unknown;
  updated?: unknown;
}

interface ArxivFeed {
  feed?: {
    entry?: ArxivEntry | ArxivEntry[];
  };
}

export const sourceCollectorToolDefinition: DeepSeekToolDefinition = {
  type: "function",
  function: {
    name: "source_collector",
    description: "Collect real research sources from web search APIs and academic paper APIs.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["topic"],
      properties: {
        topic: {
          type: "string",
          minLength: 2,
          maxLength: 200,
          description: "Research topic to collect sources for."
        },
        sourceTypes: {
          type: "array",
          description:
            "Real source types to collect. Default to papers because arXiv does not require an API key. Use web only when SEARCH_API_KEY is configured.",
          minItems: 1,
          items: {
            type: "string",
            enum: ["web", "papers"]
          },
          default: ["papers"]
        },
        maxResults: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Maximum number of deduplicated sources to return.",
          default: 6
        },
        recency: {
          type: "string",
          enum: ["recent", "balanced", "classic"],
          description: "Preferred source recency.",
          default: "balanced"
        }
      }
    }
  }
};

export async function runSourceCollector(args: unknown): Promise<ToolExecutionResult> {
  const input = validateSourceCollectorArgs(args);
  const sources = await collectSources(input);

  return {
    output: JSON.stringify({ topic: input.topic, sources }, null, 2)
  };
}

export function validateSourceCollectorArgs(args: unknown): SourceCollectorArgs {
  const parsed = sourceCollectorArgsSchema.safeParse(args);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => (issue.path.length > 0 ? issue.path.join(".") : "参数"))
      .join("、");
    throw new Error(`source_collector 参数无效：${fields}`);
  }

  return parsed.data;
}

export async function collectSources(args: SourceCollectorArgs): Promise<ResearchSource[]> {
  const collectionTasks: Array<Promise<ResearchSource[]>> = [];
  const sourceTypes = new Set(args.sourceTypes);

  if (sourceTypes.has("web")) {
    collectionTasks.push(collectWebSources(args));
  }

  if (sourceTypes.has("papers")) {
    collectionTasks.push(collectPaperSources(args));
  }

  const collected = (await Promise.all(collectionTasks)).flat();
  return dedupeSources(collected, args.maxResults);
}

export async function collectWebSources(args: SourceCollectorArgs): Promise<ResearchSource[]> {
  const apiKey = getEnvValue("SEARCH_API_KEY");
  if (!apiKey) {
    throw new Error("Missing SEARCH_API_KEY for web search");
  }

  const provider = getSearchProvider();
  if (provider === "tavily") {
    return await collectTavilySources(args, apiKey);
  }

  if (provider === "serpapi") {
    return await collectSerpApiSources(args, apiKey);
  }

  if (provider === "bing") {
    return await collectBingSources(args, apiKey);
  }

  throw new Error(`Unsupported SEARCH_PROVIDER: ${provider}`);
}

export async function collectPaperSources(args: SourceCollectorArgs): Promise<ResearchSource[]> {
  const provider = getPaperProvider();
  if (provider === "arxiv") {
    return await collectArxivSources(args);
  }

  if (provider === "semantic_scholar") {
    return await collectSemanticScholarSources(args);
  }

  throw new Error(`Unsupported PAPER_PROVIDER: ${provider}`);
}

async function collectArxivSources(args: SourceCollectorArgs): Promise<ResearchSource[]> {
  const url = new URL("https://export.arxiv.org/api/query");
  url.searchParams.set("search_query", buildArxivSearchQuery(args.topic));
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", String(args.maxResults));
  url.searchParams.set("sortBy", args.recency === "recent" ? "submittedDate" : "relevance");
  url.searchParams.set("sortOrder", "descending");

  const xml = await fetchText(url, undefined, "arXiv");
  const feed = parseArxivFeed(xml);
  const entries = Array.isArray(feed.feed?.entry) ? feed.feed.entry : feed.feed?.entry ? [feed.feed.entry] : [];

  return entries.map((entry) => mapArxivEntry(args.topic, entry)).filter((source): source is ResearchSource => Boolean(source));
}

async function collectSemanticScholarSources(args: SourceCollectorArgs): Promise<ResearchSource[]> {
  const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
  url.searchParams.set("query", buildRecencyAwareQuery(args.topic, args.recency));
  url.searchParams.set("limit", String(args.maxResults));
  url.searchParams.set("fields", "title,abstract,year,venue,url");

  const data = await fetchJson<{ data?: SemanticScholarPaper[] }>(url, {
    headers: buildSemanticScholarHeaders()
  }, "Semantic Scholar");

  if (!data || !Array.isArray(data.data)) {
    throw new Error("Invalid response format: Semantic Scholar");
  }

  return data.data
    .map((paper) => mapSemanticScholarPaper(args.topic, paper))
    .filter((source): source is ResearchSource => Boolean(source));
}

export function scoreRelevance(topic: string, title: string, summary: string): number {
  const terms = topic
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  if (terms.length === 0) {
    return 0;
  }

  const haystack = `${title} ${summary}`.toLowerCase();
  const hits = terms.filter((term) => haystack.includes(term)).length;
  return roundScore(hits / terms.length);
}

export function scoreCredibility(url: string, publisher = ""): number {
  const domain = getDomain(url);
  const combined = `${domain} ${publisher}`.toLowerCase();

  if (/(^|\.)arxiv\.org$|(^|\.)nature\.com$|(^|\.)acm\.org$|(^|\.)ieee\.org$/.test(domain)) {
    return 0.9;
  }

  if (/(^|\.)github\.com$/.test(domain) || /\bofficial\b|(^|\.)docs\.|\/docs\b|documentation/.test(combined)) {
    return 0.8;
  }

  if (/(^|\.)medium\.com$/.test(domain) || /\bblog\b/.test(combined)) {
    return 0.6;
  }

  return 0.5;
}

export function dedupeSources(sources: ResearchSource[], maxResults = sources.length): ResearchSource[] {
  const byUrl = new Map<string, ResearchSource>();

  for (const source of sources) {
    const normalizedUrl = normalizeUrl(source.url);
    const existing = byUrl.get(normalizedUrl);
    if (!existing || combinedScore(source) > combinedScore(existing)) {
      byUrl.set(normalizedUrl, source);
    }
  }

  return [...byUrl.values()].sort((left, right) => combinedScore(right) - combinedScore(left)).slice(0, maxResults);
}

async function collectTavilySources(args: SourceCollectorArgs, apiKey: string): Promise<ResearchSource[]> {
  const data = await fetchJson<{ results?: TavilyResult[] }>(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        query: buildRecencyAwareQuery(args.topic, args.recency),
        max_results: args.maxResults,
        search_depth: "advanced"
      })
    },
    "Tavily"
  );

  if (!data || !Array.isArray(data.results)) {
    throw new Error("Invalid response format: Tavily");
  }

  return data.results.map((item) => mapWebResult(args.topic, "tavily", item)).filter(isResearchSource);
}

async function collectSerpApiSources(args: SourceCollectorArgs, apiKey: string): Promise<ResearchSource[]> {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", buildRecencyAwareQuery(args.topic, args.recency));
  url.searchParams.set("num", String(args.maxResults));
  url.searchParams.set("api_key", apiKey);

  const data = await fetchJson<{ organic_results?: SerpApiResult[] }>(url, undefined, "SerpApi");
  if (!data || !Array.isArray(data.organic_results)) {
    throw new Error("Invalid response format: SerpApi");
  }

  return data.organic_results.map((item) => mapWebResult(args.topic, "serpapi", item)).filter(isResearchSource);
}

async function collectBingSources(args: SourceCollectorArgs, apiKey: string): Promise<ResearchSource[]> {
  const url = new URL("https://api.bing.microsoft.com/v7.0/search");
  url.searchParams.set("q", buildRecencyAwareQuery(args.topic, args.recency));
  url.searchParams.set("count", String(args.maxResults));

  const data = await fetchJson<{ webPages?: { value?: BingResult[] } }>(
    url,
    {
      headers: {
        "Ocp-Apim-Subscription-Key": apiKey
      }
    },
    "Bing"
  );

  if (!data?.webPages || !Array.isArray(data.webPages.value)) {
    throw new Error("Invalid response format: Bing");
  }

  return data.webPages.value.map((item) => mapWebResult(args.topic, "bing", item)).filter(isResearchSource);
}

async function fetchJson<T>(url: string | URL, init?: RequestInit, providerName = "External API"): Promise<T> {
  const response = await fetchWithTimeout(url, init, providerName);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw buildExternalApiError(response.status, body, providerName);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new Error("Invalid response format");
  }
}

async function fetchText(url: string | URL, init?: RequestInit, providerName = "External API"): Promise<string> {
  const response = await fetchWithTimeout(url, init, providerName);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw buildExternalApiError(response.status, body, providerName);
  }

  return await response.text();
}

async function fetchWithTimeout(url: string | URL, init: RequestInit | undefined, providerName: string): Promise<Response> {
  const timeoutMs = getSourceApiTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`External API request failed: ${providerName} timed out after ${timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildExternalApiError(status: number, body: string, providerName: string): Error {
  if (status === 429) {
    const suggestion =
      providerName === "Semantic Scholar"
        ? "Set SEMANTIC_SCHOLAR_API_KEY or retry later."
        : "Check the API quota or retry later.";
    return new Error(
      `External API request failed: 429 ${providerName} rate limit exceeded. ${suggestion}${body ? ` ${truncate(body, 180)}` : ""}`
    );
  }

  return new Error(`External API request failed: ${status} ${providerName}${body ? ` ${truncate(body, 180)}` : ""}`);
}

function mapWebResult(topic: string, provider: SearchProvider, item: TavilyResult | SerpApiResult | BingResult): ResearchSource | undefined {
  const title = getString((item as TavilyResult | SerpApiResult).title) || getString((item as BingResult).name);
  const url = getString((item as TavilyResult).url) || getString((item as SerpApiResult).link);
  const summary =
    getString((item as TavilyResult).content) ||
    getString((item as TavilyResult).snippet) ||
    getString((item as SerpApiResult).snippet);
  const publisher =
    getString((item as TavilyResult).domain) ||
    getString((item as SerpApiResult).source) ||
    getString((item as SerpApiResult).displayed_link) ||
    getString((item as BingResult).displayUrl) ||
    (url ? getDomain(url) : provider);

  if (!title || !url || !summary) {
    return undefined;
  }

  const credibilityScore = scoreCredibility(url, publisher);
  return {
    id: createSourceId("web", url),
    title,
    url,
    sourceType: "web",
    publisher,
    publishedAt: null,
    summary: truncate(summary, 300),
    relevanceScore: scoreRelevance(topic, title, summary),
    credibilityScore
  };
}

function mapSemanticScholarPaper(topic: string, paper: SemanticScholarPaper): ResearchSource | undefined {
  const title = getString(paper.title);
  const paperId = getString(paper.paperId);
  const url = getString(paper.url) || (paperId ? `https://www.semanticscholar.org/paper/${paperId}` : undefined);
  const abstract = getString(paper.abstract) || "未提供摘要。";
  const venue = getString(paper.venue) || "Semantic Scholar";
  const year = typeof paper.year === "number" ? String(paper.year) : getString(paper.year) || null;

  if (!title || !url) {
    return undefined;
  }

  const credibilityScore = scoreCredibility(url, venue);
  return {
    id: createSourceId("papers", url),
    title,
    url,
    sourceType: "papers",
    publisher: venue,
    publishedAt: year,
    summary: truncate(abstract, 300),
    relevanceScore: scoreRelevance(topic, title, abstract),
    credibilityScore
  };
}

function mapArxivEntry(topic: string, entry: ArxivEntry): ResearchSource | undefined {
  const title = normalizeWhitespace(getString(entry.title) || "");
  const url = getString(entry.id);
  const summary = normalizeWhitespace(getString(entry.summary) || "未提供摘要。");
  const publishedAt = getString(entry.published) || getString(entry.updated) || null;

  if (!title || !url) {
    return undefined;
  }

  const credibilityScore = scoreCredibility(url, "arXiv");
  return {
    id: createSourceId("papers", url),
    title,
    url,
    sourceType: "papers",
    publisher: "arXiv",
    publishedAt,
    summary: truncate(summary, 300),
    relevanceScore: scoreRelevance(topic, title, summary),
    credibilityScore
  };
}

function getSearchProvider(): SearchProvider {
  const provider = (getEnvValue("SEARCH_PROVIDER") || "tavily").toLowerCase();
  if (provider === "tavily" || provider === "serpapi" || provider === "bing") {
    return provider;
  }

  throw new Error(`Unsupported SEARCH_PROVIDER: ${provider}`);
}

function getPaperProvider(): PaperProvider {
  const provider = (getEnvValue("PAPER_PROVIDER") || "arxiv").toLowerCase();
  if (provider === "arxiv" || provider === "semantic_scholar") {
    return provider;
  }

  throw new Error(`Unsupported PAPER_PROVIDER: ${provider}`);
}

function parseArxivFeed(xml: string): ArxivFeed {
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      trimValues: true
    });
    const parsed = parser.parse(xml) as ArxivFeed;
    if (!parsed.feed) {
      throw new Error("missing feed");
    }
    return parsed;
  } catch {
    throw new Error("Invalid response format: arXiv");
  }
}

function buildSemanticScholarHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/json"
  };
  const apiKey = getEnvValue("SEMANTIC_SCHOLAR_API_KEY");
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  return headers;
}

function getEnvValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function getSourceApiTimeoutMs(): number {
  const timeoutMs = Number(process.env.SOURCE_API_TIMEOUT_MS || "20000");
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20000;
}

function buildRecencyAwareQuery(topic: string, recency: SourceCollectorArgs["recency"]): string {
  if (recency === "recent") {
    return `${topic} recent latest`;
  }

  if (recency === "classic") {
    return `${topic} foundational classic`;
  }

  return topic;
}

function buildArxivSearchQuery(topic: string): string {
  return `all:${topic}`;
}

function combinedScore(source: ResearchSource): number {
  return source.relevanceScore * 0.6 + source.credibilityScore * 0.4;
}

function createSourceId(sourceType: ResearchSource["sourceType"], url: string): string {
  return `${sourceType}:${createHash("sha256").update(normalizeUrl(url)).digest("hex").slice(0, 16)}`;
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.trim().toLowerCase();
  }
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isResearchSource(value: ResearchSource | undefined): value is ResearchSource {
  return Boolean(value);
}

function roundScore(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}
