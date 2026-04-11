import { GeminiClient, type GeminiResponse } from "./client.js";
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

      try {
        let fullContent = "";
        for await (const chunk of this.client.stream({ prompt, history })) {
          fullContent += chunk;
          this.bus.emit("gemini:chunk", { chunk, replyTo });
        }
        this.logger.info(`[Gemini] Response complete (${fullContent.length} chars)`);
        this.bus.emit("gemini:done", { content: fullContent, replyTo });
      } catch (err) {
        const error = String(err);
        this.logger.error(`[Gemini] Error: ${error}`);
        this.bus.emit("gemini:response", { content: error, error: true, replyTo });
      }
    });
  }

  async generate(prompt: string, history?: any[]): Promise<GeminiResponse> {
    return this.client.generate({ prompt, history });
  }
}
