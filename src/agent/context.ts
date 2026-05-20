import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "./memory.js";
import { SkillsLoader } from "./skills.js";
import type { ChatMessage } from "../providers/base.js";

const BOOTSTRAP_FILES = ["USER.md"];
const MAX_RECENT_HISTORY = 10;
const RUNTIME_TAG = "[Runtime Context]";

interface SystemPromptCache {
  /** Cache key — when this matches, the cached prompt is still valid. */
  key: string;
  /** Hour bucket the cached prompt was built for. */
  hourBucket: number;
  prompt: string;
}

export class ContextBuilder {
  readonly memory: MemoryStore;
  readonly skills: SkillsLoader;
  private promptCache = new Map<string, SystemPromptCache>();

  constructor(private workspaceDir: string) {
    this.memory = new MemoryStore(workspaceDir);
    this.skills = new SkillsLoader(workspaceDir);
  }

  buildSystemPrompt(channel?: string): string {
    // Cache key: per channel, invalidated when any input file changes, when
    // skills change, or when the dream cursor advances. We don't include the
    // exact current time — the identity block embeds a localized "now", but
    // that only meaningfully changes hour-by-hour, so we bucket by the hour.
    const key = this.promptKey(channel);
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    const cacheKey = channel ?? "__default__";
    const cached = this.promptCache.get(cacheKey);
    if (cached && cached.key === key && cached.hourBucket === hourBucket) {
      return cached.prompt;
    }

    const prompt = this.buildSystemPromptUncached(channel);
    this.promptCache.set(cacheKey, { key, hourBucket, prompt });
    return prompt;
  }

  /** Composite signature of all inputs that flow into the system prompt. */
  private promptKey(channel?: string): string {
    const userMd = this.fileMtime(join(this.workspaceDir, "USER.md"));
    const memMd = this.fileMtime(this.memory.memoryFilePath);
    const dreamCursor = this.memory.getLastDreamCursor();
    // Latest history cursor — bumps when new lines are appended.
    const all = this.memory.readAllHistory();
    const lastCursor = all.length ? all[all.length - 1].cursor : 0;
    const skillsRev = this.skills.revision();
    return [
      channel ?? "",
      `u:${userMd}`,
      `m:${memMd}`,
      `d:${dreamCursor}`,
      `h:${lastCursor}`,
      `s:${skillsRev}`,
    ].join("|");
  }

  private fileMtime(fp: string): number {
    try {
      return existsSync(fp) ? statSync(fp).mtimeMs : -1;
    } catch {
      return -1;
    }
  }

