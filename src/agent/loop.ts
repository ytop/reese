import type { InboundMessage, OutboundMessage } from "../bus/events.js";
import { sessionKey } from "../bus/events.js";
import type { MessageBus } from "../bus/queue.js";
import type { LLMProvider } from "../providers/base.js";
import { OpenAICompatProvider } from "../providers/openai_compat.js";
import { AgentRunner } from "./runner.js";
import { ContextBuilder } from "./context.js";
import { Consolidator, Dream } from "./memory.js";
import { AgentHook, CompositeHook, stripThink } from "./hook.js";
import { SessionManager, type Session } from "../session/manager.js";
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
import { Logger } from "../logger.js";

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
  private thinkProvider?: LLMProvider;
  private config: AppConfig;
  private runner: AgentRunner;
  private context: ContextBuilder;
  private sessions: SessionManager;
  private tools: ToolRegistry;
  private consolidator: Consolidator;
  private dream: Dream;
  private sessionLocks = new Map<string, Promise<void>>();
  private running = false;
  // Resolved when stop() is called — lets consumeInbound() race exit cleanly
  private stopResolve!: () => void;
  private stopSignal = new Promise<null>((r) => { this.stopResolve = () => r(null); });

  constructor(bus: MessageBus, provider: LLMProvider, config: AppConfig) {
    this.bus = bus;
    this.provider = provider;
    this.config = config;
    ensureWorkspace(config.workspaceDir);

    // Create separate provider for think model if configured
    if (config.thinkModelName && config.thinkModelApiKey) {
      this.thinkProvider = new OpenAICompatProvider({
        apiKey: config.thinkModelApiKey,
        apiBase: config.thinkModelApiBase || config.modelApiBase,
        defaultModel: config.thinkModelName,
        maxTokens: config.maxTokens,
      });
    }

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
    const logger = Logger.get();
    logger.info("AgentLoop", "Started — waiting for messages");
    console.log("[AgentLoop] Started — waiting for messages");

    while (this.running) {
      // Race consumeInbound against stop signal so we never orphan a resolver
      const msg = await Promise.race([
        this.bus.consumeInbound(),
        this.stopSignal,
      ]);

      if (!msg || !this.running) break;

      logger.info("Message", `Received from ${msg.channel}:${msg.chatId} — "${msg.content.slice(0, 60)}..."`);
      console.log(`[AgentLoop] Received message from ${msg.channel}:${msg.chatId} — "${msg.content.slice(0, 80)}"`);

      // Serial per session key
      const key = msg.sessionKeyOverride ?? sessionKey(msg);
      const prev = this.sessionLocks.get(key) ?? Promise.resolve();
      const next = prev.then(() => this.dispatch(msg)).catch((err) => {
        logger.error("AgentLoop", `Dispatch error for ${key}: ${err instanceof Error ? err.message : String(err)}`);
        console.error(`[AgentLoop] Uncaught dispatch error for ${key}:`, err);
      });
      this.sessionLocks.set(key, next);
    }

    logger.info("AgentLoop", "Stopped");
    console.log("[AgentLoop] Stopped");
  }

  stop(): void {
    this.running = false;
    this.stopResolve();
  }

  private async dispatch(msg: InboundMessage): Promise<void> {
    console.log(`[AgentLoop] Dispatching ${msg.channel}:${msg.chatId}`);
    try {
      const response = await this.processMessage(msg);
      if (response) {
        console.log(`[AgentLoop] Sending response to ${response.channel}:${response.chatId} (${response.content.length} chars)`);
        this.bus.publishOutbound(response);
      } else {
        console.log(`[AgentLoop] No response to send (tool mid-turn or command handled)`);
      }
    } catch (err) {
      console.error(`[AgentLoop] Dispatch error:`, err);
      this.bus.publishOutbound({
        channel: msg.channel,
        chatId: msg.chatId,
        content: "Sorry, I encountered an error. Check the server logs.",
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

    if (cmd === "/end" || cmd === "/stop") {
      return { channel: msg.channel, chatId: msg.chatId, content: "Stop requested." };
    }

    if (cmd === "/think" || cmd === "/t") {
      const thinkModel = this.config.thinkModelName || this.config.modelName;
      const userMessage = cmd === "/think" ? raw.slice(6).trim() : raw.slice(2).trim();
      if (!userMessage) {
        return { channel: msg.channel, chatId: msg.chatId, content: `Usage: ${cmd} <your question>` };
      }
      return null; // Continue to processMessage with think mode
    }

    if (cmd === "/double") {
      const userMessage = raw.slice(7).trim();
      if (!userMessage) {
        return { channel: msg.channel, chatId: msg.chatId, content: "Usage: /double <your message>" };
      }
      await this.handleDoubleCommand(userMessage, msg, sessionKey);
      return null;
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
          "/end — cancel current task\n" +
          "/think <question> — use advanced model for difficult tasks\n" +
          "/t <question> — short for /think\n" +
          "/double <message> — parallel dual-agent with cross-review\n" +
          "/dream — run memory consolidation now\n" +
          "/status — show session info\n" +
          "/help — show this help",
      };
    }

    return null;
  }

  // ── Core processing ─────────────────────────────────────────────────────────

  private async handleDoubleCommand(
    userMessage: string,
    msg: InboundMessage,
    sessionKey: string
  ): Promise<void> {
    const logger = Logger.get();
    
    // Main session (default model)
    const mainSession = this.sessions.getOrCreate(sessionKey);
    const secondarySessionKey = `${sessionKey}:secondary`;
    const secondarySession = this.sessions.getOrCreate(secondarySessionKey);

    // Run both agents in parallel
    const [mainResult, thinkResult] = await Promise.all([
      this.runAgent(userMessage, msg, mainSession, this.provider, this.config.modelName, "Main"),
      this.runAgent(userMessage, msg, secondarySession, this.thinkProvider || this.provider, this.config.thinkModelName || this.config.modelName, "Think"),
    ]);

    // Send initial responses
    this.bus.publishOutbound({
      channel: msg.channel,
      chatId: msg.chatId,
      content: `🤖 Main Agent:\n${mainResult}`,
    });
    this.bus.publishOutbound({
      channel: msg.channel,
      chatId: msg.chatId,
      content: `🧠 Think Agent:\n${thinkResult}`,
    });

    // Cross-review: Main reviews Think
    const mainReview = await this.runCrossReview(
      mainResult,
      thinkResult,
      mainSession,
      this.provider,
      this.config.modelName,
      "Main"
    );
    this.bus.publishOutbound({
      channel: msg.channel,
      chatId: msg.chatId,
      content: `🤖 Main Agent Review:\n${mainReview}`,
    });

    // Cross-review: Think reviews Main
    const thinkReview = await this.runCrossReview(
      thinkResult,
      mainResult,
      secondarySession,
      this.thinkProvider || this.provider,
      this.config.thinkModelName || this.config.modelName,
      "Think"
    );
    this.bus.publishOutbound({
      channel: msg.channel,
      chatId: msg.chatId,
      content: `🧠 Think Agent Review:\n${thinkReview}`,
    });

    logger.info("Double", "Cross-review complete");
  }

  private async runAgent(
    userMessage: string,
    msg: InboundMessage,
    session: Session,
    provider: LLMProvider,
    model: string,
    agentName: string
  ): Promise<string> {
    const messages = this.context.buildCompactMessages(session.compactContext, userMessage, {
      channel: msg.channel,
      chatId: msg.chatId,
    });

    const result = await this.runner.run({
      initialMessages: messages,
      tools: this.tools,
      model,
      maxIterations: this.config.maxIterations,
      maxToolResultChars: this.config.maxToolResultChars,
      provider,
    });

    const rawContent = result.finalContent ?? "";
    const { reply, compactContext } = parseCompactResponse(rawContent);

    session.compactContext = compactContext || session.compactContext;
    session.messages.push(
      { role: "user", content: userMessage },
      { role: "assistant", content: reply }
    );
    this.sessions.save(session);

    return reply || "(no response)";
  }

  private async runCrossReview(
    ownResponse: string,
    otherResponse: string,
    session: Session,
    provider: LLMProvider,
    model: string,
    agentName: string
  ): Promise<string> {
    const reviewPrompt = `Review: ${otherResponse}`;
    
    const messages = this.context.buildCompactMessages(session.compactContext, reviewPrompt, {
      channel: "system",
      chatId: "review",
    });

    const result = await this.runner.run({
      initialMessages: messages,
      tools: this.tools,
      model,
      maxIterations: Math.floor(this.config.maxIterations / 2),
      maxToolResultChars: this.config.maxToolResultChars,
      provider,
    });

    const rawContent = result.finalContent ?? "";
    const { reply, compactContext } = parseCompactResponse(rawContent);

    session.compactContext = compactContext || session.compactContext;
    session.messages.push(
      { role: "user", content: reviewPrompt },
      { role: "assistant", content: reply }
    );
    this.sessions.save(session);

    return reply || "(no review)";
  }

  // ── Core processing ─────────────────────────────────────────────────────────

  async processMessage(
    msg: InboundMessage,
    opts?: {
      onStream?: (delta: string) => void;
      onProgress?: (msg: string) => void;
    }
  ): Promise<OutboundMessage | null> {
    const logger = Logger.get();
    const key = msg.sessionKeyOverride ?? sessionKey(msg);
    const raw = msg.content.trim();

    console.log(`[AgentLoop] processMessage key=${key} content="${raw.slice(0, 80)}"`);

    // System messages (from subagents)
    if (msg.channel === "system") {
      console.log(`[AgentLoop] Routing to processSystemMessage`);
      return this.processSystemMessage(msg);
    }

    // Detect /think command
    let useThinkModel = false;
    let actualContent = raw;
    if (raw.toLowerCase().startsWith("/think ")) {
      useThinkModel = true;
      actualContent = raw.slice(7).trim();
    } else if (raw.toLowerCase().startsWith("/t ")) {
      useThinkModel = true;
      actualContent = raw.slice(3).trim();
    }

    // Slash commands
    if (raw.startsWith("/")) {
      console.log(`[AgentLoop] Handling command: ${raw.split(" ")[0]}`);
      const cmdResult = await this.handleCommand(raw, msg, key);
      if (cmdResult) return cmdResult;
      // /think returns null to continue processing
    }

    const session = this.sessions.getOrCreate(key);
    console.log(`[AgentLoop] Session history: ${session.messages.length} messages`);

    // Set context for tools
    const messageTool = this.tools.get("message") as MessageTool | undefined;
    messageTool?.setContext(msg.channel, msg.chatId);
    messageTool?.startTurn();

    const spawnTool = this.tools.get("spawn") as SpawnTool | undefined;
    spawnTool?.setContext(msg.channel, msg.chatId);

    // Build compact-context messages instead of full history
    const messages = this.context.buildCompactMessages(session.compactContext, actualContent, {
      channel: msg.channel,
      chatId: msg.chatId,
    });

    const modelToUse = useThinkModel && this.config.thinkModelName 
      ? this.config.thinkModelName 
      : this.config.modelName;
    
    const providerToUse = useThinkModel && this.thinkProvider
      ? this.thinkProvider
      : this.provider;

    const messagesText = JSON.stringify(messages);
    const preview = messagesText.slice(0, 1500 * 5).replace(/\\n/g, " ").replace(/\s+/g, " ");
    logger.info("LLM", `Calling model=${modelToUse}, messages=${messages.length}, tokens~${Math.round(messagesText.length / 4)}, preview=${preview}`);
    console.log(`[AgentLoop] Calling LLM (model=${modelToUse}, messages=${messages.length})`);

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
      model: modelToUse,
      maxIterations: this.config.maxIterations,
      maxToolResultChars: this.config.maxToolResultChars,
      hook,
      sessionKey: key,
      provider: providerToUse,
    });

    logger.info("LLM", `Response received — stopReason=${result.stopReason}, tools=[${result.toolsUsed.join(",")}], length=${result.finalContent?.length ?? 0}`);
    console.log(`[AgentLoop] Runner done — stopReason=${result.stopReason} toolsUsed=[${result.toolsUsed.join(",")}] contentLen=${result.finalContent?.length ?? 0}`);
    const rawPreview = (result.finalContent ?? "").slice(0, 1500 * 5).replace(/\n/g, " ").replace(/\s+/g, " ");
    logger.info("LLM", `Response raw preview=${rawPreview}`);

    // Parse two-paragraph response: [reply, compact context]
    const rawContent = result.finalContent ?? "";
    const { reply, compactContext } = parseCompactResponse(rawContent);

    const replyPreview = reply.slice(0, 1500 * 5).replace(/\n/g, " ").replace(/\s+/g, " ");
    logger.info("LLM", `Response parsed — replyLen=${reply.length}, compactLen=${compactContext.length}, replyPreview=${replyPreview}`);

    // Save compact context and a minimal message record to session
    session.compactContext = compactContext || session.compactContext;
    session.messages.push(
      { role: "user", content: actualContent },
      { role: "assistant", content: reply }
    );
    this.sessions.save(session);

    // If message tool sent mid-turn, don't send final response again
    if (messageTool?.hasSentInTurn) {
      console.log(`[AgentLoop] message tool handled reply, no final outbound`);
      return null;
    }

    return { channel: msg.channel, chatId: msg.chatId, content: reply || rawContent || "(no response)" };
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

/** Split LLM response into [reply paragraph, compact context paragraph]. */
function parseCompactResponse(raw: string): { reply: string; compactContext: string } {
  // Split on blank line(s) between paragraphs
  const parts = raw.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const compactContext = parts[parts.length - 1];
    const reply = parts.slice(0, parts.length - 1).join("\n\n");
    return { reply, compactContext };
  }
  return { reply: raw.trim(), compactContext: "" };
}
