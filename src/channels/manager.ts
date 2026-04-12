import type { MessageBus } from "../bus/queue.js";
import type { BaseChannel } from "./base.js";

interface ChannelWithRateLimit {
  name: string;
  channel: BaseChannel;
  rateLimitWindow: number;
  rateLimitMax: number;
}

export class ChannelManager implements BaseChannel {
  private channels: Map<string, ChannelWithRateLimit>;
  private messageCounts = new Map<string, number[]>();
  private chatChannelMap = new Map<string, string>(); // chatId -> active channel name
  private processing = new Set<string>(); // prevent circular republish

  constructor(
    private bus: MessageBus,
    channels: ChannelWithRateLimit[],
  ) {
    if (!channels.length) throw new Error("At least one channel required");
    this.channels = new Map(channels.map(c => [c.name, c]));
    this.setupHandlers();
  }

  private setupHandlers(): void {
    const originalOnOutbound = this.bus.onOutbound.bind(this.bus);
    
    // Intercept outbound messages before they reach channels
    const listeners: Array<(msg: any) => Promise<void>> = [];
    
    this.bus.onOutbound(async (msg) => {
      const msgKey = `${msg.chatId}:${msg.channel}:${Date.now()}`;
      
      // Prevent circular processing
      if (this.processing.has(msgKey)) return;
      this.processing.add(msgKey);
      
      try {
        const targetChannel = this.chatChannelMap.get(msg.chatId) || msg.channel;
        const config = this.channels.get(targetChannel);
        
        if (!config) return;
        
        // Check rate limit
        if (this.isRateLimited(targetChannel, config)) {
          console.log(`[ChannelManager] ${targetChannel} rate limited for chat ${msg.chatId}`);
          
          // Try fallback
          const fallback = this.findFallbackChannel(targetChannel);
          if (fallback) {
            console.log(`[ChannelManager] Switching chat ${msg.chatId} to ${fallback.name}`);
            this.chatChannelMap.set(msg.chatId, fallback.name);
            this.recordMessage(fallback.name);
            
            // Modify message in place
            msg.channel = fallback.name;
          } else {
            console.error(`[ChannelManager] All channels rate limited for chat ${msg.chatId}`);
            return;
          }
        } else {
          this.recordMessage(targetChannel);
        }
      } finally {
        // Clean up after a short delay
        setTimeout(() => this.processing.delete(msgKey), 100);
      }
    });
  }

  private isRateLimited(channelName: string, config: ChannelWithRateLimit): boolean {
    const now = Date.now();
    const counts = this.messageCounts.get(channelName) || [];
    const recent = counts.filter(t => now - t < config.rateLimitWindow);
    this.messageCounts.set(channelName, recent);
    return recent.length >= config.rateLimitMax;
  }

  private recordMessage(channelName: string): void {
    const counts = this.messageCounts.get(channelName) || [];
    counts.push(Date.now());
    this.messageCounts.set(channelName, counts);
  }

  private findFallbackChannel(currentChannel: string): ChannelWithRateLimit | null {
    for (const [name, config] of this.channels) {
      if (name === currentChannel) continue;
      if (!this.isRateLimited(name, config)) return config;
    }
    return null;
  }

  async start(): Promise<void> {
    await Promise.all([...this.channels.values()].map(c => c.channel.start()));
  }

  async stop(): Promise<void> {
    await Promise.all([...this.channels.values()].map(c => c.channel.stop()));
  }
}
