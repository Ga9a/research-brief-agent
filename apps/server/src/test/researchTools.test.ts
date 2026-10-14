import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runBriefWriter } from "../tools/capabilities/briefWriter.js";
import { runEvidenceSynthesizer } from "../tools/capabilities/evidenceSynthesizer.js";
import {
  collectPaperSources,
  collectWebSources,
  dedupeSources,
  runSourceCollector,
  scoreCredibility,
  scoreRelevance,
  validateSourceCollectorArgs
} from "../tools/sourceCollector.js";
import { executeRegisteredTool, toolDefinitions, toolRegistry } from "../tools/index.js";
import type { ResearchSource } from "../types.js";

const originalSearchProvider = process.env.SEARCH_PROVIDER;
const originalSearchApiKey = process.env.SEARCH_API_KEY;
const originalPaperProvider = process.env.PAPER_PROVIDER;
const originalSemanticScholarApiKey = process.env.SEMANTIC_SCHOLAR_API_KEY;
const originalSourceApiTimeoutMs = process.env.SOURCE_API_TIMEOUT_MS;

const sampleSource: ResearchSource = {
  id: "papers:sample",
  title: "RAG Evaluation Methods",
  url: "https://arxiv.org/abs/2401.00001",
  sourceType: "papers",
  publisher: "arXiv",
  publishedAt: "2024",
  summary: "RAG evaluation methods compare retrieval quality, answer faithfulness, and end-to-end usefulness.",
  relevanceScore: 1,
  credibilityScore: 0.9
};

