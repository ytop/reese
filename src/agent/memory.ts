import {
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  statSync,
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
  /** In-memory cache of parsed history.jsonl entries, kept in cursor order. */
  private historyCache: HistoryEntry[] | null = null;
  /** mtimeMs of history.jsonl when historyCache was loaded. */
  private historyCacheMtime = -1;

  constructor(private workspaceDir: string) {
    this.paths = workspacePaths(workspaceDir);
  }

  /** Resolved path to MEMORY.md. */
  get memoryFilePath(): string { return this.paths.memoryFile; }
  /** Resolved path to history.jsonl. */
  get historyFilePath(): string { return this.paths.historyFile; }

  readFile(path: string): string {
    try { return readFileSync(path, "utf-8"); }
    catch { return ""; }
  }

  readMemory(): string { return this.readFile(this.paths.memoryFile); }

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
    // Keep the in-memory cache hot so the next read doesn't have to re-parse
    // the whole file. Sync mtime to the new file mtime if available.
    if (this.historyCache) {
      this.historyCache.push(record);
      try {
        this.historyCacheMtime = statSync(this.paths.historyFile).mtimeMs;
      } catch { /* ignore */ }
    }
    return cursor;
  }

  /**
   * Read all history entries. Re-parses from disk only when history.jsonl has
   * changed since the last read (mtime-keyed). Subsequent calls in the same
   * second can hit memory directly.
   */
  readAllHistory(): HistoryEntry[] {
    if (!existsSync(this.paths.historyFile)) {
      this.historyCache = [];
      this.historyCacheMtime = -1;
      return this.historyCache;
    }
    let mtime = -1;
    try {
      mtime = statSync(this.paths.historyFile).mtimeMs;
    } catch { /* fall through to re-read */ }
    if (this.historyCache && mtime === this.historyCacheMtime) {
      return this.historyCache;
    }
    const entries = readFileSync(this.paths.historyFile, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as HistoryEntry; } catch { return null; } })
      .filter((e): e is HistoryEntry => e !== null);
    this.historyCache = entries;
    this.historyCacheMtime = mtime;
    return entries;
  }

  readUnprocessedHistory(sinceC: number): HistoryEntry[] {
    const all = this.readAllHistory();
    // Entries are appended monotonically; do a tail scan rather than full filter
    // when the unprocessed slice is small (the common case).
    if (!all.length || all[all.length - 1].cursor <= sinceC) return [];
    // Find first index where cursor > sinceC. Linear from the end is cheap.
    let i = all.length - 1;
    while (i > 0 && all[i - 1].cursor > sinceC) i--;
    return all.slice(i);
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
      `## MEMORY.md\n${this.store.readMemory() || "(empty)"}\n\n`;

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
              "Return a JSON object with optional keys: memory (string). " +
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
        };
        if (updates.memory) this.store.writeMemory(updates.memory);
      }
    } catch { /* non-fatal */ }

    this.store.setLastDreamCursor(batch[batch.length - 1].cursor);
    return true;
  }
}
