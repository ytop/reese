import OpenAI from "openai";
import type {
  ChatMessage,
  ChatParams,
  LLMProvider,
  LLMResponse,
  StreamDelta,
  ToolCallRequest,
} from "./base.js";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export class OpenAICompatProvider implements LLMProvider {
  private client: OpenAI;
  readonly defaultModel: string;
  private temperature: number;
  private maxTokens: number;

  constructor(opts: {
    apiKey: string;
    apiBase: string;
    defaultModel: string;
    temperature?: number;
    maxTokens?: number;
  }) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.apiBase,
    });
    this.defaultModel = opts.defaultModel;
    this.temperature = opts.temperature ?? 0.1;
    this.maxTokens = opts.maxTokens ?? 8192;
  }

  async chat(params: ChatParams): Promise<LLMResponse> {
    const messages = this.serializeMessages(params.messages);
    const tools = params.tools?.length ? params.tools : undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: params.model ?? this.defaultModel,
          messages,
          tools: tools as OpenAI.Chat.ChatCompletionTool[] | undefined,
          tool_choice: tools ? "auto" : undefined,
          temperature: params.temperature ?? this.temperature,
          max_tokens: params.maxTokens ?? this.maxTokens,
        });

        return this.parseResponse(response);
      } catch (err: unknown) {
        const isRateLimit =
          err instanceof OpenAI.APIError && (err.status === 429 || err.status === 503);
        if (isRateLimit && attempt < MAX_RETRIES - 1) {
          console.error(`[Provider] Rate limited (attempt ${attempt + 1}/${MAX_RETRIES}), retrying...`);
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    throw new Error("Max retries exceeded");
  }

  async chatStream(
    params: ChatParams & { onDelta: StreamDelta }
  ): Promise<LLMResponse> {
    const messages = this.serializeMessages(params.messages);
    const tools = params.tools?.length ? params.tools : undefined;

    const stream = await this.client.chat.completions.create({
      model: params.model ?? this.defaultModel,
      messages,
      tools: tools as OpenAI.Chat.ChatCompletionTool[] | undefined,
      tool_choice: tools ? "auto" : undefined,
      temperature: params.temperature ?? this.temperature,
      max_tokens: params.maxTokens ?? this.maxTokens,
      stream: true,
    });

    let content = "";
    let finishReason: LLMResponse["finishReason"] = "stop";
    const toolCallsAccum: Map<
      number,
      { id: string; name: string; argsStr: string }
    > = new Map();

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;
      if (delta.content) {
        content += delta.content;
        await params.onDelta(delta.content);
      }

      // Accumulate tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCallsAccum.has(tc.index)) {
            toolCallsAccum.set(tc.index, { id: tc.id ?? "", name: tc.function?.name ?? "", argsStr: "" });
          }
          const accum = toolCallsAccum.get(tc.index)!;
          if (tc.id) accum.id = tc.id;
          if (tc.function?.name) accum.name = tc.function.name;
          if (tc.function?.arguments) accum.argsStr += tc.function.arguments;
        }
      }

      if (choice.finish_reason) {
        finishReason = this.mapFinishReason(choice.finish_reason);
      }
    }

    const toolCalls: ToolCallRequest[] = [];
    for (const [, tc] of toolCallsAccum) {
      try {
        toolCalls.push({
          id: tc.id,
          name: tc.name,
          arguments: JSON.parse(tc.argsStr || "{}"),
        });
      } catch {
        // ignore malformed tool call
      }
    }

    if (toolCalls.length > 0) finishReason = "tool_calls";

    return {
      content: content || null,
      toolCalls,
      finishReason,
    };
  }

  private parseResponse(
    resp: OpenAI.Chat.ChatCompletion
  ): LLMResponse {
    const choice = resp.choices[0];
    const msg = choice.message;

    const toolCalls: ToolCallRequest[] = (msg.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: (() => {
        try {
          return JSON.parse(tc.function.arguments);
        } catch {
          return {};
        }
      })(),
    }));

    return {
      content: msg.content ?? null,
      toolCalls,
      finishReason: this.mapFinishReason(choice.finish_reason ?? "stop"),
      usage: resp.usage
        ? {
            promptTokens: resp.usage.prompt_tokens,
            completionTokens: resp.usage.completion_tokens,
          }
        : undefined,
    };
  }

  private mapFinishReason(
    reason: string | null
  ): LLMResponse["finishReason"] {
    if (reason === "tool_calls") return "tool_calls";
    if (reason === "length") return "length";
    if (reason === "stop") return "stop";
    return "error";
  }

  private serializeMessages(
    messages: ChatMessage[]
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map((m) => {
      if (m.role === "tool") {
        return {
          role: "tool" as const,
          tool_call_id: m.tool_call_id ?? "",
          content: Array.isArray(m.content)
            ? m.content.map((b) => b.text).join("\n")
            : (m.content ?? ""),
        };
      }
      if (m.role === "assistant" && m.tool_calls?.length) {
        return {
          role: "assistant" as const,
          content: Array.isArray(m.content)
            ? m.content.map((b) => b.text).join("\n")
            : (m.content ?? ""),
          tool_calls: m.tool_calls as OpenAI.Chat.ChatCompletionMessageToolCall[],
        };
      }
      return {
        role: m.role as "system" | "user" | "assistant",
        content: Array.isArray(m.content)
          ? m.content.map((b) => b.text).join("\n")
          : (m.content ?? ""),
      } as OpenAI.Chat.ChatCompletionMessageParam;
    });
  }
}
