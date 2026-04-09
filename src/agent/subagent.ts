import type { LLMProvider } from "../providers/base.js";
import { AgentRunner } from "./runner.js";
import { ContextBuilder } from "./context.js";
import type { AppConfig } from "../config/schema.js";
import type { ToolRegistry } from "../tools/registry.js";

/** Runs a focused subagent in isolation with its own context. */
export class SubagentRunner {
  private runner: AgentRunner;

  constructor(
    private provider: LLMProvider,
    private config: AppConfig,
    private tools: ToolRegistry
  ) {
    this.runner = new AgentRunner(provider);
  }

  async run(task: string, workspaceDir: string): Promise<string> {
    const ctx = new ContextBuilder(workspaceDir);
    const messages = ctx.buildMessages([], task, { channel: "system" });
    const result = await this.runner.run({
      initialMessages: messages,
      tools: this.tools,
      model: this.config.modelName,
      maxIterations: Math.floor(this.config.maxIterations / 2),
      maxToolResultChars: this.config.maxToolResultChars,
    });
    return result.finalContent ?? "(subagent produced no output)";
  }
}
