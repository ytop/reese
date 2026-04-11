import { EventEmitter } from "node:events";
import type { InboundMessage, OutboundMessage } from "./events.js";
import { Logger } from "../logger.js";

type InboundListener = (msg: InboundMessage) => void;
type OutboundListener = (msg: OutboundMessage) => void;

/** Dual async queue linking channels to the agent loop. */
export class MessageBus extends EventEmitter {
  private inboundQueue: InboundMessage[] = [];
  private outboundQueue: OutboundMessage[] = [];
  private inboundResolvers: Array<(msg: InboundMessage) => void> = [];
  private outboundListeners: OutboundListener[] = [];

  // ── inbound (channel → agent) ─────────────────────────────────────────────

  publishInbound(msg: InboundMessage): void {
    try {
      const logger = Logger.get();
      logger.debug("Bus", `Inbound published: ${msg.channel}:${msg.chatId}`);
    } catch {}
    
    const resolve = this.inboundResolvers.shift();
    if (resolve) {
      resolve(msg);
    } else {
      this.inboundQueue.push(msg);
    }
  }

  /** Await next inbound message. Resolves immediately if one is queued. */
  consumeInbound(): Promise<InboundMessage> {
    const queued = this.inboundQueue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.inboundResolvers.push(resolve));
  }

  // ── outbound (agent → channel) ────────────────────────────────────────────

  publishOutbound(msg: OutboundMessage): void {
    try {
      const logger = Logger.get();
      if (!msg.metadata?._log) {
        logger.debug("Bus", `Outbound published: ${msg.channel}:${msg.chatId}`);
      }
    } catch {}
    
    for (const listener of this.outboundListeners) {
      listener(msg);
    }
  }

  /** Subscribe to outbound messages (channels call this). */
  onOutbound(listener: OutboundListener): () => void {
    this.outboundListeners.push(listener);
    return () => {
      this.outboundListeners = this.outboundListeners.filter((l) => l !== listener);
    };
  }
}