describe("researchTools", () => {
  beforeEach(() => {
    process.env.SEARCH_PROVIDER = "tavily";
    process.env.SEARCH_API_KEY = "test-key";
    delete process.env.PAPER_PROVIDER;
    delete process.env.SEMANTIC_SCHOLAR_API_KEY;
  });

  afterEach(() => {
    restoreSearchEnv();
    vi.unstubAllGlobals();
  });

  it("validates arguments and defaults", () => {
    expect(validateSourceCollectorArgs({ topic: "RAG evaluation methods" })).toMatchObject({
      topic: "RAG evaluation methods",
      sourceTypes: ["papers"],
      maxResults: 6,
      recency: "balanced"
    });

    expect(() => validateSourceCollectorArgs({ topic: "R" })).toThrow(/source_collector Invalid arguments/);
    expect(() =>
      validateSourceCollectorArgs({
        topic: "RAG evaluation methods",
        sourceTypes: ["invalid"]
      })
    ).toThrow(/source_collector Invalid arguments/);
  });

  it("rejects web requests without a key", async () => {
    delete process.env.SEARCH_API_KEY;
    process.env.SEARCH_PROVIDER = "unsupported";

    await expect(
      collectWebSources({
        topic: "RAG evaluation methods",
        sourceTypes: ["web"],
        maxResults: 3,
        recency: "balanced"
      })
    ).rejects.toThrow("Missing SEARCH_API_KEY for web search");
  });

  it("rejects unsupported search providers", async () => {
    process.env.SEARCH_PROVIDER = "unsupported";
    process.env.SEARCH_API_KEY = "test-key";

    await expect(
      collectWebSources({
        topic: "RAG evaluation methods",
        sourceTypes: ["web"],
        maxResults: 3,
        recency: "balanced"
      })
    ).rejects.toThrow(/Unsupported SEARCH_PROVIDER/);
  });

  it("parses Tavily results", async () => {
    process.env.SEARCH_API_KEY = " test-key ";
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        results: [
          {
            title: "RAG Evaluation Guide",
            url: "https://docs.example.com/rag-evaluation",
            content: "RAG evaluation covers retrieval metrics and answer faithfulness.",
            domain: "docs.example.com"
          }
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const sources = await collectWebSources({
      topic: "RAG evaluation",
      sourceTypes: ["web"],
      maxResults: 3,
      recency: "balanced"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-key" })
      })
    );
    expect(sources[0]).toMatchObject({
      title: "RAG Evaluation Guide",
      sourceType: "web",
      publisher: "docs.example.com",
      credibilityScore: 0.8
    });
  });

  it("defaults paper searches to arXiv", async () => {
    const fetchMock = vi.fn(async () => textResponse(arxivXml()));
    vi.stubGlobal("fetch", fetchMock);

    const sources = await collectPaperSources({
      topic: "RAG evaluation",
      sourceTypes: ["papers"],
      maxResults: 2,
      recency: "balanced"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": "research-brief-agent/0.1 arxiv-client"
        }),
        signal: expect.any(AbortSignal)
      })
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      title: "Retrieval Augmented Generation Evaluation",
      sourceType: "papers",
      publisher: "arXiv",
      publishedAt: "2024-01-02T00:00:00Z",
      credibilityScore: 0.9
    });
  });

  it("parses Semantic Scholar results", async () => {
    process.env.PAPER_PROVIDER = "semantic_scholar";
    process.env.SEMANTIC_SCHOLAR_API_KEY = " semantic-key ";
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            paperId: "paper-1",
            title: "Evaluating Retrieval Augmented Generation",
            abstract: "This paper studies RAG evaluation metrics and practical benchmarks.",
            year: 2024,
            venue: "ACL",
            url: "https://www.semanticscholar.org/paper/paper-1"
          }
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const sources = await collectPaperSources({
      topic: "RAG evaluation",
      sourceTypes: ["papers"],
      maxResults: 2,
      recency: "balanced"
    });

    expect(sources).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-api-key": "semantic-key"
        })
      })
    );
    expect(sources[0]).toMatchObject({
      title: "Evaluating Retrieval Augmented Generation",
      sourceType: "papers",
      publisher: "ACL",
      publishedAt: "2024",
      summary: expect.stringContaining("RAG evaluation metrics")
    });
  });

  it("does not fabricate fallback sources", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502 })));

    await expect(
      collectPaperSources({
        topic: "RAG evaluation",
        sourceTypes: ["papers"],
        maxResults: 2,
        recency: "balanced"
      })
    ).rejects.toThrow(/External API request failed/);

    vi.stubGlobal("fetch", vi.fn(async () => textResponse("<not-feed />")));

    await expect(
      collectPaperSources({
        topic: "RAG evaluation",
        sourceTypes: ["papers"],
        maxResults: 2,
        recency: "balanced"
      })
    ).rejects.toThrow(/Invalid response format/);
  });

  it("reports source timeouts", async () => {
    process.env.SOURCE_API_TIMEOUT_MS = "1";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string | URL, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          })
      )
    );

    await expect(
      collectPaperSources({
        topic: "RAG evaluation",
        sourceTypes: ["papers"],
        maxResults: 2,
        recency: "balanced"
      })
    ).rejects.toThrow(/arXiv timed out after 1ms/);
  });

  it("reports Semantic Scholar rate limits", async () => {
    process.env.PAPER_PROVIDER = "semantic_scholar";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Too Many Requests", { status: 429 })));

    await expect(
      collectPaperSources({
        topic: "RAG evaluation",
        sourceTypes: ["papers"],
        maxResults: 2,
        recency: "balanced"
      })
    ).rejects.toThrow(/SEMANTIC_SCHOLAR_API_KEY/);
  });

  it("arXiv 429 returns a clear rate-limit error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Rate exceeded.", { status: 429 })));

    await expect(
      collectPaperSources({
        topic: "RAG evaluation",
        sourceTypes: ["papers"],
        maxResults: 2,
        recency: "balanced"
      })
    ).rejects.toThrow(/arXiv rate limit exceeded.*Rate exceeded/);
  });

  it("falls back to Crossref when arXiv is rate-limited", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes("export.arxiv.org")) {
        return new Response("Rate exceeded.", { status: 429 });
      }

      return jsonResponse(crossrefJson());
    });
    vi.stubGlobal("fetch", fetchMock);

    const sources = await collectPaperSources({
      topic: "RAG evaluation",
      sourceTypes: ["papers"],
      maxResults: 2,
      recency: "balanced"
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("api.crossref.org/works");
    expect(fetchMock.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": "research-brief-agent/0.1 crossref-client"
        })
      })
    );
    expect(sources[0]).toMatchObject({
      title: "Retrieval Augmented Generation Evaluation with Crossref",
      sourceType: "papers",
      publisher: "Journal of RAG Systems",
      publishedAt: "2024-01-02",
      summary: "Crossref fallback metadata for RAG evaluation.",
      credibilityScore: 0.75
    });
  });

  it("uses Crossref directly when PAPER_PROVIDER is crossref", async () => {
    process.env.PAPER_PROVIDER = "crossref";
    const fetchMock = vi.fn(async () => jsonResponse(crossrefJson()));
    vi.stubGlobal("fetch", fetchMock);

    const sources = await collectPaperSources({
      topic: "RAG evaluation",
      sourceTypes: ["papers"],
      maxResults: 2,
      recency: "balanced"
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe("https://doi.org/10.5555/rag.eval");
  });

  it("scores source relevance", () => {
    expect(scoreRelevance("RAG evaluation", "RAG metrics", "evaluation framework")).toBe(1);
    expect(scoreRelevance("RAG evaluation", "RAG metrics", "retrieval framework")).toBe(0.5);
    expect(scoreRelevance("RAG evaluation", "unrelated", "benchmark")).toBe(0);
  });

  it("scores domain credibility", () => {
    expect(scoreCredibility("https://arxiv.org/abs/2401.1")).toBe(0.9);
    expect(scoreCredibility("https://nature.com/articles/example")).toBe(0.9);
    expect(scoreCredibility("https://github.com/example/project")).toBe(0.8);
    expect(scoreCredibility("https://docs.example.com/guide", "Official docs")).toBe(0.8);
    expect(scoreCredibility("https://medium.com/example/post")).toBe(0.6);
    expect(scoreCredibility("https://example.com/article")).toBe(0.5);
  });

  it("deduplicates and ranks sources", () => {
    const sources = dedupeSources(
      [
        { ...sampleSource, id: "low", url: "https://example.com/a", relevanceScore: 0.2, credibilityScore: 0.5 },
        { ...sampleSource, id: "high", url: "https://example.com/a", relevanceScore: 1, credibilityScore: 0.9 },
        { ...sampleSource, id: "second", url: "https://example.com/b", relevanceScore: 0.4, credibilityScore: 0.5 }
      ],
      10
    );

    expect(sources).toHaveLength(2);
    expect(sources[0].id).toBe("high");
    expect(sources[1].id).toBe("second");
  });

  it("normalizes collected sources", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse(arxivXml())));

    const result = await runSourceCollector({
      topic: "RAG evaluation",
      sourceTypes: ["papers"],
      maxResults: 1
    });
    const parsed = JSON.parse(result.output);

    expect(parsed.sources).toHaveLength(1);
    expect(parsed.sources[0]).toHaveProperty("credibilityScore");
    expect(parsed.sources[0]).toHaveProperty("url");
  });
});

