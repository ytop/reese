import type { Tool } from "./base.js";
import type { OutboundMessage } from "../bus/events.js";

/** Allows the agent to send messages mid-turn (progress updates). */
export class MessageTool implements Tool {
  readonly name = "message";
  readonly description =
    "Send a message to the user mid-turn. " +
    "Use this to provide progress updates, partial results, or ask a quick clarifying question " +
    "without ending the current task.";
  readonly parameters = {
    type: "object",
    properties: {
      content: { type: "string", description: "Message text to send" },
    },
    required: ["content"],
  };

  private channel = "cli";
  private chatId = "direct";
  private sentInTurn = false;
  private sendCallback: (msg: OutboundMessage) => void;

  constructor(sendCallback: (msg: OutboundMessage) => void) {
    this.sendCallback = sendCallback;
  }

  setContext(channel: string, chatId: string): void {
    this.channel = channel;
    this.chatId = chatId;
  }

  startTurn(): void {
    this.sentInTurn = false;
  }

  get hasSentInTurn(): boolean {
    return this.sentInTurn;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const content = args.content as string;
    this.sendCallback({
      channel: this.channel,
      chatId: this.chatId,
      content,
      metadata: { _progress: true },
    });
    this.sentInTurn = true;
    return "Message sent.";
  }
}
