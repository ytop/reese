import type { AgentLoop } from "../agent/loop.js";

export interface BaseChannel {
  start(): Promise<void>;
  stop(): Promise<void>;
}