describe("researchTools", () => {
  it("synthesizes source structures", async () => {
    const result = await runEvidenceSynthesizer({
      sources: [sampleSource],
      focus: "RAG evaluation for team discussion",
      outputFormat: "decision_brief"
    });
    const parsed = JSON.parse(result.output);

    expect(parsed.synthesis.keyFindings.length).toBeGreaterThan(0);
    expect(parsed.synthesis.recommendation).toContain("evaluation workflow");
  });

  it("defaults missing synthesis focus", async () => {
    const result = await runEvidenceSynthesizer({
      sources: [sampleSource]
    });
    const parsed = JSON.parse(result.output);

    expect(parsed.synthesis.focus).toBe("Synthesis of collected sources");
    expect(parsed.synthesis.keyFindings.length).toBeGreaterThan(0);
  });

  it("compares RAG evaluation dimensions", async () => {
    const result = await runEvidenceSynthesizer({
      sources: [
        sampleSource,
        {
          ...sampleSource,
          id: "papers:frameworks",
          title: "RAGAS TruLens DeepEval for RAG evaluation",
          url: "https://arxiv.org/abs/2401.00002",
          summary:
            "RAGAS, TruLens and DeepEval evaluate faithfulness, answer relevancy, context precision, context recall and production monitoring."
        }
      ],
      focus: "RAG evaluation analysis",
      outputFormat: "decision_brief"
    });
    const parsed = JSON.parse(result.output);
    const dimensions = parsed.synthesis.comparisons.map((item: { dimension: string }) => item.dimension);

    expect(dimensions).toEqual(expect.arrayContaining(["Evaluation levels", "Key metrics", "Framework selection", "Datasets and benchmarks"]));
    expect(parsed.synthesis.keyFindings.join("\n")).toContain("faithfulness");
    expect(parsed.synthesis.comparisons.map((item: { notes: string }) => item.notes).join("\n")).toContain("RAGAS");
  });

  it("keeps memory research focused", async () => {
    const result = await runEvidenceSynthesizer({
      sources: [sampleSource],
      focus: "Research long-context memory framework selection",
      outputFormat: "decision_brief"
    });
    const parsed = JSON.parse(result.output);

    expect(parsed.synthesis.researchQuestion).toContain("memory framework");
    expect(parsed.synthesis.researchQuestion).not.toContain("RAG");
    expect(parsed.synthesis.keyFindings.join("\n")).toContain("Memory selection requires its own evaluation");
    expect(parsed.synthesis.comparisons.map((item: { dimension: string }) => item.dimension)).toEqual(
      expect.arrayContaining(["Mem0", "Letta/MemGPT", "Zep", "LangGraph Memory", "CrewAI Memory", "Custom lightweight memory layer"])
    );
    expect(parsed.synthesis.comparisons.map((item: { notes: string }) => item.notes).join("\n")).toContain(
      "absent from collected abstracts"
    );
  });

  it("writes a readable brief", async () => {
    const synthesis = JSON.parse(
      (
        await runEvidenceSynthesizer({
          sources: [sampleSource],
          focus: "RAG evaluation for team discussion",
          outputFormat: "decision_brief"
        })
      ).output
    ).synthesis;

    const result = await runBriefWriter({
      synthesis,
      audience: "team_lead",
      length: "medium"
    });
    const parsed = JSON.parse(result.output);

    expect(parsed.brief.content).toContain("# RAG evaluation for team discussion Research brief");
    expect(parsed.brief.content).toContain("## Key findings");
  });

  it("includes memory framework tables", async () => {
    const synthesis = JSON.parse(
      (
        await runEvidenceSynthesizer({
          sources: [
            {
              ...sampleSource,
              title: "Memory Frameworks for LLM Agents",
              summary: "This survey mentions Mem0, Letta, Zep and LangGraph memory for long-term agent memory."
            }
          ],
          focus: "Research long-context memory framework selection",
          outputFormat: "decision_brief"
        })
      ).output
    ).synthesis;

    const result = await runBriefWriter({
      synthesis,
      audience: "self_learning",
      length: "medium"
    });
    const parsed = JSON.parse(result.output);

    expect(parsed.brief.title).toBe("Agent/LLM memory framework selection brief");
    expect(parsed.brief.content).toContain("## Framework comparison");
    expect(parsed.brief.content).toContain("| Mem0 |");
    expect(parsed.brief.content).toContain("| Letta/MemGPT |");
    expect(parsed.brief.content).toContain("| LangGraph Memory |");
  });

  it("shortens verbose titles", async () => {
    const result = await runBriefWriter({
      synthesis: {
        focus:
          "RAG evaluation overview, including metric definitions, retrieval quality, answer faithfulness, and framework comparisons.",
        outputFormat: "decision_brief",
        keyFindings: ["RAG evaluation covers retrieval quality and answer faithfulness."],
        comparisons: [{ dimension: "Metrics", notes: "Separate retrieval and generation metrics." }],
        risksOrLimitations: ["More source coverage is required."],
        recommendation: "Build a small evaluation workflow, then expand."
      },
      audience: "self_learning",
      length: "medium"
    });
    const parsed = JSON.parse(result.output);

    expect(parsed.brief.title).toBe("RAG evaluation overview Research brief");
    expect(parsed.brief.content.split("\n")[0]).toBe("# RAG evaluation overview Research brief");
  });

  it("exposes research tools only", async () => {
    expect(Object.keys(toolRegistry)).toEqual(["source_collector", "evidence_synthesizer", "brief_writer"]);
    expect(toolDefinitions.map((tool) => tool.function.name)).toEqual([
      "source_collector",
      "evidence_synthesizer",
      "brief_writer"
    ]);

    await expect(executeRegisteredTool("unknown_tool", {})).rejects.toThrow(/Unknown tool/);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function textResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/atom+xml"
    }
  });
}

function arxivXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>https://arxiv.org/abs/2401.00001</id>
    <published>2024-01-02T00:00:00Z</published>
    <updated>2024-01-03T00:00:00Z</updated>
    <title>Retrieval Augmented Generation Evaluation</title>
    <summary>
      This paper discusses RAG evaluation methods, retrieval quality, and answer faithfulness.
    </summary>
  </entry>
</feed>`;
}

function crossrefJson() {
  return {
    message: {
      items: [
        {
          DOI: "10.5555/rag.eval",
          title: ["Retrieval Augmented Generation Evaluation with Crossref"],
          abstract: "<jats:p>Crossref fallback metadata for RAG evaluation.</jats:p>",
          publisher: "Journal of RAG Systems",
          URL: "https://doi.org/10.5555/rag.eval",
          "published-online": {
            "date-parts": [[2024, 1, 2]]
          }
        }
      ]
    }
  };
}

function restoreSearchEnv(): void {
  if (originalSearchProvider === undefined) {
    delete process.env.SEARCH_PROVIDER;
  } else {
    process.env.SEARCH_PROVIDER = originalSearchProvider;
  }

  if (originalSearchApiKey === undefined) {
    delete process.env.SEARCH_API_KEY;
  } else {
    process.env.SEARCH_API_KEY = originalSearchApiKey;
  }

  if (originalPaperProvider === undefined) {
    delete process.env.PAPER_PROVIDER;
  } else {
    process.env.PAPER_PROVIDER = originalPaperProvider;
  }

  if (originalSemanticScholarApiKey === undefined) {
    delete process.env.SEMANTIC_SCHOLAR_API_KEY;
  } else {
    process.env.SEMANTIC_SCHOLAR_API_KEY = originalSemanticScholarApiKey;
  }

  if (originalSourceApiTimeoutMs === undefined) {
    delete process.env.SOURCE_API_TIMEOUT_MS;
  } else {
    process.env.SOURCE_API_TIMEOUT_MS = originalSourceApiTimeoutMs;
  }
}

describe("Source references", () => {
  it("preserves collected references through synthesis and brief writing", async () => {
    const result = await runEvidenceSynthesizer({ sources: [sampleSource], focus: "RAG evaluation" });
    const synthesis = JSON.parse(result.output).synthesis;
    const brief = JSON.parse((await runBriefWriter({ synthesis })).output).brief;
    expect(brief.content).toContain("## Sources");
    for (const source of [sampleSource]) expect(brief.content).toContain(source.url);
  });
  it("rejects references with a non-HTTP protocol", async () => {
    await expect(runEvidenceSynthesizer({ sources: [{ ...sampleSource, url: "javascript:alert(1)" }] })).rejects.toThrow("Invalid arguments");
  });
});
