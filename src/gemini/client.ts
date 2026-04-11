import type { ChatMessage } from "../providers/base.js";

export interface GeminiRequest {
  prompt: string;
  history?: ChatMessage[];
}

export interface GeminiResponse {
  content: string;
  error?: string;
}

export interface GeminiConfig {
  getAccessToken: () => Promise<string>;
  model?: string;
  apiBase?: string;
}

export class GeminiClient {
  private getAccessToken: () => Promise<string>;
  private model: string;
  private apiBase: string;

  constructor(config: GeminiConfig) {
    this.getAccessToken = config.getAccessToken;
    this.model = config.model || "gemini-2.0-flash-exp";
    this.apiBase = config.apiBase || "https://generativelanguage.googleapis.com/v1beta";
  }

  async generate(request: GeminiRequest): Promise<GeminiResponse> {
    try {
      let content = "";
      for await (const chunk of this.stream(request)) {
        content += chunk;
      }
      return { content };
    } catch (err) {
      return { content: "", error: String(err) };
    }
  }

  async *stream(request: GeminiRequest): AsyncGenerator<string> {
    const token = await this.getAccessToken();
    const url = `${this.apiBase}/models/${this.model}:streamGenerateContent?alt=sse`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        contents: this.buildContents(request),
        generationConfig: { temperature: 1, topP: 0.95, topK: 40, maxOutputTokens: 8192 },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error: ${response.status} ${error}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const json = line.slice(6).trim();
        if (!json || json === "[DONE]") continue;
        try {
          const data = JSON.parse(json);
          const text = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
          if (text) yield text;
        } catch { /* skip malformed chunks */ }
      }
    }
  }

  private buildContents(request: GeminiRequest) {
    const contents: any[] = [];

    // Add history if provided
    if (request.history) {
      for (const msg of request.history) {
        contents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{ text: msg.content }],
        });
      }
    }

    // Add current prompt
    contents.push({
      role: "user",
      parts: [{ text: request.prompt }],
    });

    return contents;
  }

}
