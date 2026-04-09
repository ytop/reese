import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentLoop } from "../agent/loop.js";
import type { AppConfig } from "../config/schema.js";

/** Periodically polls HEARTBEAT.md and runs scheduled tasks. */
export class HeartbeatService {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private loop: AgentLoop,
    private config: AppConfig
  ) {}

  start(): void {
    const interval = this.config.heartbeatIntervalMs;
    console.log(`[Heartbeat] Starting — interval ${interval / 1000}s`);
    this.timer = setInterval(() => this.tick().catch(console.error), interval);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    const heartbeatFile = join(this.config.workspaceDir, "HEARTBEAT.md");
    if (!existsSync(heartbeatFile)) return;

    const content = readFileSync(heartbeatFile, "utf-8");
    if (!content.trim()) return;

    // Phase 1: LLM decides skip/run
    let action: "skip" | "run" = "skip";
    let tasks = "";
    try {
      const response = await this.loop["provider"].chat({
        messages: [
          {
            role: "system",
            content:
              "You decide whether to run scheduled tasks. " +
              "Given HEARTBEAT.md content, respond with JSON: " +
              '{"action":"skip"} or {"action":"run","tasks":"description of active tasks"}. ' +
              "Skip if the file has only comments or headers and no active tasks.",
          },
          { role: "user", content: content },
        ],
        model: this.config.modelName,
      });
      const json = (response.content ?? "").match(/\{[\s\S]*\}/)?.[0];
      if (json) {
        const parsed = JSON.parse(json) as { action: string; tasks?: string };
        if (parsed.action === "run") { action = "run"; tasks = parsed.tasks ?? content; }
      }
    } catch { return; }

    if (action !== "run") {
      console.log("[Heartbeat] No active tasks, skipping");
      return;
    }

    console.log("[Heartbeat] Running tasks:", tasks.slice(0, 100));

    // Phase 2: Run tasks via agent
    const result = await this.loop.processSubagentTask(
      `Run the following scheduled tasks from HEARTBEAT.md:\n\n${tasks}`,
      "heartbeat",
      "heartbeat"
    );

    // Phase 3: Evaluate and optionally notify
    try {
      const evalResp = await this.loop["provider"].chat({
        messages: [
          {
            role: "system",
            content:
              "Decide if this task result is significant enough to notify the user. " +
              'Respond with JSON: {"notify":true,"summary":"..."} or {"notify":false}.',
          },
          { role: "user", content: result },
        ],
        model: this.config.modelName,
      });
      const json = (evalResp.content ?? "").match(/\{[\s\S]*\}/)?.[0];
      if (json) {
        const ev = JSON.parse(json) as { notify: boolean; summary?: string };
        if (ev.notify && ev.summary) {
          this.loop.bus.publishOutbound({
            channel: "cli",
            chatId: "heartbeat",
            content: `[Heartbeat] ${ev.summary}`,
          });
        }
      }
    } catch { /* non-fatal */ }
  }
}
