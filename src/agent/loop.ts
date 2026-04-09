import type { InboundMessage, OutboundMessage } from "../bus/events.js";
import { sessionKey } from "../bus/events.js";
import type { MessageBus } from "../bus/queue.js";
import type { LLMProvider } from "../providers/base.js";
import { AgentRunner } from "./runner.js";
import { ContextBuilder } from "./context.js";
import { Consolidator, Dream } from "./memory.js";
import { AgentHook, CompositeHook, stripThink } from "./hook.js";
import { SessionManager } from "../session/manager.js";
import { ToolRegistry } from "../tools/registry.js";
import { ReadFileTool, WriteFileTool, EditFileTool, ListDirTool } from "../tools/filesystem.js";
import { ExecTool } from "../tools/shell.js";
import { GrepTool, GlobTool } from "../tools/search.js";
import { WebFetchTool, WebSearchTool } from "../tools/web.js";
import { MessageTool } from "../tools/message.js";
import { SpawnTool } from "../tools/spawn.js";
import type { AppConfig } from "../config/schema.js";
import type { ChatMessage } from "../providers/base.js";
import { ensureWorkspace } from "../config/paths.js";

const UNIFIED_SESSION = "unified:default";

class LoopHook extends AgentHook {
  private streamBuf = "";
  private onStreamFn?: (delta: string) => void;
  private onProgressFn?: (msg: string) => void;

  constructor(
    private loop: AgentLoop,
    opts: {
      onStream?: (delta: string) => void;
      onProgress?: (msg: string) => void;
    }
  ) {
    super();
    this.onStreamFn = opts.onStream;
    this.onProgressFn = opts.onProgress;
  }

  wantsStreaming() { return Boolean(this.onStreamFn); }

  async onStream(delta: string): Promise<void> {
    const prev = stripThink(this.streamBuf) ?? "";
    this.streamBuf += delta;
    const next = stripThink(this.streamBuf) ?? "";
    const incremental = next.slice(prev.length);
    if (incremental && this.onStreamFn) this.onStreamFn(incremental);
  }

  async onStreamEnd(resuming: boolean): Promise<void> {
    this.streamBuf = "";
  }

  finalizeContent(_ctx: unknown, content: string | null): string | null {
    return stripThink(content);
  }
}

export class AgentLoop {
  readonly bus: MessageBus;
  private provider: LLMProvider;
  private config: AppConfig;
  private runner: AgentRunner;
  private context: ContextBuilder;
  private sessions: SessionManager;
  private tools: ToolRegistry;
  private consolidator: Consolidator;
  private dream: Dream;
  private sessionLocks = new Map<string, Promise<void>>();
  private running = false;

  constructor(bus: MessageBus, provider: LLMProvider, config: AppConfig) {
    this.bus = bus;
    this.provider = provider;
    this.config = config;
    ensureWorkspace(config.workspaceDir);

    this.runner = new AgentRunner(provider);
    this.context = new ContextBuilder(config.workspaceDir);
    this.sessions = new SessionManager(config.workspaceDir);
    this.tools = new ToolRegistry();
    this.consolidator = new Consolidator(this.context.memory, provider, config.modelName);
    this.dream = new Dream(this.context.memory, provider, config.modelName);

    this.registerTools();
  }

  private registerTools(): void {
    const ws = this.config.workspaceDir;
    this.tools.register(new ReadFileTool(ws));
    this.tools.register(new WriteFileTool(ws));
    this.tools.register(new EditFileTool(ws));
    this.tools.register(new ListDirTool(ws));
    this.tools.register(new ExecTool(ws));
    this.tools.register(new GrepTool(ws));
    this.tools.register(new GlobTool(ws));
    this.tools.register(new WebFetchTool());
    this.tools.register(new WebSearchTool());
    this.tools.register(new MessageTool((msg) => this.bus.publishOutbound(msg)));
    this.tools.register(new SpawnTool(this));
  }

  /** Main loop — consume inbound messages and dispatch. */
  async run(): Promise<void> {
    this.running = true;
    console.log("[AgentLoop] Started");

    while (this.running) {
      let msg: InboundMessage;
      try {
        msg = await Promise.race([
          this.bus.consumeInbound(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), 1000)
          ),
        ]);
      } catch {
        continue; // timeout or cancellation — loop again
      }

