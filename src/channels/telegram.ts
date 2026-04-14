import { Bot, type Context, InputFile } from "grammy";
import type { MessageBus } from "../bus/queue.js";
import type { BaseChannel } from "./base.js";
import type { LLMProvider } from "../providers/base.js";

const TELEGRAM_MAX_LEN = 4000;

// ── Markdown→HTML for Telegram ─────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function markdownToTelegramHtml(text: string): string {
  if (!text) return "";

  // Protect code blocks
  const codeBlocks: string[] = [];
  text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_m, code: string) => {
    codeBlocks.push(code);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Protect inline code
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    inlineCodes.push(code);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // Headers → plain text
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "$1");

  // Escape HTML
  text = escapeHtml(text);

  // Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__(.+?)__/g, "<b>$1</b>");

  // Italic
  text = text.replace(/(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g, "<i>$1</i>");

  // Strikethrough
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Bullet lists
  text = text.replace(/^[-*]\s+/gm, "• ");

  // Restore inline code
  inlineCodes.forEach((code, i) => {
    text = text.replace(`\x00IC${i}\x00`, `<code>${escapeHtml(code)}</code>`);
  });

  // Restore code blocks
  codeBlocks.forEach((code, i) => {
    text = text.replace(`\x00CB${i}\x00`, `<pre><code>${escapeHtml(code)}</code></pre>`);
  });

  return text;
}

function splitMessage(text: string, maxLen = TELEGRAM_MAX_LEN): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut < maxLen / 2) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// ── TelegramChannel ─────────────────────────────────────────────────────────

export class TelegramChannel implements BaseChannel {
  private bot: Bot;
  private allowFrom: Set<string>;
  private logsEnabled: boolean = true;
  // streaming: chat_id → { messageId, text }
  private streamBufs = new Map<string, { messageId: number; text: string; lastEdit: number }>();

  constructor(
    token: string,
    private bus: MessageBus,
    allowFrom: string[] = [],
    private provider?: LLMProvider,
  ) {
    this.bot = new Bot(token);
    this.allowFrom = new Set(allowFrom);

    this.setupHandlers();
    this.setupOutbound();
  }

  private isAllowed(ctx: Context): boolean {
    if (!this.allowFrom.size) return true; // no allowlist = open
    const user = ctx.from;
    if (!user) {
      console.log("[Telegram] Rejected: no user on context");
      return false;
    }
    const uid = String(user.id);
    const username = user.username ?? "";
    const ok = this.allowFrom.has(uid) || this.allowFrom.has(username) || this.allowFrom.has("*");
    if (!ok) {
      console.log(`[Telegram] Rejected user id=${uid} username=${username} (not in allowlist: ${[...this.allowFrom].join(",")})`);
    }
    return ok;
  }

