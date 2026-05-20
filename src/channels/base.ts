import type { OutboundMessage } from "../bus/events.js";

export interface BaseChannel {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Send an outbound message on this channel.
   * The ChannelManager owns routing/rate-limit decisions and calls this directly;
   * channels should NOT subscribe to the bus themselves.
   */
  send(msg: OutboundMessage): Promise<void>;
}