      // process in serial per session
      const key = msg.sessionKeyOverride ?? sessionKey(msg);
      const prev = this.sessionLocks.get(key) ?? Promise.resolve();
      const next = prev.then(() => this.dispatch(msg)).catch(() => {});
      this.sessionLocks.set(key, next);
    }
  }

  stop(): void {
    this.running = false;
  }

  private async dispatch(msg: InboundMessage): Promise<void> {
    try {
      const response = await this.processMessage(msg);
      if (response) this.bus.publishOutbound(response);
    } catch (err) {
      console.error("[AgentLoop] Error:", err);
      this.bus.publishOutbound({
        channel: msg.channel,
        chatId: msg.chatId,
        content: "Sorry, I encountered an error.",
      });
    }
  }

  // ── Command handling ────────────────────────────────────────────────────────

  private async handleCommand(
    raw: string,
    msg: InboundMessage,
    sessionKey: string
  ): Promise<OutboundMessage | null> {
    const cmd = raw.toLowerCase().split(/\s+/)[0];

    if (cmd === "/new" || cmd === "/reset") {
      this.sessions.reset(sessionKey);
      return { channel: msg.channel, chatId: msg.chatId, content: "Started a new conversation." };
    }

    if (cmd === "/stop") {
      return { channel: msg.channel, chatId: msg.chatId, content: "Stop requested." };
    }

    if (cmd === "/dream") {
      const did = await this.dream.run();
      return {
        channel: msg.channel,
        chatId: msg.chatId,
        content: did ? "Dream complete — memory has been updated." : "Nothing to process.",
      };
    }

    if (cmd === "/status") {
      const session = this.sessions.getOrCreate(sessionKey);
      return {
        channel: msg.channel,
        chatId: msg.chatId,
        content: `Session: ${sessionKey}\nMessages: ${session.messages.length}\nModel: ${this.config.modelName}`,
      };
    }

    if (cmd === "/help") {
      return {
        channel: msg.channel,
        chatId: msg.chatId,
        content:
          "Available commands:\n" +
          "/new — start a new conversation\n" +
          "/stop — cancel current task\n" +
          "/dream — run memory consolidation now\n" +
          "/status — show session info\n" +
          "/help — show this help",
      };
    }

    return null;
  }

  // ── Core processing ─────────────────────────────────────────────────────────

  async processMessage(
    msg: InboundMessage,
    opts?: {
      onStream?: (delta: string) => void;
      onProgress?: (msg: string) => void;
    }
  ): Promise<OutboundMessage | null> {
    const key = msg.sessionKeyOverride ?? sessionKey(msg);
    const raw = msg.content.trim();

    // System messages (from subagents)
    if (msg.channel === "system") {
      return this.processSystemMessage(msg);
    }

    // Slash commands
    if (raw.startsWith("/")) {
      const cmdResult = await this.handleCommand(raw, msg, key);
      if (cmdResult) return cmdResult;
    }

    const session = this.sessions.getOrCreate(key);

    // Set context for tools
    const messageTool = this.tools.get("message") as MessageTool | undefined;
    messageTool?.setContext(msg.channel, msg.chatId);
    messageTool?.startTurn();

    const spawnTool = this.tools.get("spawn") as SpawnTool | undefined;
    spawnTool?.setContext(msg.channel, msg.chatId);

    // Consolidate if needed
    await this.consolidator.maybeConsolidate(
      session,
      this.config.contextWindowTokens,
      this.config.maxTokens
    );

    const history = this.sessions.getHistory(session);
    const messages = this.context.buildMessages(history, msg.content, {
      channel: msg.channel,
      chatId: msg.chatId,
    });

    const hook = new LoopHook(this, {
      onStream: opts?.onStream,
      onProgress: opts?.onProgress ?? ((m) => {
        this.bus.publishOutbound({
          channel: msg.channel,
          chatId: msg.chatId,
          content: m,
          metadata: { _progress: true },
        });
      }),
    });

    const result = await this.runner.run({
      initialMessages: messages,
      tools: this.tools,
      model: this.config.modelName,
      maxIterations: this.config.maxIterations,
      maxToolResultChars: this.config.maxToolResultChars,
      hook,
      sessionKey: key,
    });

    // Save new messages to session
    const newMessages = result.messages.slice(1 + history.length); // skip system + old history
    session.messages.push(...newMessages);
    this.sessions.save(session);

    // Background memory consolidation
    this.consolidator
      .maybeConsolidate(session, this.config.contextWindowTokens, this.config.maxTokens)
      .catch(() => {});

    // If message tool sent mid-turn, don't send final response again
    if (messageTool?.hasSentInTurn) return null;

    const content = result.finalContent ?? "(no response)";
    return { channel: msg.channel, chatId: msg.chatId, content };
  }

  private async processSystemMessage(msg: InboundMessage): Promise<OutboundMessage | null> {
    const [channel, chatId] = msg.chatId.includes(":")
      ? msg.chatId.split(":", 2)
      : ["cli", msg.chatId];

    const session = this.sessions.getOrCreate(`${channel}:${chatId}`);
    const history = this.sessions.getHistory(session);
    const messages = this.context.buildMessages(history, msg.content, {
      channel,
      chatId,
      currentRole: "user",
    });

    const result = await this.runner.run({
      initialMessages: messages,
      tools: this.tools,
      model: this.config.modelName,
      maxIterations: Math.floor(this.config.maxIterations / 2),
      maxToolResultChars: this.config.maxToolResultChars,
    });

    const newMessages = result.messages.slice(1 + history.length);
    session.messages.push(...newMessages);
    this.sessions.save(session);

    return { channel, chatId, content: result.finalContent ?? "Done." };
  }

  /** Run a task directly (used by subagents and heartbeat). */
  async processSubagentTask(task: string, channel: string, chatId: string): Promise<string> {
    const ctx = new ContextBuilder(this.config.workspaceDir);
    const messages = ctx.buildMessages([], task, { channel: "system", chatId });
    const result = await this.runner.run({
      initialMessages: messages,
      tools: this.tools,
      model: this.config.modelName,
      maxIterations: Math.floor(this.config.maxIterations / 2),
      maxToolResultChars: this.config.maxToolResultChars,
    });
    return result.finalContent ?? "(no output)";
  }

  async runDream(): Promise<boolean> {
    return this.dream.run();
  }
}
