import {
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { workspacePaths } from "../config/paths.js";
import type { LLMProvider } from "../providers/base.js";

export interface HistoryEntry {
  cursor: number;
  timestamp: string;
  content: string;
}

/** Pure file I/O layer for all memory files. */
export class MemoryStore {
  private paths: ReturnType<typeof workspacePaths>;

  constructor(private workspaceDir: string) {
    this.paths = workspacePaths(workspaceDir);
  }

  readFile(path: string): string {
    try { return readFileSync(path, "utf-8"); }
    catch { return ""; }
  }

  readUser(): string { return this.readFile(this.paths.userFile); }
  readMemory(): string { return this.readFile(this.paths.memoryFile); }

  writeUser(c: string) { writeFileSync(this.paths.userFile, c, "utf-8"); }
  writeMemory(c: string) { writeFileSync(this.paths.memoryFile, c, "utf-8"); }

  getMemoryContext(): string {
    const m = this.readMemory();
    return m ? `## Long-term Memory\n${m}` : "";
  }

  // ── history.jsonl ─────────────────────────────────────────────────────────

  appendHistory(entry: string): number {
    const cursor = this.nextCursor();
    const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
    const record: HistoryEntry = { cursor, timestamp: ts, content: entry.trim() };
    appendFileSync(this.paths.historyFile, JSON.stringify(record) + "\n", "utf-8");
    writeFileSync(this.paths.cursorFile, String(cursor), "utf-8");
    return cursor;
  }

  readAllHistory(): HistoryEntry[] {
    if (!existsSync(this.paths.historyFile)) return [];
    return readFileSync(this.paths.historyFile, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as HistoryEntry; } catch { return null; } })
      .filter((e): e is HistoryEntry => e !== null);
  }

  readUnprocessedHistory(sinceC: number): HistoryEntry[] {
    return this.readAllHistory().filter((e) => e.cursor > sinceC);
  }

  getLastCursor(): number {
    try { return parseInt(readFileSync(this.paths.cursorFile, "utf-8").trim(), 10) || 0; }
    catch { return 0; }
  }

  getLastDreamCursor(): number {
    try { return parseInt(readFileSync(this.paths.dreamCursorFile, "utf-8").trim(), 10) || 0; }
    catch { return 0; }
  }

  setLastDreamCursor(cursor: number): void {
    writeFileSync(this.paths.dreamCursorFile, String(cursor), "utf-8");
  }

  private nextCursor(): number {
    return this.getLastCursor() + 1;
  }
}

// ── Consolidator ────────────────────────────────────────────────────────────

interface SessionLike {
  messages: Array<{ role: string; content?: unknown; tool_calls?: unknown }>;
  lastConsolidated: number;
}

export class Consolidator {
  constructor(
    private store: MemoryStore,
    private provider: LLMProvider,
    private model: string
  ) {}

  /** Summarize messages and append to history.jsonl. */
  async archive(messages: SessionLike["messages"]): Promise<void> {
    if (!messages.length) return;
    const formatted = messages
      .filter((m) => m.content)
      .map((m) => {
        const content = typeof m.content === "string"
          ? m.content
          : JSON.stringify(m.content);
        return `[${m.role.toUpperCase()}]: ${content.slice(0, 500)}`;
      })
      .join("\n");

    try {
      const response = await this.provider.chat({
        model: this.model,
        messages: [
          {
            role: "system",
            content:
              "You are a memory archiver. Summarize the following conversation segment " +
              "into a concise paragraph (2-4 sentences) preserving key facts, decisions, and outcomes.",
          },
          { role: "user", content: formatted },
        ],
      });
      const summary = response.content ?? formatted.slice(0, 500);
      this.store.appendHistory(summary);
    } catch {
      // Raw archive as fallback
      this.store.appendHistory(`[RAW] ${formatted.slice(0, 1000)}`);
    }
  }

  /** Check if session is over token budget and archive old messages. */
  async maybeConsolidate(
    session: SessionLike,
    contextWindowTokens: number,
    maxTokens: number
  ): Promise<void> {
    const budget = contextWindowTokens - maxTokens - 1024;
    const estimated = this.estimateTokens(session.messages);
    if (estimated <= budget) return;

    // Archive half of unconsolidated messages
    const start = session.lastConsolidated;
    const toArchive = session.messages.slice(start, Math.floor((start + session.messages.length) / 2));
    if (!toArchive.length) return;

    await this.archive(toArchive);
    session.lastConsolidated = start + toArchive.length;
  }

  private estimateTokens(messages: SessionLike["messages"]): number {
    return messages.reduce((sum, m) => {
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      return sum + Math.ceil(c.length / 3.5) + 4;
    }, 0);
  }
}

// ── Dream ────────────────────────────────────────────────────────────────────

export class Dream {
  constructor(
    private store: MemoryStore,
    private provider: LLMProvider,
    private model: string
  ) {}

  async run(): Promise<boolean> {
    const lastCursor = this.store.getLastDreamCursor();
    const entries = this.store.readUnprocessedHistory(lastCursor);
    if (!entries.length) return false;

    const batch = entries.slice(0, 20);
    const historyText = batch
      .map((e) => `[${e.timestamp}] ${e.content}`)
      .join("\n");

    const currentDate = new Date().toISOString().slice(0, 10);
    const memCtx =
      `## Current Date\n${currentDate}\n\n` +
      `## MEMORY.md\n${this.store.readMemory() || "(empty)"}\n\n` +
      `## USER.md\n${this.store.readUser() || "(empty)"}`;

    // Phase 1: Analyze
    let analysis: string;
    try {
      const phase1 = await this.provider.chat({
        model: this.model,
        messages: [
          {
            role: "system",
            content:
              "You are a memory analyst. Given recent conversation history and current memory files, " +
              "identify: (1) new atomic facts to add, (2) stale/outdated items to remove, " +
              "(3) user preferences or patterns observed. Be concise and specific.",
          },
          { role: "user", content: `## Conversation History\n${historyText}\n\n${memCtx}` },
        ],
      });
      analysis = phase1.content ?? "";
    } catch {
      return false;
    }

    // Phase 2: Apply changes to memory files
    try {
      const phase2 = await this.provider.chat({
        model: this.model,
        messages: [
          {
            role: "system",
            content:
              "You are a memory editor. Given an analysis, produce updated versions of the memory files. " +
              "Return a JSON object with optional keys: memory (string), user (string). " +
              "Only include keys for files that need changes.\n" +
              "Rules: Keep files concise. Preserve existing structure. Use markdown. Be surgical.",
          },
          {
            role: "user",
            content: `## Analysis\n${analysis}\n\n${memCtx}\n\nReturn only valid JSON.`,
          },
        ],
      });

      const content = phase2.content ?? "";
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const updates = JSON.parse(jsonMatch[0]) as {
          memory?: string;
          user?: string;
        };
        if (updates.memory) this.store.writeMemory(updates.memory);
        if (updates.user) this.store.writeUser(updates.user);
      }
    } catch { /* non-fatal */ }

    this.store.setLastDreamCursor(batch[batch.length - 1].cursor);
    return true;
  }
}
