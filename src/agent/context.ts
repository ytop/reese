import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "./memory.js";
import { SkillsLoader } from "./skills.js";
import type { ChatMessage } from "../providers/base.js";

const BOOTSTRAP_FILES = ["USER.md"];
/** Verbatim history kept when no compactContext exists. With a summary, drop to 2. */
const MAX_RECENT_HISTORY = 6;
const RUNTIME_TAG = "[Runtime Context]";
/** Default soft-cap for the system prompt in CHARACTERS. Overridden via config. */
const DEFAULT_BUDGET_CHARS = 3000;

interface SystemPromptCache {
  /** Cache key — when this matches, the cached prompt is still valid. */
  key: string;
  /** Hour bucket the cached prompt was built for. */
  hourBucket: number;
  prompt: string;
}

export interface BuildOptions {
  /** Soft cap on system prompt size in chars. Defaults to DEFAULT_BUDGET_CHARS. */
  budgetChars?: number;
  /** Inject the text-tool-call fallback hint. Off unless the runner has needed it. */
  withFallbackHint?: boolean;
}

export class ContextBuilder {
  readonly memory: MemoryStore;
  readonly skills: SkillsLoader;
  private promptCache = new Map<string, SystemPromptCache>();
  /** Set by the runner when text-tool-call fallback was actually used. */
  static fallbackHintNeeded = false;

  constructor(private workspaceDir: string) {
    this.memory = new MemoryStore(workspaceDir);
    this.skills = new SkillsLoader(workspaceDir);
  }

