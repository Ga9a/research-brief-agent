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

describe("source_collector 真实资料采集工具", () => {
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

  it("能校验参数并补齐默认值", () => {
    expect(validateSourceCollectorArgs({ topic: "RAG 评估方法" })).toMatchObject({
      topic: "RAG 评估方法",
      sourceTypes: ["papers"],
      maxResults: 6,
      recency: "balanced"
    });

    expect(() => validateSourceCollectorArgs({ topic: "R" })).toThrow(/source_collector 参数无效/);
    expect(() =>
      validateSourceCollectorArgs({
        topic: "RAG 评估方法",
        sourceTypes: ["invalid"]
      })
    ).toThrow(/source_collector 参数无效/);
  });

  it("sourceTypes 包含 web 但缺少 SEARCH_API_KEY 时明确报错", async () => {
    delete process.env.SEARCH_API_KEY;
    process.env.SEARCH_PROVIDER = "unsupported";

    await expect(
      collectWebSources({
        topic: "RAG 评估方法",
        sourceTypes: ["web"],
        maxResults: 3,
        recency: "balanced"
      })
    ).rejects.toThrow("Missing SEARCH_API_KEY for web search");
  });

  it("SEARCH_PROVIDER 不支持时明确报错", async () => {
    process.env.SEARCH_PROVIDER = "unsupported";
    process.env.SEARCH_API_KEY = "test-key";

    await expect(
      collectWebSources({
        topic: "RAG 评估方法",
        sourceTypes: ["web"],
        maxResults: 3,
        recency: "balanced"
      })
    ).rejects.toThrow(/Unsupported SEARCH_PROVIDER/);
  });

  it("能解析 Tavily web 搜索结果", async () => {
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

  it("默认使用 arXiv 作为无需 key 的 papers 来源", async () => {
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

  it("显式选择 Semantic Scholar 时能解析返回结果", async () => {
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

  it("外部 API 失败或响应格式错误时不做 fallback", async () => {
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

  it("外部资料 API 超时时返回明确错误", async () => {
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

  it("Semantic Scholar 429 时提示配置 API key 或稍后重试", async () => {
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

  it("relevanceScore 能按主题命中词计算", () => {
    expect(scoreRelevance("RAG evaluation", "RAG metrics", "evaluation framework")).toBe(1);
    expect(scoreRelevance("RAG evaluation", "RAG metrics", "retrieval framework")).toBe(0.5);
    expect(scoreRelevance("RAG evaluation", "unrelated", "benchmark")).toBe(0);
  });

  it("credibilityScore 能按域名规则判断", () => {
    expect(scoreCredibility("https://arxiv.org/abs/2401.1")).toBe(0.9);
    expect(scoreCredibility("https://nature.com/articles/example")).toBe(0.9);
    expect(scoreCredibility("https://github.com/example/project")).toBe(0.8);
    expect(scoreCredibility("https://docs.example.com/guide", "Official docs")).toBe(0.8);
    expect(scoreCredibility("https://medium.com/example/post")).toBe(0.6);
    expect(scoreCredibility("https://example.com/article")).toBe(0.5);
  });

  it("去重逻辑按 url 去重并按综合分排序", () => {
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

  it("runSourceCollector 能统一返回结构化 ResearchSource[]", async () => {
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

describe("调研工具注册表和后续工具", () => {
  it("evidence_synthesizer 能从真实来源结构生成关键发现", async () => {
    const result = await runEvidenceSynthesizer({
      sources: [sampleSource],
      focus: "面向组长讨论的 RAG 评估方案",
      outputFormat: "decision_brief"
    });
    const parsed = JSON.parse(result.output);

    expect(parsed.synthesis.keyFindings.length).toBeGreaterThan(0);
    expect(parsed.synthesis.recommendation).toContain("评估框架");
  });

  it("evidence_synthesizer 缺少 focus 时使用工具层默认值，不再失败", async () => {
    const result = await runEvidenceSynthesizer({
      sources: [sampleSource]
    });
    const parsed = JSON.parse(result.output);

    expect(parsed.synthesis.focus).toBe("基于已收集资料的综合分析");
    expect(parsed.synthesis.keyFindings.length).toBeGreaterThan(0);
  });

  it("evidence_synthesizer 对 RAG 评估主题会生成贴合领域的对比维度", async () => {
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
      focus: "RAG 评估体系全面分析",
      outputFormat: "decision_brief"
    });
    const parsed = JSON.parse(result.output);
    const dimensions = parsed.synthesis.comparisons.map((item: { dimension: string }) => item.dimension);

    expect(dimensions).toEqual(expect.arrayContaining(["评估层次", "关键指标", "框架选择", "数据集和基准"]));
    expect(parsed.synthesis.keyFindings.join("\n")).toContain("faithfulness");
    expect(parsed.synthesis.comparisons.map((item: { notes: string }) => item.notes).join("\n")).toContain("RAGAS");
  });

  it("evidence_synthesizer 在 memory 主题下不会被来源里的 RAG 关键词带偏", async () => {
    const result = await runEvidenceSynthesizer({
      sources: [sampleSource],
      focus: "帮我研究 长上下文记忆框架选型",
      outputFormat: "decision_brief"
    });
    const parsed = JSON.parse(result.output);

    expect(parsed.synthesis.researchQuestion).toContain("记忆框架");
    expect(parsed.synthesis.researchQuestion).not.toContain("RAG");
    expect(parsed.synthesis.keyFindings.join("\n")).toContain("不能等同于 RAG 评估");
  });

  it("brief_writer 能生成自然语言简报", async () => {
    const synthesis = JSON.parse(
      (
        await runEvidenceSynthesizer({
          sources: [sampleSource],
          focus: "面向组长讨论的 RAG 评估方案",
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

    expect(parsed.brief.content).toContain("# 面向组长讨论的 RAG 评估方案调研简报");
    expect(parsed.brief.content).toContain("## 关键发现");
  });

  it("brief_writer 会把过长 focus 收敛成短标题", async () => {
    const result = await runBriefWriter({
      synthesis: {
        focus:
          "RAG评估方法的综合分析，包括：1）核心评估维度（忠实度、答案相关性、上下文相关性、检索质量）的定义与含义；2）主流评估框架对比。",
        outputFormat: "decision_brief",
        keyFindings: ["RAG 评估需要同时覆盖检索质量和答案忠实度。"],
        comparisons: [{ dimension: "指标", notes: "检索指标和生成指标需要分开看。" }],
        risksOrLimitations: ["资料覆盖仍需后续扩展。"],
        recommendation: "先建立小样本评估框架，再逐步扩展。"
      },
      audience: "self_learning",
      length: "medium"
    });
    const parsed = JSON.parse(result.output);

    expect(parsed.brief.title).toBe("RAG评估方法的综合分析调研简报");
    expect(parsed.brief.content.split("\n")[0]).toBe("# RAG评估方法的综合分析调研简报");
  });

  it("注册表只暴露调研能力", async () => {
    expect(Object.keys(toolRegistry)).toEqual(["source_collector", "evidence_synthesizer", "brief_writer"]);
    expect(toolDefinitions.map((tool) => tool.function.name)).toEqual([
      "source_collector",
      "evidence_synthesizer",
      "brief_writer"
    ]);

    await expect(executeRegisteredTool("unknown_tool", {})).rejects.toThrow(/未知工具/);
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
