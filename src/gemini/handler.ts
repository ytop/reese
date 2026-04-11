import { GeminiClient, type GeminiRequest, type GeminiResponse } from "./client.js";
import type { MessageBus } from "../bus/queue.js";
import { Logger } from "../logger.js";

export interface GeminiHandlerConfig {
  getAccessToken: () => Promise<string>;
  model?: string;
  apiBase?: string;
}

export class GeminiHandler {
  private client: GeminiClient;
  private logger = Logger.get();

  constructor(config: GeminiHandlerConfig, private bus: MessageBus) {
    this.client = new GeminiClient(config);
    this.setupBusHandlers();
  }

  private setupBusHandlers() {
    this.bus.on("gemini:request", async (data: any) => {
      const { prompt, history, replyTo } = data;
      
      this.logger.info(`[Gemini] Processing request: ${prompt.slice(0, 50)}...`);
      
      const request: GeminiRequest = { prompt, history };
      const response = await this.client.generate(request);
      
      if (response.error) {
        this.logger.error(`[Gemini] Error: ${response.error}`);
        this.bus.emit("gemini:response", {
          content: `Error: ${response.error}`,
          error: true,
          replyTo,
        });
      } else {
        this.logger.info(`[Gemini] Response: ${response.content.slice(0, 50)}...`);
        this.bus.emit("gemini:response", {
          content: response.content,
          error: false,
          replyTo,
        });
      }
    });
  }

  async generate(prompt: string, history?: any[]): Promise<GeminiResponse> {
    return this.client.generate({ prompt, history });
  }
}
