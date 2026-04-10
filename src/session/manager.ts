import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "../providers/base.js";

export interface Session {
  key: string;
  messages: ChatMessage[];
  lastConsolidated: number;
  updatedAt: string;
  metadata: Record<string, unknown>;
  compactContext?: string;
}

export class SessionManager {
  private cache = new Map<string, Session>();
  private sessionsDir: string;

  constructor(private workspaceDir: string) {
    this.sessionsDir = join(workspaceDir, "sessions");
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  getOrCreate(key: string): Session {
    if (this.cache.has(key)) return this.cache.get(key)!;
    const fp = this.sessionPath(key);
    if (existsSync(fp)) {
      try {
        const data = JSON.parse(readFileSync(fp, "utf-8")) as Session;
        this.cache.set(key, data);
        return data;
      } catch { /* fall through to create new */ }
    }
    const session: Session = {
      key,
      messages: [],
      lastConsolidated: 0,
      updatedAt: new Date().toISOString(),
      metadata: {},
    };
    this.cache.set(key, session);
    return session;
  }

  get(key: string): Session | undefined {
    return this.cache.get(key) ?? this.loadFromDisk(key);
  }

  save(session: Session): void {
    session.updatedAt = new Date().toISOString();
    this.cache.set(session.key, session);
    writeFileSync(this.sessionPath(session.key), JSON.stringify(session, null, 2), "utf-8");
  }

  /** Get message history (all messages, used for context building). */
  getHistory(session: Session): ChatMessage[] {
    return session.messages.slice(session.lastConsolidated);
  }

  reset(key: string): void {
    const session = this.getOrCreate(key);
    session.messages = [];
    session.lastConsolidated = 0;
    session.metadata = {};
    this.save(session);
  }

  private sessionPath(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9_:-]/g, "_");
    return join(this.sessionsDir, `${safe}.json`);
  }

  private loadFromDisk(key: string): Session | undefined {
    const fp = this.sessionPath(key);
    if (!existsSync(fp)) return undefined;
    try {
      const data = JSON.parse(readFileSync(fp, "utf-8")) as Session;
      this.cache.set(key, data);
      return data;
    } catch { return undefined; }
  }
}
