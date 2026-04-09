import type { LLMProvider, ChatMessage, ToolCallRequest } from "../providers/base.js";
import type { ToolRegistry } from "../tools/registry.js";
import { AgentHook, type AgentHookContext, stripThink } from "./hook.js";

interface RunSpec {
  initialMessages: ChatMessage[];
  tools: ToolRegistry;
  model: string;
  maxIterations: number;
  maxToolResultChars: number;
  hook?: AgentHook;
  sessionKey?: string;
}

interface RunResult {
  finalContent: string | null;
  messages: ChatMessage[];
  toolsUsed: string[];
  stopReason: "completed" | "max_iterations" | "error" | "empty_response";
}

const MAX_EMPTY_RETRIES = 2;
const MAX_LENGTH_RECOVERIES = 3;
const MICROCOMPACT_KEEP_RECENT = 10;
const COMPACTABLE_TOOLS = new Set(["read_file", "exec", "grep", "glob", "list_dir", "web_search", "web_fetch"]);

function isBlank(s: string | null | undefined): boolean {
  return !s || s.trim().length === 0;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n[truncated at ${max} chars]`;
}

export class AgentRunner {
  constructor(private provider: LLMProvider) {}

  async run(spec: RunSpec): Promise<RunResult> {
    const hook = spec.hook ?? new AgentHook();
    const messages: ChatMessage[] = [...spec.initialMessages];
    const toolsUsed: string[] = [];
    let finalContent: string | null = null;
    let stopReason: RunResult["stopReason"] = "completed";
    let emptyRetries = 0;
    let lengthRecoveries = 0;

    for (let iteration = 0; iteration < spec.maxIterations; iteration++) {
      const ctx: AgentHookContext = { iteration };
      await hook.beforeIteration(ctx);

      // Microcompact old tool results
      const msgs = this.microcompact(messages);

      let response;
      try {
        if (hook.wantsStreaming()) {
          response = await this.provider.chatStream({
            model: spec.model,
            messages: msgs,
            tools: spec.tools.getDefinitions(),
            onDelta: async (delta) => { await hook.onStream(delta); },
          });
        } else {
          response = await this.provider.chat({
            model: spec.model,
            messages: msgs,
            tools: spec.tools.getDefinitions(),
          });
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Runner] LLM error: ${errMsg}`);
        finalContent = `Sorry, I encountered an error calling the AI model: ${errMsg}`;
        stopReason = "error";
        break;
      }

      ctx.response = response;
      ctx.toolCalls = response.toolCalls;

      // Handle tool calls
      if (response.toolCalls.length > 0) {
        if (hook.wantsStreaming()) await hook.onStreamEnd(true);
        await hook.beforeExecuteTools(ctx);

        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: response.content,
          tool_calls: response.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        };
        messages.push(assistantMsg);
        toolsUsed.push(...response.toolCalls.map((tc) => tc.name));

        // Execute tools
        const results = await spec.tools.executeBatch(response.toolCalls);
        ctx.toolResults = results;

        for (let i = 0; i < response.toolCalls.length; i++) {
          const tc = response.toolCalls[i];
          const result = truncate(results[i], spec.maxToolResultChars);
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            name: tc.name,
            content: result,
          });
        }

        emptyRetries = 0;
        lengthRecoveries = 0;
        await hook.afterIteration(ctx);
        continue;
      }

      // Final response
      const clean = hook.finalizeContent(ctx, stripThink(response.content));

      if (response.finishReason !== "error" && isBlank(clean)) {
        emptyRetries++;
        if (emptyRetries < MAX_EMPTY_RETRIES) {
          if (hook.wantsStreaming()) await hook.onStreamEnd(false);
          await hook.afterIteration(ctx);
          continue;
        }
        finalContent = "(No response)";
        stopReason = "empty_response";
        break;
      }

      if (response.finishReason === "length" && !isBlank(clean)) {
        lengthRecoveries++;
        if (lengthRecoveries <= MAX_LENGTH_RECOVERIES) {
          if (hook.wantsStreaming()) await hook.onStreamEnd(true);
          messages.push({ role: "assistant", content: clean });
          messages.push({ role: "user", content: "Please continue your response." });
          await hook.afterIteration(ctx);
          continue;
        }
      }

      if (hook.wantsStreaming()) await hook.onStreamEnd(false);

      if (response.finishReason === "error") {
        finalContent = clean || "Sorry, the model returned an error.";
        stopReason = "error";
        break;
      }

      messages.push({ role: "assistant", content: clean });
      finalContent = clean;
      ctx.finalContent = finalContent;
      await hook.afterIteration(ctx);
      break;
    }

    if (finalContent === null) {
      stopReason = "max_iterations";
      finalContent = `I've reached my maximum of ${spec.maxIterations} iterations. Please try breaking the task into smaller steps.`;
    }

    return { finalContent, messages, toolsUsed, stopReason };
  }

  private microcompact(messages: ChatMessage[]): ChatMessage[] {
    const indices: number[] = [];
    messages.forEach((m, i) => {
      if (m.role === "tool" && COMPACTABLE_TOOLS.has((m as ChatMessage & { name?: string }).name ?? "")) {
        indices.push(i);
      }
    });
    if (indices.length <= MICROCOMPACT_KEEP_RECENT) return messages;

    const stale = indices.slice(0, indices.length - MICROCOMPACT_KEEP_RECENT);
    const result = messages.map((m, i) => {
      if (!stale.includes(i)) return m;
      const content = typeof m.content === "string" ? m.content : "";
      if (content.length < 500) return m;
      const name = (m as ChatMessage & { name?: string }).name ?? "tool";
      return { ...m, content: `[${name} result omitted from context]` };
    });
    return result;
  }
}
