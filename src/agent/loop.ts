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
import { BackgroundQueue } from "./queue.js";

const UNIFIED_SESSION = "unified:default";
/** Trailing-debounce window for per-session consolidation jobs. */
const CONSOLIDATION_DEBOUNCE_MS = 30_000;
/** Strong, explicit memory triggers — keeps micro-consolidation rare. */
const MICRO_CONSOLIDATION_TRIGGERS: RegExp[] = [
  /\bremember (that|to|this)\b/i,
  /\bnever forget\b/i,
  /\bmemorize\b/i,
  /\bsave (to|in) memory\b/i,
  /\bnote (this|down)\b/i,
  /\bmy name is\b/i,
  /\bi prefer\b/i,
  /\bmy preference\b/i,
];

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
  private bgQueue = new BackgroundQueue();
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

  private toolBuckets: { keywords: RegExp; toolNames: string[] }[] = [];
  /** Tools that are always present regardless of message content. */
  private alwaysToolNames: string[] = ["message"];

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

    // Pre-compute keyword → tool buckets. selectToolsForMessage just OR's the
    // matching buckets together rather than rebuilding the registry per turn.
    // Buckets are intentionally narrow — only ship schemas the model is
    // likely to need for this turn.
    this.toolBuckets = [
      {
        keywords: /https?:|\bweb\b|\bfetch\b|\bbrowse\b|\bdownload\b/i,
        toolNames: ["web_fetch"],
      },
      {
        keywords: /\bsearch\b|\bgoogle\b|\bduckduckgo\b|\blook\s*up\b/i,
        toolNames: ["web_search"],
      },
      // Read-only filesystem (the most common need)
      {
        keywords: /\bread\b|\bview\b|\bshow\b|\bcat\b|\bopen\b|\bls\b|\blist\b|\bdir\b|\bfolder\b|\bcontents?\b|\w+\.\w+/i,
        toolNames: ["read_file", "list_dir"],
      },
      // Write/edit (only when the user clearly intends to mutate)
      {
        keywords: /\bwrite\b|\bedit\b|\bmodify\b|\bupdate\b|\bcreate\b|\bappend\b|\breplace\b|\bsave\b/i,
        toolNames: ["read_file", "write_file", "edit_file"],
      },
      // Code search
      {
        keywords: /\bgrep\b|\bsearch\b|\bfind\b|\bglob\b|\bpattern\b|\bregex\b|\boccurrences?\b/i,
        toolNames: ["grep", "glob"],
      },
      {
        keywords: /\bbash\b|\bterminal\b|\bshell\b|\bcommand\b|\brun\b|\bexecute\b|\binstall\b|\bnpm\b|\bbun\b|\bpip\b|\byarn\b|\bcargo\b|\bgit\b|\bcmd\b|\bsh\b/i,
        toolNames: ["exec"],
      },
      // Subagent delegation only when explicitly invoked
      {
        keywords: /\bspawn\b|\bdelegate\b|\bsubagent\b|\bbackground\b|\bin\s*parallel\b/i,
        toolNames: ["spawn"],
      },
    ];
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
    this.bgQueue.cancelAll();
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

    // Cross-review: run both directions in parallel — they don't depend on
    // each other and were artificially serial before.
    const [mainReview, thinkReview] = await Promise.all([
      this.runCrossReview(
        mainResult,
        thinkResult,
        mainSession,
        this.provider,
        this.config.modelName,
        "Main"
      ),
      this.runCrossReview(
        thinkResult,
        mainResult,
        secondarySession,
        this.thinkProvider || this.provider,
        this.config.thinkModelName || this.config.modelName,
        "Think"
      ),
    ]);

    this.bus.publishOutbound({
      channel: msg.channel,
      chatId: msg.chatId,
      content: `🤖 Main Agent Review:\n${mainReview}`,
    });
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
    const history = this.sessions.getHistory(session);
    const messages = this.context.buildCompactMessages(session.compactContext, history, userMessage, {
      channel: msg.channel,
      chatId: msg.chatId,
      budgetChars: this.promptBudgetChars(),
    });

    const selectedTools = this.selectToolsForMessage(userMessage);

    const result = await this.runner.run({
      initialMessages: messages,
      tools: selectedTools,
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

    // Dynamic logging & micro-consolidation in background
    this.context.memory.appendHistory(`[USER]: ${userMessage}\n[REESE]: ${reply}`);
    this.triggerMicroConsolidation(userMessage, reply, session.key);
    this.triggerBackgroundConsolidation(session.key, session);

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
    const history = this.sessions.getHistory(session);
    
    const messages = this.context.buildCompactMessages(session.compactContext, history, reviewPrompt, {
      channel: "system",
      chatId: "review",
      budgetChars: this.promptBudgetChars(),
    });

    // Cross-review does not require tools
    const selectedTools = new ToolRegistry();

    const result = await this.runner.run({
      initialMessages: messages,
      tools: selectedTools,
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

    // Dynamic logging in background
    this.context.memory.appendHistory(`[SYSTEM REVIEW]: ${reviewPrompt}\n[REESE REVIEW]: ${reply}`);
    this.triggerBackgroundConsolidation(session.key, session);

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

    // Build compact-context messages using verbatim recent history since consolidation
    const history = this.sessions.getHistory(session);
    const messages = this.context.buildCompactMessages(session.compactContext, history, actualContent, {
      channel: msg.channel,
      chatId: msg.chatId,
      budgetChars: this.promptBudgetChars(),
    });

    const modelToUse = useThinkModel && this.config.thinkModelName 
      ? this.config.thinkModelName 
      : this.config.modelName;
    
    const providerToUse = useThinkModel && this.thinkProvider
      ? this.thinkProvider
      : this.provider;

    // Select dynamic tool schema subset to save tokens and prevent provider confusion
    const selectedTools = this.selectToolsForMessage(actualContent);

    // Per-component size breakdown for budget visibility (~chars/4 ≈ tokens).
    const sysLen = typeof messages[0]?.content === "string" ? (messages[0].content as string).length : 0;
    const histLen = messages.slice(1, -1).reduce((acc, m) => acc + (typeof m.content === "string" ? m.content.length : 0), 0);
    const userLen = typeof messages[messages.length - 1]?.content === "string" ? (messages[messages.length - 1].content as string).length : 0;
    const toolDefs = selectedTools.getDefinitions();
    const toolsLen = JSON.stringify(toolDefs).length;
    const totalChars = sysLen + histLen + userLen + toolsLen;
    const totalTokens = Math.round(totalChars / 4);
    const overBudget = totalTokens > (this.config.maxPromptTokens ?? 2000);
    logger.info(
      "LLM",
      `Calling model=${modelToUse} msgs=${messages.length} tools=${toolDefs.length} ` +
      `sys~${Math.round(sysLen/4)}t hist~${Math.round(histLen/4)}t user~${Math.round(userLen/4)}t ` +
      `tools~${Math.round(toolsLen/4)}t total~${totalTokens}t${overBudget ? " [OVER BUDGET]" : ""}`
    );
    console.log(`[AgentLoop] Calling LLM (model=${modelToUse}, tokens~${totalTokens}${overBudget ? " OVER" : ""})`);

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
      tools: selectedTools,
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

    // Dynamic logging & micro-consolidation in background asynchronously
    this.context.memory.appendHistory(`[USER]: ${actualContent}\n[REESE]: ${reply}`);
    this.triggerMicroConsolidation(actualContent, reply, key);
    this.triggerBackgroundConsolidation(key, session);

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
      budgetChars: this.promptBudgetChars(),
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
    const messages = ctx.buildMessages([], task, { channel: "system", chatId, budgetChars: this.promptBudgetChars() });
    const result = await this.runner.run({
      initialMessages: messages,
      tools: this.tools,
      model: this.config.modelName,
      maxIterations: Math.floor(this.config.maxIterations / 2),
      maxToolResultChars: this.config.maxToolResultChars,
    });
    return result.finalContent ?? "(no output)";
  }

  selectToolsForMessage(message: string): ToolRegistry {
    const registry = new ToolRegistry();

    const addByName = (name: string) => {
      const tool = this.tools.get(name);
      if (tool) registry.register(tool);
    };

    for (const name of this.alwaysToolNames) addByName(name);

    for (const bucket of this.toolBuckets) {
      if (bucket.keywords.test(message)) {
        for (const name of bucket.toolNames) addByName(name);
      }
    }

    return registry;
  }

  /** Convert configured token budget to a char budget for the system prompt
   * portion. Roughly chars ≈ tokens × 4; we reserve ~50% for history, runtime,
   * tool schemas, and the user message. */
  private promptBudgetChars(): number {
    const tokens = this.config.maxPromptTokens ?? 2000;
    return Math.max(800, Math.floor(tokens * 4 * 0.5));
  }

  /**
   * Schedule (debounced + serialized) a background consolidation pass.
   * Multiple calls within the debounce window collapse into one trailing run,
   * so a burst of messages produces a single consolidation rather than N.
   */
  private triggerBackgroundConsolidation(key: string, session: Session): void {
    if (session.messages.length - session.lastConsolidated < 6) return;

    this.bgQueue.schedule(
      `consolidation:${key}`,
      () => this.runBackgroundConsolidation(key, session),
      CONSOLIDATION_DEBOUNCE_MS,
    );
  }

  private async runBackgroundConsolidation(key: string, session: Session): Promise<void> {
    const logger = Logger.get();
    const unconsolidatedCount = session.messages.length - session.lastConsolidated;
    if (unconsolidatedCount < 6) return;

    logger.info("Consolidation", `Running background consolidation for ${key} (unconsolidated count: ${unconsolidatedCount})`);

    const newLastConsolidated = session.messages.length;
    const historyToConsolidate = session.messages.slice(session.lastConsolidated, newLastConsolidated);

    const formattedTurns = historyToConsolidate
      .filter((m) => m.content && typeof m.content === "string")
      .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
      .join("\n");

    const systemPrompt =
      "Update a running conversation summary with the new turns below. " +
      "Keep it under 100 words, factual, no fluff. Reply with the updated summary only.";

    const userPrompt =
      `Existing:\n${session.compactContext || "(none)"}\n\n` +
      `New:\n${formattedTurns}`;

    try {
      const response = await this.provider.chat({
        model: this.config.modelName,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        // Hard cap so the summary itself doesn't drift upward over time.
        maxTokens: 200,
      });

      if (response.content) {
        // Clamp to ~600 chars (≈150 tokens) regardless of model behaviour.
        let summary = response.content.trim();
        if (summary.length > 600) summary = summary.slice(0, 600).trimEnd() + "…";
        session.compactContext = summary;
        session.lastConsolidated = newLastConsolidated;
        this.sessions.save(session);
        logger.info("Consolidation", `Background consolidation complete for ${key}. New summary length: ${session.compactContext.length}`);
      }
    } catch (err) {
      logger.error("Consolidation", `Failed to run background consolidation: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private shouldTriggerMicroConsolidation(userMsg: string, agentReply: string): boolean {
    if (MICRO_CONSOLIDATION_TRIGGERS.some((re) => re.test(userMsg))) return true;
    // Agent self-reports an action: stricter than the previous heuristic so we
    // don't fire on every casual "I'll remember…" reply.
    return /\b(added|saved|noted|stored)\b[^.\n]{0,40}\b(memory|note|fact)\b/i.test(agentReply);
  }

  /** Debounced, serialized variant of micro-consolidation. */
  private triggerMicroConsolidation(userMsg: string, agentReply: string, sessionKey: string): void {
    if (!this.shouldTriggerMicroConsolidation(userMsg, agentReply)) return;

    this.bgQueue.schedule(
      `micro:${sessionKey}`,
      () => this.runMicroConsolidation(userMsg, agentReply),
      // Short debounce — micro-consolidation should still feel responsive when
      // the user explicitly asks to "remember X". 5s is enough to coalesce a
      // multi-message burst from the same trigger.
      5_000,
    );
  }

  private async runMicroConsolidation(userMsg: string, agentReply: string): Promise<void> {
    const logger = Logger.get();
    logger.info("MicroConsolidation", "Memory trigger detected. Running micro-consolidation.");

    const currentMemory = this.context.memory.readMemory() || "(empty)";
    const systemPrompt =
      "You are a precise memory consolidation assistant. Your task is to analyze the recent user-assistant interaction and extract a single, concise atomic fact (or a few key facts) that the user wanted the assistant to remember.\n" +
      "If the interaction does not contain new persistent information to remember, output nothing (empty response).\n" +
      "If there is a new fact, output the updated MEMORY.md content directly, merging/updating the new fact surgically. " +
      "Do NOT add conversational explanation. Output ONLY the updated markdown memory.";

    const userPrompt =
      `Current MEMORY.md:\n${currentMemory}\n\n` +
      `Recent Interaction:\n[USER]: ${userMsg}\n[REESE]: ${agentReply}`;

    try {
      const response = await this.provider.chat({
        model: this.config.modelName,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      });

      const updated = response.content?.trim();
      if (updated && updated !== "(empty)" && updated !== currentMemory) {
        this.context.memory.writeMemory(updated);
        logger.info("MicroConsolidation", "MEMORY.md updated surgically in real-time.");
      }
    } catch (err) {
      logger.error("MicroConsolidation", `Failed to run micro-consolidation: ${err instanceof Error ? err.message : String(err)}`);
    }
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
