import type { MessageBus } from "../bus/queue.js";
import type { OutboundMessage } from "../bus/events.js";
import type { BaseChannel } from "./base.js";

interface ChannelWithRateLimit {
  name: string;
  channel: BaseChannel;
  rateLimitWindow: number;
  rateLimitMax: number;
}

/**
 * Owns outbound routing across multiple channels.
 *
 * - Single subscriber to the bus's outbound stream. Channels themselves do
 *   NOT subscribe — this prevents the previous order-of-listener race where
 *   in-place mutation of `msg.channel` happened after channels had already
 *   filtered.
 * - Tracks per-channel rate limits with a sliding window and falls over to
 *   another channel when a chat's primary is full.
 * - Sticks each chat to its currently active channel, but recovers back to a
 *   higher-priority channel as soon as it's healthy again. The first channel
 *   in `channels[]` is treated as the primary; later channels are fallbacks.
 */
export class ChannelManager implements BaseChannel {
  private channelOrder: ChannelWithRateLimit[];
  private channels: Map<string, ChannelWithRateLimit>;
  private messageCounts = new Map<string, number[]>();
  /** chatId -> currently active channel name */
  private chatChannelMap = new Map<string, string>();

  constructor(
    private bus: MessageBus,
    channels: ChannelWithRateLimit[],
  ) {
    if (!channels.length) throw new Error("At least one channel required");
    this.channelOrder = channels;
    this.channels = new Map(channels.map((c) => [c.name, c]));
    this.bus.onOutbound((msg) => {
      // Fire-and-forget — bus listeners are sync; we don't want to block other listeners.
      this.route(msg).catch((err) => {
        console.error(`[ChannelManager] Routing error:`, err);
      });
    });
  }

  /** Required by BaseChannel — manager is itself a channel-shaped façade. */
  async send(msg: OutboundMessage): Promise<void> {
    await this.route(msg);
  }

  // ── Routing ────────────────────────────────────────────────────────────────

  private async route(msg: OutboundMessage): Promise<void> {
    // If the message isn't targeted at any channel we own (e.g., a CLI-bound
    // message in a mixed setup), let other bus subscribers handle it.
    const requested = msg.channel;
    const requestedKnown = this.channels.has(requested);
    const pinnedKnown = this.chatChannelMap.has(msg.chatId);
    if (!requestedKnown && !pinnedKnown) return;

    // Resolve the target channel. Priority:
    //   1. The chat's pinned channel (from a previous failover) if still healthy.
    //   2. Otherwise, the channel matching msg.channel.
    //   3. Otherwise, fall back through channels in declared order.
    const pinned = this.chatChannelMap.get(msg.chatId);
    const primaryName = this.channelOrder[0]?.name;

    // If the chat was failed over to a non-primary and the primary is now
    // healthy, prefer the primary again.
    if (pinned && pinned !== primaryName && primaryName) {
      const primary = this.channels.get(primaryName);
      if (primary && !this.isRateLimited(primaryName, primary)) {
        this.chatChannelMap.delete(msg.chatId);
      }
    }

    const candidates = this.candidateOrder(msg.chatId, requested);
    for (const cfg of candidates) {
      if (this.isRateLimited(cfg.name, cfg)) continue;

      this.recordMessage(cfg.name);
      // Pin only when we deviated from the originally-requested channel.
      if (cfg.name !== requested) {
        this.chatChannelMap.set(msg.chatId, cfg.name);
        console.log(
          `[ChannelManager] Routing chat ${msg.chatId} via ${cfg.name} ` +
            `(requested=${requested}, rate-limit failover)`
        );
      }
      // Forward without mutating the original message — set channel on a copy
      // so downstream observers (logs, metrics) see the actual delivery target.
      await cfg.channel.send({ ...msg, channel: cfg.name });
      return;
    }

    console.error(
      `[ChannelManager] All channels rate limited for chat ${msg.chatId}; dropping message.`
    );
  }

  /**
   * Build the ordered list of candidates to try for a given chat.
   * Pinned (if any) → requested → remaining channels in declared order.
   */
  private candidateOrder(
    chatId: string,
    requested: string
  ): ChannelWithRateLimit[] {
    const seen = new Set<string>();
    const out: ChannelWithRateLimit[] = [];

    const tryAdd = (name: string | undefined) => {
      if (!name || seen.has(name)) return;
      const cfg = this.channels.get(name);
      if (!cfg) return;
      seen.add(name);
      out.push(cfg);
    };

    tryAdd(this.chatChannelMap.get(chatId));
    tryAdd(requested);
    for (const cfg of this.channelOrder) tryAdd(cfg.name);
    return out;
  }

  // ── Rate-limit bookkeeping ────────────────────────────────────────────────

  private isRateLimited(channelName: string, config: ChannelWithRateLimit): boolean {
    const now = Date.now();
    const counts = this.messageCounts.get(channelName) ?? [];
    const windowStart = now - config.rateLimitWindow;
    // Drop expired entries while we're here so the array doesn't grow forever.
    const recent = counts.filter((t) => t > windowStart);
    if (recent.length !== counts.length) {
      this.messageCounts.set(channelName, recent);
    }
    return recent.length >= config.rateLimitMax;
  }

  private recordMessage(channelName: string): void {
    const cfg = this.channels.get(channelName);
    const now = Date.now();
    const windowStart = cfg ? now - cfg.rateLimitWindow : 0;
    const counts = (this.messageCounts.get(channelName) ?? []).filter(
      (t) => t > windowStart
    );
    counts.push(now);
    this.messageCounts.set(channelName, counts);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await Promise.all(this.channelOrder.map((c) => c.channel.start()));
  }

  async stop(): Promise<void> {
    await Promise.all(this.channelOrder.map((c) => c.channel.stop()));
  }
}