  buildSystemPrompt(channel?: string, opts: BuildOptions = {}): string {
    // Cache key: per channel, invalidated when any input file changes, when
    // skills change, or when the dream cursor advances. We don't include the
    // exact current time — the identity block embeds a localized "now", but
    // that only meaningfully changes hour-by-hour, so we bucket by the hour.
    const key = this.promptKey(channel) +
      `|b:${opts.budgetChars ?? DEFAULT_BUDGET_CHARS}` +
      `|f:${opts.withFallbackHint ? 1 : 0}`;
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    const cacheKey = channel ?? "__default__";
    const cached = this.promptCache.get(cacheKey);
    if (cached && cached.key === key && cached.hourBucket === hourBucket) {
      return cached.prompt;
    }

    const prompt = this.buildSystemPromptUncached(channel, opts);
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

  private buildSystemPromptUncached(channel?: string, opts: BuildOptions = {}): string {
    const BUDGET_LIMIT = opts.budgetChars ?? DEFAULT_BUDGET_CHARS;
    const parts: string[] = [];

    // Core identity (lean)
    const identity = this.buildIdentity(channel);
    parts.push(identity);

    // Bootstrap files (USER.md). Pre-cap at 1000 chars so a long USER.md doesn't
    // dominate; user can opt into more by trimming the file.
    let bootstrap = this.loadBootstrapFiles();
    if (bootstrap.length > 1000) bootstrap = bootstrap.slice(0, 1000) + "\n…[user.md truncated]";

    // Long-term memory (capped). Same idea.
    let mem = this.memory.getMemoryContext();
    if (mem.length > 800) mem = mem.slice(0, 800) + "\n…[memory truncated]";

    // Always-on skills inline content (rarely populated; capped).
    let activeSkillsContent = "";
    const alwaysSkills = this.skills.getAlwaysSkills();
    if (alwaysSkills.length) {
      activeSkillsContent = this.skills.loadSkillsForContext(alwaysSkills);
      if (activeSkillsContent.length > 800) {
        activeSkillsContent = activeSkillsContent.slice(0, 800) + "\n…[skills truncated]";
      }
    }

    // Compact skills summary by default (one line per available skill).
    let skillsSummary = this.buildCompactSkillsSummary();

    // Recent history bridge: only include when there's no compactContext flowing
    // through buildCompactMessages. The caller signals that via withFallbackHint
    // — but to avoid coupling, just keep this short and let dynamic trimming
    // drop it first when over budget.
    const lastDreamC = this.memory.getLastDreamCursor();
    const recent = this.memory.readUnprocessedHistory(lastDreamC);
    let recentHistoryContent = "";
    if (recent.length) {
      const capped = recent.slice(-MAX_RECENT_HISTORY);
      recentHistoryContent = capped.map((e) => `- [${e.timestamp}] ${e.content}`).join("\n");
      if (recentHistoryContent.length > 800) {
        recentHistoryContent = recentHistoryContent.slice(0, 800) + "\n…[history truncated]";
      }
    }

    // Fallback tool-call boilerplate — only when the runner has actually needed
    // it in the past. Saves ~280 chars/turn for the common case.
    const fallbackFormat = (opts.withFallbackHint || ContextBuilder.fallbackHintNeeded)
      ? "## Fallback Tool Call\nIf native tool calling fails, output `[CALL: tool_name {\"arg\":\"val\"}]` in your reply."
      : "";

    const measure = () =>
      identity.length + bootstrap.length + mem.length + activeSkillsContent.length +
      skillsSummary.length + recentHistoryContent.length + fallbackFormat.length + 30;

    let totalLen = measure();

    // Progressive trimming. Drop redundant pieces first.
    if (totalLen > BUDGET_LIMIT && recentHistoryContent) {
      recentHistoryContent = ""; // covered by compactContext / verbatim history
      totalLen = measure();
    }
    if (totalLen > BUDGET_LIMIT && activeSkillsContent) {
      activeSkillsContent = activeSkillsContent.slice(0, 400) + "\n…[truncated]";
      totalLen = measure();
    }
    if (totalLen > BUDGET_LIMIT && bootstrap) {
      bootstrap = bootstrap.slice(0, 500) + "\n…[truncated]";
      totalLen = measure();
    }
    if (totalLen > BUDGET_LIMIT && mem) {
      mem = mem.slice(0, 400) + "\n…[truncated]";
      totalLen = measure();
    }
    if (totalLen > BUDGET_LIMIT && skillsSummary) {
      // Drop everything but the names line.
      skillsSummary = this.skills
        .listSkills()
        .filter((e) => this.skills.isAvailable(this.skills.getSkillMeta(e.name)))
        .map((e) => e.name)
        .join(",");
      if (skillsSummary) skillsSummary = `Skills: ${skillsSummary}`;
    }

    if (bootstrap) parts.push(bootstrap);
    if (mem) parts.push(mem);
    if (activeSkillsContent) parts.push(activeSkillsContent);
    if (skillsSummary) parts.push(skillsSummary);
    if (recentHistoryContent) parts.push("# Recent\n" + recentHistoryContent);
    if (fallbackFormat) parts.push(fallbackFormat);

    return parts.join("\n\n");
  }

  /** One-line-per-skill summary. Drops <location> and <requires>. */
  private buildCompactSkillsSummary(): string {
    const skills = this.skills.listSkills();
    if (!skills.length) return "";
    const lines: string[] = ["Skills:"];
    for (const entry of skills) {
      const meta = this.skills.getSkillMeta(entry.name);
      if (!this.skills.isAvailable(meta)) continue;
      const desc = (meta.description ?? "").slice(0, 80);
      lines.push(`- ${entry.name}: ${desc}`);
    }
    if (lines.length === 1) return "";
    lines.push("(load via read_file on skills/<name>/SKILL.md)");
    return lines.join("\n");
  }

  private buildIdentity(channel?: string): string {
    const now = new Date().toLocaleString("en-US", { timeZoneName: "short" });
    return (
      `You are Reese, a personal AI assistant. Time:${now} channel:${channel ?? "cli"}.\n` +
      `Use tools to act. Persist facts to MEMORY.md. Reply concisely. ` +
      `Wrap private reasoning in <think>…</think>; the user only sees text outside it.`
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
    // Compact one-liner. Was 4 separate lines.
    const now = new Date().toISOString();
    const bits = [`t=${now}`];
    if (channel) bits.push(`ch=${channel}`);
    if (chatId) bits.push(`cid=${chatId}`);
    return `${RUNTIME_TAG} ${bits.join(" ")}`;
  }

  buildMessages(
    history: ChatMessage[],
    currentMessage: string,
    opts?: { channel?: string; chatId?: string; currentRole?: "user" | "assistant"; budgetChars?: number }
  ): ChatMessage[] {
    const { channel, chatId, currentRole = "user", budgetChars } = opts ?? {};
    const systemPrompt = this.buildSystemPrompt(channel, { budgetChars });
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
   * When a compactContext summary is present, drops verbatim history sharply
   * (it would just re-ship the same information).
   */
  buildCompactMessages(
    compactContext: string | undefined,
    recentHistory: ChatMessage[],
    currentMessage: string,
    opts?: { channel?: string; chatId?: string; budgetChars?: number }
  ): ChatMessage[] {
    const { channel, chatId, budgetChars } = opts ?? {};
    const systemPrompt = this.buildSystemPrompt(channel, { budgetChars });

    const runtime = ContextBuilder.buildRuntimeContext(channel, chatId);
    const userContent = compactContext
      ? `${runtime}\n\n[Summary]:\n${compactContext}\n\n[New]:\n${currentMessage}`
      : `${runtime}\n\n${currentMessage}`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
    ];

    // When we already have a compactContext summary, ship at most 2 raw turns
    // for short-term continuity. Without a summary, keep up to 6 raw turns.
    const tail = compactContext ? 2 : 6;
    if (recentHistory && recentHistory.length > 0) {
      messages.push(...recentHistory.slice(-tail));
    }

    messages.push({ role: "user", content: userContent });
    return messages;
  }
}
