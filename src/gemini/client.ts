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
      const token = await this.getAccessToken();
      const contents = this.buildContents(request);
      const url = `${this.apiBase}/models/${this.model}:generateContent`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature: 1,
            topP: 0.95,
            topK: 40,
            maxOutputTokens: 8192,
          },
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        return { content: "", error: `API error: ${response.status} ${error}` };
      }

      const data = await response.json();
      const content = this.extractContent(data);
      return { content };
    } catch (err) {
      return { content: "", error: String(err) };
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

  private extractContent(data: any): string {
    try {
      const candidate = data.candidates?.[0];
      if (!candidate) return "";
      
      const parts = candidate.content?.parts || [];
      return parts.map((p: any) => p.text || "").join("");
    } catch {
      return "";
    }
  }
}
