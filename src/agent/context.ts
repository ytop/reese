import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "./memory.js";
import { SkillsLoader } from "./skills.js";
import type { ChatMessage } from "../providers/base.js";

const BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "USER.md"];
const MAX_RECENT_HISTORY = 50;
const RUNTIME_TAG = "[Runtime Context]";

export class ContextBuilder {
  readonly memory: MemoryStore;
  readonly skills: SkillsLoader;

  constructor(private workspaceDir: string) {
    this.memory = new MemoryStore(workspaceDir);
    this.skills = new SkillsLoader(workspaceDir);
  }

  buildSystemPrompt(channel?: string): string {
    const parts: string[] = [];

    // Core identity
    parts.push(this.buildIdentity(channel));

    // Bootstrap files
    const bootstrap = this.loadBootstrapFiles();
    if (bootstrap) parts.push(bootstrap);

    // Long-term memory
    const mem = this.memory.getMemoryContext();
    if (mem) parts.push(`# Memory\n\n${mem}`);

    // Always-on skills
    const alwaysSkills = this.skills.getAlwaysSkills();
    if (alwaysSkills.length) {
      const content = this.skills.loadSkillsForContext(alwaysSkills);
      if (content) parts.push(`# Active Skills\n\n${content}`);
    }

    // Skills summary XML
    const skillsSummary = this.skills.buildSkillsSummary();
    if (skillsSummary) {
      parts.push(
        `# Available Skills\n\nYou have access to the following skills. ` +
        `Use read_file on the <location> path to get full instructions when needed.\n\n${skillsSummary}`
      );
    }

    // Recent unprocessed history (bridge entries)
    const lastDreamC = this.memory.getLastDreamCursor();
    const recent = this.memory.readUnprocessedHistory(lastDreamC);
    if (recent.length) {
      const capped = recent.slice(-MAX_RECENT_HISTORY);
      parts.push(
        "# Recent History\n\n" +
        capped.map((e) => `- [${e.timestamp}] ${e.content}`).join("\n")
      );
    }

    return parts.join("\n\n---\n\n");
  }

  private buildIdentity(channel?: string): string {
    const now = new Date().toLocaleString("en-US", { timeZoneName: "short" });
    return (
      `You are Reese, a personal AI agent running locally on this machine.\n` +
      `Current time: ${now}\n` +
      `Channel: ${channel ?? "cli"}\n` +
      `Workspace: ${this.workspaceDir}\n\n` +
      `You can use tools to read/write files, execute shell commands, search the web, ` +
      `and more. You have a persistent memory system — important facts are stored in ` +
      `markdown files in the workspace. Skills are instruction files that teach you ` +
      `how to perform specific tasks.`
    );
  }

  private loadBootstrapFiles(): string {
    const parts: string[] = [];
    for (const filename of BOOTSTRAP_FILES) {
      const fp = join(this.workspaceDir, filename);
      if (existsSync(fp)) {
        const content = readFileSync(fp, "utf-8");
        parts.push(`## ${filename}\n\n${content}`);
      }
    }
    return parts.join("\n\n");
  }

  static buildRuntimeContext(channel?: string, chatId?: string): string {
    const now = new Date().toISOString();
    const lines = [`${RUNTIME_TAG}`, `Current Time: ${now}`];
    if (channel) lines.push(`Channel: ${channel}`);
    if (chatId) lines.push(`Chat ID: ${chatId}`);
    return lines.join("\n");
  }

  buildMessages(
    history: ChatMessage[],
    currentMessage: string,
    opts?: { channel?: string; chatId?: string; currentRole?: "user" | "assistant" }
  ): ChatMessage[] {
    const { channel, chatId, currentRole = "user" } = opts ?? {};
    const systemPrompt = this.buildSystemPrompt(channel);
    const runtime = ContextBuilder.buildRuntimeContext(channel, chatId);
    const merged = `${runtime}\n\n${currentMessage}`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...history,
    ];

    if (messages[messages.length - 1]?.role === currentRole) {
      const last = messages[messages.length - 1];
      const prev = typeof last.content === "string" ? last.content : "";
      last.content = prev ? `${prev}\n\n${merged}` : merged;
    } else {
      messages.push({ role: currentRole, content: merged });
    }

    return messages;
  }

  /**
   * Build a minimal message array using compact context instead of full history.
   * The system prompt instructs the LLM to reply in two paragraphs:
   *   1. The actual reply to the user
   *   2. An updated compact context summary (≤900 words) for the next turn
   */
  buildCompactMessages(
    compactContext: string | undefined,
    currentMessage: string,
    opts?: { channel?: string; chatId?: string }
  ): ChatMessage[] {
    const { channel, chatId } = opts ?? {};
    const systemPrompt = this.buildSystemPrompt(channel);
    const compactInstruction =
      "\n\n---\n\nIMPORTANT: Reply in exactly two paragraphs separated by a blank line.\n" +
      "Paragraph 1: Your actual reply to the user.\n" +
      "Paragraph 2: An updated compact context summary of this entire conversation so far, " +
      "under 900 words, written in third-person past tense, capturing key facts, decisions, " +
      "and context needed for future turns. This paragraph is never shown to the user.";

    const runtime = ContextBuilder.buildRuntimeContext(channel, chatId);
    const userContent = compactContext
      ? `${runtime}\n\n[Conversation context so far]:\n${compactContext}\n\n[New message]:\n${currentMessage}`
      : `${runtime}\n\n${currentMessage}`;

    return [
      { role: "system", content: systemPrompt + compactInstruction },
      { role: "user", content: userContent },
    ];
  }
}