  private setupHandlers(): void {
    this.bot.command("start", async (ctx) => {
      if (!this.isAllowed(ctx)) return;
      await ctx.reply(`👋 Hi! I'm Reese, your personal AI agent.\nSend me a message or /help to see commands.`);
    });

    this.bot.command("help", async (ctx) => {
      await ctx.reply(
        "Commands:\n" +
        "/new — start a new conversation\n" +
        "/end — cancel current task\n" +
        "/dream — run memory consolidation\n" +
        "/status — show session info\n" +

        "/btw <message> — raw LLM query (no memory, no context)\n" +
        "/b <message> — short for /btw\n" +
        "/think <question> — use advanced model for difficult tasks\n" +
        "/t <question> — short for /think\n" +
        "/double <message> — parallel dual-agent with cross-review\n" +
        "/logx — toggle log info written to telegram\n" +
        "/help — show this message"
      );
    });

    this.bot.command(["btw", "b"], async (ctx) => {
      if (!this.isAllowed(ctx)) return;
      const text = ctx.message?.text ?? "";
      const prompt = text.replace(/^\/(btw|b)(@\w+)?\s*/, "").trim();
      if (!prompt) {
        await ctx.reply("Usage: /btw <your message>");
        return;
      }
      if (!this.provider) {
        await ctx.reply("❌ LLM provider not available.");
        return;
      }
      const chatId = String(ctx.chat.id);
      const numChatId = ctx.chat.id;
      await ctx.api.sendChatAction(numChatId, "typing").catch(() => { });
      try {
        await this.provider.chatStream({
          messages: [{ role: "user", content: prompt }],
          onDelta: async (delta: string) => {
            await this.handleStreamDelta(numChatId, chatId, delta);
          },
        });
        await this.finalizeStream(numChatId, chatId);
      } catch (err) {
        await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    this.bot.command("logx", async (ctx) => {
      if (!this.isAllowed(ctx)) return;
      this.logsEnabled = !this.logsEnabled;
      await ctx.reply(`Logs are now ${this.logsEnabled ? "🟢 ENABLED" : "🔴 DISABLED"} in Telegram.`);
    });

    this.bot.command(["new", "end", "dream", "status", "double", "think", "t"], async (ctx) => {
      if (!this.isAllowed(ctx)) return;
      const chatId = String(ctx.chat.id);
      const senderId = ctx.from ? String(ctx.from.id) : chatId;
      const text = ctx.message?.text ?? "";
      this.bus.publishInbound({
        channel: "telegram",
        senderId,
        chatId,
        content: text,
        timestamp: new Date(),
        metadata: { message_id: ctx.message?.message_id },
      });
    });

    this.bot.on("message", async (ctx) => {
      const user = ctx.from;
      const chatId = String(ctx.chat.id);
      const senderId = user ? String(user.id) : chatId;
      console.log(`[Telegram] Message from user=${senderId} username=${user?.username ?? "?"} chat=${chatId}`);

      if (!this.isAllowed(ctx)) {
        console.log(`[Telegram] Message rejected (not allowed)`);
        return;
      }

      const msg = ctx.message;
      const text = msg.text ?? msg.caption ?? "";
      if (!text) {
        console.log(`[Telegram] Message has no text, ignoring (type=${Object.keys(msg).filter(k => !['from', 'chat', 'date', 'message_id'].includes(k)).join(",")})`);
        return;
      }

      console.log(`[Telegram] Publishing inbound: "${text.slice(0, 80)}"`);

      // Show typing indicator
      await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => { });

      this.bus.publishInbound({
        channel: "telegram",
        senderId,
        chatId,
        content: text,
        timestamp: new Date(),
        metadata: {
          message_id: msg.message_id,
          username: user?.username,
          first_name: user?.first_name,
        },
      });
    });

  }

  private setupOutbound(): void {
    this.bus.onOutbound(async (msg) => {
      if (msg.channel !== "telegram") return;
      console.log(`[Telegram] Outbound to chat=${msg.chatId} (${msg.content.length} chars)`);
      await this.send(msg.chatId, msg.content, msg.metadata ?? {});
    });
  }

  private async send(
    chatId: string,
    content: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    const isProgress = Boolean(metadata._progress);
    const isStreamDelta = Boolean(metadata._stream_delta);
    const isStreamEnd = Boolean(metadata._stream_end);
    const isLog = Boolean(metadata._log);
    const numChatId = parseInt(chatId, 10);

    if (isStreamDelta) {
      await this.handleStreamDelta(numChatId, chatId, content);
      return;
    }
    if (isStreamEnd) {
      await this.finalizeStream(numChatId, chatId);
      return;
    }
    if (isProgress) {
      return; // Skip progress messages for Telegram
    }
    if (isLog && !this.logsEnabled) {
      return; // Skip logs if toggled off
    }

    if (!content || content === "[empty message]") {
      console.log(`[Telegram] Skipping empty content for chat=${chatId}`);
      return;
    }

    for (const chunk of splitMessage(content)) {
      try {
        // Send log messages as plain text without HTML parsing
        if (isLog) {
          await this.bot.api.sendMessage(numChatId, chunk);
          console.log(`[Telegram] Log sent OK`);
        } else {
          const html = markdownToTelegramHtml(chunk);
          console.log(`[Telegram] Sending message to chat=${chatId}`);
          await this.bot.api.sendMessage(numChatId, html, { parse_mode: "HTML" });
          console.log(`[Telegram] Sent OK`);
        }
      } catch (err) {
        console.warn(`[Telegram] HTML send failed, retrying as plain text:`, err instanceof Error ? err.message : err);
        try {
          await this.bot.api.sendMessage(numChatId, chunk);
          console.log(`[Telegram] Plain text send OK`);
        } catch (err2) {
          console.error(`[Telegram] Failed to send message:`, err2);
        }
      }
    }
  }

  private async handleStreamDelta(numChatId: number, chatId: string, delta: string): Promise<void> {
    const buf = this.streamBufs.get(chatId);
    const now = Date.now();
    if (!buf) {
      try {
        const sent = await this.bot.api.sendMessage(numChatId, delta);
        this.streamBufs.set(chatId, { messageId: sent.message_id, text: delta, lastEdit: now });
      } catch { /* ignore */ }
      return;
    }
    buf.text += delta;
    if (now - buf.lastEdit >= 600) {
      try {
        await this.bot.api.editMessageText(numChatId, buf.messageId, buf.text.slice(0, TELEGRAM_MAX_LEN));
        buf.lastEdit = now;
      } catch { /* ignore "not modified" errors */ }
    }
  }

  private async finalizeStream(numChatId: number, chatId: string): Promise<void> {
    const buf = this.streamBufs.get(chatId);
    if (!buf) return;
    this.streamBufs.delete(chatId);
    try {
      const html = markdownToTelegramHtml(buf.text);
      await this.bot.api.editMessageText(numChatId, buf.messageId, html, { parse_mode: "HTML" });
    } catch {
      try {
        await this.bot.api.editMessageText(numChatId, buf.messageId, buf.text.slice(0, TELEGRAM_MAX_LEN));
      } catch { /* ignore */ }
    }
  }

  async start(): Promise<void> {
    console.log("[Telegram] Starting long-polling...");
    await this.bot.api.setMyCommands([
      { command: "start", description: "Start the bot" },
      { command: "new", description: "New conversation" },
      { command: "end", description: "Stop current task" },
      { command: "dream", description: "Run memory consolidation" },
      { command: "status", description: "Show session info" },
      { command: "btw", description: "Raw LLM query (no memory, no context)" },
      { command: "b", description: "Short for /btw" },
      { command: "think", description: "Use advanced model for difficult tasks" },
      { command: "t", description: "Short for /think" },
      { command: "double", description: "Parallel dual-agent with cross-review" },
      { command: "logx", description: "Toggle log info written to telegram" },
      { command: "help", description: "Show help" },
    ]);
    this.bot.start({ onStart: (info) => console.log(`[Telegram] Bot @${info.username} connected`) });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}
