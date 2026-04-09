import type { Tool } from "./base.js";
import { buildToolDefinition } from "./base.js";
import type { ToolDefinition, ToolCallRequest } from "../providers/base.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map(buildToolDefinition);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return `Error: Unknown tool "${name}"`;
    try {
      return await tool.execute(args);
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Execute a batch of tool calls, respecting concurrency safety. */
  async executeBatch(calls: ToolCallRequest[]): Promise<string[]> {
    const results: string[] = new Array(calls.length);
    // Group into serial batches; concurrent-safe tools can run in parallel
    const batches: ToolCallRequest[][] = [];
    let currentBatch: ToolCallRequest[] = [];

    for (const call of calls) {
      const tool = this.tools.get(call.name);
      if (tool?.concurrencySafe) {
        currentBatch.push(call);
      } else {
        if (currentBatch.length) { batches.push(currentBatch); currentBatch = []; }
        batches.push([call]);
      }
    }
    if (currentBatch.length) batches.push(currentBatch);

    let idx = 0;
    for (const batch of batches) {
      if (batch.length === 1) {
        results[idx++] = await this.execute(batch[0].name, batch[0].arguments);
      } else {
        const batchResults = await Promise.all(
          batch.map((c) => this.execute(c.name, c.arguments))
        );
        for (const r of batchResults) results[idx++] = r;
      }
    }
    return results;
  }
}