  private buildSystemPromptUncached(channel?: string): string {
    const parts: string[] = [];

    // Core identity
    parts.push(this.buildIdentity(channel));

    // Bootstrap files
    let bootstrap = this.loadBootstrapFiles();

    // Long-term memory
    const mem = this.memory.getMemoryContext();

    // Always-on skills
    let activeSkillsContent = "";
    const alwaysSkills = this.skills.getAlwaysSkills();
    if (alwaysSkills.length) {
      activeSkillsContent = this.skills.loadSkillsForContext(alwaysSkills);
    }

    // Skills summary XML
    let skillsSummary = this.skills.buildSkillsSummary();

    // Recent unprocessed history (bridge entries)
    const lastDreamC = this.memory.getLastDreamCursor();
    const recent = this.memory.readUnprocessedHistory(lastDreamC);
    let recentHistoryContent = "";
    if (recent.length) {
      const capped = recent.slice(-MAX_RECENT_HISTORY);
      recentHistoryContent = capped.map((e) => `- [${e.timestamp}] ${e.content}`).join("\n");
    }

    // Text tool call fallback notification
    const fallbackFormat =
      "## Fallback Tool Calling Format\n" +
      "If you need to call a tool but standard function calling is unavailable or failing, " +
      "you can output the call inside your response text using one of these formats:\n" +
      "- `[CALL: tool_name {\"arg\": \"val\"}]`\n" +
      "- `CALL: tool_name(arg=\"val\")`";

    // Dynamic budgeting based on length (budget: 8000 characters)
    const BUDGET_LIMIT = 8000;
    let totalLen =
      this.buildIdentity(channel).length +
      bootstrap.length +
      mem.length +
      activeSkillsContent.length +
      skillsSummary.length +
      recentHistoryContent.length +
      fallbackFormat.length +
      30;

    if (totalLen > BUDGET_LIMIT) {
      // 1. Trim skillsSummary: build a super compact skills list
      if (skillsSummary) {
        const skills = this.skills.listSkills();
        const compactLines = ["<skills>"];
        for (const entry of skills) {
          const meta = this.skills.getSkillMeta(entry.name);
          const available = this.skills.isAvailable(meta);
          if (available) {
            compactLines.push(`  <skill><name>${entry.name}</name><desc>${meta.description || ""}</desc></skill>`);
          }
        }
        compactLines.push("</skills>");
        skillsSummary = compactLines.join("\n");
      }

      totalLen =
        this.buildIdentity(channel).length +
        bootstrap.length +
        mem.length +
        activeSkillsContent.length +
        skillsSummary.length +
        recentHistoryContent.length +
        fallbackFormat.length +
        30;

      // 2. Trim activeSkillsContent
      if (totalLen > BUDGET_LIMIT && activeSkillsContent) {
        activeSkillsContent = activeSkillsContent.slice(0, 1500) + "\n... [truncated due to context limit]";
        totalLen =
          this.buildIdentity(channel).length +
          bootstrap.length +
          mem.length +
          activeSkillsContent.length +
          skillsSummary.length +
          recentHistoryContent.length +
          fallbackFormat.length +
          30;
      }

      // 3. Trim bootstrap
      if (totalLen > BUDGET_LIMIT && bootstrap) {
        bootstrap = bootstrap.slice(0, 1500) + "\n... [truncated due to context limit]";
      }
    }

    if (bootstrap) parts.push(bootstrap);
    if (mem) parts.push(`# Memory\n\n${mem}`);
    if (activeSkillsContent) parts.push(`# Active Skills\n\n${activeSkillsContent}`);
    if (skillsSummary) {
      parts.push(
        `# Available Skills\n\nYou have access to the following skills. ` +
        `Use read_file on the <location> path to get full instructions when needed.\n\n${skillsSummary}`
      );
    }
    if (recentHistoryContent) {
      parts.push("# Recent History\n\n" + recentHistoryContent);
    }
    parts.push(fallbackFormat);

    return parts.join("\n\n---\n\n");
  }

  private buildIdentity(channel?: string): string {
    const now = new Date().toLocaleString("en-US", { timeZoneName: "short" });
    return (
      `You are Reese, a personal AI assistant.\n` +
      `Current time: ${now}\n` +
      `Channel: ${channel ?? "cli"}\n` +
      `Workspace: ${this.workspaceDir}\n\n` +
      `## Core Principles\n` +
      `- Be helpful, honest, and direct\n` +
      `- Use tools proactively to get things done\n` +
      `- Store important facts in memory files\n` +
      `- Load skill files when you need specialized guidance\n` +
      `- Keep responses concise unless detail is needed\n\n` +
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
   * Build a minimal message array using compact context and verbatim recent history.
   */
  buildCompactMessages(
    compactContext: string | undefined,
    recentHistory: ChatMessage[],
    currentMessage: string,
    opts?: { channel?: string; chatId?: string }
  ): ChatMessage[] {
    const { channel, chatId } = opts ?? {};
    const systemPrompt = this.buildSystemPrompt(channel);

    const runtime = ContextBuilder.buildRuntimeContext(channel, chatId);
    const userContent = compactContext
      ? `${runtime}\n\n[Conversation summary context so far]:\n${compactContext}\n\n[New message]:\n${currentMessage}`
      : `${runtime}\n\n${currentMessage}`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
    ];

    if (recentHistory && recentHistory.length > 0) {
      messages.push(...recentHistory.slice(-10));
    }

    messages.push({ role: "user", content: userContent });
    return messages;
  }
}
