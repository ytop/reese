import type { Tool } from "./base.js";

// ── web_fetch ──────────────────────────────────────────────────────────────

export class WebFetchTool implements Tool {
  readonly name = "web_fetch";
  readonly description =
    "Fetch the content of a URL and return it as plain text. " +
    "Useful for reading documentation, articles, and APIs.";
  readonly concurrencySafe = true;
  readonly parameters = {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
      max_chars: { type: "number", description: "Max characters to return (default 16000)" },
    },
    required: ["url"],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const url = args.url as string;
    const maxChars = (args.max_chars as number | undefined) ?? 16000;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "reese-agent/0.1 (+https://github.com/reese)" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return `Error: HTTP ${res.status} ${res.statusText} for ${url}`;
      const text = await res.text();
      // Strip HTML tags for cleaner output
      const stripped = text
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ")
        .replace(/\s{2,}/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      return stripped.length > maxChars
        ? stripped.slice(0, maxChars) + `\n\n[truncated at ${maxChars} chars]`
        : stripped;
    } catch (err: unknown) {
      return `Error fetching URL: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

// ── web_search ─────────────────────────────────────────────────────────────

export class WebSearchTool implements Tool {
  readonly name = "web_search";
  readonly description =
    "Search the web using DuckDuckGo and return a list of results with titles, URLs, and snippets.";
  readonly concurrencySafe = true;
  readonly parameters = {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      max_results: { type: "number", description: "Max results (default 5)", minimum: 1 },
    },
    required: ["query"],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args.query as string;
    const maxResults = (args.max_results as number | undefined) ?? 5;
    try {
      // DuckDuckGo lite API — no API key needed
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const res = await fetch(url, {
        headers: { "User-Agent": "reese-agent/0.1" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return `Error: DuckDuckGo returned ${res.status}`;
      const data = await res.json() as {
        AbstractText?: string;
        AbstractURL?: string;
        RelatedTopics?: Array<{ FirstURL?: string; Text?: string; Topics?: unknown[] }>;
      };

      const results: string[] = [];

      if (data.AbstractText) {
        results.push(`**Summary**: ${data.AbstractText}\nSource: ${data.AbstractURL ?? ""}`);
      }

      for (const topic of (data.RelatedTopics ?? []).slice(0, maxResults)) {
        if (topic.Topics) continue; // skip subcategory headers
        if (topic.FirstURL && topic.Text) {
          results.push(`• ${topic.Text}\n  ${topic.FirstURL}`);
        }
        if (results.length >= maxResults) break;
      }

      if (!results.length) return `No results found for "${query}"`;
      return results.join("\n\n");
    } catch (err: unknown) {
      return `Error searching: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
