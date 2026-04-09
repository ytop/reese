import type { LLMResponse, ToolCallRequest } from "../providers/base.js";

export interface AgentHookContext {
  iteration: number;
  response?: LLMResponse;
  toolCalls?: ToolCallRequest[];
  toolResults?: string[];
  finalContent?: string | null;
}

/** Lifecycle hooks for agent execution. */
export class AgentHook {
  wantsStreaming(): boolean { return false; }
  async onStream(_delta: string): Promise<void> {}
  async onStreamEnd(_resuming: boolean): Promise<void> {}
  async beforeIteration(_ctx: AgentHookContext): Promise<void> {}
  async beforeExecuteTools(_ctx: AgentHookContext): Promise<void> {}
  async afterIteration(_ctx: AgentHookContext): Promise<void> {}
  finalizeContent(_ctx: AgentHookContext, content: string | null): string | null {
    return content;
  }
}

export class CompositeHook extends AgentHook {
  constructor(private hooks: AgentHook[]) { super(); }

  wantsStreaming(): boolean { return this.hooks.some((h) => h.wantsStreaming()); }

  async onStream(delta: string): Promise<void> {
    for (const h of this.hooks) await h.onStream(delta);
  }
  async onStreamEnd(resuming: boolean): Promise<void> {
    for (const h of this.hooks) await h.onStreamEnd(resuming);
  }
  async beforeIteration(ctx: AgentHookContext): Promise<void> {
    for (const h of this.hooks) await h.beforeIteration(ctx);
  }
  async beforeExecuteTools(ctx: AgentHookContext): Promise<void> {
    for (const h of this.hooks) await h.beforeExecuteTools(ctx);
  }
  async afterIteration(ctx: AgentHookContext): Promise<void> {
    for (const h of this.hooks) await h.afterIteration(ctx);
  }
  finalizeContent(ctx: AgentHookContext, content: string | null): string | null {
    let result = content;
    for (const h of this.hooks) result = h.finalizeContent(ctx, result);
    return result;
  }
}

/** Strip <think>…</think> blocks from content. */
export function stripThink(text: string | null): string | null {
  if (!text) return null;
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim() || null;
}
