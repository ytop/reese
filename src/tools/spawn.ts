import type { Tool } from "./base.js";
import type { AgentLoop } from "../agent/loop.js";

/** Spawn a background subagent to run a focused task. */
export class SpawnTool implements Tool {
  readonly name = "spawn";
  readonly description =
    "Spawn a background subagent to run a focused, isolated task. " +
    "The subagent runs concurrently and posts its result back when done. " +
    "Use this to parallelize work or delegate long-running tasks.";
  readonly parameters = {
    type: "object",
    properties: {
      task: { type: "string", description: "The task description for the subagent" },
      context: { type: "string", description: "Optional context or files to give the subagent" },
    },
    required: ["task"],
  };

  private channel = "cli";
  private chatId = "direct";

  constructor(private loop: AgentLoop) {}

  setContext(channel: string, chatId: string): void {
    this.channel = channel;
    this.chatId = chatId;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const task = args.task as string;
    const context = args.context as string | undefined;
    const fullPrompt = context ? `${context}\n\n${task}` : task;
    const channel = this.channel;
    const chatId = this.chatId;

    // Fire and forget — result posted back via bus
    Promise.resolve().then(async () => {
      try {
        const result = await this.loop.processSubagentTask(fullPrompt, channel, chatId);
        this.loop.bus.publishInbound({
          channel: "system",
          senderId: "subagent",
          chatId: `${channel}:${chatId}`,
          content: `Subagent completed task:\n\n${result}`,
          timestamp: new Date(),
        });
      } catch (err) {
        this.loop.bus.publishInbound({
          channel: "system",
          senderId: "subagent",
          chatId: `${channel}:${chatId}`,
          content: `Subagent failed: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: new Date(),
        });
      }
    });

    return `Subagent spawned. It will post results when done.`;
  }
}
