import { Client, GatewayIntentBits, Partials, type Message } from "discord.js";
import type { MessageBus } from "../bus/queue.js";
import type { BaseChannel } from "./base.js";

const DISCORD_MAX_LEN = 2000;

function splitMessage(text: string, maxLen = DISCORD_MAX_LEN): string[] {
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

export class DiscordChannel implements BaseChannel {
  private client: Client;
  private allowFrom: Set<string>;
  private streamBufs = new Map<string, { messageId: string; text: string; lastEdit: number }>();

  constructor(
    token: string,
    private bus: MessageBus,
    allowFrom: string[] = [],
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [
        Partials.Channel,   // Required: DM channels are not cached by default
        Partials.Message,   // Required: DM messages may arrive as partial
      ],
    });
    this.allowFrom = new Set(allowFrom);
    this.setupHandlers();
    this.setupOutbound();
    this.client.login(token);
  }

  private isAllowed(msg: Message): boolean {
    if (!this.allowFrom.size) return true;
    const uid = msg.author.id;
    const username = msg.author.username;
    return this.allowFrom.has(uid) || this.allowFrom.has(username) || this.allowFrom.has("*");
  }

  private setupHandlers(): void {
    this.client.on("clientReady", () => {
      console.log(`[Discord] Bot ${this.client.user?.tag} connected`);
    });

    this.client.on("messageCreate", async (msg) => {
      if (msg.author.bot) return;
      if (!this.isAllowed(msg)) return;

      const chatId = msg.channel.id;
      const senderId = msg.author.id;
      const text = msg.content;

      if (!text) return;

      console.log(`[Discord] Message from user=${senderId} channel=${chatId}`);

      this.bus.publishInbound({
        channel: "discord",
        senderId,
        chatId,
        content: text,
        timestamp: new Date(),
        metadata: { message_id: msg.id },
      });
    });
  }

  private setupOutbound(): void {
    this.bus.onOutbound(async (msg) => {
      if (msg.channel !== "discord") return;
      console.log(`[Discord] Outbound to channel=${msg.chatId}`);
      await this.send(msg.chatId, msg.content, msg.metadata ?? {});
    });
  }

  private async send(
    chatId: string,
    content: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    const isStreamDelta = Boolean(metadata._stream_delta);
    const isStreamEnd = Boolean(metadata._stream_end);
    const isProgress = Boolean(metadata._progress);

    if (isStreamDelta) {
      await this.handleStreamDelta(chatId, content);
      return;
    }
    if (isStreamEnd) {
      await this.finalizeStream(chatId);
      return;
    }
    if (isProgress) return;

    if (!content || content === "[empty message]") return;

    const channel = await this.client.channels.fetch(chatId);
    if (!channel?.isTextBased() || !("send" in channel)) return;

    for (const chunk of splitMessage(content)) {
      try {
        await channel.send(chunk);
      } catch (err) {
        console.error(`[Discord] Failed to send:`, err);
      }
    }
  }

  private async handleStreamDelta(chatId: string, delta: string): Promise<void> {
    const buf = this.streamBufs.get(chatId);
    const now = Date.now();
    
    if (!buf) {
      try {
        const channel = await this.client.channels.fetch(chatId);
        if (!channel?.isTextBased() || !("send" in channel)) return;
        const sent = await channel.send(delta);
        this.streamBufs.set(chatId, { messageId: sent.id, text: delta, lastEdit: now });
      } catch { /* ignore */ }
      return;
    }

    buf.text += delta;
    if (now - buf.lastEdit >= 1000) {
      try {
        const channel = await this.client.channels.fetch(chatId);
        if (!channel?.isTextBased() || !("messages" in channel)) return;
        const msg = await channel.messages.fetch(buf.messageId);
        await msg.edit(buf.text.slice(0, DISCORD_MAX_LEN));
        buf.lastEdit = now;
      } catch { /* ignore */ }
    }
  }

  private async finalizeStream(chatId: string): Promise<void> {
    const buf = this.streamBufs.get(chatId);
    if (!buf) return;
    this.streamBufs.delete(chatId);
    
    try {
      const channel = await this.client.channels.fetch(chatId);
      if (!channel?.isTextBased() || !("messages" in channel)) return;
      const msg = await channel.messages.fetch(buf.messageId);
      await msg.edit(buf.text.slice(0, DISCORD_MAX_LEN));
    } catch { /* ignore */ }
  }

  async start(): Promise<void> {
    console.log("[Discord] Starting...");
  }

  async stop(): Promise<void> {
    this.client.destroy();
  }
}
